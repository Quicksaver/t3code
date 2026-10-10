import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MAGI_ARM_CONTEXT_KIND,
  MagiArmId,
  MagiDecisionSetId,
  MagiParticipantId,
  MagiPersonalityId,
  type MagiParticipantResponse,
  type MagiRecordArbitrationInput,
  type MagiRunId,
  type MagiRunState,
  MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
  magiExclusiveDecisionSetFingerprint,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { ProjectionMagiRepositoryLive } from "../persistence/ProjectionMagi.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProjectionMagiRepository } from "../persistence/ProjectionMagi.ts";
import { layer as layerProviderRegistry } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { layer as magiServiceLayer, MagiService } from "./MagiService.ts";

const ownerThreadId = ThreadId.make("thread:magi-owner");
const projectId = ProjectId.make("project:magi");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexSelection = { instanceId: codexInstanceId, model: "gpt-5.4" } satisfies ModelSelection;
const claudeSelection = {
  instanceId: claudeInstanceId,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const evidenceMarker = "magi-evidence-marker-7f3a";
/** Tasks starting with this marker keep running, like the owner's turn. */
const stayActiveMarker = "magi-stay-active-marker";
/** Usage each participant turn reports on completion. */
const participantTurnUsage = {
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  hasSubagents: false,
  inputTokens: 1_200,
  outputTokens: 300,
};
/** A fenced structured participant answer. */
const participantReply = (fields: Partial<MagiParticipantResponse> = {}) =>
  [
    "```json",
    JSON.stringify({
      recommendation: "Adopt the proposal.",
      rationale: ["The evidence supports it."],
      assumptions: [],
      risks: [],
      confidence: 80,
      candidateFingerprint: null,
      ballot: "not-applicable",
      proposals: [],
      proposalEvaluations: [],
      exclusiveSetEvaluations: [],
      ...fields,
    } satisfies MagiParticipantResponse),
    "```",
  ].join("\n");
const participantResponse = participantReply();
/** An answer proposing each engine as an optional, mutually alternative change. */
const engineProposalsReply = (engines: ReadonlyArray<string>) =>
  participantReply({
    recommendation: "Adopt one storage engine.",
    rationale: ["Either engine works, but not both."],
    confidence: 70,
    proposals: engines.map((engine) => ({
      kind: "optional",
      change: `Use ${engine}.`,
      rationale: `${engine} fits the workload.`,
      expectedVoteEffect: "None.",
      atomicSetKey: null,
    })),
  });
/** Participant prompts whose objective carries this marker answer with two proposals. */
const proposalMarker = "magi-proposal-marker";
const proposalResponse = engineProposalsReply(["SQLite", "PostgreSQL"]);

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly text: string;
}

/** A participant's answer to a prompt, or null to keep its turn running until the test ends it. */
type ParticipantResponder = (prompt: string) => string | null;
const defaultResponder: ParticipantResponder = (prompt) =>
  prompt.includes(proposalMarker) ? proposalResponse : participantResponse;

/** A turn that keeps running: the owner's, or one the responder held. */
interface HeldTurn {
  readonly publish: (events: ReadonlyArray<ProviderAdapterV2Event>) => Effect.Effect<void>;
  readonly driver: ProviderDriverKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly nodeId: ProviderAdapterV2TurnInput["rootNodeId"];
  /** Completes the turn with an assistant answer. */
  readonly finish: (text: string) => Effect.Effect<void>;
  /** Ends the turn as interrupted, without an answer. */
  readonly interrupt: Effect.Effect<void>;
}

interface FakeProviderShape {
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly respond: Ref.Ref<ParticipantResponder>;
  /** The latest held turn of each thread. */
  readonly heldTurns: Ref.Ref<ReadonlyMap<ThreadId, HeldTurn>>;
  /** While set, reads of specific messages fail, as when the projection is unreadable. */
  readonly failMessageReads: Ref.Ref<boolean>;
  /** While set, remembering an armed run's panel, between run creation and turn 1, waits here. */
  readonly panelMemoryGate: Ref.Ref<Option.Option<StartGate>>;
}

interface StartGate {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

class FakeProvider extends Context.Service<FakeProvider, FakeProviderShape>()(
  "t3/magi/MagiService.integration.test/FakeProvider",
) {}

const makeFakeProvider: Effect.Effect<FakeProviderShape> = Effect.all({
  captured: Ref.make<ReadonlyArray<CapturedTurn>>([]),
  respond: Ref.make<ParticipantResponder>(defaultResponder),
  heldTurns: Ref.make<ReadonlyMap<ThreadId, HeldTurn>>(new Map()),
  failMessageReads: Ref.make(false),
  panelMemoryGate: Ref.make(Option.none<StartGate>()),
});

const providerSnapshot = (instanceId: ProviderInstanceId, model: string): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-03T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

/**
 * A provider that records turns. The owner's turn, any turn asked to stay active, and any turn the
 * responder holds report one finished command and keep running, as an arbitrator does while it
 * runs Magi; every other turn answers with the responder's text and reports its token usage.
 */
const makeAdapter = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly fake: FakeProviderShape;
}): ProviderAdapterV2["Service"] => {
  const driver = ProviderDriverKind.make(input.instanceId);
  return {
    instanceId: input.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const unsupported = (detail: string) =>
          Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
        return {
          instanceId: input.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: input.instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
            model: sessionInput.modelSelection.model,
            capabilities: input.capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          } satisfies OrchestrationV2ProviderSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${driver}:${threadInput.threadId}`),
              driver,
              providerInstanceId: input.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `${driver}:${threadInput.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            } satisfies OrchestrationV2ProviderThread),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput: ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.fake.captured, (turns) => [
                ...turns,
                { threadId: turnInput.threadId, text: turnInput.message.text },
              ]);
              const at = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerTurn = (status: "running" | "completed" | "interrupted") => ({
                type: "provider_turn.updated" as const,
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    strength: "strong" as const,
                  },
                  ordinal: turnInput.providerTurnOrdinal,
                  status,
                  startedAt: at,
                  completedAt: status === "running" ? null : at,
                  ...(status === "completed" ? { turnTokenUsage: participantTurnUsage } : {}),
                },
              });
              const item = {
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                nodeId: turnInput.rootNodeId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                status: "completed" as const,
                title: null,
                startedAt: at,
                completedAt: at,
                updatedAt: at,
              };
              const finish = (text: string) =>
                publish([
                  providerTurn("completed"),
                  {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      ...item,
                      id: TurnItemId.make(
                        `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      ),
                      ordinal: turnInput.runOrdinal * 100,
                      type: "assistant_message",
                      messageId: MessageId.make(
                        `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      text,
                      streaming: false,
                    },
                  },
                  {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
                ]);
              const interrupt = publish([
                providerTurn("interrupted"),
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
              yield* publish([providerTurn("running")]);
              const answer =
                turnInput.threadId === ownerThreadId ||
                turnInput.message.text.startsWith(stayActiveMarker)
                  ? null
                  : (yield* Ref.get(input.fake.respond))(turnInput.message.text);
              if (answer !== null) return yield* finish(answer);
              // Registered before its evidence is published, so a test that saw it can use it.
              yield* Ref.update(input.fake.heldTurns, (turns) =>
                new Map(turns).set(turnInput.threadId, {
                  publish,
                  driver,
                  providerSessionId: sessionInput.providerSessionId,
                  providerTurnId,
                  nodeId: turnInput.rootNodeId,
                  finish,
                  interrupt,
                }),
              );
              yield* publish([
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...item,
                    id: TurnItemId.make(`turn-item:${turnInput.threadId}:evidence`),
                    ordinal: 1,
                    type: "command_execution",
                    input: "git diff",
                    output: evidenceMarker,
                  },
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unsupported("readThreadSnapshot is unused"),
          rollbackThread: () => unsupported("rollbackThread is unused"),
          forkThread: () => unsupported("forkThread is unused"),
        };
      }),
  };
};

/**
 * The service over a deterministic provider. Its dependencies stay in the context, so a test can
 * build a restarted service over the same database.
 */
const testLayer = (fake: FakeProviderShape, cwd: string) => {
  const registryLayer = ProviderAdapterRegistry.layerFromAdapters([
    makeAdapter({ instanceId: codexInstanceId, capabilities: CodexProviderCapabilitiesV2, fake }),
    makeAdapter({ instanceId: claudeInstanceId, capabilities: ClaudeProviderCapabilitiesV2, fake }),
  ]);
  const orchestratorLayer = layerWithRegistry(
    { name: "magi-service", runtimePolicyOverride: { cwd } },
    registryLayer,
    { databaseLayer: Sqlite.layerMemory },
  );
  const threadsLayer = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const getThreadRecords: typeof threads.getThreadRecords = (threadId, fields, filter) =>
        Effect.flatMap(Ref.get(fake.failMessageReads), (fail) =>
          fail && filter?.messageIds !== undefined
            ? Effect.die("Injected message read failure.")
            : threads.getThreadRecords(threadId, fields, filter),
        );
      return { ...threads, getThreadRecords };
    }),
  ).pipe(Layer.provide(ThreadManagementService.layer), Layer.provide(orchestratorLayer));
  return magiServiceLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(orchestratorLayer, threadsLayer)),
    Layer.provideMerge(ProjectStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(
      layerProviderRegistry([
        providerSnapshot(codexInstanceId, codexSelection.model),
        providerSnapshot(claudeInstanceId, claudeSelection.model),
      ]),
    ),
    Layer.provideMerge(
      Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          const updateSettings: typeof settings.updateSettings = (patch) =>
            Effect.flatMap(Ref.get(fake.panelMemoryGate), (gate) =>
              Option.isNone(gate) || patch.magi?.lastPanelRoster === undefined
                ? settings.updateSettings(patch)
                : Deferred.succeed(gate.value.reached, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.value.release)),
                    Effect.andThen(settings.updateSettings(patch)),
                  ),
            );
          return { ...settings, updateSettings };
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest().pipe(Layer.orDie))),
    ),
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        generateThreadTitle: () => Effect.succeed({ title: "Magi decision" }),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(FakeProvider, fake)),
  );
};
type TestServices = Layer.Success<ReturnType<typeof testLayer>>;

/** The first stored event on `threadId` matching `predicate`, including past events. */
const awaitEvent = (
  threadId: ThreadId,
  predicate: (
    event: Orchestrator.OrchestratorV2DispatchResult["storedEvents"][number]["event"],
  ) => boolean,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter((stored) => predicate(stored.event)),
      Stream.runHead,
    ),
  );

const createOwnerThread = Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
  orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:magi-owner:create"),
    threadId: ownerThreadId,
    projectId,
    title: "Magi owner",
    modelSelection: codexSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  }),
);

/** Starts the owner's turn from `message`; like an arbitrator's, it keeps running. */
const startOwnerTurn = (message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:magi-owner:start"),
      threadId: ownerThreadId,
      messageId: MessageId.make("message:magi-owner:start"),
      ...message,
      attachments: [],
      modelSelection: codexSelection,
      dispatchMode: { type: "start_immediately" },
    });
    yield* awaitEvent(
      ownerThreadId,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed",
    );
  });

const startOwnerRun = Effect.andThen(
  createOwnerThread,
  startOwnerTurn({ text: "Run Magi on this change." }),
);

/** Delegates a task that keeps running from `parentThreadId`'s active run; returns its thread. */
const delegateActiveTask = (parentThreadId: ThreadId, key: string, title: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs.find((run) => run.status === "running");
    if (parentRun?.rootNodeId == null) return yield* Effect.die("The parent run is not running.");
    const delegated = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`command:magi:${key}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId,
      task: `${stayActiveMarker} Review the change and run Magi on it.`,
      title,
      modelSelection: codexSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const childThreadId = delegated.storedEvents.find(
      (stored) => stored.event.type === "run.created" && stored.event.threadId !== parentThreadId,
    )?.event.threadId;
    if (childThreadId === undefined) return yield* Effect.die("No delegated conversation.");
    yield* awaitEvent(
      childThreadId,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed",
    );
    return childThreadId;
  });

const config = {
  participants: [
    {
      participantId: MagiParticipantId.make("codex-reviewer"),
      modelSelection: codexSelection,
      personalityId: null,
      weight: 1,
    },
    {
      participantId: MagiParticipantId.make("claude-reviewer"),
      modelSelection: claudeSelection,
      personalityId: null,
      weight: 1,
    },
  ],
  consensusThresholdPercent: 100,
  magiTurnLimit: 1,
};

const caller = {
  threadId: ownerThreadId,
  providerInstanceId: codexInstanceId,
  providerSessionId: "provider-session:magi-owner",
};

describe("MagiService on orchestration V2", () => {
  it.live("runs participants as child conversations that read only their own evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider;
        const cwd = yield* checkpointWorkspace("magi-service");
        yield* Effect.gen(function* () {
          yield* startOwnerRun;
          const magi = yield* MagiService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;

          const listed = yield* magi.listContextActivities(caller);
          const evidence = listed.activities.find(
            (activity) => activity.kind === "command_execution",
          );
          expect(evidence).toBeDefined();

          const started = yield* magi.startFromTool(caller, {
            config,
            objective: "Decide whether to adopt the change.",
            contextActivityIds: evidence ? [evidence.activityId] : [],
          });
          expect(started.participants.map((participant) => participant.response.format)).toEqual([
            "structured",
            "structured",
          ]);

          const detail = yield* magi.getRunDetail({
            runId: started.runId,
            includeDiagnostics: false,
          });
          expect(detail.summary.state).toBe("awaiting-arbitration");
          // Each participant's tokens come from the provider turns of its conversation run.
          expect(
            started.participants.map((participant) => [
              participant.inputTokens,
              participant.outputTokens,
            ]),
          ).toEqual([
            [1_200, 300],
            [1_200, 300],
          ]);
          const listing = yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 10 });
          expect(listing.runs[0]?.tokenCount).toBe(3_000);
          const artifactId = detail.magiTurns?.[0]?.activities[0]?.artifactId;
          expect(artifactId).toBeDefined();

          const participantThreads = detail.participants.flatMap((participant) =>
            participant.childThreadId === null ? [] : [participant.childThreadId],
          );
          expect(participantThreads).toHaveLength(2);
          for (const childThreadId of participantThreads) {
            const child = yield* orchestrator.getThreadProjection(childThreadId);
            expect(child.thread.lineage).toMatchObject({
              parentThreadId: ownerThreadId,
              relationshipToParent: "subagent",
            });
          }

          const participantPrompts = (yield* Ref.get(fake.captured)).filter((turn) =>
            participantThreads.includes(turn.threadId),
          );
          expect(participantPrompts).toHaveLength(2);
          for (const prompt of participantPrompts) {
            expect(prompt.text).toContain(artifactId);
            expect(prompt.text).not.toContain(evidenceMarker);
          }

          const artifactIds = artifactId ? [artifactId] : [];
          const [firstParticipant] = participantThreads;
          if (firstParticipant === undefined) return;
          const read = yield* magi.readContextArtifacts(
            { ...caller, threadId: firstParticipant },
            { artifactIds },
          );
          expect(read.artifacts[0]?.result).toMatchObject({ output: evidenceMarker });

          const denied = yield* magi
            .readContextArtifacts(caller, { artifactIds })
            .pipe(Effect.flip);
          expect(denied.reason).toBe("unknown-activity");
        }).pipe(Effect.provide(testLayer(fake, cwd)));
      }),
    ),
  );

  it.live("shows subagent and nested subagent runs in the root conversation's history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider;
        const cwd = yield* checkpointWorkspace("magi-service-descendant");
        yield* Effect.gen(function* () {
          yield* startOwnerRun;
          const magi = yield* MagiService;
          const delegateThreadId = yield* delegateActiveTask(
            ownerThreadId,
            "delegate",
            "Delegated reviewer",
          );
          const nestedThreadId = yield* delegateActiveTask(
            delegateThreadId,
            "nested",
            "Nested reviewer",
          );

          const delegateRun = yield* magi.startFromTool(
            { ...caller, threadId: delegateThreadId },
            { config, objective: "Decide on the delegated review.", contextActivityIds: [] },
          );
          const nestedRun = yield* magi.startFromTool(
            { ...caller, threadId: nestedThreadId },
            { config, objective: "Decide on the nested review.", contextActivityIds: [] },
          );

          const rootListing = yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 10 });
          expect(rootListing.activeRunCount).toBe(2);
          expect(
            rootListing.runs.map((run) => [run.runId, run.rootThreadId, run.ownerTitle]),
          ).toEqual(
            expect.arrayContaining([
              [delegateRun.runId, delegateThreadId, "Delegated reviewer"],
              [nestedRun.runId, nestedThreadId, "Nested reviewer"],
            ]),
          );
          const rootUpdates = yield* magi
            .subscribeThreadRuns({ rootThreadId: ownerThreadId, limit: 10 })
            .pipe(
              Stream.filter((listing) => listing.runs.some((run) => run.runId === nestedRun.runId)),
              Stream.runHead,
            );
          expect(rootUpdates._tag).toBe("Some");
        }).pipe(Effect.provide(testLayer(fake, cwd)));
      }),
    ),
  );

  it.live("rejects Magi starts from participants and their subagents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider;
        const cwd = yield* checkpointWorkspace("magi-service-participant-start");
        yield* Effect.gen(function* () {
          yield* startOwnerRun;
          const magi = yield* MagiService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const started = yield* magi.startFromTool(caller, {
            config,
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          });
          const detail = yield* magi.getRunDetail({
            runId: started.runId,
            includeDiagnostics: false,
          });
          const participantThreadId = detail.participants.find(
            (participant) => participant.participantId === "codex-reviewer",
          )?.childThreadId;
          if (participantThreadId == null) return expect.fail("No participant conversation.");

          // The participant works on in its own conversation and delegates a task of its own.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:magi-participant:continue"),
            threadId: participantThreadId,
            messageId: MessageId.make("message:magi-participant:continue"),
            text: `${stayActiveMarker} Run Magi on your own review.`,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* awaitEvent(
            participantThreadId,
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "command_execution" &&
              event.payload.status === "completed",
          );
          const participantDelegate = yield* delegateActiveTask(
            participantThreadId,
            "participant-delegate",
            "Participant delegate",
          );

          // Provider-native subagents share the participant's credential, so they call as it.
          for (const threadId of [participantThreadId, participantDelegate]) {
            const rejected = yield* magi
              .startFromTool(
                { ...caller, threadId },
                { config, objective: "Start a nested run.", contextActivityIds: [] },
              )
              .pipe(Effect.flip);
            expect(rejected.reason).toBe("recursive-start");
          }
          const rootListing = yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 10 });
          expect(rootListing.runs.map((run) => run.runId)).toEqual([started.runId]);
        }).pipe(Effect.provide(testLayer(fake, cwd)));
      }),
    ),
  );

  it.live("deletes participant conversations and run records with their owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider;
        const cwd = yield* checkpointWorkspace("magi-service-delete");
        yield* Effect.gen(function* () {
          yield* startOwnerRun;
          const magi = yield* MagiService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const started = yield* magi.startFromTool(caller, {
            config,
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          });
          const detail = yield* magi.getRunDetail({
            runId: started.runId,
            includeDiagnostics: false,
          });

          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("command:magi-owner:delete"),
            threadId: ownerThreadId,
          });
          for (const participant of detail.participants) {
            if (participant.childThreadId === null) continue;
            yield* awaitEvent(
              participant.childThreadId,
              (event) => event.type === "thread.deleted",
            );
          }
          // Run records go once every participant conversation is gone.
          const runs = yield* magi
            .subscribeThreadRuns({ rootThreadId: ownerThreadId, limit: 10 })
            .pipe(
              Stream.filter((listing) => listing.runs.length === 0),
              Stream.runHead,
            );
          expect(runs._tag).toBe("Some");
        }).pipe(Effect.provide(testLayer(fake, cwd)));
      }),
    ),
  );
});

const withService = <A, E>(name: string, body: Effect.Effect<A, E, TestServices>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeProvider;
      const cwd = yield* checkpointWorkspace(name);
      return yield* body.pipe(Effect.provide(testLayer(fake, cwd)));
    }),
  );

/** Runs `body` against a fresh service whose owner conversation has an active run. */
const withOwnerRun = <A, E>(name: string, body: Effect.Effect<A, E, TestServices>) =>
  withService(name, Effect.andThen(startOwnerRun, body));

/** Creates a conversation without a run, which can be armed. */
const createIdleThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const idleThreadId = ThreadId.make("thread:magi-idle");
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:magi-idle:create"),
    threadId: idleThreadId,
    projectId,
    title: "Idle conversation",
    modelSelection: codexSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  return idleThreadId;
});

describe("MagiService arms and starts", () => {
  it.live("keeps arm revisions increasing across a disarm and rejects stale changes", () =>
    withOwnerRun(
      "magi-service-arm-revision",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const idleThreadId = yield* createIdleThread;

        const first = yield* magi.armThread({
          threadId: idleThreadId,
          expectedRevision: 0,
          config,
        });
        yield* magi.disarmThread(idleThreadId, first.revision);
        const second = yield* magi.armThread({
          threadId: idleThreadId,
          expectedRevision: 0,
          config,
        });
        expect(second.revision).toBeGreaterThan(first.revision);

        const staleDisarm = yield* magi
          .disarmThread(idleThreadId, first.revision)
          .pipe(Effect.flip);
        expect(staleDisarm.reason).toBe("invalid-protocol-state");
        const staleUpdate = yield* magi
          .armThread({ threadId: idleThreadId, expectedRevision: first.revision, config })
          .pipe(Effect.flip);
        expect(staleUpdate.reason).toBe("invalid-protocol-state");
        expect((yield* magi.getArm(idleThreadId))?.armId).toBe(second.armId);
      }),
    ),
  );

  it.live("attaches an arm only to prompts that the conversation accepts", () =>
    withOwnerRun(
      "magi-service-arm-attachment",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        const threadId = yield* createIdleThread;
        const arm = yield* magi.armThread({ threadId, expectedRevision: 0, config });
        let sends = 0;
        const send = (text: string, sent: Effect.Effect<void, string> = Effect.void) =>
          magi.sendArmedMessage(
            {
              threadId,
              messageId: MessageId.make("message:magi-idle:1"),
              text,
              context: undefined,
              attachments: [],
            },
            (message) =>
              Effect.as(
                Effect.andThen(
                  Effect.sync(() => sends++),
                  sent,
                ),
                message,
              ),
          );
        const pathPrompt = "/src/foo.ts is broken";

        // A native maintenance command goes unchanged and leaves the arm pending.
        expect(yield* send("/compact")).toEqual({ text: "/compact" });
        expect((yield* magi.getArm(threadId))?.armId).toBe(arm.armId);

        // An unreadable message lookup is retryable and keeps the arm pending.
        yield* Ref.set(fake.failMessageReads, true);
        const unknown = yield* send(pathPrompt).pipe(
          Effect.flip,
          Effect.ensuring(Ref.set(fake.failMessageReads, false)),
        );
        expect(unknown).toMatchObject({
          _tag: "MagiValidationError",
          reason: "invalid-protocol-state",
        });
        expect(sends).toBe(1);
        expect((yield* magi.getArm(threadId))?.armId).toBe(arm.armId);

        // A failed or interrupted send of a message that never arrived returns the arm.
        yield* send(pathPrompt, Effect.fail("not delivered")).pipe(Effect.flip);
        expect((yield* magi.getArm(threadId))?.armId).toBe(arm.armId);
        const sending = yield* Deferred.make<void>();
        const interrupted = yield* Effect.forkChild(
          send(pathPrompt, Effect.andThen(Deferred.succeed(sending, undefined), Effect.never)),
        );
        yield* Deferred.await(sending);
        yield* Fiber.interrupt(interrupted);
        expect((yield* magi.getArm(threadId))?.armId).toBe(arm.armId);

        // A path-led prompt is an ordinary prompt and takes the arm.
        const armed = yield* send(pathPrompt);
        expect(
          armed.text.startsWith(`${pathPrompt}

`),
        ).toBe(true);
        expect(armed.context?.records.map((record) => record.kind)).toEqual([
          MAGI_ARM_CONTEXT_KIND,
        ]);
        expect(yield* magi.getArm(threadId)).toBeNull();
      }),
    ),
  );

  it.live("arms only an idle conversation", () =>
    withOwnerRun(
      "magi-service-arm-busy",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const rejected = yield* magi
          .armThread({ threadId: ownerThreadId, expectedRevision: 0, config })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("invalid-protocol-state");
        expect(rejected.message).toContain("idle");
        expect(yield* magi.getArm(ownerThreadId)).toBeNull();
      }),
    ),
  );

  it.live("replays only the run this call started", () =>
    withOwnerRun(
      "magi-service-start-replay",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective: "Decide whether to adopt the change.",
          contextActivityIds: [],
        });

        // A retry from the same session and owner run returns its run, even reworded.
        const retried = yield* magi.startFromTool(caller, {
          objective: "Decide on adopting the change.",
          contextActivityIds: [],
        });
        expect(retried.runId).toBe(started.runId);

        // An arm this conversation never carried is not a retry of that run.
        const foreignArm = yield* magi
          .startFromTool(caller, {
            armId: MagiArmId.make("arm-this-conversation-never-carried"),
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          })
          .pipe(Effect.flip);
        expect(foreignArm.field).toBe("armId");
      }),
    ),
  );

  it.live("rejects a personality that no longer exists before starting", () =>
    withOwnerRun(
      "magi-service-unknown-personality",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const [first, second] = config.participants;
        if (first === undefined || second === undefined) return expect.fail("No roster.");
        const rejected = yield* magi
          .startFromTool(caller, {
            config: {
              ...config,
              participants: [
                { ...first, personalityId: MagiPersonalityId.make("deleted-personality") },
                second,
              ],
            },
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("unknown-personality");
        expect((yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 10 })).runs).toEqual([]);
      }),
    ),
  );

  it.live("derives exclusive decision set ids and rejects a mismatched one", () =>
    withOwnerRun(
      "magi-service-decision-set",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective: `${proposalMarker} Choose a storage engine.`,
          contextActivityIds: [],
        });
        expect(started.pendingProposalIds).toHaveLength(2);
        const record = (decisionSetId?: string) => ({
          candidate: {
            conclusion: "Adopt exactly one storage engine.",
            rationale: ["Both participants agree only one engine applies."],
            recommendedActions: [],
            caveats: [],
          },
          assessments: config.participants.map((participant) => ({
            participantId: participant.participantId,
            stance: "supports" as const,
            evidence: "Recommends adopting one engine.",
            clarificationNeeded: false,
            clarificationQuestion: null,
          })),
          disagreements: [],
          proposalDispositions: [],
          exclusiveDecisionSets: [
            {
              ...(decisionSetId === undefined
                ? {}
                : { decisionSetId: MagiDecisionSetId.make(decisionSetId) }),
              proposalIds: started.pendingProposalIds,
              rationale: "The engines are alternatives.",
            },
          ],
          nextTurnBrief: null,
          authorizedExecutionActions: [],
          requestedOutcome: "continue" as const,
          terminalProposalDigestUpdates: [],
        });
        const expectedId = magiExclusiveDecisionSetFingerprint(
          started.runId,
          started.pendingProposalIds,
        );

        const mismatched = yield* magi
          .recordArbitration(caller, {
            runId: started.runId,
            magiTurn: 1,
            record: record("decision_not-derived"),
          })
          .pipe(Effect.flip);
        expect(mismatched.message).toContain(expectedId);

        const recorded = yield* magi.recordArbitration(caller, {
          runId: started.runId,
          magiTurn: 1,
          record: record(),
        });
        expect(recorded.exclusiveDecisionSetIds).toEqual([expectedId]);
        expect(recorded.candidateChanged).toBe(false);
        const detail = yield* magi.getRunDetail({
          runId: started.runId,
          includeDiagnostics: false,
        });
        expect(
          detail.exclusiveDecisionSets?.map((decisionSet) => decisionSet.decisionSetId),
        ).toEqual([expectedId]);
      }),
    ),
  );
});

const objective = "Decide whether to adopt the change.";
const candidateConclusion = "Ship the change behind a feature flag.";
const withTurnLimit = (magiTurnLimit: number) => ({ ...config, magiTurnLimit });

/** A unanimous arbitration of one candidate, asking for consensus unless overridden. */
const arbitration = (
  overrides: Partial<MagiRecordArbitrationInput["record"]> = {},
): MagiRecordArbitrationInput["record"] => ({
  candidate: {
    conclusion: candidateConclusion,
    rationale: ["Every participant recommends adopting it."],
    recommendedActions: [],
    caveats: [],
  },
  assessments: config.participants.map((participant) => ({
    participantId: participant.participantId,
    stance: "supports",
    evidence: "Recommends adopting the change.",
    clarificationNeeded: false,
    clarificationQuestion: null,
  })),
  disagreements: [],
  proposalDispositions: [],
  exclusiveDecisionSets: [],
  nextTurnBrief: null,
  authorizedExecutionActions: [],
  requestedOutcome: "consensus",
  terminalProposalDigestUpdates: [],
  ...overrides,
});

const applyAction = {
  summary: "Apply the change.",
  relatedProposalIds: [],
  obligation: "required",
} as const;

const runDetail = (runId: MagiRunId) =>
  Effect.flatMap(MagiService, (magi) => magi.getRunDetail({ runId, includeDiagnostics: false }));

/** The run's detail once it is in `state`, including when it already is. */
const awaitRunState = (runId: MagiRunId, state: MagiRunState) =>
  Effect.flatMap(MagiService, (magi) =>
    magi.subscribeRunDetail({ runId, includeDiagnostics: false }).pipe(
      Stream.filter((detail) => detail.summary.state === state),
      Stream.runHead,
      Effect.flatMap((detail) =>
        Option.isSome(detail)
          ? Effect.succeed(detail.value)
          : Effect.die(`Magi run ${runId} never reached ${state}.`),
      ),
    ),
  );

/** The turn `threadId` keeps running, once its evidence is stored. */
const heldTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* awaitEvent(
      threadId,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed",
    );
    const turn = (yield* Ref.get((yield* FakeProvider).heldTurns)).get(threadId);
    if (turn === undefined) return yield* Effect.die(`No held turn on ${threadId}.`);
    return turn;
  });

/** Opens or resolves an approval or user-input request on the owner's running turn. */
const updateOwnerRequest = (kind: "command" | "user_input", status: "pending" | "resolved") =>
  Effect.gen(function* () {
    const turn = yield* heldTurn(ownerThreadId);
    const at = yield* DateTime.now;
    yield* turn.publish([
      {
        type: "runtime_request.updated",
        driver: turn.driver,
        runtimeRequest: {
          id: RuntimeRequestId.make(`runtime-request:magi-owner:${kind}`),
          nodeId: turn.nodeId,
          providerTurnId: turn.providerTurnId,
          nativeRequestRef: null,
          kind,
          status,
          responseCapability: { type: "live", providerSessionId: turn.providerSessionId },
          createdAt: at,
          resolvedAt: status === "resolved" ? at : null,
        },
      },
    ]);
  });

/**
 * Starts a run whose turn-1 participants keep working until the test finishes or stops them.
 * Returns the waiting start call, the run, and each participant's running turn.
 */
const startHeldRun = Effect.gen(function* () {
  const magi = yield* MagiService;
  yield* Ref.set((yield* FakeProvider).respond, () => null);
  const start = yield* magi
    .startFromTool(caller, { config, objective, contextActivityIds: [] })
    .pipe(Effect.forkChild);
  const listing = yield* magi.subscribeThreadRuns({ rootThreadId: ownerThreadId, limit: 10 }).pipe(
    Stream.filter((runs) => runs.runs.length > 0),
    Stream.runHead,
  );
  const runId = Option.getOrUndefined(listing)?.runs[0]?.runId;
  if (runId === undefined) return yield* Effect.die("The Magi run never appeared.");
  const detail = yield* runDetail(runId);
  const participantTurns = yield* Effect.forEach(detail.participants, (participant) =>
    participant.childThreadId === null
      ? Effect.die("No participant conversation.")
      : heldTurn(participant.childThreadId),
  );
  return { start, runId, participantTurns };
});

/** Rewrites a stored run's state, as a server that stopped in that state left it. */
const seedRunState = (
  runId: MagiRunId,
  state: MagiRunState,
  stateBeforePause: MagiRunState | null,
) =>
  Effect.gen(function* () {
    const repository = yield* ProjectionMagiRepository;
    const stored = yield* repository.getRun(runId).pipe(Effect.orDie);
    if (Option.isNone(stored)) return yield* Effect.die("The Magi run was not stored.");
    const run = stored.value;
    yield* repository
      .putRun({
        ...run,
        protocol: { ...(run.protocol as Record<string, unknown>), stateBeforePause },
        detail: {
          ...run.detail,
          summary: { ...run.detail.summary, state },
          activity: { ...run.detail.activity, state },
        },
      })
      .pipe(Effect.orDie);
  }).pipe(Effect.provide(ProjectionMagiRepositoryLive));

/** The run as stored. */
const storedRun = (runId: MagiRunId) =>
  Effect.gen(function* () {
    const stored = yield* (yield* ProjectionMagiRepository).getRun(runId).pipe(Effect.orDie);
    if (Option.isNone(stored)) return yield* Effect.die("The Magi run was not stored.");
    return stored.value;
  }).pipe(Effect.provide(ProjectionMagiRepositoryLive));

/** Runs `body` against a newly started service over the same database, as after a restart. */
const afterRestart = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(Layer.fresh(magiServiceLayer)));

describe("MagiService arbitration transitions", () => {
  it.live("succeeds when the first turn reaches consensus", () =>
    withOwnerRun(
      "magi-service-consensus",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const recorded = yield* magi.recordArbitration(caller, {
          runId: started.runId,
          magiTurn: 1,
          record: arbitration(),
        });
        expect(recorded.transition).toEqual({ state: "consensus-reached" });
        expect(recorded.supportWeight).toBe(2);
        const detail = yield* runDetail(started.runId);
        expect(detail.summary.state).toBe("succeeded");
        expect(detail.summary.completedAt).not.toBeNull();

        const repeated = yield* magi
          .recordArbitration(caller, { runId: started.runId, magiTurn: 1, record: arbitration() })
          .pipe(Effect.flip);
        expect(repeated.reason).toBe("invalid-protocol-state");
      }),
    ),
  );

  it.live("ends at the turn limit when support falls short of the threshold", () =>
    withOwnerRun(
      "magi-service-turn-limit",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const [supporter, opponent] = config.participants;
        if (supporter === undefined || opponent === undefined) return expect.fail("No roster.");
        // Asking for consensus cannot override the server's arithmetic.
        const recorded = yield* magi.recordArbitration(caller, {
          runId: started.runId,
          magiTurn: 1,
          record: arbitration({
            assessments: [
              {
                participantId: supporter.participantId,
                stance: "supports",
                evidence: "Recommends adopting the change.",
                clarificationNeeded: false,
                clarificationQuestion: null,
              },
              {
                participantId: opponent.participantId,
                stance: "opposes",
                evidence: "Rejects the change.",
                clarificationNeeded: false,
                clarificationQuestion: null,
              },
            ],
          }),
        });
        expect(recorded).toMatchObject({ supportWeight: 1, opposingWeight: 1 });
        expect(recorded.transition).toEqual({ state: "turn-limit-reached" });
        const detail = yield* runDetail(started.runId);
        expect(detail.summary.state).toBe("turn-limit-reached");
        expect(detail.summary.completedAt).not.toBeNull();

        const another = yield* magi
          .deliberate(caller, { runId: started.runId, contextActivityIds: [] })
          .pipe(Effect.flip);
        expect(another.reason).toBe("invalid-protocol-state");
      }),
    ),
  );

  it.live("continues into a second Magi turn in the same participant conversations", () =>
    withOwnerRun(
      "magi-service-second-turn",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const started = yield* magi.startFromTool(caller, {
          config: withTurnLimit(2),
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;
        const first = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration({ requestedOutcome: "continue" }),
        });
        expect(first.transition).toEqual({ state: "continue" });
        const awaiting = yield* magi.recoverRunContext(caller, { runId });
        expect(awaiting).toMatchObject({
          state: "awaiting-next-turn",
          nextRequiredTool: "magi_deliberate",
        });

        const second = yield* magi.deliberate(caller, { runId, contextActivityIds: [] });
        expect(second.magiTurn).toBe(2);
        expect(second.candidateFingerprint).not.toBeNull();
        expect(second.candidateFingerprint).toBe(awaiting.candidateFingerprint);
        expect(second.participants.map((participant) => participant.response.format)).toEqual([
          "structured",
          "structured",
        ]);
        const detail = yield* runDetail(runId);
        expect(detail.summary).toMatchObject({
          state: "awaiting-arbitration",
          completedMagiTurns: 2,
        });

        // Turn 2 is a queued message in each participant's own conversation, carrying the
        // arbitrated candidate.
        const captured = yield* Ref.get((yield* FakeProvider).captured);
        for (const participant of detail.participants) {
          const childThreadId = participant.childThreadId;
          if (childThreadId === null) return expect.fail("No participant conversation.");
          const child = yield* orchestrator.getThreadProjection(childThreadId);
          expect(child.runs).toHaveLength(2);
          expect(child.messages.map((message) => message.id)).toContain(
            MessageId.make(`magi:${runId}:2:${participant.participantId}:turn`),
          );
          const prompts = captured.filter((turn) => turn.threadId === childThreadId);
          expect(prompts).toHaveLength(2);
          expect(prompts[0]?.text).not.toContain(candidateConclusion);
          expect(prompts[1]?.text).toContain(candidateConclusion);
        }

        const final = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 2,
          record: arbitration(),
        });
        expect(final.candidateChanged).toBe(false);
        expect(final.transition).toEqual({ state: "consensus-reached" });
        expect((yield* runDetail(runId)).summary.state).toBe("succeeded");
      }),
    ),
  );

  it.live("issues authorized actions and continues once they complete", () =>
    withOwnerRun(
      "magi-service-actions",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config: withTurnLimit(2),
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;
        const recorded = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration({ authorizedExecutionActions: [applyAction] }),
        });
        if (recorded.transition.state !== "actions-required") {
          return expect.fail(`Expected actions-required, got ${recorded.transition.state}.`);
        }
        expect(recorded.transition).toMatchObject({
          actions: [applyAction],
          afterActions: "continue",
        });
        const issued = yield* magi.recoverRunContext(caller, { runId });
        expect(issued).toMatchObject({
          state: "awaiting-actions",
          nextRequiredTool: "magi_record_actions",
        });
        const action = issued.issuedActionBatch?.actions[0];
        if (action === undefined) return expect.fail("No issued action.");

        const outcome = yield* magi.recordActions(caller, {
          runId,
          magiTurn: 1,
          record: {
            batchId: recorded.transition.batchId,
            actions: [
              {
                ...action,
                status: "completed",
                details: "Applied the change.",
                unforeseenConsequence: null,
              },
            ],
          },
        });
        expect(outcome).toEqual({
          runId,
          transition: "continue",
          mandatoryReassessmentActionIds: [],
        });
        const after = yield* magi.recoverRunContext(caller, { runId });
        expect(after).toMatchObject({
          state: "awaiting-next-turn",
          nextRequiredTool: "magi_deliberate",
          issuedActionBatch: null,
        });
        expect(after.recordedActions.map((recordedAction) => recordedAction.status)).toEqual([
          "completed",
        ]);
        // The recorded action changes the candidate the next turn assesses.
        expect(after.candidateFingerprint).not.toBe(issued.candidateFingerprint);
      }),
    ),
  );

  it.live("holds an unknown action outcome for reconciliation before ending at the limit", () =>
    withOwnerRun(
      "magi-service-reconciliation",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;
        const recorded = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration({ authorizedExecutionActions: [applyAction] }),
        });
        if (recorded.transition.state !== "actions-required") {
          return expect.fail(`Expected actions-required, got ${recorded.transition.state}.`);
        }
        expect(recorded.transition.afterActions).toBe("turn-limit-reached");
        const batchId = recorded.transition.batchId;
        const action = (yield* magi.recoverRunContext(caller, { runId })).issuedActionBatch
          ?.actions[0];
        if (action === undefined) return expect.fail("No issued action.");
        const record = (status: "completed" | "unknown") => ({
          batchId,
          actions: [{ ...action, status, details: "Ran the change.", unforeseenConsequence: null }],
        });

        const unknown = yield* magi.recordActions(caller, {
          runId,
          magiTurn: 1,
          record: record("unknown"),
        });
        expect(unknown).toEqual({
          runId,
          transition: "awaiting-action-reconciliation",
          mandatoryReassessmentActionIds: [action.actionId],
        });
        const reconciling = yield* magi.recoverRunContext(caller, { runId });
        expect(reconciling).toMatchObject({
          state: "awaiting-action-reconciliation",
          nextRequiredTool: "magi_record_actions",
        });
        expect(reconciling.issuedActionBatch?.batchId).toBe(batchId);

        const reconciled = yield* magi.recordActions(caller, {
          runId,
          magiTurn: 1,
          record: record("completed"),
        });
        expect(reconciled.transition).toBe("turn-limit-reached");
        const detail = yield* runDetail(runId);
        expect(detail.summary.state).toBe("turn-limit-reached");
        expect(detail.summary.completedAt).not.toBeNull();
      }),
    ),
  );
});

describe("MagiService cancellation and owner pauses", () => {
  it.live("stops an in-flight deliberation and reports the cancellation to its caller", () =>
    withOwnerRun(
      "magi-service-stop",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const { start, runId } = yield* startHeldRun;

        const stopped = yield* magi.controlRun(caller, { runId, action: "stop" });
        expect(stopped).toMatchObject({ state: "cancelled", nextRequiredTool: "none" });
        const result = yield* Fiber.join(start);
        expect(result.runId).toBe(runId);
        expect(result.controlInstructions).toContain("The user cancelled this Magi run.");
        expect(result.thresholdReachable).toBe(false);
        expect(result.participants.map((participant) => participant.state)).toEqual([
          "cancelled",
          "cancelled",
        ]);
        const detail = yield* runDetail(runId);
        expect(detail.summary).toMatchObject({ state: "cancelled", completedMagiTurns: 0 });
        expect(detail.participants.map((participant) => participant.state)).toEqual([
          "cancelled",
          "cancelled",
        ]);

        const retried = yield* magi
          .deliberate(caller, { runId, contextActivityIds: [] })
          .pipe(Effect.flip);
        expect(retried.reason).toBe("invalid-protocol-state");

        // A provider retry of the same start answers with the stopped run, not a new one.
        const restarted = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        expect(restarted.runId).toBe(runId);
        expect(restarted.controlInstructions).toContain("The user cancelled this Magi run.");
        const listing = yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 10 });
        expect(listing.runs.map((run) => run.runId)).toEqual([runId]);
      }),
    ),
  );

  it.live("keeps arming and message dispatch available while turn-1 participants run", () =>
    withOwnerRun(
      "magi-service-start-lock",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const { start, runId } = yield* startHeldRun;

        // Both take the owner's arm lock, which a running start must not hold.
        const sent = yield* magi.sendArmedMessage(
          {
            threadId: ownerThreadId,
            messageId: MessageId.make("message:magi-owner:follow-up"),
            text: "Also check the tests.",
            context: undefined,
            attachments: [],
          },
          Effect.succeed,
        );
        expect(sent).toEqual({ text: "Also check the tests." });
        const armed = yield* magi
          .armThread({ threadId: ownerThreadId, expectedRevision: 0, config })
          .pipe(Effect.flip);
        expect(armed.reason).toBe("magi-run-active");
        expect((yield* runDetail(runId)).summary.state).toBe("deliberating");

        yield* magi.cancelRun(runId);
        yield* Fiber.join(start);
      }),
    ),
  );

  it.live("claims turn 1 under an owner approval raised before the claim", () =>
    withService(
      "magi-service-turn-one-pause",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        yield* createOwnerThread;
        const arm = yield* magi.armThread({ threadId: ownerThreadId, expectedRevision: 0, config });
        yield* magi.sendArmedMessage(
          {
            threadId: ownerThreadId,
            messageId: MessageId.make("message:magi-owner:start"),
            text: "Run Magi on this change.",
            context: undefined,
            attachments: [],
          },
          startOwnerTurn,
        );
        const gate: StartGate = {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        yield* Ref.set(fake.panelMemoryGate, Option.some(gate));
        const start = yield* magi
          .startFromTool(caller, { armId: arm.armId, objective, contextActivityIds: [] })
          .pipe(Effect.forkChild);

        // The run exists as deliberating, and turn 1 is not claimed yet.
        yield* Deferred.await(gate.reached);
        const runId = (yield* magi.listRuns({ rootThreadId: ownerThreadId, limit: 1 })).runs[0]
          ?.runId;
        if (runId === undefined) return yield* Effect.die("The Magi run was not created.");
        yield* updateOwnerRequest("command", "pending");
        yield* awaitRunState(runId, "awaiting-main-approval");
        yield* Deferred.succeed(gate.release, undefined);

        const result = yield* Fiber.join(start);
        expect(result.participants.map((participant) => participant.response.format)).toEqual([
          "structured",
          "structured",
        ]);
        expect((yield* runDetail(runId)).summary).toMatchObject({
          state: "awaiting-main-approval",
          completedMagiTurns: 1,
        });
        yield* updateOwnerRequest("command", "resolved");
        yield* awaitRunState(runId, "awaiting-arbitration");
      }),
    ),
  );

  it.live("pauses for the owner's approval and resumes the recorded state", () =>
    withOwnerRun(
      "magi-service-owner-approval",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;

        yield* updateOwnerRequest("command", "pending");
        yield* awaitRunState(runId, "awaiting-main-approval");
        const blocked = yield* magi
          .recordArbitration(caller, { runId, magiTurn: 1, record: arbitration() })
          .pipe(Effect.flip);
        expect(blocked.reason).toBe("invalid-protocol-state");

        yield* updateOwnerRequest("command", "resolved");
        yield* awaitRunState(runId, "awaiting-arbitration");
        const recorded = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration(),
        });
        expect(recorded.transition).toEqual({ state: "consensus-reached" });
      }),
    ),
  );

  it.live("holds an owner pause raised mid-deliberation until the participants settle", () =>
    withOwnerRun(
      "magi-service-owner-input",
      Effect.gen(function* () {
        const { start, runId, participantTurns } = yield* startHeldRun;

        yield* updateOwnerRequest("user_input", "pending");
        yield* awaitRunState(runId, "awaiting-main-input");
        yield* Effect.forEach(participantTurns, (turn) => turn.finish(participantResponse), {
          discard: true,
        });
        const result = yield* Fiber.join(start);
        expect(result.participants.map((participant) => participant.response.format)).toEqual([
          "structured",
          "structured",
        ]);
        // The turn is recorded, but the pause holds until the owner's request is answered.
        expect((yield* runDetail(runId)).summary).toMatchObject({
          state: "awaiting-main-input",
          completedMagiTurns: 1,
        });

        yield* updateOwnerRequest("user_input", "resolved");
        yield* awaitRunState(runId, "awaiting-arbitration");
      }),
    ),
  );
});

/**
 * Starts a run and ends its owner's turn while the run is paused, so this server leaves the run
 * alone, then waits until that ending was handled.
 */
const endOwnerTurnWhilePaused = (
  end: (turn: HeldTurn) => Effect.Effect<void>,
  status: "completed" | "interrupted",
) =>
  Effect.gen(function* () {
    const magi = yield* MagiService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { runId } = yield* magi.startFromTool(caller, {
      config,
      objective,
      contextActivityIds: [],
    });
    const ownerRunId = (yield* storedRun(runId)).mainRunId;
    if (ownerRunId === null) return yield* Effect.die("The run has no driving owner run.");

    yield* seedRunState(runId, "paused", "awaiting-arbitration");
    yield* end(yield* heldTurn(ownerThreadId));
    yield* awaitEvent(
      ownerThreadId,
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === ownerRunId &&
        event.payload.status === status,
    );
    // Lifecycle events are handled in order: once the owner's archive and unarchive reach a
    // participant, the ending before them was handled.
    const participantThreadId = (yield* runDetail(runId)).participants[0]?.childThreadId;
    if (participantThreadId == null) return yield* Effect.die("No participant conversation.");
    for (const [type, cascaded] of [
      ["thread.archive", "thread.archived"],
      ["thread.unarchive", "thread.unarchived"],
    ] as const) {
      yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`command:magi-owner:${type}`),
        threadId: ownerThreadId,
      });
      yield* awaitEvent(participantThreadId, (event) => event.type === cascaded);
    }
    return { runId, ownerRunId };
  });

describe("MagiService restart recovery", () => {
  it.live("resumes a paused run and fails a deliberation that a restart interrupted", () =>
    withOwnerRun(
      "magi-service-recovery",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;

        yield* seedRunState(runId, "awaiting-main-input", "awaiting-arbitration");
        yield* afterRestart(
          Effect.gen(function* () {
            const restarted = yield* MagiService;
            const recovered = yield* restarted.recoverRunContext(caller, { runId });
            expect(recovered).toMatchObject({
              state: "paused",
              nextRequiredTool: "magi_control_run",
            });
            const resumed = yield* restarted.controlRun(caller, { runId, action: "resume" });
            expect(resumed).toMatchObject({
              state: "awaiting-arbitration",
              nextRequiredTool: "magi_recover_turn_result",
            });
          }),
        );

        yield* seedRunState(runId, "deliberating", null);
        yield* afterRestart(
          Effect.gen(function* () {
            const recovered = yield* runDetail(runId);
            expect(recovered.summary.state).toBe("failed");
            expect(recovered.summary.completedAt).not.toBeNull();
          }),
        );
      }),
    ),
  );

  it.live("continues a protocol whose owner turn completed while the server was down", () =>
    withOwnerRun(
      "magi-service-recovery-owner-completed",
      Effect.gen(function* () {
        const { runId, ownerRunId } = yield* endOwnerTurnWhilePaused(
          (turn) => turn.finish("Done for now."),
          "completed",
        );

        // As a server that stopped before it saw the completion left the run.
        yield* seedRunState(runId, "awaiting-arbitration", null);
        yield* afterRestart(
          Effect.gen(function* () {
            const recovered = yield* storedRun(runId);
            expect(recovered.detail.summary.state).toBe("awaiting-arbitration");
            expect(recovered.mainRunId).not.toBeNull();
            expect(recovered.mainRunId).not.toBe(ownerRunId);
            expect(recovered.protocol).toMatchObject({
              controlContinuationRunId: recovered.mainRunId,
            });
          }),
        );
      }),
    ),
  );

  it.live("pauses a protocol whose owner turn was interrupted while the server was down", () =>
    withOwnerRun(
      "magi-service-recovery-owner-interrupted",
      Effect.gen(function* () {
        const { runId, ownerRunId } = yield* endOwnerTurnWhilePaused(
          (turn) => turn.interrupt,
          "interrupted",
        );

        // As a server that stopped before it saw the interruption left the run.
        yield* seedRunState(runId, "awaiting-arbitration", null);
        yield* afterRestart(
          Effect.gen(function* () {
            const recovered = yield* storedRun(runId);
            expect(recovered.detail.summary.state).toBe("paused");
            expect(recovered.mainRunId).toBe(ownerRunId);
            expect(recovered.protocol).toMatchObject({ stateBeforePause: "awaiting-arbitration" });
          }),
        );
      }),
    ),
  );
});

describe("MagiService decision sets", () => {
  it.live("rejects an exclusive decision set that overlaps another set", () =>
    withOwnerRun(
      "magi-service-overlapping-sets",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        yield* Ref.set(fake.respond, () => engineProposalsReply(["SQLite", "PostgreSQL", "MySQL"]));
        const started = yield* magi.startFromTool(caller, {
          config: withTurnLimit(2),
          objective,
          contextActivityIds: [],
        });
        const runId = started.runId;
        const [first, second, third] = started.pendingProposalIds;
        if (first === undefined || second === undefined || third === undefined) {
          return expect.fail("Expected three proposals.");
        }
        const sets = (...groups: ReadonlyArray<ReadonlyArray<typeof first>>) =>
          groups.map((proposalIds) => ({
            proposalIds: [...proposalIds],
            rationale: "The engines are alternatives.",
          }));

        const sameRecord = yield* magi
          .recordArbitration(caller, {
            runId,
            magiTurn: 1,
            record: arbitration({
              requestedOutcome: "continue",
              exclusiveDecisionSets: sets([first, second], [second, third]),
            }),
          })
          .pipe(Effect.flip);
        expect(sameRecord.message).toContain("a proposal can belong to only one declared set");

        yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration({
            requestedOutcome: "continue",
            exclusiveDecisionSets: sets([first, second]),
          }),
        });
        yield* Ref.set(fake.respond, () => participantResponse);
        yield* magi.deliberate(caller, { runId, contextActivityIds: [] });

        const overlapping = yield* magi
          .recordArbitration(caller, {
            runId,
            magiTurn: 2,
            record: arbitration({
              requestedOutcome: "continue",
              exclusiveDecisionSets: sets([second, third]),
            }),
          })
          .pipe(Effect.flip);
        expect(overlapping.message).toContain("already belongs to another exclusive decision set");

        // Repeating the known set is allowed.
        const repeated = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 2,
          record: arbitration({
            requestedOutcome: "continue",
            exclusiveDecisionSets: sets([first, second]),
          }),
        });
        expect(repeated.exclusiveDecisionSetIds).toEqual([
          magiExclusiveDecisionSetFingerprint(runId, [first, second]),
        ]);
      }),
    ),
  );

  it.live("drops digest entries of accepted proposals that a decision set reopens", () =>
    withOwnerRun(
      "magi-service-reopened-digest",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        const started = yield* magi.startFromTool(caller, {
          config: withTurnLimit(5),
          objective: `${proposalMarker} Choose a storage engine.`,
          contextActivityIds: [],
        });
        const runId = started.runId;
        const proposalIds = started.pendingProposalIds;
        expect(proposalIds).toHaveLength(2);
        const terminalPage = magi.getTerminalProposals(caller, {
          runId,
          scope: "all-terminal",
          offset: 0,
          limit: 10,
          includePersistedDigest: true,
        });

        yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 1,
          record: arbitration({ requestedOutcome: "continue" }),
        });
        // Turn 2: the whole panel approves both proposals.
        yield* Ref.set(fake.respond, () =>
          participantReply({
            ballot: "approve",
            proposalEvaluations: proposalIds.map((proposalId) => ({
              proposalId,
              ballot: "approve",
              rationale: "Either engine fits.",
            })),
          }),
        );
        yield* magi.deliberate(caller, { runId, contextActivityIds: [] });
        const accepted = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 2,
          record: arbitration({
            requestedOutcome: "continue",
            proposalDispositions: proposalIds.map((proposalId) => ({
              proposalId,
              disposition: "apply",
              rationale: "Incorporated into the candidate.",
            })),
            terminalProposalDigestUpdates: proposalIds.map((proposalId, index) => ({
              proposalId,
              summary: `Accepted engine ${index + 1}.`,
            })),
          }),
        });
        expect([...accepted.acceptedProposalIds].toSorted()).toEqual([...proposalIds].toSorted());
        expect((yield* terminalPage).persistedDigest).toHaveLength(2);

        // Turn 3: declaring the accepted pair exclusive reopens both proposals.
        yield* Ref.set(fake.respond, () => participantResponse);
        yield* magi.deliberate(caller, { runId, contextActivityIds: [] });
        const reopened = yield* magi.recordArbitration(caller, {
          runId,
          magiTurn: 3,
          record: arbitration({
            requestedOutcome: "continue",
            exclusiveDecisionSets: [
              { proposalIds: [...proposalIds], rationale: "Only one engine can ship." },
            ],
          }),
        });
        expect([...reopened.pendingProposalIds].toSorted()).toEqual([...proposalIds].toSorted());
        expect(yield* terminalPage).toMatchObject({
          terminalProposalCount: 0,
          persistedDigest: [],
        });
      }),
    ),
  );
});

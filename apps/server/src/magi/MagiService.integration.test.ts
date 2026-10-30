import * as MagiParticipantPolicy from "./MagiParticipantPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MagiDecisionSetId,
  MagiParticipantId,
  type MagiParticipantResponse,
  type MagiRecordArbitrationInput,
  type MagiRunId,
  type MagiRunState,
  type RunId,
  type MagiStartResult,
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
import { OrchestrationEffectWorkerV2 } from "../orchestration-v2/EffectWorker.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
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
import { ProjectionMagiRepository, type PersistedMagiRun } from "../persistence/ProjectionMagi.ts";
import { layer as layerProviderRegistry } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { MagiToolkitHandlersLive } from "../mcp/toolkits/magi/handlers.ts";
import { MagiToolkit } from "../mcp/toolkits/magi/tools.ts";
import { makeMagiService, MagiService } from "./MagiService.ts";

// Existing protocol tests await persisted completion; agent-facing calls return receipts.
const completedMagiService = Effect.map(MagiService, (magi) => {
  const result = (caller: Parameters<typeof magi.getTurnResult>[0], receipt: MagiStartResult) =>
    watchStoredRuns(receipt.runId).pipe(
      Stream.filter(
        ({ detail }) =>
          detail.summary.completedMagiTurns >= receipt.magiTurn ||
          detail.summary.completedAt !== null,
      ),
      Stream.runHead,
      Effect.flatMap(() => magi.getTurnResult(caller, receipt)),
    );
  return {
    ...magi,
    startFromTool: (
      caller: Parameters<typeof magi.startFromTool>[0],
      input: Parameters<typeof magi.startFromTool>[1],
    ) =>
      magi.startFromTool(caller, input).pipe(Effect.flatMap((receipt) => result(caller, receipt))),
    deliberate: (
      caller: Parameters<typeof magi.deliberate>[0],
      input: Parameters<typeof magi.deliberate>[1],
    ) => magi.deliberate(caller, input).pipe(Effect.flatMap((receipt) => result(caller, receipt))),
  };
});

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
  readonly persisted: PubSub.PubSub<PersistedMagiRun>;
  readonly deleted: Deferred.Deferred<void>;
}

class FakeProvider extends Context.Service<FakeProvider, FakeProviderShape>()(
  "t3/magi/MagiService.integration.test/FakeProvider",
) {}

const makeFakeProvider: Effect.Effect<FakeProviderShape> = Effect.all({
  captured: Ref.make<ReadonlyArray<CapturedTurn>>([]),
  respond: Ref.make<ParticipantResponder>(defaultResponder),
  heldTurns: Ref.make<ReadonlyMap<ThreadId, HeldTurn>>(new Map()),
  failMessageReads: Ref.make(false),
  persisted: PubSub.unbounded<PersistedMagiRun>(),
  deleted: Deferred.make<void>(),
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

const observedRepositoryLayer = Layer.effect(
  ProjectionMagiRepository,
  Effect.gen(function* () {
    const repository = yield* ProjectionMagiRepository;
    const fake = yield* FakeProvider;
    return {
      ...repository,
      deleteByOwnerThreadId: (owner: ThreadId) =>
        repository
          .deleteByOwnerThreadId(owner)
          .pipe(Effect.tap(() => Deferred.succeed(fake.deleted, undefined))),
      putRun: (run: PersistedMagiRun) =>
        repository.putRun(run).pipe(Effect.tap(() => PubSub.publish(fake.persisted, run))),
    };
  }),
).pipe(Layer.provide(ProjectionMagiRepositoryLive));

const magiServiceLayer = Layer.effect(MagiService, makeMagiService).pipe(
  Layer.provide([observedRepositoryLayer, MagiParticipantPolicy.layer]),
);

const watchStoredRuns = (runId?: MagiRunId) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fake = yield* FakeProvider;
      const subscription = yield* PubSub.subscribe(fake.persisted);
      const initial = yield* Effect.flatMap(ProjectionMagiRepository, (repository) =>
        runId === undefined
          ? repository.listRunsByOwner(ownerThreadId)
          : repository
              .getRun(runId)
              .pipe(Effect.map((run) => (Option.isSome(run) ? [run.value] : []))),
      ).pipe(Effect.provide(ProjectionMagiRepositoryLive), Effect.orDie);
      return Stream.concat(Stream.fromArray(initial), Stream.fromSubscription(subscription)).pipe(
        Stream.filter((run) => runId === undefined || run.detail.summary.runId === runId),
      );
    }),
  ).pipe(Stream.scoped, Stream.orDie);

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
    Layer.provideMerge(ProjectionMagiRepositoryLive),
    Layer.provideMerge(Layer.mergeAll(orchestratorLayer, threadsLayer)),
    Layer.provideMerge(ProjectStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
    Layer.provideMerge(CommandReceiptStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(
      layerProviderRegistry([
        providerSnapshot(codexInstanceId, codexSelection.model),
        providerSnapshot(claudeInstanceId, claudeSelection.model),
      ]),
    ),
    Layer.provideMerge(ServerSettings.layerTest().pipe(Layer.orDie)),
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
      weight: 1,
    },
    {
      participantId: MagiParticipantId.make("claude-reviewer"),
      modelSelection: claudeSelection,
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
          const magi = yield* completedMagiService;
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

          const detail = yield* runDetail(started.runId);
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

  it.live("keeps nested Magi runs and participants with their owning subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider;
        const cwd = yield* checkpointWorkspace("magi-service-descendant");
        yield* Effect.gen(function* () {
          yield* startOwnerRun;
          const magi = yield* completedMagiService;
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

          const repository = yield* ProjectionMagiRepository;
          expect(yield* repository.listRunsByOwner(ownerThreadId)).toEqual([]);
          expect(
            (yield* repository.listRunsByOwner(delegateThreadId)).map(
              (run) => run.detail.summary.runId,
            ),
          ).toEqual([delegateRun.runId]);
          expect(
            (yield* repository.listRunsByOwner(nestedThreadId)).map(
              (run) => run.detail.summary.runId,
            ),
          ).toEqual([nestedRun.runId]);
          const root = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
            ownerThreadId,
          );
          expect(
            root.subagents.flatMap((agent) =>
              agent.childThreadId === null ? [] : [agent.childThreadId],
            ),
          ).toEqual([delegateThreadId]);
          for (const [runId, ownerId] of [
            [delegateRun.runId, delegateThreadId],
            [nestedRun.runId, nestedThreadId],
          ] as const) {
            const detail = yield* runDetail(runId);
            for (const participant of detail.participants) {
              const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
                participant.childThreadId!,
              );
              expect(child.thread.lineage).toMatchObject({
                parentThreadId: ownerId,
                relationshipToParent: "subagent",
              });
              expect(
                root.subagents.some((agent) => agent.childThreadId === participant.childThreadId),
              ).toBe(false);
            }
          }
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
          const magi = yield* completedMagiService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const started = yield* magi.startFromTool(caller, {
            config,
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          });
          const detail = yield* runDetail(started.runId);
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
          expect(
            (yield* (yield* ProjectionMagiRepository).listRunsByOwner(ownerThreadId)).map(
              (run) => run.detail.summary.runId,
            ),
          ).toEqual([started.runId]);
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
          const magi = yield* completedMagiService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const started = yield* magi.startFromTool(caller, {
            config,
            objective: "Decide whether to adopt the change.",
            contextActivityIds: [],
          });
          const detail = yield* runDetail(started.runId);

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
          yield* Deferred.await((yield* FakeProvider).deleted);
          expect(yield* (yield* ProjectionMagiRepository).listRunsByOwner(ownerThreadId)).toEqual(
            [],
          );
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

describe("MagiService starts", () => {
  it.live("rejects omitted configuration before persistence or participant dispatch", () =>
    withOwnerRun(
      "magi-required-configuration",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        const before = yield* Ref.get(fake.captured);
        const missingFields = ["participants", "consensusThresholdPercent", "magiTurnLimit"];
        const malformed = [
          { objective: "is X really Y?", contextActivityIds: [] },
          {
            objective,
            contextActivityIds: [],
            config: {
              ...config,
              participants: config.participants.map((entry) => ({
                ...entry,
                personalityId: "old",
              })),
            },
          },
          ...missingFields.map((field) => ({
            config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== field)),
            objective: "is X really Y?",
            contextActivityIds: [],
          })),
        ];
        for (const input of malformed) {
          const error = yield* magi
            .startFromTool(caller, input as unknown as Parameters<typeof magi.startFromTool>[1])
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "invalid-config", field: "config" });
          expect(error.message).toContain("Ask the user");
        }
        expect(yield* (yield* ProjectionMagiRepository).listRunsByOwner(ownerThreadId)).toEqual([]);
        expect(yield* Ref.get(fake.captured)).toEqual(before);
      }),
    ),
  );

  it.live("deliberates with twelve explicitly configured ordinary subagents", () =>
    withOwnerRun(
      "magi-large-roster",
      Effect.gen(function* () {
        const magi = yield* completedMagiService;
        const participants = Array.from({ length: 12 }, (_, index) => ({
          modelSelection: config.participants[index % 2]!.modelSelection,
          participantId: MagiParticipantId.make(`seat-${index}`),
        }));
        const result = yield* magi.startFromTool(caller, {
          config: { participants, consensusThresholdPercent: 75, magiTurnLimit: 2 },
          objective: "Evaluate with the user's twelve-person roster.",
          contextActivityIds: [],
        });
        expect(result.participants).toHaveLength(12);
        expect(result.totalWeight).toBe(12);
        expect(result.requiredWeight).toBe(9);
        const owner = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          ownerThreadId,
        );
        const stored = yield* runDetail(result.runId);
        expect(stored.config.participants.every((participant) => participant.weight === 1)).toBe(
          true,
        );
        const children = stored.participants.map((participant) => participant.childThreadId);
        expect(
          owner.subagents.filter((agent) => children.includes(agent.childThreadId)),
        ).toHaveLength(12);
      }),
    ),
  );

  it.live("replays only the run this call started", () =>
    withOwnerRun(
      "magi-service-start-replay",
      Effect.gen(function* () {
        const magi = yield* completedMagiService;
        const started = yield* magi.startFromTool(caller, {
          config,
          objective: "Decide whether to adopt the change.",
          contextActivityIds: [],
        });

        // A retry from the same session and owner run returns its run, even reworded.
        const retried = yield* magi.startFromTool(caller, {
          config,
          objective: "Decide on adopting the change.",
          contextActivityIds: [],
        });
        expect(retried.runId).toBe(started.runId);
      }),
    ),
  );

  it.live(
    "rejects the whole roster before persistence or dispatch when its project disables a provider",
    () =>
      withOwnerRun(
        "magi-service-project-disabled",
        Effect.gen(function* () {
          const magi = yield* MagiService;
          const fake = yield* FakeProvider;
          const capturedBefore = yield* Ref.get(fake.captured);
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [claudeInstanceId]: { enabled: false } } },
            },
          });
          const rejected = yield* magi
            .startFromTool(caller, {
              config,
              objective: "Review with the mixed roster.",
              contextActivityIds: [],
            })
            .pipe(Effect.flip);
          expect(rejected.reason).toBe("unavailable-model");
          expect(rejected.message).toContain("disabled for this project");
          expect(yield* (yield* ProjectionMagiRepository).listRunsByOwner(ownerThreadId)).toEqual(
            [],
          );
          expect(yield* Ref.get(fake.captured)).toEqual(capturedBefore);
          const children =
            yield* (yield* ThreadManagementService.ThreadManagementService).listProjectThreads({
              projectId,
              includeSubagents: true,
            });
          expect(children.map((thread) => thread.id)).toEqual([ownerThreadId]);
        }),
      ),
  );

  it.live(
    "scopes catalogue and MCP discovery to the caller project without requiring an active run",
    () =>
      withService(
        "magi-project-catalogue",
        Effect.gen(function* () {
          yield* createOwnerThread;
          const magi = yield* MagiService;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({
            providerInstances: {
              [codexInstanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: {
                  [codexInstanceId]: { enabled: true },
                  [claudeInstanceId]: { enabled: false },
                },
              },
            },
          });
          const scoped = yield* magi.getOptions(projectId);
          expect(scoped.providerInstances).toMatchObject([
            { instanceId: codexInstanceId, available: true, unavailableReason: null },
            {
              instanceId: claudeInstanceId,
              available: false,
              unavailableReason: "Provider instance is disabled for this project.",
            },
          ]);
          expect(
            (yield* magi.getOptions(null)).providerInstances.every(
              (provider) => provider.available,
            ),
          ).toBe(true);
          expect(
            (yield* magi.getOptions(ProjectId.make("other-project"))).providerInstances[0]
              ?.available,
          ).toBe(false);
          const toolkit = yield* MagiToolkit.pipe(
            Effect.provide(McpToolAccess.HandlersLayer.layer(MagiToolkitHandlersLive)),
          );
          const results = yield* toolkit
            .handle("magi_get_options", {})
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(results.at(-1)).toMatchObject({ isFailure: false, result: scoped });
          const missingCaller = yield* magi
            .getOptionsForCaller({ threadId: ThreadId.make("missing-caller") })
            .pipe(Effect.flip);
          expect(missingCaller.reason).toBe("invalid-protocol-state");
          expect(yield* Ref.get((yield* FakeProvider).captured)).toEqual([]);
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("magi-test"),
            requestNamespace: "magi-test-catalogue",
            thread: caller,
            client: undefined,
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
        ),
      ),
  );

  it.live("derives exclusive decision set ids and rejects a mismatched one", () =>
    withOwnerRun(
      "magi-service-decision-set",
      Effect.gen(function* () {
        const magi = yield* completedMagiService;
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
        const detail = yield* runDetail(started.runId);
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
  storedRun(runId).pipe(
    Effect.map((run) => ({
      ...run.detail,
      exclusiveDecisionSets: (
        run.protocol as {
          decisionSets: ReadonlyArray<import("@t3tools/contracts").MagiKnownDecisionSet>;
        }
      ).decisionSets,
      magiTurns: (
        run.protocol as {
          turns: ReadonlyArray<{
            activities: ReadonlyArray<{
              artifactId: import("@t3tools/contracts").ContextArtifactId;
            }>;
          }>;
        }
      ).turns,
    })),
  );

/** The run's detail once it is in `state`, including when it already is. */
const awaitRunState = (runId: MagiRunId, state: MagiRunState) =>
  watchStoredRuns(runId).pipe(
    Stream.map((run) => run.detail),
    Stream.filter((detail) => detail.summary.state === state),
    Stream.runHead,
    Effect.flatMap((detail) =>
      Option.isSome(detail)
        ? Effect.succeed(detail.value)
        : Effect.die(`Magi run ${runId} never reached ${state}.`),
    ),
  );

/** The turn `threadId` keeps running, once its evidence is stored. */
const heldTurn = (threadId: ThreadId, runOrdinal?: number) =>
  Effect.gen(function* () {
    yield* awaitEvent(
      threadId,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed" &&
        (runOrdinal === undefined ||
          event.payload.providerTurnId === `provider-turn:${threadId}:${runOrdinal}`),
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
  yield* Ref.set((yield* FakeProvider).respond, () => null);
  const service = yield* MagiService;
  const receipt = yield* service.startFromTool(caller, {
    config,
    objective,
    contextActivityIds: [],
  });
  const runId = receipt.runId;
  const start = yield* watchStoredRuns(runId).pipe(
    Stream.filter(
      (run) =>
        run.detail.summary.completedMagiTurns >= receipt.magiTurn ||
        run.detail.summary.completedAt !== null,
    ),
    Stream.runHead,
    Effect.flatMap(() => service.getTurnResult(caller, receipt)),
    Effect.forkChild,
  );
  const detail = yield* runDetail(runId);
  const participantTurns = yield* Effect.forEach(detail.participants, (participant) =>
    participant.childThreadId === null
      ? Effect.die("No participant conversation.")
      : heldTurn(participant.childThreadId),
  );
  return { start, runId, participantTurns };
});

describe("MagiService passive delivery", () => {
  it.live.each([false, true])("keeps a settled owner paused after Stop with force=%s", (force) =>
    withOwnerRun(
      "magi-idle-owner-stop",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* Ref.set((yield* FakeProvider).respond, () => null);
        const { runId } = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const ownerRunId = (yield* storedRun(runId)).mainRunId;
        yield* (yield* heldTurn(ownerThreadId)).finish("Waiting for Magi.");
        yield* awaitEvent(
          ownerThreadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === ownerRunId &&
            event.payload.status === "completed",
        );
        yield* threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("magi:stop-idle-owner"),
          threadId: ownerThreadId,
        });
        yield* awaitRunState(runId, "paused");
        yield* awaitEvent(
          ownerThreadId,
          (event) =>
            event.type === "thread.metadata-updated" && event.payload.pendingMagiRunId === null,
        );
        expect(
          (yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId,
        ).toBeNull();
        if (force) {
          yield* threads.forceStopThread({ threadId: ownerThreadId, runId: ownerRunId! });
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          const records = yield* threads.getThreadRecords(ownerThreadId, ["runs"]);
          expect(records.thread.pendingMagiRunId).toBeNull();
          expect(records.runs.find((run) => run.id === ownerRunId)?.status).toBe("completed");
          expect((yield* runDetail(runId)).summary.state).toBe("paused");
        }
      }),
    ),
  );

  it.live(
    "keeps a withdrawn completion cancelled when the owner run and a later user turn complete while paused",
    () =>
      withOwnerRun(
        "magi-paused-unattended-queue",
        Effect.gen(function* () {
          const magi = yield* MagiService;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const receipt = yield* magi.startFromTool(caller, {
            config,
            objective,
            contextActivityIds: [],
          });
          yield* watchStoredRuns(receipt.runId).pipe(
            Stream.filter((run) => run.detail.summary.completedMagiTurns === 1),
            Stream.runHead,
          );
          yield* magi.controlRun(caller, { runId: receipt.runId, action: "pause" });
          const owner = yield* heldTurn(ownerThreadId);
          const ownerRunId = (yield* storedRun(receipt.runId)).mainRunId;
          yield* owner.finish("Paused while waiting for the user.");
          yield* awaitEvent(
            ownerThreadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === ownerRunId &&
              event.payload.status === "completed",
          );
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          const messageId = MessageId.make("magi:paused:user-follow-up");
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("magi:paused:user-follow-up"),
            threadId: ownerThreadId,
            messageId,
            text: "Keep Magi paused while answering this unrelated question.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const following = (yield* threads.getThreadRecords(ownerThreadId, ["runs"])).runs.find(
            (run) => run.userMessageId === messageId,
          )!;
          yield* (yield* heldTurn(ownerThreadId, following.ordinal)).finish("Unrelated answer.");
          yield* awaitEvent(
            ownerThreadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === following.id &&
              event.payload.status === "completed",
          );
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          const records = yield* threads.getThreadRecords(ownerThreadId, ["runs", "messages"]);
          const wake = records.messages.find(
            (message) => message.id === `magi:${receipt.runId}:1:completion`,
          )!;
          expect(records.runs.find((run) => run.id === wake.runId)?.status).toBe("cancelled");
          expect(records.runs.find((run) => run.id === following.id)?.status).toBe("completed");
          expect(records.thread.pendingMagiRunId).toBeNull();
          expect((yield* runDetail(receipt.runId)).summary.state).toBe("paused");
          expect(records.runs.filter((run) => run.status === "queued")).toEqual([]);
        }),
      ),
  );

  it.live(
    "clears a completed run's waiting marker after a crash between persistence and projection",
    () =>
      withOwnerRun(
        "magi-waiting-recovery",
        Effect.gen(function* () {
          const magi = yield* completedMagiService;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const { runId } = yield* magi.startFromTool(caller, {
            config,
            objective,
            contextActivityIds: [],
          });
          yield* magi.controlRun(caller, { runId, action: "stop" });
          yield* threads.dispatch({
            type: "thread.magi-work.set",
            commandId: CommandId.make("magi:seed-stale-wait"),
            threadId: ownerThreadId,
            pendingMagiRunId: runId,
          });
          yield* afterRestart(
            Effect.gen(function* () {
              const restartedThreads = yield* ThreadManagementService.ThreadManagementService;
              expect(
                (yield* restartedThreads.getThreadRecords(ownerThreadId, [])).thread
                  .pendingMagiRunId,
              ).toBeNull();
            }),
          );
        }),
      ),
  );

  it.live("wakes the owner with a failure when a restart interrupts passive deliberation", () =>
    withOwnerRun(
      "magi-passive-restart-failure",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        yield* Ref.set(fake.respond, () => null);
        const receipt = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const detail = yield* runDetail(receipt.runId);
        yield* Effect.forEach(detail.participants, (participant) =>
          heldTurn(participant.childThreadId!),
        );
        yield* afterRestart(
          Effect.gen(function* () {
            const restarted = yield* MagiService;
            const threads = yield* ThreadManagementService.ThreadManagementService;
            expect((yield* runDetail(receipt.runId)).summary.state).toBe("failed");
            const messages = yield* threads.getThreadRecords(ownerThreadId, ["messages"]);
            const notification = messages.messages.find(
              (message) => message.id === `magi:${receipt.runId}:1:completion`,
            )!;
            expect(notification.text).toContain("failed during panel turn 1");
            const result = yield* restarted.getTurnResult(caller, receipt);
            expect(result.participants).toEqual([]);
            expect(result.thresholdReachable).toBe(false);
          }),
        );
      }),
    ),
  );

  it.live("keeps a delegated Magi owner pending until its final arbitration answer", () =>
    withOwnerRun(
      "magi-passive-delegated-owner",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const childThreadId = yield* delegateActiveTask(ownerThreadId, "passive-owner", "Reviewer");
        const childCaller = { ...caller, threadId: childThreadId };
        yield* Ref.set(fake.respond, () => null);
        const receipt = yield* magi.startFromTool(childCaller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const detail = yield* runDetail(receipt.runId);
        const turns = yield* Effect.forEach(detail.participants, (participant) =>
          heldTurn(participant.childThreadId!),
        );
        yield* (yield* heldTurn(childThreadId)).finish("Waiting for Magi.");
        const task = (yield* threads.getThreadRecords(ownerThreadId, ["subagents"])).subagents.find(
          (entry) => entry.childThreadId === childThreadId,
        )!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        expect(yield* orchestrator.delegatedTaskResultPending(childThreadId, task.id)).toBe(true);
        yield* Effect.forEach(turns, (turn) => turn.finish(participantResponse), { discard: true });
        const messageId = MessageId.make(`magi:${receipt.runId}:1:completion`);
        yield* awaitEvent(
          childThreadId,
          (event) => event.type === "message.updated" && event.payload.id === messageId,
        );
        yield* magi.getTurnResult(childCaller, receipt);
        const stored = yield* storedRun(receipt.runId);
        const delivery = (stored.protocol as { turnDelivery: { runId: RunId } }).turnDelivery;
        yield* awaitEvent(
          childThreadId,
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.runId === delivery.runId &&
            event.payload.type === "command_execution",
        );
        expect(task.status).toBe("running");
        expect(task.result).toBeNull();
        yield* magi.recordArbitration(childCaller, {
          runId: receipt.runId,
          magiTurn: 1,
          record: arbitration(),
        });
        yield* (yield* heldTurn(childThreadId)).finish(
          "Magi consensus: adopt the reviewed change.",
        );
        yield* awaitEvent(
          ownerThreadId,
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.status === "completed",
        );
        const finalTask = (yield* threads.getThreadRecords(ownerThreadId, [
          "subagents",
        ])).subagents.find((entry) => entry.id === task.id)!;
        expect(JSON.stringify(finalTask.result)).toContain(
          "Magi consensus: adopt the reviewed change.",
        );
      }),
    ),
  );

  it.live.each(["pause", "stop"] as const)("withdraws an unstarted completion on %s", (action) =>
    withOwnerRun(
      `magi-passive-withdraw-${action}`,
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const receipt = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        yield* watchStoredRuns(receipt.runId).pipe(
          Stream.map((run) => run.detail),
          Stream.filter((run) => run.summary.completedMagiTurns === 1),
          Stream.runHead,
        );
        yield* magi.controlRun(caller, { runId: receipt.runId, action });
        const messages = yield* threads.getThreadRecords(ownerThreadId, ["runs", "messages"]);
        const notification = messages.messages.find(
          (message) => message.id === `magi:${receipt.runId}:1:completion`,
        )!;
        expect(messages.runs.find((run) => run.id === notification.runId)?.status).toBe(
          "cancelled",
        );
        if (action === "pause") {
          yield* magi.controlRun(caller, { runId: receipt.runId, action: "resume" });
          const resumed = yield* threads.getThreadRecords(ownerThreadId, ["runs", "messages"]);
          const replacement = resumed.messages.find(
            (message) => message.id === `magi:${receipt.runId}:1:completion:1`,
          )!;
          expect(resumed.runs.find((run) => run.id === replacement.runId)?.status).toBe("queued");
          yield* magi.getTurnResult(caller, receipt);
          yield* magi.recordArbitration(caller, {
            runId: receipt.runId,
            magiTurn: 1,
            record: arbitration(),
          });
        }
      }),
    ),
  );

  it.live(
    "repairs completion persistence after enqueue without duplicating the wake on restart",
    () =>
      withOwnerRun(
        "magi-passive-restart-delivery",
        Effect.gen(function* () {
          const magi = yield* MagiService;
          const receipt = yield* magi.startFromTool(caller, {
            config,
            objective,
            contextActivityIds: [],
          });
          yield* watchStoredRuns(receipt.runId).pipe(
            Stream.map((run) => run.detail),
            Stream.filter((run) => run.summary.completedMagiTurns === 1),
            Stream.runHead,
          );
          // A read under the run lock makes sure enqueue has finished before seeding the crash gap.
          yield* magi.controlRun(caller, { runId: receipt.runId, action: "resume" });
          const run = yield* storedRun(receipt.runId);
          yield* Effect.gen(function* () {
            const repository = yield* ProjectionMagiRepository;
            yield* repository
              .putRun({
                ...run,
                protocol: {
                  ...(run.protocol as object),
                  turnDelivery: { magiTurn: 1, state: "pending", runId: null },
                },
              })
              .pipe(Effect.orDie);
          }).pipe(Effect.provide(ProjectionMagiRepositoryLive));
          yield* afterRestart(
            Effect.gen(function* () {
              const restarted = yield* MagiService;
              const threads = yield* ThreadManagementService.ThreadManagementService;
              const recovered = yield* storedRun(receipt.runId);
              expect(
                (recovered.protocol as { turnDelivery: { state: string } }).turnDelivery.state,
              ).toBe("queued");
              const records = yield* threads.getThreadRecords(ownerThreadId, ["messages"]);
              expect(
                records.messages.filter(
                  (message) => message.id === `magi:${receipt.runId}:1:completion`,
                ),
              ).toHaveLength(1);
              expect((yield* restarted.getTurnResult(caller, receipt)).participants).toHaveLength(
                2,
              );
            }),
          );
        }),
      ),
  );

  it.live(
    "returns receipts before participants finish and wakes an idle owner once per panel turn",
    () =>
      withOwnerRun(
        "magi-passive-delivery",
        Effect.gen(function* () {
          const magi = yield* MagiService;
          const fake = yield* FakeProvider;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* Ref.set(fake.respond, () => null);
          const receipt = yield* magi.startFromTool(caller, {
            config: withTurnLimit(4),
            objective,
            contextActivityIds: [],
          });
          expect(receipt).toMatchObject({ state: "deliberating", magiTurn: 1 });
          expect("participants" in receipt).toBe(false);
          const replayed = yield* magi.startFromTool(caller, {
            config,
            objective,
            contextActivityIds: [],
          });
          expect(replayed.runId).toBe(receipt.runId);
          const premature = yield* magi.getTurnResult(caller, receipt).pipe(Effect.flip);
          expect(premature.message).toContain("still running");
          let detail = yield* runDetail(receipt.runId);
          for (let turnNumber = 1; turnNumber <= 3; turnNumber++) {
            if (turnNumber > 1) {
              const next = yield* magi.deliberate(caller, {
                runId: receipt.runId,
                contextActivityIds: [],
              });
              expect(next.magiTurn).toBe(turnNumber);
              const retried = yield* magi.deliberate(caller, {
                runId: receipt.runId,
                contextActivityIds: [],
              });
              expect(retried.magiTurn).toBe(turnNumber);
            }
            const turns = yield* Effect.forEach(detail.participants, (participant) =>
              heldTurn(participant.childThreadId!, turnNumber),
            );
            const owner = yield* heldTurn(ownerThreadId);
            const ownerRunId = (yield* storedRun(receipt.runId)).mainRunId;
            yield* owner.finish("Waiting for Magi.");
            yield* awaitEvent(
              ownerThreadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === ownerRunId &&
                event.payload.status === "completed",
            );
            expect(
              (yield* threads.getThreadShell(ownerThreadId))?.pendingBackgroundTasks,
            ).toContainEqual({
              taskId: `magi:${receipt.runId}`,
              kind: "monitor",
              description: "Waiting on Magi",
              awaited: true,
            });
            const first = turns[0]!;
            yield* first.finish(participantResponse);
            // A complete panel, rather than an individual participant, triggers delivery.
            expect(
              (yield* threads.getThreadRecords(ownerThreadId, ["messages"])).messages.some(
                (message) => message.id === `magi:${receipt.runId}:${turnNumber}:completion`,
              ),
            ).toBe(false);
            yield* Effect.forEach(turns.slice(1), (turn) => turn.finish(participantResponse), {
              discard: true,
            });
            const messageId = MessageId.make(`magi:${receipt.runId}:${turnNumber}:completion`);
            yield* awaitEvent(
              ownerThreadId,
              (event) => event.type === "message.updated" && event.payload.id === messageId,
            );
            const stored = yield* storedRun(receipt.runId);
            const delivery = (stored.protocol as { turnDelivery: { runId: RunId } }).turnDelivery;
            yield* awaitEvent(
              ownerThreadId,
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.runId === delivery.runId &&
                event.payload.type === "command_execution",
            );
            const records = yield* threads.getThreadRecords(ownerThreadId, ["turnItems"]);
            expect(
              records.turnItems.some(
                (item) => item.type === "user_message" && item.messageId === messageId,
              ),
            ).toBe(false);
            expect(
              records.turnItems.find(
                (item) => item.runId === delivery.runId && item.type === "notification",
              ),
            ).toMatchObject({
              type: "notification",
              summary: `Magi panel turn ${turnNumber} complete`,
              outcome: "completed",
            });
            const result = yield* magi.getTurnResult(caller, {
              runId: receipt.runId,
              magiTurn: turnNumber,
            });
            expect(result.participants).toHaveLength(2);
            const again = yield* magi.getTurnResult(caller, {
              runId: receipt.runId,
              magiTurn: turnNumber,
            });
            expect(again).toEqual(result);
            expect(
              (yield* threads.getThreadRecords(ownerThreadId, ["messages"])).messages.filter(
                (message) => message.id === messageId,
              ),
            ).toHaveLength(1);
            yield* magi.recordArbitration(caller, {
              runId: receipt.runId,
              magiTurn: turnNumber,
              record: arbitration({ requestedOutcome: "continue" }),
            });
            detail = yield* runDetail(receipt.runId);
          }
          expect(detail.summary.state).toBe("awaiting-next-turn");
          expect((yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId).toBe(
            receipt.runId,
          );
          yield* magi.controlRun(caller, { runId: receipt.runId, action: "stop" });
          expect(
            (yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId,
          ).toBeNull();
        }),
      ),
  );

  it.live("preserves an explicit pause across user input and delivers only after resume", () =>
    withOwnerRun(
      "magi-passive-pause",
      Effect.gen(function* () {
        const magi = yield* MagiService;
        const fake = yield* FakeProvider;
        yield* Ref.set(fake.respond, () => null);
        const receipt = yield* magi.startFromTool(caller, {
          config,
          objective,
          contextActivityIds: [],
        });
        const detail = yield* runDetail(receipt.runId);
        const turns = yield* Effect.forEach(detail.participants, (participant) =>
          heldTurn(participant.childThreadId!),
        );
        yield* magi.controlRun(caller, { runId: receipt.runId, action: "pause" });
        const threads = yield* ThreadManagementService.ThreadManagementService;
        expect(
          (yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId,
        ).toBeNull();
        yield* updateOwnerRequest("user_input", "pending");
        yield* updateOwnerRequest("user_input", "resolved");
        yield* Effect.forEach(turns, (turn) => turn.finish(participantResponse), { discard: true });
        yield* watchStoredRuns(receipt.runId).pipe(
          Stream.map((run) => run.detail),
          Stream.filter((run) => run.summary.completedMagiTurns === 1),
          Stream.runHead,
        );
        expect((yield* runDetail(receipt.runId)).summary.state).toBe("paused");
        const messageId = MessageId.make(`magi:${receipt.runId}:1:completion`);
        expect(
          (yield* threads.getThreadRecords(ownerThreadId, ["messages"])).messages.some(
            (message) => message.id === messageId,
          ),
        ).toBe(false);
        yield* magi.controlRun(caller, { runId: receipt.runId, action: "resume" });
        expect((yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId).toBe(
          receipt.runId,
        );
        yield* awaitEvent(
          ownerThreadId,
          (event) => event.type === "message.updated" && event.payload.id === messageId,
        );
        const result = yield* magi.getTurnResult(caller, receipt);
        expect(result.participants).toHaveLength(2);
      }),
    ),
  );
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
        },
      })
      .pipe(Effect.orDie);
  }).pipe(Effect.provide(ProjectionMagiRepositoryLive));

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
        const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
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

        const settings = yield* ServerSettings.ServerSettingsService;
        const capturedBefore = yield* Ref.get((yield* FakeProvider).captured);
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [claudeInstanceId]: { enabled: false } } },
          },
        });
        const refused = yield* magi
          .deliberate(caller, { runId, contextActivityIds: [] })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("unavailable-model");
        expect(refused.message).toContain("disabled for this project");
        expect((yield* runDetail(runId)).summary).toMatchObject({
          state: "awaiting-next-turn",
          completedMagiTurns: 1,
        });
        expect(yield* Ref.get((yield* FakeProvider).captured)).toEqual(capturedBefore);
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [claudeInstanceId]: { enabled: true } } },
          },
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
        const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
        const { start, runId } = yield* startHeldRun;

        const stopped = yield* magi.controlRun(caller, { runId, action: "stop" });
        expect(stopped).toMatchObject({ state: "cancelled", nextRequiredTool: "none" });
        const result = yield* Fiber.join(start);
        expect(result.runId).toBe(runId);
        expect(result.controlInstructions).toContain("The user cancelled this Magi run.");
        expect(result.thresholdReachable).toBe(false);
        expect(result.participants).toEqual([]);
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
      }),
    ),
  );

  it.live("pauses for the owner's approval and resumes the recorded state", () =>
    withOwnerRun(
      "magi-service-owner-approval",
      Effect.gen(function* () {
        const magi = yield* completedMagiService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
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
        expect(
          (yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId,
        ).toBeNull();
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
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* awaitEvent(
          ownerThreadId,
          (event) =>
            event.type === "thread.metadata-updated" && event.payload.pendingMagiRunId === null,
        );
        expect(
          (yield* threads.getThreadRecords(ownerThreadId, [])).thread.pendingMagiRunId,
        ).toBeNull();
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
    const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
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
              nextRequiredTool: "magi_get_turn_result",
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
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const records = yield* threads.getThreadRecords(ownerThreadId, ["messages"]);
            expect(
              records.messages.find((message) => message.runId === recovered.mainRunId)
                ?.notification,
            ).toMatchObject({
              source: { kind: "system" },
              summary: "Magi arbitration continued",
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
        const magi = yield* completedMagiService;
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
        const magi = yield* completedMagiService;
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

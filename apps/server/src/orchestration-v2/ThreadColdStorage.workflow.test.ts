import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadColdStorage from "./ThreadColdStorage.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "test-model" };
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);
const coldLayer = ThreadColdStorage.layer.pipe(
  Layer.provideMerge(EventSink.layerFromStores.pipe(Layer.provideMerge(stores))),
  Layer.provideMerge(
    Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.effect(
        ServerConfig.ServerConfig,
        ProviderReplayHarness.makeReplayServerConfig("workflow-cold-storage").pipe(Effect.orDie),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each(["archive", "recold"] as const)(
  "preserves workflow stopping across %s with a null task provider thread",
  (transition) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`workflow-${transition}`);
        const stopped: Array<
          Parameters<NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["stopTask"]>>[0]
        > = [];
        const turns: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        let closedSessions = 0;
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedSessions++;
                }),
              );
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities: ClaudeProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                hasPendingBackgroundWork: Effect.succeed(true),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) =>
                  Effect.succeed({ ...providerThread, providerSessionId: input.providerSessionId }),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    turns.push(turn);
                    const startedAt = yield* DateTime.now;
                    const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: providerTurnId,
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native-turn:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt,
                        completedAt: null,
                      },
                    });
                    yield* Queue.offer(events, {
                      type: "subagent.updated",
                      driver,
                      subagent: {
                        id: NodeId.make(`workflow:${turn.runId}`),
                        threadId: turn.threadId,
                        runId: turn.runId,
                        parentNodeId: turn.rootNodeId,
                        origin: "provider_native",
                        createdBy: "agent",
                        driver,
                        providerInstanceId: instanceId,
                        providerThreadId: null,
                        childThreadId: null,
                        nativeTaskRef: {
                          driver,
                          nativeId: `task:${turn.runId}`,
                          strength: "strong",
                        },
                        workflow: { phases: [], agents: [] },
                        prompt: "Run in background",
                        title: null,
                        model: null,
                        status: "running",
                        result: null,
                        startedAt,
                        completedAt: null,
                        updatedAt: startedAt,
                      },
                    });
                    yield* Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  }),
                stopTask: (request) =>
                  Effect.sync(() => {
                    stopped.push(request);
                  }),
                steerTurn: () => Effect.die("unused steer"),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.die("unused request"),
                readThreadSnapshot: () => Effect.die("unused snapshot"),
                rollbackThread: () => Effect.die("unused rollback"),
                forkThread: () => Effect.die("unused fork"),
              };
            }),
        };
        const replay = ProviderReplayHarness.layerWithRegistry(
          { name: `workflow-${transition}` },
          ProviderAdapterRegistry.layerSingle(adapter),
          { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
        ).pipe(Layer.provideMerge(coldLayer));
        const runtime = ThreadManagementService.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(replay),
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make(`thread:workflow-${transition}`);
          const status = sql<{
            status: string;
          }>`SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}`.pipe(
            Effect.map((rows) => rows[0]?.status),
          );
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:workflow"),
            title: "Workflow",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const launch = (key: string) =>
            Effect.gen(function* () {
              const waiting = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.threadId === threadId &&
                    event.type === "run.updated" &&
                    event.payload.status === "waiting",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkChild,
              );
              yield* threads.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(key),
                threadId,
                messageId: MessageId.make(`message:${key}`),
                text: "Launch a workflow",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              if (key === "after-archive") {
                yield* TestClock.adjust(ThreadColdStorage.RECOLD_DELAY_MS);
              }
              yield* worker.drain();
              yield* Fiber.join(waiting);
              yield* worker.drain();
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const turn = turns.at(-1)!;
              const task = projection.subagents.find((task) => task.runId === turn.runId)!;
              assert.equal(
                projection.runs.find((run) => run.id === turn.runId)?.status,
                "completed",
              );
              assert.equal(task.status, "running");
              assert.isNull(task.providerThreadId);
              assert.isTrue(
                Option.isSome(yield* sessions.get(turn.providerThread.providerSessionId!)),
              );
              return { task, turn };
            });
          const first = yield* launch("first");
          yield* threads.stopWorkflow({ threadId, subagentId: first.task.id });
          assert.equal(stopped[0]?.taskId, first.task.nativeTaskRef?.nativeId);
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive"),
            threadId,
          });
          yield* worker.drain();
          assert.equal(yield* status, "cold");
          assert.equal(closedSessions, 1);
          assert.isTrue(
            Option.isNone(yield* sessions.get(first.turn.providerThread.providerSessionId!)),
          );
          assert.isEmpty((yield* orchestrator.getThreadProjection(threadId)).runs);
          if (transition === "archive") {
            const result = yield* threads
              .stopWorkflow({ threadId, subagentId: first.task.id })
              .pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure.reason, "unavailable");
            assert.lengthOf(stopped, 1);
          } else {
            // Generic dispatch is the typed authenticated RPC path; it does not use sendToThread.
            const second = yield* launch("after-archive");
            assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
            assert.equal(yield* status, "kept-hot");
            // A refused unarchive schedules cold cleanup without detaching the live runtime.
            const unarchive = yield* threads
              .dispatch({
                type: "thread.unarchive",
                commandId: CommandId.make("refused-unarchive"),
                threadId,
              })
              .pipe(
                Effect.provideService(DispatchModeLimit, {
                  runtimeMode: "approval-required",
                  interactionMode: "plan",
                }),
                Effect.result,
              );
            assert.equal(unarchive._tag, "Failure");
            yield* worker.drain();
            assert.equal(yield* status, "cold");
            assert.isEmpty((yield* orchestrator.getThreadProjection(threadId)).runs);
            assert.equal(closedSessions, 1);
            assert.isTrue(
              Option.isSome(yield* sessions.get(second.turn.providerThread.providerSessionId!)),
            );
            yield* threads.stopWorkflow({ threadId, subagentId: second.task.id });
            assert.equal(stopped.at(-1)?.taskId, second.task.nativeTaskRef?.nativeId);
            assert.equal(stopped.at(-1)?.providerThread.id, second.turn.providerThread.id);
            assert.equal(yield* status, "restored");
          }
        }).pipe(Effect.provide(runtime));
      }),
    ),
);

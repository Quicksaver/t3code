import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadColdStorage from "./ThreadColdStorage.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const providerInstanceId = modelSelection.instanceId;
const driver = ProviderDriverKind.make("codex");

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  makeReplayServerConfig("cold-storage").pipe(Effect.orDie),
).pipe(Layer.provide(NodeServices.layer));
const storesLayer = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);
// Everything cold storage runs on, without a cold storage instance.
const BaseLayer = EventSink.layerFromStores.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      storesLayer,
      ThreadCommandExecutor.layer,
      configLayer,
      NodeServices.layer,
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);
const TestLayer = ThreadColdStorage.layer.pipe(Layer.provideMerge(BaseLayer));

// The server's live cold storage and an effect worker that runs its lifecycle effects.
const StartupLayer = EffectWorker.layer.pipe(
  Layer.provide(
    Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const cold = yield* ThreadColdStorage.ThreadColdStorage;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            (effect.request.type === "thread.storage-purge"
              ? cold.purge(effect.threadId)
              : cold.archive(effect.threadId, Effect.void)
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectWorker.OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            ),
        });
      }),
    ),
  ),
  Layer.provideMerge(ThreadColdStorage.layerWithReconcile),
);

const commit = (
  threadId: ThreadId,
  key: string,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.commitCommand({
      commandId: CommandId.make(`command:${key}`),
      threadId,
      commandType: "test",
      acceptedAt: yield* DateTime.now,
      events,
      effects: [],
    });
  });

const threadPayload = (
  threadId: ThreadId,
  now: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:cold"),
  title: "Cold thread",
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

/** Seeds a settled conversation with one attachment and a provider log, then archives it. */
const seedArchivedThread = (
  key: string,
  options: { readonly runStatus?: "completed" | "running"; readonly archive?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${key}`);
    const runId = RunId.make(`run:${key}`);
    const nodeId = NodeId.make(`node:${key}`);
    const messageId = MessageId.make(`message:${key}`);
    const attachmentId = createAttachmentId(threadId, "png")!;
    yield* fs.writeFileString(path.join(config.attachmentsDir, `${attachmentId}.png`), "png");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: options.runStatus ?? ("completed" as const),
      requestedAt: now,
      startedAt: now,
      completedAt: options.runStatus === "running" ? null : now,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* commit(threadId, `${key}:seed`, [
      {
        id: EventId.make(`event:${key}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: threadPayload(threadId, now),
      },
      {
        id: EventId.make(`event:${key}:run`),
        type: "run.created",
        threadId,
        runId,
        nodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make(`event:${key}:message`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Remember this",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          ],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`event:${key}:item`),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${key}`),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "command",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo cold",
        },
      },
    ]);
    if (options.archive !== false) {
      yield* commit(threadId, `${key}:archive`, [
        {
          id: EventId.make(`event:${key}:archived`),
          type: "thread.archived",
          threadId,
          occurredAt: now,
          payload: threadPayload(threadId, now, { archivedAt: now }),
        },
      ]);
    }
    return {
      threadId,
      attachmentId,
      attachmentPath: path.join(config.attachmentsDir, `${attachmentId}.png`),
    };
  });

const hotCounts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly runs: number;
      readonly messages: number;
      readonly items: number;
      readonly events: number;
      readonly lifecycle_events: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}) AS runs,
        (SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}) AS messages,
        (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}) AS items,
        (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}) AS events,
        (SELECT COUNT(*) FROM orchestration_events
          WHERE stream_id = ${threadId} AND event_type LIKE 'thread.%') AS lifecycle_events
    `;
    return rows[0]!;
  });

const manifestStatus = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
    `;
    return rows[0]?.status ?? null;
  });

it.effect("moves an archived conversation cold, keeps its shell, and restores it on read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const { threadId, attachmentPath } = yield* seedArchivedThread("archive");
    const threadLog = path.join(config.providerLogsDir, "events.thread-archive.log");
    const otherLog = path.join(config.providerLogsDir, "events.thread-archive2.log");
    for (const file of [threadLog, `${threadLog}.1`, otherLog]) {
      yield* fs.writeFileString(file, "log");
    }
    const projectionBefore = yield* projections.getThreadProjection(threadId);
    const shellBefore = yield* projections.getThreadShell(threadId);
    assert.isNotNull(shellBefore?.latestUserMessageAt);
    assert.isNotNull(shellBefore?.latestUserAuthoredMessageAt);

    yield* cold.archive(threadId, Effect.void);

    assert.equal(yield* manifestStatus(threadId), "cold");
    const counts = yield* hotCounts(threadId);
    assert.deepEqual(
      [counts.runs, counts.messages, counts.items],
      [0, 0, 0],
      "conversation rows leave the hot database",
    );
    // Lifecycle events and the newest event of the stream stay hot.
    assert.isAtLeast(counts.lifecycle_events, 2);
    assert.equal(counts.events, counts.lifecycle_events);
    assert.isFalse(yield* fs.exists(attachmentPath));
    assert.isFalse(yield* fs.exists(threadLog));
    assert.isFalse(yield* fs.exists(`${threadLog}.1`));
    assert.isTrue(yield* fs.exists(otherLog));
    // The archive list keeps the activity fields that worktree cleanup reads.
    assert.deepEqual(yield* projections.getThreadShell(threadId), shellBefore);
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    assert.deepEqual(archived.archivedThreads, [shellBefore!]);
    const decodeSnapshot = yield* sql.withTransaction(
      projections.readShellSnapshot({ location: "archive" }),
    );
    assert.deepEqual((yield* decodeSnapshot).archivedThreads, [shellBefore!]);

    yield* cold.withHot(threadId, Effect.void);

    assert.equal(yield* manifestStatus(threadId), "restored");
    assert.isTrue(yield* fs.exists(attachmentPath));
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projectionBefore);
    const recold = yield* sql<{
      readonly status: string;
      readonly available_at: string;
      readonly created_at: string;
    }>`
      SELECT status, available_at, created_at FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'thread.cold-archive'
    `;
    assert.lengthOf(recold, 1);
    assert.equal(recold[0]?.status, "pending");
    assert.equal(
      Date.parse(recold[0]!.available_at) - Date.parse(recold[0]!.created_at),
      ThreadColdStorage.RECOLD_DELAY_MS,
    );

    // The queued re-cold moves it back while it stays archived.
    yield* cold.archive(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");
    assert.deepEqual(yield* projections.getThreadShell(threadId), shellBefore);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("restores cold conversation rows for search pulls and history pages", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* seedArchivedThread("find");
    const now = yield* DateTime.now;
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make("event:find:project"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project:cold"),
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.make("project:cold"),
        title: "Cold project",
        workspaceRoot: "/work/cold",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    const itemId = TurnItemId.make("item:find:message");
    yield* commit(threadId, "find:message-item", [
      {
        id: EventId.make("event:find:message-item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: itemId,
          threadId,
          runId: RunId.make("run:find"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: "Message",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:find"),
          text: "Remember this",
          inputIntent: "turn_start",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      },
    ]);
    const managementLayer = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          searchThread: (input) => projections.searchThread(input).pipe(Effect.orDie),
          searchThreadStream: (input) => projections.searchThreadStream(input).pipe(Stream.orDie),
          getThreadHistoryPage: (...args) =>
            projections.getThreadHistoryPage(...args).pipe(Effect.orDie),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const management = yield* ThreadManagementService.ThreadManagementService;
      const input = { threadId, query: "Remember this" };
      const expected = yield* management.searchThread(input);
      assert.equal(expected.totalMatches, 1);
      yield* cold.archive(threadId, Effect.void);
      assert.equal(yield* manifestStatus(threadId), "cold");
      assert.deepEqual(yield* management.searchThread({ threadId, query: "Remember" }), expected);
      assert.equal(yield* manifestStatus(threadId), "restored");
      yield* cold.archive(threadId, Effect.void);
      const results = yield* Stream.runCollect(
        management.searchThreadStream({ threadId, query: "this" }),
      );
      assert.deepEqual(results.at(-1), expected);
      assert.equal(yield* manifestStatus(threadId), "restored");
      yield* cold.archive(threadId, Effect.void);
      const page = yield* management.getThreadHistoryPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: expected.snapshotSequence,
          sourceThreadId: threadId,
          sourceItemId: "absent",
          position: 2,
        }),
      );
      assert.isTrue(page.items.some(({ item }) => item.id === itemId));
      assert.equal(yield* manifestStatus(threadId), "restored");
    }).pipe(Effect.provide(managementLayer));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["html_render", "example.view"] as const)(
  "moves a %s document cold and restores its bytes and turn item on asset access",
  (toolName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const cold = yield* ThreadColdStorage.ThreadColdStorage;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId } = yield* seedArchivedThread("html-page");
      const now = yield* DateTime.now;
      const attachmentId = createAttachmentId(threadId, "html")!;
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.html`);
      const page = "<!doctype html><title>Archived page</title><p>Keep these bytes.</p>";
      yield* fs.writeFileString(attachmentPath, page);
      const item = {
        id: TurnItemId.make("item:html-page:render"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "completed" as const,
        title: "Archived page",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName,
        input: {},
        output:
          toolName === "html_render"
            ? { htmlRender: { attachmentId, title: "Archived page", height: 200 } }
            : {
                t3McpApp: {
                  attachmentId,
                  server: "example",
                  tool: "view",
                  resourceUri: "ui://example/view",
                },
              },
      };
      yield* commit(threadId, "html-page:item", [
        {
          id: EventId.make("event:html-page:render"),
          type: "turn-item.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: item,
        },
      ]);

      const itemBefore = yield* projections.getTurnItem({ threadId, itemId: item.id });
      assert.isNotNull(itemBefore);
      yield* cold.archive(threadId, Effect.void);
      assert.equal(yield* manifestStatus(threadId), "cold");
      assert.isFalse(yield* fs.exists(attachmentPath));
      assert.isNull(yield* projections.getTurnItem({ threadId, itemId: item.id }));

      yield* cold.ensureAttachmentHot(attachmentId);
      assert.equal(yield* manifestStatus(threadId), "restored");
      assert.equal(yield* fs.readFileString(attachmentPath), page);
      assert.deepEqual(yield* projections.getTurnItem({ threadId, itemId: item.id }), itemBefore);

      yield* cold.archive(threadId, Effect.void);
      assert.isFalse(yield* fs.exists(attachmentPath));
      yield* cold.ensureAttachmentHot(attachmentId);
      assert.equal(yield* fs.readFileString(attachmentPath), page);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("restores a cold MCP App item for model-context updates without a live session", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("mcp-context");
    const now = yield* DateTime.now;
    const itemId = TurnItemId.make("item:mcp-context");
    yield* commit(threadId, "mcp-context:item", [
      {
        id: EventId.make("event:mcp-context:app"),
        type: "turn-item.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: itemId,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: ProviderThreadId.make("provider-thread:mcp-context"),
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: "Captured app",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "example.view",
          input: {},
          output: {
            t3McpApp: {
              attachmentId: createAttachmentId(threadId, "html")!,
              server: "example",
              tool: "view",
              resourceUri: "ui://example/view",
            },
          },
        },
      },
    ]);
    yield* cold.archive(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");
    assert.isNull(yield* projections.getTurnItem({ threadId, itemId }));

    const requestsLayer = McpAppRequests.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getTurnItem: (input) => projections.getTurnItem(input).pipe(Effect.orDie),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            withThreadReadable: (id, use) => cold.withHot(id, use),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          McpAppModelContext.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      yield* requests.updateModelContext({
        threadId,
        itemId,
        conversationThreadId: threadId,
        content: [{ type: "text", text: "Recovered app context" }],
      });
    }).pipe(Effect.provide(requestsLayer));

    assert.equal(yield* manifestStatus(threadId), "restored");
    const rows = yield* sql`SELECT text FROM mcp_app_model_context WHERE thread_id = ${threadId}`;
    assert.equal(rows[0]?.text, "Recovered app context");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("moves a migrated conversation's V1 rows with it and purges them on delete", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("legacy");
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, 'project:cold', 'Cold thread', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('legacy-message', ${threadId}, 'user', 'Remember this', 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('legacy-activity', ${threadId}, 'info', 'tool.completed', 'Ran', '{}', ${now})
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
      VALUES ('legacy-command', 'thread', ${threadId}, ${now}, 0, 'accepted')
    `;
    const legacyCounts = sql<{
      readonly threads: number;
      readonly messages: number;
      readonly activities: number;
      readonly legacy_receipts: number;
      readonly receipts: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${threadId}) AS threads,
        (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) AS messages,
        (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) AS activities,
        (SELECT COUNT(*) FROM orchestration_command_receipts
          WHERE aggregate_id = ${threadId} AND command_type = 'legacy') AS legacy_receipts,
        (SELECT COUNT(*) FROM orchestration_command_receipts
          WHERE aggregate_id = ${threadId} AND command_type <> 'legacy') AS receipts
    `.pipe(Effect.map((rows) => rows[0]!));
    const before = yield* legacyCounts;
    assert.isAtLeast(before.receipts, 1);

    yield* cold.archive(threadId, Effect.void);

    // The V1 shell row stays for shell repair, and V2 receipts stay hot.
    assert.deepEqual(yield* legacyCounts, {
      ...before,
      messages: 0,
      activities: 0,
      legacy_receipts: 0,
    });

    yield* cold.withHot(threadId, Effect.void);
    assert.deepEqual(yield* legacyCounts, before);

    yield* cold.archive(threadId, Effect.void);
    const deletedAt = yield* DateTime.now;
    yield* commit(threadId, "legacy:delete", [
      {
        id: EventId.make("event:legacy:deleted"),
        type: "thread.deleted",
        threadId,
        occurredAt: deletedAt,
        payload: threadPayload(threadId, deletedAt, { archivedAt: deletedAt, deletedAt }),
      },
    ]);
    yield* cold.purge(threadId);
    const purged = yield* legacyCounts;
    assert.deepEqual(
      [purged.messages, purged.activities, purged.legacy_receipts],
      [0, 0, 0],
      "permanent deletion removes the V1 rows too",
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "unarchive restores the conversation, cancels a pending re-cold, and drops the bundle afterwards",
  () =>
    Effect.gen(function* () {
      const cold = yield* ThreadColdStorage.ThreadColdStorage;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, attachmentPath } = yield* seedArchivedThread("unarchive");
      const fs = yield* FileSystem.FileSystem;
      const before = yield* projections.getThreadProjection(threadId);
      yield* cold.archive(threadId, Effect.void);
      // A read restores and queues a re-cold before the user unarchives.
      yield* cold.withHot(threadId, Effect.void);
      yield* cold.archive(threadId, Effect.void);

      yield* cold.withHot(threadId, Effect.void, { unarchive: true });

      assert.equal(yield* manifestStatus(threadId), "restored");
      assert.isTrue(yield* fs.exists(attachmentPath));
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).turnItems,
        before.turnItems,
      );
      const pending = yield* sql`
        SELECT 1 FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
      `;
      assert.lengthOf(pending, 0);

      // The unarchive commits, then the cold-archive effect queued after it runs.
      const now = yield* DateTime.now;
      yield* commit(threadId, "unarchive:unarchived", [
        {
          id: EventId.make("event:unarchive:unarchived"),
          type: "thread.unarchived",
          threadId,
          occurredAt: now,
          payload: threadPayload(threadId, now),
        },
      ]);
      yield* cold.archive(threadId, Effect.void);

      assert.isNull(yield* manifestStatus(threadId));
      const chunks = yield* sql`
        SELECT 1 FROM cold_archive.archive_thread_chunks WHERE thread_id = ${threadId}
      `;
      assert.lengthOf(chunks, 0);
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).turnItems,
        before.turnItems,
      );
      assert.isTrue(yield* fs.exists(attachmentPath));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps stream versions unique when lifecycle events are appended while cold", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* seedArchivedThread("versions");
    yield* cold.archive(threadId, Effect.void);
    const now = yield* DateTime.now;
    yield* commit(threadId, "versions:rename", [
      {
        id: EventId.make("event:versions:renamed"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: threadPayload(threadId, now, { archivedAt: now, title: "Renamed while cold" }),
      },
    ]);

    yield* cold.withHot(threadId, Effect.void);

    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.thread.title, "Renamed while cold");
    assert.lengthOf(projection.messages, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps archived threads hot while they run or another live thread forks them", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const running = yield* seedArchivedThread("running", { runStatus: "running" });
    yield* cold.archive(running.threadId, Effect.void);
    assert.equal(yield* manifestStatus(running.threadId), "kept-hot");
    assert.equal((yield* hotCounts(running.threadId)).runs, 1);

    const source = yield* seedArchivedThread("fork-source");
    const now = yield* DateTime.now;
    const forkId = ThreadId.make("thread:fork-child");
    yield* commit(forkId, "fork-child", [
      {
        id: EventId.make("event:fork-child:created"),
        type: "thread.created",
        threadId: forkId,
        occurredAt: now,
        payload: threadPayload(forkId, now, {
          forkedFrom: {
            type: "run",
            threadId: source.threadId,
            runId: RunId.make("run:fork-source"),
          } as OrchestrationV2AppThread["forkedFrom"],
        }),
      },
    ]);
    yield* cold.archive(source.threadId, Effect.void);
    assert.equal(yield* manifestStatus(source.threadId), "kept-hot");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("purges a deleted cold thread but keeps its deleted shell and lifecycle events", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("purge");
    yield* sql`
      INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
      VALUES (${threadId}, 'item:purge', 'example', 'view', 'Delete this context',
        '2026-10-07T00:00:00.000Z')
    `;
    yield* cold.archive(threadId, Effect.void);
    assert.lengthOf(
      yield* sql`SELECT 1 FROM mcp_app_model_context WHERE thread_id = ${threadId}`,
      1,
    );
    const now = yield* DateTime.now;
    yield* commit(threadId, "purge:delete", [
      {
        id: EventId.make("event:purge:deleted"),
        type: "thread.deleted",
        threadId,
        occurredAt: now,
        payload: threadPayload(threadId, now, { archivedAt: now, deletedAt: now }),
      },
    ]);
    // Reads of a deleted thread never restore it.
    yield* cold.withHot(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");

    yield* cold.purge(threadId);

    assert.equal(yield* manifestStatus(threadId), "purged");
    assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    const counts = yield* hotCounts(threadId);
    assert.equal(counts.events, counts.lifecycle_events);
    const chunks = yield* sql`
      SELECT 1 FROM cold_archive.archive_thread_chunks WHERE thread_id = ${threadId}
    `;
    assert.lengthOf(chunks, 0);
    assert.lengthOf(
      yield* sql`SELECT 1 FROM mcp_app_model_context WHERE thread_id = ${threadId}`,
      0,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reconcile queues lifecycle work for threads that predate cold storage", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const archived = yield* seedArchivedThread("reconcile-archived");
    const deleted = yield* seedArchivedThread("reconcile-deleted", { archive: false });
    const active = yield* seedArchivedThread("reconcile-active", { archive: false });
    const now = yield* DateTime.now;
    yield* commit(deleted.threadId, "reconcile-deleted:delete", [
      {
        id: EventId.make("event:reconcile-deleted:deleted"),
        type: "thread.deleted",
        threadId: deleted.threadId,
        occurredAt: now,
        payload: threadPayload(deleted.threadId, now, { deletedAt: now }),
      },
    ]);

    yield* cold.reconcile;
    yield* cold.reconcile;

    const queued = yield* sql<{ readonly thread_id: string; readonly effect_type: string }>`
      SELECT thread_id, effect_type FROM orchestration_v2_effect_outbox ORDER BY thread_id
    `;
    assert.deepEqual(
      queued.map((row) => [row.thread_id, row.effect_type]),
      [
        [archived.threadId, "thread.cold-archive"],
        [deleted.threadId, "thread.storage-purge"],
      ],
    );
    assert.notInclude(
      queued.map((row) => row.thread_id),
      active.threadId,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("starting the live service converges threads that predate cold storage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const archived = yield* seedArchivedThread("startup-archived");
    const deleted = yield* seedArchivedThread("startup-deleted", { archive: false });
    const now = yield* DateTime.now;
    yield* commit(deleted.threadId, "startup-deleted:delete", [
      {
        id: EventId.make("event:startup-deleted:deleted"),
        type: "thread.deleted",
        threadId: deleted.threadId,
        occurredAt: now,
        payload: threadPayload(deleted.threadId, now, { deletedAt: now }),
      },
    ]);

    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      // Reconciliation notifies the worker once it has queued the lifecycle effects.
      yield* outbox.awaitAvailable;
      assert.equal(yield* worker.drain(), 2);
    }).pipe(Effect.provide(StartupLayer));

    assert.equal(yield* manifestStatus(archived.threadId), "cold");
    assert.equal((yield* hotCounts(archived.threadId)).messages, 0);
    assert.equal(yield* manifestStatus(deleted.threadId), "purged");
    assert.equal((yield* hotCounts(deleted.threadId)).runs, 0);
    // The drained queue returned the freed pages.
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    assert.equal(free[0]?.freelist_count, 0);
  }).pipe(Effect.provide(BaseLayer)),
);

it.effect("returns freed pages in bounded steps that let the event loop run", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("bulk", { archive: false });
    const now = yield* DateTime.now;
    // Enough message history that moving it frees many reclaim steps' worth of pages.
    yield* commit(
      threadId,
      "bulk:history",
      Array.from({ length: 1500 }, (_, index) => ({
        id: EventId.make(`event:bulk:message:${index}`),
        type: "message.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user" as const,
          creationSource: "web" as const,
          id: MessageId.make(`message:bulk:${index}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user" as const,
          text: `${index}:${"x".repeat(4000)}`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })),
    );
    yield* commit(threadId, "bulk:archive", [
      {
        id: EventId.make("event:bulk:archived"),
        type: "thread.archived",
        threadId,
        occurredAt: now,
        payload: threadPayload(threadId, now, { archivedAt: now }),
      },
    ]);
    const pageCount = (yield* sql<{ readonly page_count: number }>`PRAGMA page_count`)[0]!
      .page_count;

    // Counts event-loop turns that run while the move and reclamation proceed.
    let turns = 0;
    let running = true;
    const tick = () => {
      turns += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    yield* cold
      .archive(threadId, Effect.void)
      .pipe(Effect.ensuring(Effect.sync(() => (running = false))));

    const after = (yield* sql<{ readonly page_count: number; readonly freelist_count: number }>`
      SELECT (SELECT page_count FROM pragma_page_count()) AS page_count,
             (SELECT freelist_count FROM pragma_freelist_count()) AS freelist_count
    `)[0]!;
    const returnedPages = pageCount - after.page_count;
    assert.equal(yield* manifestStatus(threadId), "cold");
    assert.equal(after.freelist_count, 0);
    assert.isAbove(returnedPages, ThreadColdStorage.RECLAIM_CHUNK_PAGES * 4);
    // At least one event-loop turn per reclaim step.
    assert.isAtLeast(turns, Math.ceil(returnedPages / ThreadColdStorage.RECLAIM_CHUNK_PAGES));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("resumes a move that stopped after handing reads to the bundle", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("resume");
    yield* cold.archive(threadId, Effect.void);
    // A restore brings the rows back while keeping the complete bundle; marking
    // it `moving` reproduces a crash right after a move handed reads to it.
    yield* cold.withHot(threadId, Effect.void);
    yield* sql`UPDATE thread_archive_manifests SET status = 'moving' WHERE thread_id = ${threadId}`;
    assert.isAbove((yield* hotCounts(threadId)).messages, 0);

    // The restore's re-cold is still queued, so reconciliation adds nothing.
    yield* cold.reconcile;
    const queued = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'thread.cold-archive' AND status = 'pending'
    `;
    assert.lengthOf(queued, 1);

    yield* cold.archive(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");
    const counts = yield* hotCounts(threadId);
    assert.deepEqual([counts.runs, counts.messages, counts.items], [0, 0, 0]);
  }).pipe(Effect.provide(TestLayer)),
);

const ChunkRowsJson = Schema.fromJsonString(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeChunkRows = Schema.decodeUnknownSync(ChunkRowsJson);
const encodeChunkRows = Schema.encodeSync(ChunkRowsJson);

const markDeleted = (
  threadId: ThreadId,
  key: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* commit(threadId, `${key}:delete`, [
      {
        id: EventId.make(`event:${key}:deleted`),
        type: "thread.deleted",
        threadId,
        occurredAt: now,
        payload: threadPayload(threadId, now, { ...overrides, archivedAt: now, deletedAt: now }),
      },
    ]);
  });

const forkedFrom = (sourceId: ThreadId, key: string) =>
  ({
    type: "run",
    threadId: sourceId,
    runId: RunId.make(`run:${key}`),
  }) as OrchestrationV2AppThread["forkedFrom"];

const createFork = (forkId: ThreadId, sourceId: ThreadId, key: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* commit(forkId, key, [
      {
        id: EventId.make(`event:${key}:created`),
        type: "thread.created",
        threadId: forkId,
        occurredAt: now,
        payload: threadPayload(forkId, now, { forkedFrom: forkedFrom(sourceId, key) }),
      },
    ]);
  });

it.effect("defers a cold move while a read uses the thread", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("lease");
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const read = yield* cold
      .withHot(
        threadId,
        Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(hotCounts(threadId)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(reading);

    yield* cold.archive(threadId, Effect.void);

    assert.isNull(yield* manifestStatus(threadId));
    const retry = yield* sql`
      SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'thread.cold-archive'
        AND status = 'pending' AND effect_id LIKE '%:busy:%'
    `;
    assert.lengthOf(retry, 1);
    yield* Deferred.succeed(release, undefined);
    assert.equal((yield* Fiber.join(read)).messages, 1);

    yield* cold.archive(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a fork admitted during a cold move waits for it and keeps its source hot", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const { threadId: sourceId } = yield* seedArchivedThread("move-fork");
    const forkId = ThreadId.make("thread:move-fork-child");
    const moving = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    const archiving = yield* cold
      .archive(
        sourceId,
        Deferred.succeed(moving, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(moving);

    let forkCommitted = false;
    const fork = yield* cold
      .withHot(
        sourceId,
        createFork(forkId, sourceId, "move-fork-child").pipe(
          Effect.andThen(Effect.sync(() => (forkCommitted = true))),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    // The fork waits for the move instead of reading rows that are leaving.
    assert.isFalse(forkCommitted);
    yield* Deferred.succeed(proceed, undefined);
    yield* Fiber.join(archiving);
    yield* Fiber.join(fork);

    assert.isTrue(forkCommitted);
    assert.equal(yield* manifestStatus(sourceId), "restored");
    assert.equal((yield* hotCounts(sourceId)).messages, 1);
    // The queued re-cold sees the fork and keeps the source hot.
    yield* cold.archive(sourceId, Effect.void);
    assert.equal(yield* manifestStatus(sourceId), "kept-hot");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rechecks fork references before a move hands reads to the bundle", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const { threadId: sourceId } = yield* seedArchivedThread("late-fork");
    // A fork committed outside a lease while the bundle is being prepared.
    yield* cold.archive(
      sourceId,
      createFork(ThreadId.make("thread:late-fork-child"), sourceId, "late-fork-child").pipe(
        Effect.provideService(EventSink.EventSinkV2, sink),
      ),
    );

    assert.equal(yield* manifestStatus(sourceId), "kept-hot");
    assert.equal((yield* hotCounts(sourceId)).messages, 1);
    const chunks = yield* sql`
      SELECT 1 FROM cold_archive.archive_thread_chunks WHERE thread_id = ${sourceId}
    `;
    assert.lengthOf(chunks, 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to restore from a missing bundle and keeps the manifest", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("missing-bundle");
    yield* cold.archive(threadId, Effect.void);
    yield* sql`DELETE FROM cold_archive.archive_threads WHERE thread_id = ${threadId}`;

    const error = yield* Effect.flip(cold.withHot(threadId, Effect.void));

    assert.equal(error._tag, "ThreadColdStorageError");
    assert.equal(yield* manifestStatus(threadId), "cold");
    assert.equal((yield* hotCounts(threadId)).messages, 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("restores the conversation that holds a requested cold attachment", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const fs = yield* FileSystem.FileSystem;
    const { threadId, attachmentId, attachmentPath } = yield* seedArchivedThread("asset");
    yield* cold.archive(threadId, Effect.void);
    assert.isFalse(yield* fs.exists(attachmentPath));

    yield* cold.ensureAttachmentHot(attachmentId);

    assert.isTrue(yield* fs.exists(attachmentPath));
    assert.equal(yield* manifestStatus(threadId), "restored");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reconcile retries failed lifecycle work and re-evaluates kept-hot threads", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const kept = yield* seedArchivedThread("retry-kept", { runStatus: "running" });
    yield* cold.archive(kept.threadId, Effect.void);
    assert.equal(yield* manifestStatus(kept.threadId), "kept-hot");
    const failed = yield* seedArchivedThread("retry-failed");

    yield* cold.reconcile;
    yield* sql`
      UPDATE orchestration_v2_effect_outbox SET status = 'failed'
      WHERE effect_type = 'thread.cold-archive'
    `;
    // The next startup.
    yield* TestClock.adjust("1 second");
    yield* cold.reconcile;

    const effects = yield* sql<{ readonly thread_id: string; readonly status: string }>`
      SELECT thread_id, status FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'thread.cold-archive' ORDER BY thread_id, status
    `;
    assert.deepEqual(
      effects.map((row) => [row.thread_id, row.status]),
      [
        [failed.threadId, "failed"],
        [failed.threadId, "pending"],
        [kept.threadId, "failed"],
        [kept.threadId, "pending"],
      ],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps a deleted fork source until its last fork is purged", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId: sourceId } = yield* seedArchivedThread("purge-source", { archive: false });
    const forkId = ThreadId.make("thread:purge-source-fork");
    yield* createFork(forkId, sourceId, "purge-source-fork");
    yield* markDeleted(sourceId, "purge-source");

    yield* cold.purge(sourceId);
    assert.isNull(yield* manifestStatus(sourceId));
    assert.equal((yield* hotCounts(sourceId)).messages, 1);

    yield* markDeleted(forkId, "purge-source-fork", {
      forkedFrom: forkedFrom(sourceId, "purge-source-fork"),
    });
    yield* cold.purge(forkId);
    const queued = yield* sql`
      SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${sourceId} AND effect_type = 'thread.storage-purge' AND status = 'pending'
    `;
    assert.lengthOf(queued, 1);

    yield* cold.purge(sourceId);
    assert.equal(yield* manifestStatus(sourceId), "purged");
    assert.equal((yield* hotCounts(sourceId)).messages, 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("purge removes attachment files an interrupted cleanup left behind", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const fs = yield* FileSystem.FileSystem;
    const { threadId, attachmentPath } = yield* seedArchivedThread("leftover");
    yield* cold.archive(threadId, Effect.void);
    yield* fs.writeFileString(attachmentPath, "png");
    yield* markDeleted(threadId, "leftover");

    yield* cold.purge(threadId);

    assert.isFalse(yield* fs.exists(attachmentPath));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("purges a shared provider session once its last binding is gone", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* seedArchivedThread("session-first", { archive: false });
    const second = yield* seedArchivedThread("session-second", { archive: false });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
      VALUES ('session:shared', ${second.threadId}, 'codex', 'stopped', NULL, ${now}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
      VALUES ('session:shared', ${first.threadId}), ('session:shared', ${second.threadId})
    `;
    const sessionCount = sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = 'session:shared'
    `.pipe(Effect.map((rows) => rows[0]!.count));

    yield* markDeleted(second.threadId, "session-second");
    yield* cold.purge(second.threadId);
    assert.equal(yield* sessionCount, 1);

    // An earlier purge of the first thread stopped after removing its bindings.
    yield* markDeleted(first.threadId, "session-first");
    yield* sql`
      DELETE FROM orchestration_v2_projection_provider_session_bindings
      WHERE thread_id = ${first.threadId}
    `;
    yield* cold.purge(first.threadId);
    assert.equal(yield* sessionCount, 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("restores bundles across compatible column changes", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("compat");
    yield* cold.archive(threadId, Effect.void);
    // A later migration added a column and dropped one the bundle still holds.
    yield* sql`
      ALTER TABLE orchestration_v2_projection_messages
      ADD COLUMN cold_test TEXT NOT NULL DEFAULT 'defaulted'
    `;
    const chunks = yield* sql<{ readonly chunk_index: number; readonly data: Uint8Array }>`
      SELECT chunk_index, data FROM cold_archive.archive_thread_chunks
      WHERE thread_id = ${threadId} AND kind = 'table:orchestration_v2_projection_messages'
    `;
    for (const chunk of chunks) {
      const rows = decodeChunkRows(NodeZlib.gunzipSync(chunk.data).toString("utf8"));
      const data = NodeZlib.gzipSync(
        encodeChunkRows(rows.map((row) => ({ ...row, removed_column: "gone" }))),
      );
      yield* sql`
        UPDATE cold_archive.archive_thread_chunks SET data = ${new Uint8Array(data)}
        WHERE thread_id = ${threadId} AND chunk_index = ${chunk.chunk_index}
      `;
    }

    yield* cold.withHot(threadId, Effect.void);

    const restored = yield* sql<{ readonly cold_test: string }>`
      SELECT cold_test FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(
      restored.map((row) => row.cold_test),
      ["defaulted"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("moves an archived fork source cold once its last fork is purged", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId: sourceId } = yield* seedArchivedThread("kept-source");
    const forkId = ThreadId.make("thread:kept-source-fork");
    yield* createFork(forkId, sourceId, "kept-source-fork");
    yield* cold.archive(sourceId, Effect.void);
    assert.equal(yield* manifestStatus(sourceId), "kept-hot");

    yield* markDeleted(forkId, "kept-source-fork", {
      forkedFrom: forkedFrom(sourceId, "kept-source-fork"),
    });
    yield* cold.purge(forkId);
    const queued = yield* sql`
      SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${sourceId} AND effect_type = 'thread.cold-archive' AND status = 'pending'
    `;
    assert.lengthOf(queued, 1);

    yield* cold.archive(sourceId, Effect.void);
    assert.equal(yield* manifestStatus(sourceId), "cold");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("defers a purge while a read or command holds the thread", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* seedArchivedThread("purge-lease", { archive: false });
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const lease = yield* cold
      .withHot(
        threadId,
        Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(holding);
    yield* markDeleted(threadId, "purge-lease");

    yield* cold.purge(threadId);

    assert.isNull(yield* manifestStatus(threadId));
    assert.equal((yield* hotCounts(threadId)).messages, 1);
    const retry = yield* sql`
      SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'thread.storage-purge'
        AND status = 'pending' AND effect_id LIKE '%:busy:%'
    `;
    assert.lengthOf(retry, 1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(lease);

    yield* cold.purge(threadId);
    assert.equal(yield* manifestStatus(threadId), "purged");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("an interrupted restore is finished as a move", () =>
  Effect.gen(function* () {
    const cold = yield* ThreadColdStorage.ThreadColdStorage;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const { threadId, attachmentPath } = yield* seedArchivedThread("interrupted-restore");
    yield* cold.archive(threadId, Effect.void);
    // A row chunk that cannot be decoded stops the restore after its files.
    yield* sql`
      UPDATE cold_archive.archive_thread_chunks SET data = ${new Uint8Array([1, 2, 3])}
      WHERE thread_id = ${threadId} AND kind = 'table:orchestration_v2_projection_messages'
    `;

    yield* Effect.flip(cold.withHot(threadId, Effect.void));

    assert.equal(yield* manifestStatus(threadId), "moving");
    assert.isTrue(yield* fs.exists(attachmentPath));
    yield* cold.reconcile;
    const queued = yield* sql`
      SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'thread.cold-archive' AND status = 'pending'
    `;
    assert.lengthOf(queued, 1);

    yield* cold.archive(threadId, Effect.void);
    assert.equal(yield* manifestStatus(threadId), "cold");
    assert.isFalse(yield* fs.exists(attachmentPath));
  }).pipe(Effect.provide(TestLayer)),
);

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import ProjectionThreadsSettled from "./038_ProjectionThreadsSettled.ts";
import ProjectionThreadsSnoozed from "./039_ProjectionThreadsSnoozed.ts";
import ProjectionThreadTitleRegeneration from "./040_ProjectionThreadTitleRegeneration.ts";
import ProjectionThreadsPinned from "./042_ProjectionThreadsPinned.ts";
import ProjectionTurnsKeysetIndex from "./043_ProjectionTurnsKeysetIndex.ts";
import ProjectionThreadsPinOrderKey from "./044_ProjectionThreadsPinOrderKey.ts";
import ProjectionProjectsDefaultThreadEnvMode from "./045_ProjectionProjectsDefaultThreadEnvMode.ts";
import ProjectionProjectFaviconPath from "./046_ProjectionProjectFaviconPath.ts";
import AuthSessionClientConnection from "./045_AuthSessionClientConnection.ts";
import ProjectionThreadLinkedPullRequest from "./046_ProjectionThreadLinkedPullRequest.ts";
import ProjectionThreadsUnsettledAt from "./047_ProjectionThreadsUnsettledAt.ts";
import ClearAutomaticProjectModelDefaults from "./048_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./049_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./051_RepairAutomaticSettlementTimestamps.ts";
import ProjectionProjectIcon from "./052_ProjectionProjectIcon.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035-037 thread storage lifecycle migrations", (it) => {
  it.effect("queues archived and deleted threads and groups archived subagents by root", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      const insertThread = (input: {
        readonly threadId: string;
        readonly rootThreadId: string;
        readonly parentKind: "root" | "subagent";
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
      }) => sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at,
          parent_kind, root_thread_id
        ) VALUES (
          ${input.threadId}, 'project-1', ${input.threadId},
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z', ${input.archivedAt}, ${input.deletedAt},
          ${input.parentKind}, ${input.rootThreadId}
        )
      `;

      yield* insertThread({
        threadId: "archived-root",
        rootThreadId: "archived-root",
        parentKind: "root",
        archivedAt: "2026-07-02T00:00:00.000Z",
        deletedAt: null,
      });
      yield* insertThread({
        threadId: "archived-child",
        rootThreadId: "archived-root",
        parentKind: "subagent",
        archivedAt: "2026-07-02T00:00:00.000Z",
        deletedAt: null,
      });
      yield* insertThread({
        threadId: "deleted-thread",
        rootThreadId: "deleted-thread",
        parentKind: "root",
        archivedAt: null,
        deletedAt: "2026-07-03T00:00:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 37 });

      const manifests = yield* sql<{
        readonly threadId: string;
        readonly rootThreadId: string;
        readonly status: string;
      }>`
        SELECT thread_id AS "threadId", root_thread_id AS "rootThreadId", status
        FROM thread_archive_manifests
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(manifests, [
        { threadId: "archived-child", rootThreadId: "archived-root", status: "pending" },
        { threadId: "archived-root", rootThreadId: "archived-root", status: "pending" },
      ]);

      const cleanup = yield* sql<{ readonly threadId: string; readonly reason: string }>`
        SELECT thread_id AS "threadId", reason FROM thread_cleanup_queue
      `;
      assert.deepStrictEqual(cleanup, [{ threadId: "deleted-thread", reason: "deleted" }]);
    }),
  );
});

const forkHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

forkHistoryLayer("041 fork-history compatibility", (it) => {
  it.effect("preserves lifecycle state when cold archive setup reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'cold-thread', 'project-1', 'Cold thread',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL
          ),
          (
            'cleanup-pending-thread', 'project-1', 'Cleanup pending thread',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        UPDATE thread_archive_manifests
        SET
          status = CASE thread_id
            WHEN 'cold-thread' THEN 'cold'
            ELSE 'cleanup_pending'
          END,
          original_bytes = CASE thread_id
            WHEN 'cold-thread' THEN 1024
            ELSE 2048
          END,
          compressed_bytes = CASE thread_id
            WHEN 'cold-thread' THEN 512
            ELSE 1024
          END
        WHERE thread_id IN ('cold-thread', 'cleanup-pending-thread')
      `;
      yield* sql`
        UPDATE thread_storage_maintenance
        SET status = 'complete'
        WHERE task = 'compact-legacy-thread-storage'
      `;

      const readManifests = () =>
        sql<{
          readonly threadId: string;
          readonly status: string;
          readonly originalBytes: number;
          readonly compressedBytes: number;
        }>`
          SELECT
            thread_id AS "threadId",
            status,
            original_bytes AS "originalBytes",
            compressed_bytes AS "compressedBytes"
          FROM thread_archive_manifests
          ORDER BY thread_id
        `;
      const readMaintenance = () =>
        sql<{ readonly task: string; readonly status: string }>`
          SELECT task, status
          FROM thread_storage_maintenance
          ORDER BY task
        `;
      const beforeManifests = yield* readManifests();
      const beforeMaintenance = yield* readMaintenance();

      const executed = yield* runMigrations({ toMigrationInclusive: 41 });
      assert.deepStrictEqual(executed, [
        [37, "SubagentColdArchiveGlue"],
        [38, "ProjectionThreadsSettled"],
        [39, "ProjectionThreadsSnoozed"],
        [40, "ProjectionThreadTitleRegeneration"],
        [41, "ThreadColdArchiveCompatibility"],
      ]);
      assert.deepStrictEqual(yield* readManifests(), beforeManifests);
      assert.deepStrictEqual(yield* readMaintenance(), beforeMaintenance);
    }),
  );
});

const upstreamSnoozeMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamSnoozeMigrationLayer("035 thread storage upstream snooze convergence", (it) => {
  it.effect("converges an upstream database that already recorded snooze migration 34", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          deleted_at
        )
        VALUES (
          'thread-upstream-34',
          'project-upstream-34',
          'Upstream migration 34',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-07-25T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const rows = yield* sql<{
        readonly rootThreadId: string;
        readonly snoozedUntil: string | null;
      }>`
        SELECT
          root_thread_id AS "rootThreadId",
          snoozed_until AS "snoozedUntil"
        FROM projection_threads
        WHERE thread_id = 'thread-upstream-34'
      `;

      assert.isTrue(columns.some((column) => column.name === "parent_kind"));
      assert.isTrue(columns.some((column) => column.name === "settled_override"));
      assert.isTrue(columns.some((column) => column.name === "snoozed_until"));
      assert.deepStrictEqual(rows, [
        {
          rootThreadId: "thread-upstream-34",
          snoozedUntil: "2026-07-25T00:00:00.000Z",
        },
      ]);
    }),
  );
});

const upstreamTitleMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamTitleMigrationLayer("035 thread storage upstream title convergence", (it) => {
  it.effect("bridges databases that recorded upstream title regeneration as migration 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-upstream-title-35',
          'project-upstream-title-35',
          'Upstream title migration',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          '2026-07-25T00:00:00.000Z',
          NULL
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 41 });
      assert.deepStrictEqual(executed, [
        [35, "ThreadColdArchive"],
        [36, "DeletedThreadCleanupQueue"],
        [37, "SubagentColdArchiveGlue"],
        [38, "ProjectionThreadsSettled"],
        [39, "ProjectionThreadsSnoozed"],
        [40, "ProjectionThreadTitleRegeneration"],
        [41, "ThreadColdArchiveCompatibility"],
      ]);

      const manifests = yield* sql<{
        readonly threadId: string;
        readonly rootThreadId: string;
        readonly status: string;
      }>`
        SELECT
          thread_id AS "threadId",
          root_thread_id AS "rootThreadId",
          status
        FROM thread_archive_manifests
      `;
      assert.deepStrictEqual(manifests, [
        {
          threadId: "thread-upstream-title-35",
          rootThreadId: "thread-upstream-title-35",
          status: "pending",
        },
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.isTrue(names.has("root_thread_id"));
      assert.isTrue(names.has("title_regeneration_request_id"));
      assert.isTrue(names.has("title_regeneration_started_at"));
    }),
  );
});

const upstreamPinningMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamPinningMigrationLayer("038 thread storage upstream pinning convergence", (it) => {
  it.effect("rehomes upstream pinning migrations after the fork lifecycle range", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* ProjectionThreadsPinned;
      yield* ProjectionTurnsKeysetIndex;
      yield* ProjectionThreadsPinOrderKey;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at,
          archived_at,
          pinned_at,
          pin_order_key,
          deleted_at
        )
        VALUES (
          'thread-upstream-pin-38',
          'project-upstream-pin-38',
          'Upstream pinning migration',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          NULL,
          '2026-08-02T00:00:00.000Z',
          'm',
          NULL
        )
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [35, "ThreadColdArchive"],
        [36, "DeletedThreadCleanupQueue"],
        [37, "SubagentColdArchiveGlue"],
        [38, "ProjectionThreadsSettled"],
        [39, "ProjectionThreadsSnoozed"],
        [40, "ProjectionThreadTitleRegeneration"],
        [41, "ThreadColdArchiveCompatibility"],
        [42, "ProjectionThreadsPinned"],
        [43, "ProjectionTurnsKeysetIndex"],
        [44, "ProjectionThreadsPinOrderKey"],
        [45, "ProjectionProjectsDefaultThreadEnvMode"],
        [46, "ProjectionProjectFaviconPath"],
        [47, "ThreadStorageLifecycleCompatibility"],
        [48, "MagiProjections"],
        [49, "MagiActiveConversationUniqueness"],
        [50, "MagiProposalTerminology"],
        [51, "MagiThreadColdArchiveGlue"],
        [52, "AuthSessionClientConnection"],
        [53, "ProjectionThreadLinkedPullRequest"],
        [54, "ProjectionThreadsUnsettledAt"],
        [55, "ClearAutomaticProjectModelDefaults"],
        [56, "ProjectionProjectsAutoPull"],
        [57, "ProjectionThreadLineageConvergenceAfterUpstreamTail"],
        [58, "RepairAutomaticSettlementTimestamps"],
        [59, "ProjectionProjectIcon"],
        [60, "MagiCoreMigrationCompatibility"],
      ]);

      const rows = yield* sql<{
        readonly pinnedAt: string | null;
        readonly pinOrderKey: string | null;
        readonly parentKind: string;
        readonly rootThreadId: string;
      }>`
        SELECT
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          parent_kind AS "parentKind",
          root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-upstream-pin-38'
      `;
      assert.deepStrictEqual(rows, [
        {
          pinnedAt: "2026-08-02T00:00:00.000Z",
          pinOrderKey: "m",
          parentKind: "root",
          rootThreadId: "thread-upstream-pin-38",
        },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_turns_thread_keyset'
      `;
      assert.lengthOf(indexes, 1);
    }),
  );
});

const currentUpstreamHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

currentUpstreamHistoryLayer("047 current-upstream compatibility", (it) => {
  it.effect("creates lifecycle tables after upstream migrations through 47", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'upstream-current-archived', 'project-1', 'Archived',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL
          ),
          (
            'upstream-current-deleted', 'project-1', 'Deleted',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', NULL, '2026-07-03T00:00:00.000Z'
          )
      `;

      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* ProjectionThreadsPinned;
      yield* ProjectionTurnsKeysetIndex;
      yield* ProjectionThreadsPinOrderKey;
      yield* ProjectionProjectsDefaultThreadEnvMode;
      yield* ProjectionProjectFaviconPath;
      yield* AuthSessionClientConnection;
      yield* ProjectionThreadLinkedPullRequest;
      yield* ProjectionThreadsUnsettledAt;
      yield* ClearAutomaticProjectModelDefaults;
      yield* ProjectionProjectsAutoPull;
      yield* RepairAutomaticSettlementTimestamps;
      yield* ProjectionProjectIcon;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath'),
          (41, 'AuthSessionClientConnection'),
          (42, 'ProjectionThreadLinkedPullRequest'),
          (43, 'ProjectionThreadsUnsettledAt'),
          (44, 'ClearAutomaticProjectModelDefaults'),
          (45, 'ProjectionProjectsAutoPull'),
          (46, 'RepairAutomaticSettlementTimestamps'),
          (47, 'ProjectionProjectIcon')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 47 });
      assert.deepStrictEqual(executed, [
        [35, "ThreadColdArchive"],
        [36, "DeletedThreadCleanupQueue"],
        [37, "SubagentColdArchiveGlue"],
        [38, "ProjectionThreadsSettled"],
        [39, "ProjectionThreadsSnoozed"],
        [40, "ProjectionThreadTitleRegeneration"],
        [41, "ThreadColdArchiveCompatibility"],
        [42, "ProjectionThreadsPinned"],
        [43, "ProjectionTurnsKeysetIndex"],
        [44, "ProjectionThreadsPinOrderKey"],
        [45, "ProjectionProjectsDefaultThreadEnvMode"],
        [46, "ProjectionProjectFaviconPath"],
        [47, "ThreadStorageLifecycleCompatibility"],
      ]);

      const manifests = yield* sql<{ readonly threadId: string; readonly status: string }>`
        SELECT thread_id AS "threadId", status FROM thread_archive_manifests
      `;
      assert.deepStrictEqual(manifests, [
        { threadId: "upstream-current-archived", status: "pending" },
      ]);

      const cleanup = yield* sql<{ readonly threadId: string; readonly reason: string }>`
        SELECT thread_id AS "threadId", reason FROM thread_cleanup_queue
      `;
      assert.deepStrictEqual(cleanup, [
        { threadId: "upstream-current-deleted", reason: "deleted" },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import BackfillEmptyProjectionThreadRootIds from "./035_BackfillEmptyProjectionThreadRootIds.ts";
import ProjectionThreadsSnoozed from "./036_ProjectionThreadsSnoozed.ts";
import ProjectionThreadTitleRegeneration from "./037_ProjectionThreadTitleRegeneration.ts";
import ProjectionThreadsPinned from "./038_ProjectionThreadsPinned.ts";
import ProjectionTurnsKeysetIndex from "./040_ProjectionTurnsKeysetIndex.ts";
import ProjectionThreadsPinOrderKey from "./041_ProjectionThreadsPinOrderKey.ts";
import ProjectionProjectsDefaultThreadEnvMode from "./042_ProjectionProjectsDefaultThreadEnvMode.ts";
import ProjectionProjectFaviconPath from "./043_ProjectionProjectFaviconPath.ts";
import AuthSessionClientConnection from "./045_AuthSessionClientConnection.ts";
import ProjectionThreadLinkedPullRequest from "./046_ProjectionThreadLinkedPullRequest.ts";
import ProjectionThreadsUnsettledAt from "./047_ProjectionThreadsUnsettledAt.ts";
import ClearAutomaticProjectModelDefaults from "./048_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./049_ProjectionProjectsAutoPull.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const currentMigrationTail = migrationManifest
  .filter(([id]) => id > 44)
  .map(([id, name]) => ({ id, name }));
const currentMigrationsAfterIncomingTail = migrationManifest
  .filter(([id]) => id > 45)
  .map(([id, name]) => ({ id, name }));

layer("035_BackfillEmptyProjectionThreadRootIds", (it) => {
  it.effect("backfills empty root thread ids left by earlier projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          parent_kind,
          root_thread_id,
          parent_thread_id,
          parent_turn_id,
          parent_item_id,
          parent_activity_sequence,
          provider_thread_id,
          title_seed,
          subagent_depth,
          subagent_started_at,
          subagent_completed_at,
          subagent_status,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-empty-root',
          'project-empty-root',
          'Empty root id',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          NULL,
          NULL,
          'root',
          '',
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-06-12T00:00:00.000Z',
          '2026-06-12T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-empty-root'
      `;

      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-empty-root" }]);
    }),
  );
});

const upstreamMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamMigrationLayer("035_BackfillEmptyProjectionThreadRootIds upstream convergence", (it) => {
  it.effect("converges an upstream database that already recorded snooze migration 34", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* ProjectionThreadsSnoozed;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (34, 'ProjectionThreadsSnoozed')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-upstream-34',
          'project-upstream-34',
          'Upstream migration 34',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-07-25T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const migrations = yield* sql<{
        readonly id: number;
        readonly name: string;
      }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id ASC
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
      assert.isTrue(columns.some((column) => column.name === "title_regeneration_request_id"));
      assert.isTrue(columns.some((column) => column.name === "title_regeneration_started_at"));
      assert.isTrue(columns.some((column) => column.name === "pin_order_key"));
      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(projectColumns.some((column) => column.name === "default_thread_env_mode"));
      assert.isTrue(projectColumns.some((column) => column.name === "favicon_path"));
      assert.deepStrictEqual(migrations, [
        { id: 34, name: "ProjectionThreadsSnoozed" },
        { id: 35, name: "BackfillEmptyProjectionThreadRootIds" },
        { id: 36, name: "ProjectionThreadsSnoozed" },
        { id: 37, name: "ProjectionThreadTitleRegeneration" },
        { id: 38, name: "ProjectionThreadsPinned" },
        { id: 39, name: "ProjectionThreadLineageConvergence" },
        { id: 40, name: "ProjectionTurnsKeysetIndex" },
        { id: 41, name: "ProjectionThreadsPinOrderKey" },
        { id: 42, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { id: 43, name: "ProjectionProjectFaviconPath" },
        { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
        ...currentMigrationTail,
      ]);
      assert.deepStrictEqual(rows, [
        {
          rootThreadId: "thread-upstream-34",
          snoozedUntil: "2026-07-25T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("converges an upstream database that already recorded migrations through 38", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* ProjectionThreadsPinned;
      // Upstream recorded pin ordering at id 38. The merged branch installs
      // its idempotent equivalent again at 41 after lineage convergence.
      yield* ProjectionThreadsPinOrderKey;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
        ON projection_turns(thread_id, requested_at, turn_id)
      `;
      // This layer is shared across cases: preserve the accumulated schema
      // while replacing its recorded post-33 history with the upstream one.
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id > 33
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
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
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        )
        VALUES (
          'thread-upstream-38',
          'project-upstream-38',
          'Upstream migration 38',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-08-07T00:00:00.000Z',
          '2026-08-07T00:00:00.000Z',
          0,
          0,
          0
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-upstream-38'
      `;
      const migrations = yield* sql<{
        readonly id: number;
        readonly name: string;
      }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id ASC
      `;
      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-upstream-38" }]);
      assert.deepStrictEqual(migrations, [
        { id: 34, name: "ProjectionThreadsSnoozed" },
        { id: 35, name: "ProjectionThreadTitleRegeneration" },
        { id: 36, name: "ProjectionThreadsPinned" },
        { id: 37, name: "ProjectionTurnsKeysetIndex" },
        { id: 38, name: "ProjectionThreadsPinOrderKey" },
        { id: 39, name: "ProjectionThreadLineageConvergence" },
        { id: 40, name: "ProjectionTurnsKeysetIndex" },
        { id: 41, name: "ProjectionThreadsPinOrderKey" },
        { id: 42, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { id: 43, name: "ProjectionProjectFaviconPath" },
        { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
        ...currentMigrationTail,
      ]);
    }),
  );

  for (const recordedThrough of [39, 40] as const) {
    it.effect(`continues from the earlier merged branch through ${recordedThrough}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = `thread-earlier-merge-${recordedThrough}`;

        yield* runMigrations({ toMigrationInclusive: 33 });
        yield* ProjectionThreadsSnoozed;
        yield* ProjectionThreadTitleRegeneration;
        yield* ProjectionThreadsPinned;
        yield* ProjectionThreadsPinOrderKey;
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
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan
          )
          VALUES (
            ${threadId},
            'project-earlier-merge',
            'Earlier merged branch',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access',
            'default',
            '2026-08-07T00:00:00.000Z',
            '2026-08-07T00:00:00.000Z',
            0,
            0,
            0
          )
        `;

        // The earlier merged branch's migration 39 already ran this exact
        // convergence before recording its keyset-index name at that id.
        yield* BackfillEmptyProjectionThreadRootIds;
        yield* sql`
          CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
          ON projection_turns(thread_id, requested_at, turn_id)
        `;
        // The test layer retains schema and data between cases; replace only
        // the migration ledger with the earlier merge candidate's history.
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id > 33
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (34, 'ProjectionThreadsSnoozed'),
            (35, 'ProjectionThreadTitleRegeneration'),
            (36, 'ProjectionThreadsPinned'),
            (37, 'ProjectionTurnsKeysetIndex'),
            (38, 'ProjectionThreadsPinOrderKey'),
            (39, 'ProjectionTurnsKeysetIndex')
        `;
        if (recordedThrough === 40) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (40, 'ProjectionThreadsPinOrderKey')
          `;
        }

        yield* runMigrations();

        const rows = yield* sql<{ readonly rootThreadId: string }>`
          SELECT root_thread_id AS "rootThreadId"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
          SELECT migration_id AS id, name
          FROM effect_sql_migrations
          WHERE migration_id >= 39
          ORDER BY migration_id ASC
        `;

        assert.deepStrictEqual(rows, [{ rootThreadId: threadId }]);
        assert.deepStrictEqual(
          migrations,
          recordedThrough === 39
            ? [
                { id: 39, name: "ProjectionTurnsKeysetIndex" },
                { id: 40, name: "ProjectionTurnsKeysetIndex" },
                { id: 41, name: "ProjectionThreadsPinOrderKey" },
                { id: 42, name: "ProjectionProjectsDefaultThreadEnvMode" },
                { id: 43, name: "ProjectionProjectFaviconPath" },
                { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
                ...currentMigrationTail,
              ]
            : [
                { id: 39, name: "ProjectionTurnsKeysetIndex" },
                { id: 40, name: "ProjectionThreadsPinOrderKey" },
                { id: 41, name: "ProjectionThreadsPinOrderKey" },
                { id: 42, name: "ProjectionProjectsDefaultThreadEnvMode" },
                { id: 43, name: "ProjectionProjectFaviconPath" },
                { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
                ...currentMigrationTail,
              ],
        );
      }),
    );
  }
});

const upstreamProjectMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamProjectMigrationLayer("project migration ledger lineage convergence", (it) => {
  it.effect("converges an upstream database already recorded through project migration 40", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* ProjectionThreadsPinned;
      yield* ProjectionTurnsKeysetIndex;
      yield* ProjectionThreadsPinOrderKey;
      yield* ProjectionProjectsDefaultThreadEnvMode;
      yield* ProjectionProjectFaviconPath;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath')
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
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        )
        VALUES (
          'thread-upstream-project-40',
          'project-upstream-project-40',
          'Upstream project migration 40',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-08-09T00:00:00.000Z',
          '2026-08-09T00:00:00.000Z',
          0,
          0,
          0
        )
      `;

      yield* runMigrations();

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-upstream-project-40'
      `;
      const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id ASC
      `;

      assert.isTrue(threadColumns.some((column) => column.name === "parent_kind"));
      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-upstream-project-40" }]);
      assert.deepStrictEqual(migrations, [
        { id: 34, name: "ProjectionThreadsSnoozed" },
        { id: 35, name: "ProjectionThreadTitleRegeneration" },
        { id: 36, name: "ProjectionThreadsPinned" },
        { id: 37, name: "ProjectionTurnsKeysetIndex" },
        { id: 38, name: "ProjectionThreadsPinOrderKey" },
        { id: 39, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { id: 40, name: "ProjectionProjectFaviconPath" },
        { id: 41, name: "ProjectionThreadsPinOrderKey" },
        { id: 42, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { id: 43, name: "ProjectionProjectFaviconPath" },
        { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
        ...currentMigrationTail,
      ]);
    }),
  );
});

const incomingUpstreamMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

incomingUpstreamMigrationLayer("incoming upstream migration ledger lineage convergence", (it) => {
  it.effect("converges an upstream database already recorded through migration 43", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
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
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath'),
          (41, 'AuthSessionClientConnection'),
          (42, 'ProjectionThreadLinkedPullRequest'),
          (43, 'ProjectionThreadsUnsettledAt')
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
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        )
        VALUES (
          'thread-incoming-upstream-43',
          'project-incoming-upstream-43',
          'Incoming upstream migration 43',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-08-27T00:00:00.000Z',
          '2026-08-27T00:00:00.000Z',
          0,
          0,
          0
        )
      `;

      yield* runMigrations();

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-incoming-upstream-43'
      `;
      const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id ASC
      `;

      assert.isTrue(threadColumns.some((column) => column.name === "parent_kind"));
      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-incoming-upstream-43" }]);
      assert.deepStrictEqual(migrations, [
        { id: 34, name: "ProjectionThreadsSnoozed" },
        { id: 35, name: "ProjectionThreadTitleRegeneration" },
        { id: 36, name: "ProjectionThreadsPinned" },
        { id: 37, name: "ProjectionTurnsKeysetIndex" },
        { id: 38, name: "ProjectionThreadsPinOrderKey" },
        { id: 39, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { id: 40, name: "ProjectionProjectFaviconPath" },
        { id: 41, name: "AuthSessionClientConnection" },
        { id: 42, name: "ProjectionThreadLinkedPullRequest" },
        { id: 43, name: "ProjectionThreadsUnsettledAt" },
        { id: 44, name: "ProjectionThreadLineageConvergenceAfterProjectMigrations" },
        ...currentMigrationTail,
      ]);
    }),
  );
});

const incomingUpstreamTailMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

incomingUpstreamTailMigrationLayer(
  "incoming upstream tail migration ledger lineage convergence",
  (it) => {
    it.effect("converges an upstream database already recorded through migration 45", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 33 });
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
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (34, 'ProjectionThreadsSnoozed'),
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
          (45, 'ProjectionProjectsAutoPull')
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
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        )
        VALUES (
          'thread-incoming-upstream-45',
          'project-incoming-upstream-45',
          'Incoming upstream migration 45',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          '2026-09-03T00:00:00.000Z',
          '2026-09-03T00:00:00.000Z',
          0,
          0,
          0
        )
      `;

        yield* runMigrations();

        const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-incoming-upstream-45'
      `;
        const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id ASC
      `;

        assert.isTrue(threadColumns.some((column) => column.name === "parent_kind"));
        assert.deepStrictEqual(rows, [{ rootThreadId: "thread-incoming-upstream-45" }]);
        assert.deepStrictEqual(migrations, [
          { id: 34, name: "ProjectionThreadsSnoozed" },
          { id: 35, name: "ProjectionThreadTitleRegeneration" },
          { id: 36, name: "ProjectionThreadsPinned" },
          { id: 37, name: "ProjectionTurnsKeysetIndex" },
          { id: 38, name: "ProjectionThreadsPinOrderKey" },
          { id: 39, name: "ProjectionProjectsDefaultThreadEnvMode" },
          { id: 40, name: "ProjectionProjectFaviconPath" },
          { id: 41, name: "AuthSessionClientConnection" },
          { id: 42, name: "ProjectionThreadLinkedPullRequest" },
          { id: 43, name: "ProjectionThreadsUnsettledAt" },
          { id: 44, name: "ClearAutomaticProjectModelDefaults" },
          { id: 45, name: "ProjectionProjectsAutoPull" },
          ...currentMigrationsAfterIncomingTail,
        ]);
      }),
    );
  },
);

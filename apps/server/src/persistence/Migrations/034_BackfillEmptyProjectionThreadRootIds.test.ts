import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import ProjectionThreadsSettled from "./038_ProjectionThreadsSettled.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_BackfillEmptyProjectionThreadRootIds", (it) => {
  it.effect("backfills empty root thread ids left by earlier projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

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

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-empty-root'
      `;

      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-empty-root" }]);
    }),
  );
});

const upstream33Layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstream33Layer("034 upstream settlement compatibility", (it) => {
  it.effect("converges a database recorded through upstream migration 33", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'ProjectionThreadsSettled')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan,
          settled_override, settled_at
        ) VALUES (
          'thread-upstream-settled-33', 'project-upstream-settled-33',
          'Upstream settled thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', 0, 0, 0,
          'settled', '2026-08-02T00:00:00.000Z'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 34 });
      assert.deepStrictEqual(executed, [[34, "BackfillEmptyProjectionThreadRootIds"]]);

      const rows = yield* sql<{
        readonly parentKind: string;
        readonly rootThreadId: string;
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          parent_kind AS "parentKind",
          root_thread_id AS "rootThreadId",
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-upstream-settled-33'
      `;
      assert.deepStrictEqual(rows, [
        {
          parentKind: "root",
          rootThreadId: "thread-upstream-settled-33",
          settledOverride: "settled",
          settledAt: "2026-08-02T00:00:00.000Z",
        },
      ]);
    }),
  );
});

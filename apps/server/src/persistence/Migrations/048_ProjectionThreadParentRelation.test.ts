import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048 projection thread parent relation", (it) => {
  it.effect("adds the final lineage schema and backfills existing roots", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'existing-thread', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z'
        )
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[48, "ProjectionThreadParentRelation"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const columnNames = new Set(columns.map((column) => column.name));
      assert.deepStrictEqual(
        [
          "parent_kind",
          "root_thread_id",
          "parent_thread_id",
          "parent_turn_id",
          "parent_item_id",
          "parent_activity_sequence",
          "provider_thread_id",
          "title_seed",
          "subagent_depth",
          "subagent_started_at",
          "subagent_completed_at",
          "subagent_status",
        ].filter((name) => !columnNames.has(name)),
        [],
      );

      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'existing-thread'
      `;
      assert.deepStrictEqual(rows, [{ rootThreadId: "existing-thread" }]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_projection_threads_parent_relation',
            'idx_projection_threads_root_relation'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_projection_threads_parent_relation" },
        { name: "idx_projection_threads_root_relation" },
      ]);
    }),
  );
});

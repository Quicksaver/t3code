import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048 Magi projections", (it) => {
  it.effect("migrates pre-Magi threads without inventing active state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(before.some((column) => column.name === "active_magi_run_json"));

      yield* runMigrations({ toMigrationInclusive: 48 });
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(after.some((column) => column.name === "active_magi_run_json"));

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'projection_magi_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "projection_magi_action_batches",
          "projection_magi_action_reconciliations",
          "projection_magi_actions",
          "projection_magi_arms",
          "projection_magi_exclusive_decision_sets",
          "projection_magi_exclusive_set_evaluations",
          "projection_magi_members",
          "projection_magi_proposal_evaluations",
          "projection_magi_proposals",
          "projection_magi_responses",
          "projection_magi_runs",
          "projection_magi_turns",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name = 'uq_projection_magi_runs_active_conversation'
      `;
      assert.deepStrictEqual(indexes, [{ name: "uq_projection_magi_runs_active_conversation" }]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("061_MagiProjections", (it) => {
  it.effect("adds only Magi tables after the orchestration V2 schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 61 }), [
        [61, "MagiProjections"],
      ]);
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const added = after
        .map((row) => row.name)
        .filter((name) => !before.some((row) => row.name === name));
      assert.deepStrictEqual(added, [
        "magi_arms",
        "magi_context_artifacts",
        "magi_context_grants",
        "magi_run_audiences",
        "magi_run_participants",
        "magi_runs",
      ]);
    }),
  );
});

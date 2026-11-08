import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("090_DropMagiTables", (it) => {
  it.effect("drops the former Magi run store and leaves other tables alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`CREATE TABLE magi_runs (run_id TEXT PRIMARY KEY, snapshot_json TEXT)`;
      yield* sql`CREATE TABLE magi_context_grants (artifact_id TEXT, thread_id TEXT)`;
      yield* sql`CREATE TABLE projection_magi_runs (run_id TEXT)`;
      yield* sql`INSERT INTO magi_runs VALUES ('run-1', '{}')`;
      yield* runMigrations({ toMigrationInclusive: 90 });
      const remaining = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND (name GLOB '*magi*' OR name = 'projection_threads')
      `;
      assert.deepEqual(remaining, [{ name: "projection_threads" }]);
    }),
  );
});

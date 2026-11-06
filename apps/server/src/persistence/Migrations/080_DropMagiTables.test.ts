import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("078_DropMagiTables", (it) => {
  it.effect("drops the former Magi run store and leaves other tables alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`CREATE TABLE projection_magi_runs (run_id TEXT)`;
      yield* sql`
        INSERT INTO magi_runs
          (run_id, root_thread_id, state, snapshot_json, started_at, updated_at)
        VALUES ('run-1', 'thread-1', 'completed', '{}', '2026-11-02', '2026-11-02')
      `;
      yield* runMigrations({ toMigrationInclusive: 95 });
      const remaining = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND (name GLOB '*magi*' OR name = 'projection_threads')
      `;
      assert.deepEqual(remaining, [{ name: "projection_threads" }]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PUBLISHED_FORK_MIGRATION_ID, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("071_ThreadStorageLifecycle", (it) => {
  it.effect("keeps published V1 cold-storage rows aside and starts V2 manifests empty", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: PUBLISHED_FORK_MIGRATION_ID });
      yield* sql`
          INSERT INTO thread_archive_manifests (thread_id, root_thread_id, status, archived_at, updated_at)
          VALUES ('v1-cold', 'v1-cold', 'cold', '2026-07-01', '2026-07-01')
        `;

      yield* runMigrations({ toMigrationInclusive: 71 });

      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, status FROM legacy_v1_thread_archive_manifests`,
        [{ thread_id: "v1-cold", status: "cold" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT task, status FROM legacy_v1_thread_storage_maintenance`,
        [{ task: "compact-legacy-thread-storage", status: "pending" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_archive_manifests`, []);
      const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(thread_archive_manifests)
        `;
      assert.ok(columns.some((column) => column.name === "shell_json"));
      assert.deepStrictEqual(yield* sql`SELECT task, status FROM thread_storage_maintenance`, [
        { task: "compact-thread-storage", status: "pending" },
      ]);
    }),
  );
});

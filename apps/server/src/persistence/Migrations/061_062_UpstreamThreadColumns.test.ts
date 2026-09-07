import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("published fork migration upgrade", (it) => {
  it.effect("adds upstream columns while preserving the published ledger and thread data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const before =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, root_thread_id
        ) VALUES ('existing', 'project', 'Retained thread', '2026-09-01', '2026-09-01', 'existing')
      `;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [61, "ProjectionThreadBranchPullRequest"],
        [62, "ProjectionThreadsActiveOrderKey"],
      ]);
      const published =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`;
      assert.deepStrictEqual(published, before);
      const threads =
        yield* sql`SELECT title, root_thread_id, branch_pull_request_json, active_order_key FROM projection_threads WHERE thread_id = 'existing'`;
      assert.deepStrictEqual(threads, [
        {
          title: "Retained thread",
          root_thread_id: "existing",
          branch_pull_request_json: null,
          active_order_key: null,
        },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

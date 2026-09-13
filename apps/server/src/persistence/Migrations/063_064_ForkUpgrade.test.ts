import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("published fork migration upgrade", (it) => {
  it.effect("preserves published history and migrates existing linked pull requests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      const before =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, root_thread_id, linked_pull_request_json
        ) VALUES ('existing', 'project', 'Retained thread', '2026-09-01', '2026-09-01', 'existing',
          '{"repository":"owner/repo","number":12,"url":"https://github.com/owner/repo/pull/12"}')
      `;
      assert.deepStrictEqual(yield* runMigrations(), [
        [63, "ProjectionThreadPullRequests"],
        [64, "ProjectionThreadMessageContext"],
      ]);
      const published =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 62 ORDER BY migration_id`;
      assert.deepStrictEqual(published, before);
      const links =
        yield* sql`SELECT thread_id, repository, number, source FROM projection_thread_pull_requests`;
      assert.deepStrictEqual(links, [
        { thread_id: "existing", repository: "owner/repo", number: 12, source: "manual" },
      ]);
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.ok(columns.some((column) => column.name === "context_json"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

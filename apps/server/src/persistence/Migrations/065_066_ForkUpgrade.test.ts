import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "published fork title and review upgrade",
  (it) => {
    it.effect("keeps the published ledger and adds title state and viewed files", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 64 });
        const before =
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('retained', 'project', 'Retained title', '2026-09-19', '2026-09-19')`;
        assert.deepStrictEqual(yield* runMigrations(), [
          [65, "ProjectionThreadTitleState"],
          [66, "PullRequestFilesViewed"],
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 64 ORDER BY migration_id`,
          before,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT title, title_state_json FROM projection_threads WHERE thread_id = 'retained'`,
          [{ title: "Retained title", title_state_json: null }],
        );
        yield* sql`INSERT INTO pull_request_files_viewed (provider, host, repository, number, viewer, path, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'reader', 'file.ts', '2026-09-19')`;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
    );
  },
);

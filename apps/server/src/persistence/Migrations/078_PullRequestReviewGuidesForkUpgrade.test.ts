import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { seedUpstreamLedger } from "../upstreamMigrationLedger.testFixtures.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("creates fresh fork schemas and repository-scoped review guides", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
    yield* sql`INSERT INTO pull_request_review_guides VALUES
      ('github.com', 'owner/repo', 1, 'first'),
      ('github.com', 'owner/other', 1, 'other'),
      ('enterprise.example', 'owner/repo', 1, 'enterprise')`;
    assert.ok(
      Exit.isFailure(
        yield* Effect.exit(
          sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'owner/repo', 1, 'duplicate')`,
        ),
      ),
    );
    yield* sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'owner/repo', 1, 'updated')
      ON CONFLICT(host, repository, number) DO UPDATE SET guide_json = excluded.guide_json`;
    assert.deepStrictEqual(
      yield* sql`SELECT guide_json FROM pull_request_review_guides ORDER BY guide_json`,
      [{ guide_json: "enterprise" }, { guide_json: "other" }, { guide_json: "updated" }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("adds only review guides to published V2 while preserving schema, data and ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 77 });
    const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const schema =
      yield* sql`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`;
    yield* sql`INSERT INTO magi_arms(thread_id, revision) VALUES ('owner', 9)`;
    yield* sql`INSERT INTO magi_run_participants(thread_id, run_id) VALUES ('participant', 'run')`;
    yield* sql`INSERT INTO thread_archive_manifests(thread_id, status, updated_at, shell_json)
      VALUES ('cold', 'cold', '2026-10-11', '{"title":"preserved"}')`;
    yield* sql`INSERT INTO mcp_app_model_context VALUES ('cold', 'item', 'server', 'tool', 'context', '2026-10-11')`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 78 }), [
      [78, "PullRequestReviewGuides"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 77 ORDER BY migration_id`,
      ledger,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND name <> 'pull_request_review_guides' ORDER BY name`,
      schema,
    );
    assert.deepStrictEqual(yield* sql`SELECT thread_id, arm_id, revision FROM magi_arms`, [
      { thread_id: "owner", arm_id: null, revision: 9 },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM magi_run_participants`, [
      { thread_id: "participant", run_id: "run" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT shell_json FROM thread_archive_manifests`, [
      { shell_json: '{"title":"preserved"}' },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT text FROM mcp_app_model_context`, [
      { text: "context" },
    ]);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 78 }), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("relocates genuine upstream 61 without skipping fork cold-storage and Magi schemas", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedUpstreamLedger(61);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('magi_runs', 'thread_archive_manifests')`,
      [],
    );
    const timestamps = yield* sql<{
      migration_id: number;
      created_at: string;
    }>`SELECT migration_id, created_at FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id`;
    yield* sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'owner/repo', 42, 'guide')`;
    yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-11')`;
    yield* runMigrations();
    const destinations = [69, 70, 74, 75, 76, 77, 78];
    for (const [index, row] of timestamps.entries()) {
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = ${destinations[index]}`,
        [{ created_at: row.created_at }],
      );
    }
    yield* sql`INSERT INTO magi_arms(thread_id, revision) VALUES ('owner', 3)`;
    yield* sql`INSERT INTO magi_run_participants(thread_id, run_id) VALUES ('participant', 'run')`;
    yield* sql`INSERT INTO thread_archive_manifests(thread_id, status, updated_at) VALUES ('cold', 'cold', '2026-10-11')`;
    assert.deepStrictEqual(yield* sql`SELECT guide_json FROM pull_request_review_guides`, [
      { guide_json: "guide" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT text FROM mcp_app_model_context`, [
      { text: "context" },
    ]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rolls back upstream relocation and fork replay together when the final marker fails",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedUpstreamLedger(61);
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`INSERT INTO pull_request_review_guides VALUES ('github.com', 'owner/repo', 42, 'guide')`;
      yield* sql`CREATE TRIGGER reject_relocation BEFORE INSERT ON effect_sql_migrations
      WHEN NEW.migration_id = 78 BEGIN SELECT RAISE(ABORT, 'injected relocation failure'); END`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('magi_runs', 'thread_archive_manifests')`,
        [],
      );
      assert.deepStrictEqual(yield* sql`SELECT guide_json FROM pull_request_review_guides`, [
        { guide_json: "guide" },
      ]);
      yield* sql`DROP TRIGGER reject_relocation`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(layer)),
);

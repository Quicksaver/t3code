import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Logger from "effect/Logger";
import * as Console from "effect/Console";
import * as NodeUtil from "node:util";
import type { DatabaseMigrationProgress as Progress } from "@t3tools/contracts";
import {
  databaseMigrationProgress,
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import * as DatabaseMigrationProgress from "./DatabaseMigrationProgress.ts";

import { seedUpstreamLedger } from "./upstreamMigrationLedger.testFixtures.ts";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 69);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const current = yield* Ref.make<Progress | null>(null);
      const exit = yield* Effect.exit(
        runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 103),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("appends upstream schema after the published fork tail without replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 138 });
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runMigrations(), [[139, "WorkflowRunSubject"]]);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 138 ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("relocates the complete upstream ledger without changing timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedUpstreamLedger(119);
      const original = yield* sql<{
        readonly name: string;
        readonly created_at: string;
      }>`SELECT name, created_at FROM effect_sql_migrations WHERE migration_id BETWEEN 64 AND 119 ORDER BY migration_id`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT name, created_at FROM effect_sql_migrations WHERE migration_id BETWEEN 81 AND 139 AND migration_id NOT IN (86, 95, 125) ORDER BY migration_id`,
        original,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (69, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 68 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "69_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades at 68 and rechecks without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      const current = yield* Ref.make<Progress | null>(null);
      const steps: Array<Progress | null> = [];
      const loggedSteps: Array<Progress | null> = [];
      let output = "";
      const pretty = Logger.consolePretty({ mode: "tty", colors: false });
      const logger = Logger.make((options) => {
        pretty.log(options);
        if (String(options.message).startsWith(DATABASE_MIGRATION_PROGRESS_MESSAGE)) {
          steps.push(Ref.getUnsafe(current));
          loggedSteps.push(databaseMigrationProgress(output.slice(-4_000)));
        }
      });
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              output += `${NodeUtil.format(...args)}\n`;
            },
          }),
        ),
        v2Migrations,
      );
      assert.deepStrictEqual(
        steps,
        v2Migrations.map((_, index) => ({ current: index + 1, total: v2Migrations.length })),
      );
      assert.deepStrictEqual(loggedSteps, steps);
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
        [],
      );
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 68])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (70, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 69 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 70 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "70_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "74_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

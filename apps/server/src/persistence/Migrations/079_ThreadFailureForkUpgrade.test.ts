import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { seedUpstreamLedger } from "../upstreamMigrationLedger.testFixtures.ts";

it.effect("adds the failure index after the published fork tail without replaying it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 78 });
    const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const schema = yield* sql`SELECT type, name, sql FROM sqlite_schema ORDER BY name`;
    yield* sql`INSERT INTO magi_arms(thread_id, revision) VALUES ('owner', 7)`;
    yield* sql`INSERT INTO thread_archive_manifests(thread_id, status, updated_at)
      VALUES ('cold', 'cold', '2026-10-15')`;

    assert.deepStrictEqual(yield* runMigrations(), [[79, "ThreadFailureLookupIndex"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 78 ORDER BY migration_id`,
      ledger,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT type, name, sql FROM sqlite_schema
        WHERE name <> 'orchestration_v2_projection_turn_items_failed_error_idx' ORDER BY name`,
      schema,
    );
    assert.deepStrictEqual(yield* sql`SELECT thread_id, revision FROM magi_arms`, [
      { thread_id: "owner", revision: 7 },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT thread_id, status FROM thread_archive_manifests`, [
      { thread_id: "cold", status: "cold" },
    ]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("relocates genuine upstream 62 while preserving its index and timestamp", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedUpstreamLedger(62);
    const timestamp =
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 62`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 79`,
      timestamp,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 35 ORDER BY migration_id`,
      migrationManifest
        .filter(([id]) => id >= 35)
        .map(([migration_id, name]) => ({ migration_id, name })),
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

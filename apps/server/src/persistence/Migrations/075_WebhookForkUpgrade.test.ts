import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { seedUpstreamLedger } from "../upstreamMigrationLedger.testFixtures.ts";
import OrchestrationV2 from "./055_OrchestrationV2.ts";
import RemoveRedundantProjectionIndexes from "./056_RemoveRedundantProjectionIndexes.ts";
import ScheduledTaskWebhooks from "./057_ScheduledTaskWebhooks.ts";
import WebhookRelayDeliveries from "./058_WebhookRelayDeliveries.ts";

it.effect("retains upstream webhook history while applying the intervening fork schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedUpstreamLedger(54);
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "55_OrchestrationV2": OrchestrationV2,
        "56_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes,
        "57_ScheduledTaskWebhooks": ScheduledTaskWebhooks,
        "58_WebhookRelayDeliveries": WebhookRelayDeliveries,
      }),
    });
    const upstreamTimes =
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id IN (57, 58) ORDER BY migration_id`;
    yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries VALUES ('delivery', 'task', '2026-10-06T00:00:00Z')`;

    const applied = yield* runMigrations();
    assert.ok(applied.some(([id]) => id === 71));
    assert.ok(applied.some(([id]) => id === 72));
    assert.ok(applied.some(([id]) => id === 73));
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id IN (74, 75) ORDER BY migration_id`,
      upstreamTimes,
    );
    assert.strictEqual(
      (yield* sql`SELECT * FROM scheduled_task_webhook_relay_deliveries`).length,
      1,
    );
    yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('new-cleared-arm', 1)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("adds webhooks after the installed fork tail without replaying Magi", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 73 });
    yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('cleared-arm', 4)`;
    const published = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 75 }), [
      [74, "ScheduledTaskWebhooks"],
      [75, "WebhookRelayDeliveries"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 73 ORDER BY migration_id`,
      published,
    );
    assert.deepStrictEqual(yield* sql`SELECT thread_id, revision FROM magi_arms`, [
      { thread_id: "cleared-arm", revision: 4 },
    ]);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
    assert.ok(columns.some(({ name }) => name === "webhook_token"));
    assert.ok(columns.some(({ name }) => name === "webhook_secret"));
    assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_webhook_deliveries`, []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_webhook_relay_deliveries`, []);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 75 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

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
import McpAppModelContext from "./059_McpAppModelContext.ts";

it.effect(
  "adds MCP App context after the installed fork ledger without replaying published work",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      const published = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('preserved-arm', 4)`;
      yield* sql`INSERT INTO thread_archive_manifests (thread_id, status, updated_at) VALUES ('preserved-cold', 'cold', '2026-10-08')`;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 76 }), [
        [76, "McpAppModelContext"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 75 ORDER BY migration_id`,
        published,
      );
      assert.deepStrictEqual(yield* sql`SELECT thread_id, revision FROM magi_arms`, [
        { thread_id: "preserved-arm", revision: 4 },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT thread_id, status FROM thread_archive_manifests`, [
        { thread_id: "preserved-cold", status: "cold" },
      ]);
      yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-08')`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 76 }), []);
      assert.strictEqual((yield* sql`SELECT * FROM mcp_app_model_context`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("relocates upstream MCP App history while retaining its data and timestamp", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedUpstreamLedger(54);
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "55_OrchestrationV2": OrchestrationV2,
        "56_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes,
        "57_ScheduledTaskWebhooks": ScheduledTaskWebhooks,
        "58_WebhookRelayDeliveries": WebhookRelayDeliveries,
        "59_McpAppModelContext": McpAppModelContext,
      }),
    });
    const timestamp =
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 59`;
    yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-08')`;

    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 76`,
      timestamp,
    );
    assert.strictEqual((yield* sql`SELECT text FROM mcp_app_model_context`)[0]?.text, "context");
    yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('cleared-arm', 2)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

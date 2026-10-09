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
import ThreadSnapshotWindowIndexes from "./060_ThreadSnapshotWindowIndexes.ts";

it.effect("adds snapshot indexes without replaying the installed fork ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 76 });
    const published = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('preserved-arm', 4)`;
    yield* sql`INSERT INTO thread_archive_manifests (thread_id, status, updated_at) VALUES ('preserved-cold', 'cold', '2026-10-09')`;

    assert.deepStrictEqual(yield* runMigrations(), [[77, "ThreadSnapshotWindowIndexes"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 76 ORDER BY migration_id`,
      published,
    );
    assert.deepStrictEqual(yield* sql`SELECT thread_id, revision FROM magi_arms`, [
      { thread_id: "preserved-arm", revision: 4 },
    ]);
    assert.strictEqual((yield* sql`SELECT * FROM thread_archive_manifests`).length, 1);
    const indexes = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index'`;
    assert.ok(
      indexes.some(
        ({ name }) => name === "orchestration_v2_projection_turn_items_user_message_idx",
      ),
    );
    assert.ok(indexes.some(({ name }) => name === "orchestration_v2_projection_nodes_live_idx"));
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("relocates upstream snapshot history without losing its timestamp", () =>
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
        "60_ThreadSnapshotWindowIndexes": ThreadSnapshotWindowIndexes,
      }),
    });
    const timestamp =
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 60`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 77`,
      timestamp,
    );
    yield* sql`INSERT INTO magi_arms (thread_id, revision) VALUES ('cleared-arm', 2)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

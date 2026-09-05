import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import MagiProjections from "./048_MagiProjections.ts";
import MagiActiveConversationUniqueness from "./049_MagiActiveConversationUniqueness.ts";
import MagiProposalTerminology from "./050_MagiProposalTerminology.ts";

const readCanonicalMagiRows = Effect.fn("readCanonicalMagiRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name
    FROM effect_sql_migrations
    WHERE name LIKE 'Magi%'
    ORDER BY migration_id
  `;
});

const canonicalMagiRows = [
  { migration_id: 48, name: "MagiProjections" },
  { migration_id: 49, name: "MagiActiveConversationUniqueness" },
  { migration_id: 50, name: "MagiProposalTerminology" },
  { migration_id: 51, name: "MagiThreadColdArchiveGlue" },
  { migration_id: 60, name: "MagiCoreMigrationCompatibility" },
];

const liveHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

liveHistoryLayer("060 current shared-ledger compatibility", (it) => {
  it.effect("continues the shipped migration 54 history without rewriting it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [55, "ClearAutomaticProjectModelDefaults"],
        [56, "ProjectionProjectsAutoPull"],
        [57, "ProjectionThreadLineageConvergenceAfterUpstreamTail"],
        [58, "RepairAutomaticSettlementTimestamps"],
        [59, "ProjectionProjectIcon"],
        [60, "MagiCoreMigrationCompatibility"],
      ]);
      assert.deepStrictEqual(yield* readCanonicalMagiRows(), canonicalMagiRows);

      const separateLedger = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'effect_sql_magi_migrations'
      `;
      assert.deepStrictEqual(separateLedger, [{ count: 0 }]);
    }),
  );
});

const oldSharedHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

oldSharedHistoryLayer("060 old shared-ledger compatibility", (it) => {
  it.effect("replaces misplaced Magi records with the canonical ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* MagiProjections;
      yield* MagiActiveConversationUniqueness;
      yield* MagiProposalTerminology;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (41, 'MagiProjections'),
          (42, 'MagiActiveConversationUniqueness'),
          (43, 'MagiProposalTerminology')
      `;

      yield* runMigrations();

      assert.deepStrictEqual(yield* readCanonicalMagiRows(), canonicalMagiRows);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.isTrue(columns.some((column) => column.name === "client_surface"));
      assert.isTrue(columns.some((column) => column.name === "client_app_version"));
    }),
  );
});

const experimentalLedgerLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

experimentalLedgerLayer("060 experimental separate-ledger cleanup", (it) => {
  it.effect("folds experimental Magi records back into the core ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id BETWEEN 48 AND 50
      `;
      yield* sql`
        CREATE TABLE effect_sql_magi_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_magi_migrations (migration_id, name)
        VALUES
          (47, 'MagiProjections'),
          (48, 'MagiActiveConversationUniqueness'),
          (49, 'MagiProposalTerminology'),
          (50, 'MagiCoreMigrationCompatibility')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[60, "MagiCoreMigrationCompatibility"]]);
      assert.deepStrictEqual(yield* readCanonicalMagiRows(), canonicalMagiRows);

      const separateLedger = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'effect_sql_magi_migrations'
      `;
      assert.deepStrictEqual(separateLedger, [{ count: 0 }]);
    }),
  );
});

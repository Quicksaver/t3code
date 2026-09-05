import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0044 from "./048_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./049_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./051_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./047_MagiProjections.ts";
import Migration0048 from "./048_MagiActiveConversationUniqueness.ts";
import Migration0049 from "./049_MagiProposalTerminology.ts";
import Migration0050 from "./050_MagiCoreMigrationCompatibility.ts";

const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyLayer("050 Magi core migration compatibility", (it) => {
  it.effect("repairs databases whose old Magi ledger occupies core ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* Migration0047;
      yield* Migration0048;
      yield* Migration0049;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'MagiProjections')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (42, 'MagiActiveConversationUniqueness')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (43, 'MagiProposalTerminology')
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const authSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.isTrue(authSessionColumns.some((column) => column.name === "client_surface"));
      assert.isTrue(authSessionColumns.some((column) => column.name === "client_app_version"));

      const projectionThreadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(
        projectionThreadColumns.some((column) => column.name === "linked_pull_request_json"),
      );
      assert.isTrue(projectionThreadColumns.some((column) => column.name === "unsettled_at"));
      assert.isTrue(
        projectionThreadColumns.some((column) => column.name === "active_magi_run_json"),
      );

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_magi_runs'
      `;
      assert.deepStrictEqual(tables, [{ name: "projection_magi_runs" }]);
    }),
  );
});

const previousManifestLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

previousManifestLayer("050 compatibility with the previous Magi manifest", (it) => {
  it.effect("applies core migrations whose ids were already occupied by Magi", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* Migration0047;
      yield* Migration0048;
      yield* Migration0049;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (44, 'MagiProjections'),
          (45, 'MagiActiveConversationUniqueness'),
          (46, 'MagiProposalTerminology'),
          (47, 'MagiCoreMigrationCompatibility')
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(projectColumns.some((column) => column.name === "auto_pull"));
      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_magi_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 47, name: "MagiProjections" },
        { migration_id: 48, name: "MagiActiveConversationUniqueness" },
        { migration_id: 49, name: "MagiProposalTerminology" },
        { migration_id: 50, name: "MagiCoreMigrationCompatibility" },
      ]);
      const oldMagiLedgerRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM effect_sql_migrations
        WHERE name LIKE 'Magi%'
      `;
      assert.deepStrictEqual(oldMagiLedgerRows, [{ count: 0 }]);
    }),
  );
});

const collidingSettlementLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

collidingSettlementLayer("050 compatibility with the colliding settlement manifest", (it) => {
  it.effect("replays the core settlement repair when Magi already occupied ids 46 through 49", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* Migration0047;
      yield* Migration0048;
      yield* Migration0049;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (46, 'MagiProjections'),
          (47, 'MagiActiveConversationUniqueness'),
          (48, 'MagiProposalTerminology'),
          (49, 'MagiCoreMigrationCompatibility')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          created_at,
          updated_at,
          settled_override,
          settled_at
        ) VALUES (
          'thread-auto',
          'project-1',
          'Automatic settlement',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          '2026-05-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          'settled',
          '2026-09-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          'event-auto',
          'thread',
          'thread-auto',
          0,
          'thread.settled',
          '2026-09-01T00:00:00.000Z',
          'server:auto-settle:thread-auto:uuid',
          'server:auto-settle:thread-auto:uuid',
          'server',
          '{"threadId":"thread-auto","settledAt":"2026-09-01T00:00:00.000Z"}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly settledAt: string }>`
        SELECT settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-auto'
      `;
      assert.deepStrictEqual(rows, [{ settledAt: "2026-05-01T00:00:00.000Z" }]);
      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_magi_migrations
        WHERE migration_id = 50
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 50, name: "MagiCoreMigrationCompatibility" },
      ]);
    }),
  );
});

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("050 Magi core migration compatibility on a fresh database", (it) => {
  it.effect("is a no-op after the core migrations added their columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_magi_migrations
        WHERE migration_id = 50
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 50,
          name: "MagiCoreMigrationCompatibility",
        },
      ]);
    }),
  );
});

const interleavedManifestLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interleavedManifestLayer("050 compatibility with an interleaved historical manifest", (it) => {
  it.effect("converges when later core rows remain above old Magi ledger holes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* Migration0047;
      yield* Migration0048;
      yield* Migration0049;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (41, 'MagiProjections'),
          (42, 'MagiActiveConversationUniqueness'),
          (43, 'MagiProposalTerminology')
      `;

      yield* Migration0044;
      yield* Migration0045;
      yield* Migration0046;
      yield* Migration0050;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (44, 'ClearAutomaticProjectModelDefaults'),
          (45, 'ProjectionProjectsAutoPull'),
          (46, 'RepairAutomaticSettlementTimestamps'),
          (47, 'MagiProjections'),
          (48, 'MagiActiveConversationUniqueness'),
          (49, 'MagiProposalTerminology'),
          (50, 'MagiCoreMigrationCompatibility')
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const authSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.isTrue(authSessionColumns.some((column) => column.name === "client_surface"));
      assert.isTrue(authSessionColumns.some((column) => column.name === "client_app_version"));
      const projectionThreadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(
        projectionThreadColumns.some((column) => column.name === "linked_pull_request_json"),
      );
      assert.isTrue(projectionThreadColumns.some((column) => column.name === "unsettled_at"));
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_magi_runs'
      `;
      assert.deepStrictEqual(tables, [{ name: "projection_magi_runs" }]);
      const coreRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id BETWEEN 41 AND 50
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(coreRows, [
        { migration_id: 44, name: "ClearAutomaticProjectModelDefaults" },
        { migration_id: 45, name: "ProjectionProjectsAutoPull" },
        { migration_id: 46, name: "RepairAutomaticSettlementTimestamps" },
        { migration_id: 47, name: "ThreadStorageLifecycleCompatibility" },
      ]);
      const magiRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_magi_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(magiRows, [
        { migration_id: 47, name: "MagiProjections" },
        { migration_id: 48, name: "MagiActiveConversationUniqueness" },
        { migration_id: 49, name: "MagiProposalTerminology" },
        { migration_id: 50, name: "MagiCoreMigrationCompatibility" },
      ]);
    }),
  );
});

const currentManifestLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

currentManifestLayer("050 compatibility with the current Magi manifest", (it) => {
  it.effect("moves the shipped Magi ledger entries without replaying them on every boot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id = 47
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        SELECT migration_id, name, created_at
        FROM effect_sql_magi_migrations
      `;
      yield* sql`DELETE FROM effect_sql_magi_migrations`;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const coreRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM effect_sql_migrations
        WHERE name LIKE 'Magi%'
      `;
      assert.deepStrictEqual(coreRows, [{ count: 0 }]);
      const magiRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name
        FROM effect_sql_magi_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(magiRows, [
        { migration_id: 47, name: "MagiProjections" },
        { migration_id: 48, name: "MagiActiveConversationUniqueness" },
        { migration_id: 49, name: "MagiProposalTerminology" },
        { migration_id: 50, name: "MagiCoreMigrationCompatibility" },
      ]);

      const secondRun = yield* runMigrations({ toMigrationInclusive: 50 });
      assert.deepStrictEqual(secondRun, []);
    }),
  );
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ClearAutomaticProjectModelDefaults from "./048_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./049_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./051_RepairAutomaticSettlementTimestamps.ts";
import MagiProjections from "./048_MagiProjections.ts";
import MagiActiveConversationUniqueness from "./049_MagiActiveConversationUniqueness.ts";
import MagiProposalTerminology from "./050_MagiProposalTerminology.ts";

// Reapply every idempotent migration affected by fork-only development
// histories, then collapse any experimental Magi ledger into the canonical
// migration table.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authSessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!authSessionColumns.some((column) => column.name === "client_surface")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_surface TEXT
    `;
  }

  if (!authSessionColumns.some((column) => column.name === "client_app_version")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_app_version TEXT
    `;
  }

  const projectionThreadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!projectionThreadColumns.some((column) => column.name === "linked_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_pull_request_json TEXT
    `;
  }

  if (!projectionThreadColumns.some((column) => column.name === "unsettled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN unsettled_at TEXT
    `;
  }

  yield* ClearAutomaticProjectModelDefaults;
  yield* ProjectionProjectsAutoPull;
  yield* RepairAutomaticSettlementTimestamps;
  yield* MagiProjections;
  yield* MagiActiveConversationUniqueness;
  yield* MagiProposalTerminology;

  yield* sql`
    INSERT OR IGNORE INTO effect_sql_migrations (migration_id, name)
    VALUES
      (48, 'MagiProjections'),
      (49, 'MagiActiveConversationUniqueness'),
      (50, 'MagiProposalTerminology')
  `;
  yield* sql`DROP TABLE IF EXISTS effect_sql_magi_migrations`;
});

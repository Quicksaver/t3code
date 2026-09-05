import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ClearAutomaticProjectModelDefaults from "./048_ClearAutomaticProjectModelDefaults.ts";
import ProjectionProjectsAutoPull from "./049_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./051_RepairAutomaticSettlementTimestamps.ts";
import MagiProjections from "./047_MagiProjections.ts";
import MagiActiveConversationUniqueness from "./048_MagiActiveConversationUniqueness.ts";
import MagiProposalTerminology from "./049_MagiProposalTerminology.ts";

// Older Magi builds recorded these migrations in the core ledger at ids later
// assigned to core migrations. Ledger normalization now lets the missing core
// work run first. Reapply that work and every idempotent Magi migration at the
// end of the separate Magi ledger so all historical schemas converge.
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
});

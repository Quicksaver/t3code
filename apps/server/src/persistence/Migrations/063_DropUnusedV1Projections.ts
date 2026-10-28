import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V2 retains V1 transcript sources but no longer reads its copied projections.
// Older builds use state.sqlite, so dropping these does not prevent rollback.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS projection_thread_activities`;
  yield* sql`DROP TABLE IF EXISTS projection_turns`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
  yield* sql`DROP TABLE IF EXISTS projection_state`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_projection_magi_runs_active_conversation
    ON projection_magi_runs(root_thread_id)
    WHERE state IN (
      'initializing',
      'awaiting-main-tool',
      'deliberating',
      'awaiting-arbitration',
      'awaiting-actions',
      'awaiting-next-turn',
      'awaiting-main-approval',
      'awaiting-main-input',
      'awaiting-action-reconciliation',
      'paused',
      'cancelling'
    )
  `;
});

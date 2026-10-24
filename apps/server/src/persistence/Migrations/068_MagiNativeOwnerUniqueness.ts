import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS uq_projection_magi_runs_active_conversation`;
  yield* sql`
    CREATE UNIQUE INDEX uq_projection_magi_runs_active_conversation
    ON projection_magi_runs(root_thread_id,
      COALESCE(json_extract(snapshot_json, '$.detail.summary.nativeOwner.providerInstanceId'), ''),
      COALESCE(json_extract(snapshot_json, '$.detail.summary.nativeOwner.nativeThreadId'), ''))
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

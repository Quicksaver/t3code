import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Magi's durable run state. Participant conversations are ordinary V2 child threads; these
 * tables hold only the consensus protocol, the one-shot arm, and selected evidence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per armed conversation. Disarming or consuming an arm clears its columns but keeps
  // the row, so the revision keeps increasing and a stale client revision never matches a new arm.
  yield* sql`
    CREATE TABLE magi_arms (
      thread_id TEXT PRIMARY KEY NOT NULL,
      arm_id TEXT UNIQUE,
      revision INTEGER NOT NULL,
      config_json TEXT,
      armed_at TEXT,
      attached_message_id TEXT
    )
  `;
  yield* sql`
    CREATE TABLE magi_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      root_thread_id TEXT NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL,
      title_json TEXT NOT NULL,
      objective TEXT,
      initiating_reference_id TEXT,
      snapshot_json TEXT NOT NULL,
      completed_magi_turns INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_magi_runs_root_newest
    ON magi_runs(root_thread_id, started_at DESC, run_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_magi_runs_initiating_reference
    ON magi_runs(initiating_reference_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX uq_magi_runs_active_owner
    ON magi_runs(root_thread_id)
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
  // The owner and each of its lineage ancestors at run start. Conversation panels list the
  // runs whose audience contains them, so descendants' runs surface in the root conversation.
  yield* sql`
    CREATE TABLE magi_run_audiences (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_magi_run_audiences_run ON magi_run_audiences(run_id)
  `;
  // Participant conversations of every run. The participant policy checks a caller's lineage
  // against it on thread-creating and messaging tool calls.
  yield* sql`
    CREATE TABLE magi_run_participants (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_magi_run_participants_run ON magi_run_participants(run_id)
  `;
  yield* sql`
    CREATE TABLE magi_context_artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_magi_context_artifacts_run ON magi_context_artifacts(run_id)
  `;
  // Reads join through this table on the caller's own conversation, so a participant can
  // only ever resolve the artifacts addressed to it.
  yield* sql`
    CREATE TABLE magi_context_grants (
      participant_thread_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (participant_thread_id, artifact_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_magi_context_grants_run ON magi_context_grants(run_id)
  `;
});

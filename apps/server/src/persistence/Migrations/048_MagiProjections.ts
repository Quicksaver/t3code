import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  if (!threadColumns.some((column) => column.name === "active_magi_run_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN active_magi_run_json TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_root_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_root_thread_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_parent_thread_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_run_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_run_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_participant_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_participant_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_provider_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_provider_thread_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_started_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_started_at TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_completed_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_completed_at TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "magi_status")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN magi_status TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_arms (
      thread_id TEXT PRIMARY KEY NOT NULL,
      arm_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      armed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      root_thread_id TEXT NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL,
      title_json TEXT NOT NULL,
      objective TEXT,
      initiating_reference_id TEXT,
      initiating_instruction TEXT NOT NULL,
      main_turn_id TEXT,
      main_message_id TEXT,
      focused_objective TEXT,
      config_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      completed_magi_turns INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_magi_runs_root_newest
    ON projection_magi_runs(root_thread_id, started_at DESC, run_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_magi_runs_nonterminal
    ON projection_magi_runs(root_thread_id, state, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_magi_runs_initiating_reference
    ON projection_magi_runs(initiating_reference_id, started_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_members (
      run_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      child_thread_id TEXT,
      state TEXT NOT NULL,
      member_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, participant_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_turns (
      run_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      state TEXT NOT NULL,
      candidate_fingerprint TEXT,
      turn_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (run_id, magi_turn)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_responses (
      run_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      participant_id TEXT NOT NULL,
      participant_thread_id TEXT NOT NULL,
      participant_turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      parse_mode TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      response_json TEXT,
      metrics_json TEXT NOT NULL,
      PRIMARY KEY (run_id, magi_turn, participant_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_proposals (
      run_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      first_magi_turn INTEGER NOT NULL,
      proposal_json TEXT NOT NULL,
      PRIMARY KEY (run_id, proposal_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_proposal_evaluations (
      run_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      participant_id TEXT NOT NULL,
      evaluation_json TEXT NOT NULL,
      weight_contribution INTEGER NOT NULL,
      PRIMARY KEY (run_id, proposal_id, magi_turn, participant_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_exclusive_decision_sets (
      run_id TEXT NOT NULL,
      decision_set_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      decision_json TEXT NOT NULL,
      PRIMARY KEY (run_id, decision_set_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_exclusive_set_evaluations (
      run_id TEXT NOT NULL,
      decision_set_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      participant_id TEXT NOT NULL,
      evaluation_json TEXT NOT NULL,
      weight_contribution INTEGER NOT NULL,
      PRIMARY KEY (run_id, decision_set_id, magi_turn, participant_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_action_batches (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      magi_turn INTEGER NOT NULL,
      state TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      PRIMARY KEY (run_id, batch_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_actions (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      PRIMARY KEY (run_id, action_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_magi_action_reconciliations (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      reconciliation_id TEXT NOT NULL,
      reconciliation_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (run_id, reconciliation_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_magi_members_child_thread
    ON projection_magi_members(child_thread_id, run_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_magi_responses_transcript
    ON projection_magi_responses(participant_thread_id, participant_turn_id)
  `;
});

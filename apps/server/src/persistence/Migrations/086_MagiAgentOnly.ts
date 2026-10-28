import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqlClient from "effect/sql/SqlClient";

import { migrateMagiArbitratorPrompt } from "../../magi/MagiSettingsMigration.ts";

/**
 * Magi's durable run state. Participant conversations are ordinary V2 child threads; these
 * tables hold only the consensus protocol and selected evidence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS magi_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      root_thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      initiating_reference_id TEXT,
      snapshot_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_magi_runs_root_newest
    ON magi_runs(root_thread_id, started_at DESC, run_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_magi_runs_initiating_reference
    ON magi_runs(initiating_reference_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_magi_runs_active_owner
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
  // Participant conversations of every run. The participant policy checks a caller's lineage
  // against it on thread-creating and messaging tool calls.
  yield* sql`
    CREATE TABLE IF NOT EXISTS magi_run_participants (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_magi_run_participants_run ON magi_run_participants(run_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS magi_context_artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_magi_context_artifacts_run ON magi_context_artifacts(run_id)
  `;
  // Reads join through this table on the caller's own conversation, so a participant can
  // only ever resolve the artifacts addressed to it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS magi_context_grants (
      participant_thread_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (participant_thread_id, artifact_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_magi_context_grants_run ON magi_context_grants(run_id)
  `;
  yield* sql`DROP TABLE IF EXISTS magi_arms`;
  yield* sql`DROP TABLE IF EXISTS magi_run_audiences`;
  // V1 Magi projections have no readers in the V2 engine.
  const obsoleteTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'projection_magi_*'
  `;
  yield* Effect.forEach(obsoleteTables, ({ name }) => sql`DROP TABLE ${sql(name)}`, {
    discard: true,
  });
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(magi_runs)`;
  for (const name of [
    "title_json",
    "objective",
    "source",
    "completed_magi_turns",
    "completed_at",
  ]) {
    if (columns.some((column) => column.name === name)) {
      yield* sql`ALTER TABLE magi_runs DROP COLUMN ${sql(name)}`;
    }
  }
  const threadTable = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
  `;
  if (threadTable.length > 0) {
    yield* sql`
      WITH titles AS MATERIALIZED (
        SELECT json_extract(participant.value, '$.childThreadId') AS thread_id,
          'Magi: ' || json_extract(participant.value, '$.modelSelection.model') AS model_title,
          'Magi: ' || json_extract(participant.value, '$.modelSelection.model') || ' (' ||
            json_extract(participant.value, '$.personality.name') || ')' AS old_title
        FROM magi_runs, json_each(snapshot_json, '$.detail.participants') AS participant
        WHERE json_extract(participant.value, '$.personality.name') IS NOT NULL
      )
      UPDATE orchestration_v2_projection_threads AS threads
      SET title = (SELECT model_title FROM titles WHERE titles.thread_id = threads.thread_id),
        payload_json = json_set(payload_json, '$.title',
          (SELECT model_title FROM titles WHERE titles.thread_id = threads.thread_id))
      WHERE EXISTS (SELECT 1 FROM titles WHERE titles.thread_id = threads.thread_id
        AND titles.old_title = threads.title
        AND titles.old_title = json_extract(threads.payload_json, '$.title'))
    `;
  }
  for (const arrayPath of [
    "$.detail.config.participants",
    "$.detail.participants",
    "$.protocol.members",
  ]) {
    yield* sql`
      UPDATE magi_runs SET snapshot_json = json_set(
        snapshot_json, ${arrayPath}, json((
          SELECT json_group_array(json_remove(value,
            '$.personality', '$.personalityId', '$.participant.personalityId'))
          FROM json_each(snapshot_json, ${arrayPath})
        ))
      )
      WHERE json_type(snapshot_json, ${arrayPath}) = 'array'
    `;
  }
  const prompts = yield* sql<{ readonly runId: string; readonly prompt: string }>`
    SELECT run_id AS "runId", json_extract(snapshot_json, '$.arbitratorPrompt') AS prompt
    FROM magi_runs WHERE json_type(snapshot_json, '$.arbitratorPrompt') = 'text'
  `;
  yield* Effect.forEach(
    prompts,
    ({ runId, prompt }) =>
      Effect.gen(function* () {
        const migrated = yield* migrateMagiArbitratorPrompt(prompt);
        if (migrated !== prompt) {
          yield* sql`
        UPDATE magi_runs SET snapshot_json = json_set(snapshot_json, '$.arbitratorPrompt', ${migrated})
        WHERE run_id = ${runId}
      `;
        }
      }),
    { discard: true },
  );
  yield* sql`
    UPDATE magi_runs SET snapshot_json = json_remove(
      snapshot_json,
      '$.audienceThreadIds', '$.mainMessageId',
      '$.detail.summary.title', '$.detail.summary.objective', '$.detail.summary.ownerTitle',
      '$.detail.summary.participantCount', '$.detail.summary.magiTurnLimit',
      '$.detail.summary.tokenCount', '$.detail.summary.agreedVoteCount',
      '$.detail.summary.totalVoteCount', '$.detail.summary.leadingAgreementWeight',
      '$.detail.summary.leadingAgreementLabel', '$.detail.summary.requiredWeight',
      '$.detail.activity', '$.detail.finalParticipantVotes', '$.detail.initialPrompt',
      '$.detail.magiTurns', '$.detail.proposals', '$.detail.exclusiveDecisionSets',
      '$.detail.actionReconciliations'
    )
  `;
}).pipe(Effect.provide(NodeCrypto.layer));

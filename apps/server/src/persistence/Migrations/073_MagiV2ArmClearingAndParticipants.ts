import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Preserve arm revisions when clearing values and index existing participants.
// Databases that already applied Magi projections at 72 need this follow-up.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE magi_arms_nullable (
      thread_id TEXT PRIMARY KEY NOT NULL,
      arm_id TEXT UNIQUE,
      revision INTEGER NOT NULL,
      config_json TEXT,
      armed_at TEXT,
      attached_message_id TEXT
    )
  `;
  yield* sql`
    INSERT INTO magi_arms_nullable (
      thread_id, arm_id, revision, config_json, armed_at, attached_message_id
    )
    SELECT thread_id, arm_id, revision, config_json, armed_at, attached_message_id
    FROM magi_arms
  `;
  yield* sql`DROP TABLE magi_arms`;
  yield* sql`ALTER TABLE magi_arms_nullable RENAME TO magi_arms`;

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
    INSERT OR IGNORE INTO magi_run_participants (thread_id, run_id)
    SELECT participant.value ->> '$.childThreadId', run.run_id
    FROM magi_runs AS run, json_each(run.snapshot_json, '$.detail.participants') AS participant
    WHERE participant.value ->> '$.childThreadId' IS NOT NULL
  `;
});

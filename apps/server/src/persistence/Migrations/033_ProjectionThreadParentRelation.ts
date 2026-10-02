import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("parent_kind")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'root'`;
  }
  if (!columnNames.has("root_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN root_thread_id TEXT NOT NULL DEFAULT ''`;
  }
  if (!columnNames.has("parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  if (!columnNames.has("parent_turn_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_turn_id TEXT`;
  }
  if (!columnNames.has("parent_item_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_item_id TEXT`;
  }
  if (!columnNames.has("parent_activity_sequence")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_activity_sequence INTEGER NOT NULL DEFAULT 0`;
  }
  if (!columnNames.has("provider_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN provider_thread_id TEXT`;
  }
  if (!columnNames.has("title_seed")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_seed TEXT`;
  }
  if (!columnNames.has("subagent_depth")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_depth INTEGER NOT NULL DEFAULT 0`;
  }
  if (!columnNames.has("subagent_started_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_started_at TEXT`;
  }
  if (!columnNames.has("subagent_completed_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_completed_at TEXT`;
  }
  if (!columnNames.has("subagent_status")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_status TEXT`;
  }

  yield* sql`
    UPDATE projection_threads
    SET root_thread_id = thread_id
    WHERE root_thread_id = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_relation
    ON projection_threads(parent_thread_id, subagent_status, subagent_started_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_root_relation
    ON projection_threads(root_thread_id, deleted_at, archived_at, thread_id)
  `;
});

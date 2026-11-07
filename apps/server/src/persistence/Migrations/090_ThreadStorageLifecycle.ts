import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Cold-storage lifecycle state for archived and deleted threads. Existing
 * threads are discovered by the server's startup reconciliation, which
 * queues their durable lifecycle effects once the server is activated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // status: moving (bundle complete in archivev2.sqlite, hot rows and files
  // still being removed), cold (rows live in archivev2.sqlite), restored (hot
  // again until a queued re-cold or unarchive finalization), kept-hot (archived
  // but not eligible for cold storage), purged (deleted thread storage removed).
  yield* sql`
    CREATE TABLE thread_archive_manifests (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      archived_at TEXT,
      restore_generation INTEGER NOT NULL DEFAULT 0,
      shell_json TEXT,
      original_bytes INTEGER NOT NULL DEFAULT 0,
      compressed_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_archive_manifests_status
    ON thread_archive_manifests(status, thread_id)
  `;
});

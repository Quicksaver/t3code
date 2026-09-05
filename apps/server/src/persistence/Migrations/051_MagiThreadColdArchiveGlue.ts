import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Magi participants use the exact owning conversation as their domain root.
 * Cold storage groups every hidden descendant under the top lifecycle root so
 * one root unarchive restores native subagents and their Magi participants.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE thread_archive_manifests
    SET root_thread_id = COALESCE(
      (
        SELECT CASE
          WHEN threads.parent_kind = 'magi' THEN COALESCE(
            (
              SELECT NULLIF(TRIM(parent.root_thread_id), '')
              FROM projection_threads AS parent
              WHERE parent.thread_id = threads.parent_thread_id
            ),
            threads.parent_thread_id,
            threads.thread_id
          )
          ELSE COALESCE(NULLIF(TRIM(threads.root_thread_id), ''), threads.thread_id)
        END
        FROM projection_threads AS threads
        WHERE threads.thread_id = thread_archive_manifests.thread_id
      ),
      thread_id
    )
  `;
});

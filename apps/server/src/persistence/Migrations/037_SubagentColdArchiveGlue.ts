import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import EnsureThreadColdArchive from "./035_ThreadColdArchive.ts";

/**
 * Connects the generic cold-archive manifests to the fork's subagent tree
 * metadata. Kept separate so the base data-savings migrations remain useful
 * without the subagent-threading customization.
 */
export default Effect.gen(function* () {
  // A database that recorded upstream's title-regeneration migration as ID 35
  // skips this fork's cold-archive migration. Establish the idempotent base
  // tables before the lineage glue reads them.
  yield* EnsureThreadColdArchive;

  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE thread_archive_manifests
    SET root_thread_id = COALESCE(
      (
        SELECT NULLIF(TRIM(threads.root_thread_id), '')
        FROM projection_threads threads
        WHERE threads.thread_id = thread_archive_manifests.thread_id
      ),
      thread_id
    )
    WHERE status = 'pending'
  `;
});

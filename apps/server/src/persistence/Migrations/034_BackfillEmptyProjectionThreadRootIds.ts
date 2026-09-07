import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import EnsureProjectionThreadParentRelation from "./033_ProjectionThreadParentRelation.ts";

export default Effect.gen(function* () {
  // Upstream assigned migration 33 to settlement before this fork assigned it
  // to lineage. Ensure the columns exist before the backfill runs at id 34.
  yield* EnsureProjectionThreadParentRelation;
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET root_thread_id = thread_id
    WHERE TRIM(root_thread_id) = ''
  `;
});

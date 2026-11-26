import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import EnsureProjectionThreadParentRelation from "./034_ProjectionThreadParentRelation.ts";

export default Effect.gen(function* () {
  // Upstream snoozing occupied fork lineage ID 34. Reapply the idempotent
  // lineage schema before the root-ID backfill on either published history.
  yield* EnsureProjectionThreadParentRelation;

  const sql = yield* SqlClient.SqlClient;

  // Migration 033 was used by the branch for parent-relation columns before
  // upstream assigned it to settled-thread columns. Ensure databases created
  // by either lineage converge on the merged schema.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "settled_override")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_override TEXT`;
  }
  if (!columns.some((column) => column.name === "settled_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_at TEXT`;
  }

  yield* sql`
    UPDATE projection_threads
    SET root_thread_id = thread_id
    WHERE TRIM(root_thread_id) = ''
  `;
});

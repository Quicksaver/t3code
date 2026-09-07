import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import EnsureProjectionThreadParentRelation from "./034_ProjectionThreadParentRelation.ts";

export default Effect.gen(function* () {
  // Upstream assigned migration 34 to snoozing while this branch assigned
  // the same id to parent-relation columns. Effect's migrator skips every
  // migration at or below the recorded latest id, so an upstream database at
  // 34 reaches this migration without ever running the branch's 34. Re-run
  // the idempotent parent-relation migration here so both histories converge.
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

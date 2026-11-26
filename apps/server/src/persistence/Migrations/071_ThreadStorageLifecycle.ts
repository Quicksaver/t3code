import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadStorageLifecycle from "./057_ThreadStorageLifecycle.ts";

/**
 * Main registration of the cold-storage lifecycle migration. Published fork
 * migrations 35, 41, and 47 created pre-V2 cold-storage tables under the same
 * names; their bundles live in `archive.sqlite`, which V2 never reads. Keep
 * those rows under legacy names so the V2 tables start empty.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('thread_archive_manifests', 'thread_storage_maintenance')
  `;
  if (tables.some((table) => table.name === "thread_archive_manifests")) {
    yield* sql`ALTER TABLE thread_archive_manifests RENAME TO legacy_v1_thread_archive_manifests`;
  }
  if (tables.some((table) => table.name === "thread_storage_maintenance")) {
    yield* sql`ALTER TABLE thread_storage_maintenance RENAME TO legacy_v1_thread_storage_maintenance`;
  }
  yield* ThreadStorageLifecycle;
});

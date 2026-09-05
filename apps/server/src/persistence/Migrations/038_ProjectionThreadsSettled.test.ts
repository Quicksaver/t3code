import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038 projection thread settlement migration", (it) => {
  it.effect("adds settlement columns after the storage lifecycle schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(before.some((column) => column.name === "settled_override"));
      assert.isFalse(before.some((column) => column.name === "settled_at"));

      yield* runMigrations({ toMigrationInclusive: 38 });

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(after.some((column) => column.name === "settled_override"));
      assert.isTrue(after.some((column) => column.name === "settled_at"));

      const lifecycleTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('thread_archive_manifests', 'thread_cleanup_queue')
        ORDER BY name
      `;
      assert.deepStrictEqual(lifecycleTables, [
        { name: "thread_archive_manifests" },
        { name: "thread_cleanup_queue" },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionProjectFaviconPath", (it) => {
  it.effect("adds nullable project mode and favicon fields to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const faviconPath = columns.find((column) => column.name === "favicon_path");
      const defaultThreadEnvMode = columns.find(
        (column) => column.name === "default_thread_env_mode",
      );

      assert.equal(faviconPath?.name, "favicon_path");
      assert.equal(faviconPath?.notnull, 0);
      assert.equal(defaultThreadEnvMode?.name, "default_thread_env_mode");
      assert.equal(defaultThreadEnvMode?.notnull, 0);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("051 Magi thread cold archive glue", (it) => {
  it.effect("reparents existing Magi manifests to the top lifecycle root", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, parent_kind,
          root_thread_id, parent_thread_id, created_at, updated_at, archived_at
        ) VALUES
          (
            'magi-cold-root', 'magi-cold-project', 'Root', NULL, 'root',
            'magi-cold-root', NULL, '2026-08-27T00:00:00.000Z',
            '2026-08-27T00:00:00.000Z', '2026-08-27T01:00:00.000Z'
          ),
          (
            'magi-cold-owner', 'magi-cold-project', 'Owner', NULL, 'subagent',
            'magi-cold-root', 'magi-cold-root', '2026-08-27T00:00:01.000Z',
            '2026-08-27T00:00:01.000Z', '2026-08-27T01:00:00.000Z'
          ),
          (
            'magi-cold-participant', 'magi-cold-project', 'Participant', NULL, 'magi',
            'magi-cold-owner', 'magi-cold-owner', '2026-08-27T00:00:02.000Z',
            '2026-08-27T00:00:02.000Z', '2026-08-27T01:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO thread_archive_manifests (
          thread_id, root_thread_id, status, archive_version, archived_at, updated_at
        ) VALUES
          (
            'magi-cold-owner', 'magi-cold-root', 'cold', 1,
            '2026-08-27T01:00:00.000Z', CURRENT_TIMESTAMP
          ),
          (
            'magi-cold-participant', 'magi-cold-owner', 'cold', 1,
            '2026-08-27T01:00:00.000Z', CURRENT_TIMESTAMP
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const manifests = yield* sql<{ readonly threadId: string; readonly rootThreadId: string }>`
        SELECT thread_id AS "threadId", root_thread_id AS "rootThreadId"
        FROM thread_archive_manifests
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(manifests, [
        { threadId: "magi-cold-owner", rootThreadId: "magi-cold-root" },
        { threadId: "magi-cold-participant", rootThreadId: "magi-cold-root" },
      ]);
    }),
  );
});

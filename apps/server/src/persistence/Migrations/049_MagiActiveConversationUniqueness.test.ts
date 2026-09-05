import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049 Magi active conversation uniqueness", (it) => {
  it.effect(
    "allows one active run per exact conversation while allowing sibling conversations",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        const insert = (runId: string, rootThreadId: string, state: string) => sql`
        INSERT INTO projection_magi_runs (
          run_id,
          root_thread_id,
          source,
          state,
          title_json,
          initiating_instruction,
          config_json,
          snapshot_json,
          started_at,
          updated_at
        ) VALUES (
          ${runId},
          ${rootThreadId},
          'agent-tool',
          ${state},
          '{}',
          'instruction',
          '{}',
          '{}',
          '2026-08-21T00:00:00.000Z',
          '2026-08-21T00:00:00.000Z'
        )
      `;

        yield* insert("run-a", "conversation-a", "deliberating");
        yield* insert("run-b", "conversation-b", "deliberating");
        const duplicate = yield* Effect.exit(
          insert("run-a-duplicate", "conversation-a", "awaiting-arbitration"),
        );
        assert.isTrue(Exit.isFailure(duplicate));

        yield* sql`UPDATE projection_magi_runs SET state = 'succeeded' WHERE run_id = 'run-a'`;
        yield* insert("run-a-next", "conversation-a", "deliberating");
        const active = yield* sql<{ readonly rootThreadId: string; readonly count: number }>`
        SELECT root_thread_id AS "rootThreadId", COUNT(*) AS count
        FROM projection_magi_runs
        WHERE state = 'deliberating'
        GROUP BY root_thread_id
        ORDER BY root_thread_id
      `;
        assert.deepStrictEqual(active, [
          { rootThreadId: "conversation-a", count: 1 },
          { rootThreadId: "conversation-b", count: 1 },
        ]);
      }),
  );
});

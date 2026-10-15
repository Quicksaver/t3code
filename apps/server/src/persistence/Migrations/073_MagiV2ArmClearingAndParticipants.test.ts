import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("073_MagiV2ArmClearingAndParticipants", (it) => {
  it.effect("keeps arms clearable and indexes existing run participants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      const snapshot = `{"detail":{"participants":[
        {"participantId":"one","childThreadId":"participant-thread-1"},
        {"participantId":"two","childThreadId":"participant-thread-2"},
        {"participantId":"pending","childThreadId":null}
      ]}}`;
      yield* sql`
        INSERT INTO magi_runs (
          run_id, root_thread_id, source, state, title_json, snapshot_json, started_at, updated_at
        ) VALUES (
          'run-1', 'owner-thread', 'agent-tool', 'succeeded', '{}', ${snapshot},
          '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO magi_arms (thread_id, arm_id, revision, config_json, armed_at)
        VALUES ('owner-thread', 'arm-1', 3, '{}', '2026-10-04T00:00:00.000Z')
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 73 }), [
        [73, "MagiV2ArmClearingAndParticipants"],
      ]);

      assert.deepStrictEqual(
        yield* sql<{ readonly thread_id: string; readonly run_id: string }>`
          SELECT thread_id, run_id FROM magi_run_participants ORDER BY thread_id
        `,
        [
          { thread_id: "participant-thread-1", run_id: "run-1" },
          { thread_id: "participant-thread-2", run_id: "run-1" },
        ],
      );

      yield* sql`
        UPDATE magi_arms
        SET arm_id = NULL, config_json = NULL, armed_at = NULL, attached_message_id = NULL
        WHERE thread_id = 'owner-thread'
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly arm_id: string | null; readonly revision: number }>`
          SELECT arm_id, revision FROM magi_arms WHERE thread_id = 'owner-thread'
        `,
        [{ arm_id: null, revision: 3 }],
      );

      yield* sql`
        INSERT INTO magi_arms (thread_id, arm_id, revision, config_json, armed_at)
        VALUES ('other-thread', 'arm-2', 1, '{}', '2026-10-04T00:00:00.000Z')
      `;
      const duplicate = yield* Effect.exit(sql`
        UPDATE magi_arms SET arm_id = 'arm-2' WHERE thread_id = 'owner-thread'
      `);
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );
});

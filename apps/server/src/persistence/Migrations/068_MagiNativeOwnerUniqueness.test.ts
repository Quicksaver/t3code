import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "068_MagiNativeOwnerUniqueness",
  (it) => {
    it.effect("preserves published runs and ledger while separating native owner uniqueness", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        const published = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const insert = (id: string, snapshot: string) => sql`
        INSERT INTO projection_magi_runs (
          run_id, root_thread_id, source, state, title_json, initiating_instruction,
          config_json, snapshot_json, started_at, updated_at
        ) VALUES (
          ${id}, 'main', 'agent-tool', 'awaiting-arbitration', '{}', 'Retain this instruction',
          '{}', ${snapshot}, '2026-09-29', '2026-09-29'
        )
      `;
        yield* insert("existing-main", '{"detail":{"summary":{}}}');
        const existing = yield* sql`SELECT * FROM projection_magi_runs`;
        assert.deepStrictEqual(yield* runMigrations(), [[68, "MagiNativeOwnerUniqueness"]]);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 67 ORDER BY migration_id`,
          published,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_magi_runs`, existing);

        const firstOwner =
          '{"detail":{"summary":{"nativeOwner":{"providerInstanceId":"codex","nativeThreadId":"child-a"}}}}';
        yield* insert("child-a", firstOwner);
        yield* insert(
          "child-b",
          '{"detail":{"summary":{"nativeOwner":{"providerInstanceId":"codex","nativeThreadId":"child-b"}}}}',
        );
        yield* insert(
          "another-instance",
          '{"detail":{"summary":{"nativeOwner":{"providerInstanceId":"codex-other","nativeThreadId":"child-a"}}}}',
        );
        assert.equal(
          (yield* insert("duplicate-child", firstOwner).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* insert("duplicate-main", '{"detail":{"summary":{"nativeOwner":null}}}').pipe(
            Effect.result,
          ))._tag,
          "Failure",
        );
        yield* sql`UPDATE projection_magi_runs SET state = 'completed' WHERE run_id = 'child-a'`;
        yield* insert("next-child-run", firstOwner);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
    );
  },
);

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("086_MagiAgentOnly", (it) => {
  it.effect("preserves operational tables after the published fork schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 86 }), [
        [86, "MagiAgentOnly"],
      ]);
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const added = after
        .map((row) => row.name)
        .filter((name) => !before.some((row) => row.name === name));
      assert.deepStrictEqual(added, []);
      for (const name of [
        "magi_context_artifacts",
        "magi_context_grants",
        "magi_run_participants",
        "magi_runs",
      ]) {
        assert.include(
          after.map((row) => row.name),
          name,
        );
      }
    }),
  );
  it.effect("removes old panel schema and data while retaining the core protocol and ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* sql`INSERT INTO magi_arms (thread_id, revision, config_json) VALUES ('owner', 1, '{"obsolete":true}')`;
      yield* sql`INSERT INTO magi_run_audiences VALUES ('grandparent', 'run')`;
      const snapshot = {
        detail: {
          summary: {
            runId: "run",
            rootThreadId: "owner",
            title: { title: "old" },
            objective: "old",
          },
          config: {
            participants: [{ participantId: "one", weight: 1, personalityId: "old" }],
            consensusThresholdPercent: 75,
            magiTurnLimit: 3,
          },
          activity: { leadingAgreementLabel: "obsolete" },
          initialPrompt: "obsolete",
          finalParticipantVotes: [],
          magiTurns: [],
          proposals: [],
          exclusiveDecisionSets: [],
          actionReconciliations: [],
          participants: [
            {
              participantId: "one",
              childThreadId: "child",
              modelSelection: { model: "model" },
              personality: { name: "Reviewer", prompt: "obsolete", included: true },
            },
          ],
          candidate: { conclusion: "keep" },
          actions: ["keep"],
        },
        protocol: {
          members: [
            {
              participant: { participantId: "one", weight: 1, personalityId: "old" },
              personality: { name: "Reviewer", prompt: "obsolete" },
              threadId: "child",
            },
          ],
          turns: [{ arbitration: { decision: "keep" } }],
          actions: ["keep"],
          pendingBatch: "keep",
        },
        focusedObjective: "keep",
        arbitratorPrompt: "keep",
        initiatingInstruction: "keep",
        mainRunId: "keep",
        mainMessageId: "obsolete",
        audienceThreadIds: ["owner", "grandparent"],
      };
      yield* sql`
        INSERT INTO magi_runs VALUES (
          'run', 'owner', 'agent-tool', 'paused', '{}', 'old', 'reference',
          ${JSON.stringify(snapshot)}, 1, '2026-10-23T00:00:00.000Z', NULL, '2026-10-23T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('child', 'project', 'Magi: model (Reviewer)', 'codex', 'full-access', 'default',
          '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z',
          '{"title":"Magi: model (Reviewer)","keep":"instructions"}')
      `;
      const ledgerBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* runMigrations({ toMigrationInclusive: 86 });
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      assert.notInclude(
        tables.map((table) => table.name),
        "magi_arms",
      );
      assert.notInclude(
        tables.map((table) => table.name),
        "magi_run_audiences",
      );
      assert.notInclude(
        tables.map((table) => table.name),
        "projection_magi_runs",
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(magi_runs)`;
      assert.notInclude(
        columns.map((column) => column.name),
        "title_json",
      );
      assert.notInclude(
        columns.map((column) => column.name),
        "objective",
      );
      const [row] = yield* sql<{
        readonly snapshot: string;
      }>`SELECT snapshot_json AS snapshot FROM magi_runs WHERE run_id = 'run'`;
      const cleaned = JSON.parse(row!.snapshot);
      assert.deepStrictEqual(cleaned.protocol, {
        ...snapshot.protocol,
        members: [{ participant: { participantId: "one", weight: 1 }, threadId: "child" }],
      });
      assert.deepStrictEqual(cleaned.detail.config, {
        ...snapshot.detail.config,
        participants: [{ participantId: "one", weight: 1 }],
      });
      assert.deepStrictEqual(cleaned.detail.actions, snapshot.detail.actions);
      assert.deepStrictEqual(cleaned.detail.candidate, snapshot.detail.candidate);
      assert.deepStrictEqual(cleaned.detail.participants, [
        { participantId: "one", childThreadId: "child", modelSelection: { model: "model" } },
      ]);
      const [child] = yield* sql<{ readonly title: string; readonly payload: string }>`
        SELECT title, payload_json AS payload FROM orchestration_v2_projection_threads WHERE thread_id = 'child'
      `;
      assert.strictEqual(child!.title, "Magi: model");
      assert.deepStrictEqual(JSON.parse(child!.payload), {
        title: "Magi: model",
        keep: "instructions",
      });
      assert.strictEqual(cleaned.mainRunId, snapshot.mainRunId);
      assert.strictEqual(cleaned.focusedObjective, snapshot.focusedObjective);
      assert.notProperty(cleaned, "audienceThreadIds");
      assert.notProperty(cleaned, "mainMessageId");
      assert.notProperty(cleaned.detail, "activity");
      assert.notProperty(cleaned.detail, "magiTurns");
      const ledgerAfter =
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 85 ORDER BY migration_id`;
      assert.deepStrictEqual(ledgerAfter, ledgerBefore);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
  );
});

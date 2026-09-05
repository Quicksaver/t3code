import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const encodeJson = Schema.encodeSync(JsonText);
const opaqueResult = {
  suggestions: [{ suggestionId: "suggestion_external", change: "Provider-owned schema" }],
  nested: { selectedSuggestionId: "suggestion_opaque" },
};

layer("049 Magi proposal terminology", (it) => {
  it.effect("renames legacy tables, columns, payload keys, and generated ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`ALTER TABLE projection_magi_proposals RENAME TO projection_magi_suggestions`;
      yield* sql`ALTER TABLE projection_magi_suggestions RENAME COLUMN proposal_id TO suggestion_id`;
      yield* sql`ALTER TABLE projection_magi_suggestions RENAME COLUMN proposal_json TO suggestion_json`;
      yield* sql`
        ALTER TABLE projection_magi_proposal_evaluations
        RENAME TO projection_magi_suggestion_evaluations
      `;
      yield* sql`
        ALTER TABLE projection_magi_suggestion_evaluations
        RENAME COLUMN proposal_id TO suggestion_id
      `;
      yield* sql`
        CREATE TABLE projection_magi_requested_roster (
          run_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          participant_json TEXT NOT NULL,
          PRIMARY KEY (run_id, participant_id)
        )
      `;
      yield* sql`
        CREATE TABLE projection_magi_preflight_exclusions (
          run_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, participant_id)
        )
      `;
      yield* sql`
        INSERT INTO projection_magi_runs (
          run_id, root_thread_id, source, state, title_json, initiating_instruction,
          config_json, snapshot_json, started_at, updated_at
        ) VALUES (
          'run-1', 'thread-1', 'agent-tool', 'succeeded', '{}', 'instruction', '{}',
          ${encodeJson({
            protocol: {
              suggestions: [
                {
                  suggestionId: "suggestion_hash",
                  proposal: {
                    supersedesSuggestionId: null,
                    rationale: "Suggestion prose may mention suggestion_hash without changing.",
                  },
                },
              ],
              terminalSuggestionDigest: [
                {
                  suggestionId: "suggestion_hash",
                  summary: "Suggestion summary keeps the authored suggestion_hash reference.",
                },
              ],
              pendingContextArtifacts: [{ activityId: "activity-1", result: opaqueResult }],
            },
          })},
          '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_magi_turns (
          run_id, magi_turn, state, candidate_fingerprint, turn_json, started_at, completed_at
        ) VALUES (
          'run-1', 1, 'completed', NULL,
          ${encodeJson({
            suggestions: [{ suggestionId: "suggestion_turn" }],
            activities: [{ activityId: "activity-1", result: opaqueResult }],
          })},
          '2026-08-26T00:00:00.000Z', '2026-08-26T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_magi_suggestions
          (run_id, suggestion_id, first_magi_turn, suggestion_json)
        VALUES (
          'run-1', 'suggestion_hash', 1,
          ${encodeJson({
            suggestionId: "suggestion_hash",
            proposal: { change: "Keep Suggestion prose and suggestion_hash references unchanged." },
          })}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'projection_magi_%suggest%'
      `;
      assert.deepStrictEqual(tables, []);
      const proposalRows = yield* sql<{
        readonly proposalId: string;
        readonly proposalJson: string;
      }>`
        SELECT proposal_id AS "proposalId", proposal_json AS "proposalJson"
        FROM projection_magi_proposals
      `;
      assert.strictEqual(proposalRows[0]?.proposalId, "proposal_hash");
      assert.include(proposalRows[0]?.proposalJson ?? "", '"proposalId":"proposal_hash"');
      assert.include(
        proposalRows[0]?.proposalJson ?? "",
        "Keep Suggestion prose and suggestion_hash references unchanged.",
      );
      const runRows = yield* sql<{ readonly snapshot: string }>`
        SELECT snapshot_json AS snapshot FROM projection_magi_runs WHERE run_id = 'run-1'
      `;
      assert.include(runRows[0]?.snapshot ?? "", '"proposals"');
      assert.include(runRows[0]?.snapshot ?? "", '"proposal_hash"');
      assert.include(
        runRows[0]?.snapshot ?? "",
        "Suggestion prose may mention suggestion_hash without changing.",
      );
      assert.include(
        runRows[0]?.snapshot ?? "",
        "Suggestion summary keeps the authored suggestion_hash reference.",
      );
      const migratedSnapshot = decodeJson(runRows[0]!.snapshot) as {
        readonly protocol: {
          readonly pendingContextArtifacts: ReadonlyArray<{ readonly result: unknown }>;
        };
      };
      assert.deepStrictEqual(
        migratedSnapshot.protocol.pendingContextArtifacts[0]?.result,
        opaqueResult,
      );
      const turnRows = yield* sql<{ readonly turn: string }>`
        SELECT turn_json AS turn FROM projection_magi_turns WHERE run_id = 'run-1'
      `;
      const migratedTurn = decodeJson(turnRows[0]!.turn) as {
        readonly proposals: ReadonlyArray<{ readonly proposalId: string }>;
        readonly activities: ReadonlyArray<{ readonly result: unknown }>;
      };
      assert.strictEqual(migratedTurn.proposals[0]?.proposalId, "proposal_turn");
      assert.deepStrictEqual(migratedTurn.activities[0]?.result, opaqueResult);
      const removedTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'projection_magi_requested_roster',
            'projection_magi_preflight_exclusions'
          )
      `;
      assert.deepStrictEqual(removedTables, []);
    }),
  );
});

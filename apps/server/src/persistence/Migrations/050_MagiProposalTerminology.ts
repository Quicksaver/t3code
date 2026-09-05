import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const renamedKeys = new Map<string, string>([
  ["suggestionId", "proposalId"],
  ["suggestionIds", "proposalIds"],
  ["suggestionEvaluations", "proposalEvaluations"],
  ["suggestionDispositions", "proposalDispositions"],
  ["supersedesSuggestionId", "supersedesProposalId"],
  ["selectedSuggestionId", "selectedProposalId"],
  ["winningSuggestionId", "winningProposalId"],
  ["relatedSuggestionIds", "relatedProposalIds"],
  ["terminalSuggestionDigest", "terminalProposalDigest"],
  ["terminalSuggestionDigestUpdates", "terminalProposalDigestUpdates"],
  ["terminalSuggestionCount", "terminalProposalCount"],
  ["acceptedSuggestionIds", "acceptedProposalIds"],
  ["rejectedSuggestionIds", "rejectedProposalIds"],
  ["unresolvedSuggestionIds", "unresolvedProposalIds"],
  ["pendingSuggestionIds", "pendingProposalIds"],
  ["pendingSuggestions", "pendingProposals"],
  ["suggestions", "proposals"],
]);
const scalarIdKeys = new Set([
  "suggestionId",
  "supersedesSuggestionId",
  "selectedSuggestionId",
  "winningSuggestionId",
]);
const arrayIdKeys = new Set([
  "suggestionIds",
  "relatedSuggestionIds",
  "acceptedSuggestionIds",
  "rejectedSuggestionIds",
  "unresolvedSuggestionIds",
  "pendingSuggestionIds",
]);
const opaqueKeys = new Set(["result"]);
const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const encodeJson = Schema.encodeSync(JsonText);

const rewriteProposalId = (value: unknown): unknown =>
  Predicate.isString(value) && value.startsWith("suggestion_")
    ? `proposal_${value.slice("suggestion_".length)}`
    : value;

const rewriteProposalJsonValue = (value: unknown, owningKey: string | null = null): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      owningKey !== null && arrayIdKeys.has(owningKey)
        ? rewriteProposalId(item)
        : rewriteProposalJsonValue(item),
    );
  }
  if (!Predicate.isObject(value)) {
    return owningKey !== null && scalarIdKeys.has(owningKey) ? rewriteProposalId(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      renamedKeys.get(key) ?? key,
      opaqueKeys.has(key)
        ? child
        : scalarIdKeys.has(key)
          ? rewriteProposalId(child)
          : rewriteProposalJsonValue(child, key),
    ]),
  );
};

const rewriteProposalJson = (value: string): string =>
  encodeJson(rewriteProposalJsonValue(decodeJson(value)));

const jsonColumns = [
  ["projection_magi_runs", "snapshot_json"],
  ["projection_magi_turns", "turn_json"],
  ["projection_magi_responses", "response_json"],
  ["projection_magi_proposals", "proposal_json"],
  ["projection_magi_proposal_evaluations", "evaluation_json"],
  ["projection_magi_exclusive_decision_sets", "decision_json"],
  ["projection_magi_exclusive_set_evaluations", "evaluation_json"],
  ["projection_magi_action_batches", "batch_json"],
  ["projection_magi_actions", "action_json"],
  ["projection_magi_action_reconciliations", "reconciliation_json"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  const names = new Set(tables.map((table) => table.name));

  if (names.has("projection_magi_suggestions") && !names.has("projection_magi_proposals")) {
    yield* sql`ALTER TABLE projection_magi_suggestions RENAME TO projection_magi_proposals`;
    yield* sql`ALTER TABLE projection_magi_proposals RENAME COLUMN suggestion_id TO proposal_id`;
    yield* sql`ALTER TABLE projection_magi_proposals RENAME COLUMN suggestion_json TO proposal_json`;
  }
  if (
    names.has("projection_magi_suggestion_evaluations") &&
    !names.has("projection_magi_proposal_evaluations")
  ) {
    yield* sql`
      ALTER TABLE projection_magi_suggestion_evaluations
      RENAME TO projection_magi_proposal_evaluations
    `;
    yield* sql`
      ALTER TABLE projection_magi_proposal_evaluations
      RENAME COLUMN suggestion_id TO proposal_id
    `;
  }

  for (const [table, column] of jsonColumns) {
    const rows = yield* sql.unsafe<{ readonly rowId: number; readonly value: string }>(
      `SELECT rowid AS "rowId", ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`,
    );
    for (const row of rows) {
      yield* sql.unsafe(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [
        rewriteProposalJson(row.value),
        row.rowId,
      ]);
    }
  }

  yield* sql`
    UPDATE projection_magi_proposals
    SET proposal_id = 'proposal_' || substr(proposal_id, length('suggestion_') + 1)
    WHERE proposal_id LIKE 'suggestion_%'
  `;
  yield* sql`
    UPDATE projection_magi_proposal_evaluations
    SET proposal_id = 'proposal_' || substr(proposal_id, length('suggestion_') + 1)
    WHERE proposal_id LIKE 'suggestion_%'
  `;
  yield* sql`DROP TABLE IF EXISTS projection_magi_requested_roster`;
  yield* sql`DROP TABLE IF EXISTS projection_magi_preflight_exclusions`;
});

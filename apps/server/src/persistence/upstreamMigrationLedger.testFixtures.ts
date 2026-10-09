import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { PUBLISHED_FORK_MIGRATION_ID, migrationManifest, runMigrations } from "./Migrations.ts";

/** Upstream's migration names from id 33; ids 1 through 32 match main. */
const upstreamNamesFrom33 = [
  "ProjectionThreadsSettled",
  "ProjectionThreadsSnoozed",
  "ProjectionThreadTitleRegeneration",
  "ProjectionThreadsPinned",
  "ProjectionTurnsKeysetIndex",
  "ProjectionThreadsPinOrderKey",
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
  "AuthSessionClientConnection",
  "ProjectionThreadLinkedPullRequest",
  "ProjectionThreadsUnsettledAt",
  "ClearAutomaticProjectModelDefaults",
  "ProjectionProjectsAutoPull",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionProjectIcon",
  "ProjectionThreadBranchPullRequest",
  "ProjectionThreadsActiveOrderKey",
  "ProjectionThreadPullRequests",
  "ProjectionThreadMessageContext",
  "ProjectionThreadTitleState",
  "PullRequestFilesViewed",
  "ProjectionThreadsAutoSettleDisabledAt",
  "OrchestrationV2",
  "RemoveRedundantProjectionIndexes",
] as const;

export const upstreamMigrationManifest: ReadonlyArray<readonly [number, string]> = [
  ...migrationManifest.filter(([id]) => id <= 32),
  ...upstreamNamesFrom33.map((name, index) => [index + 33, name] as const),
];

/**
 * Seeds the published fork V1 schema, a superset of upstream's V1 schema, and records
 * upstream's ledger through `throughId` in place of the fork ledger.
 */
export const seedUpstreamLedger = (throughId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: PUBLISHED_FORK_MIGRATION_ID });
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 32`;
    for (const [id, name] of upstreamMigrationManifest) {
      if (id <= 32 || id > throughId) continue;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

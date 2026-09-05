/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadParentRelation.ts";
import Migration0034 from "./Migrations/034_BackfillEmptyProjectionThreadRootIds.ts";
import Migration0035 from "./Migrations/035_ThreadColdArchive.ts";
import Migration0036 from "./Migrations/036_DeletedThreadCleanupQueue.ts";
import Migration0037 from "./Migrations/037_SubagentColdArchiveGlue.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsSettled.ts";
import Migration0039 from "./Migrations/039_ProjectionThreadsSnoozed.ts";
import Migration0040 from "./Migrations/040_ProjectionThreadTitleRegeneration.ts";
import Migration0041 from "./Migrations/041_ThreadColdArchiveCompatibility.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadsPinned.ts";
import Migration0043 from "./Migrations/043_ProjectionTurnsKeysetIndex.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadsPinOrderKey.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0046 from "./Migrations/046_ProjectionProjectFaviconPath.ts";
import Migration0047 from "./Migrations/047_ThreadStorageLifecycleCompatibility.ts";
import Migration0048 from "./Migrations/048_MagiProjections.ts";
import Migration0049 from "./Migrations/049_MagiActiveConversationUniqueness.ts";
import Migration0050 from "./Migrations/050_MagiProposalTerminology.ts";
import Migration0051 from "./Migrations/051_MagiThreadColdArchiveGlue.ts";
import Migration0052 from "./Migrations/052_AuthSessionClientConnection.ts";
import Migration0053 from "./Migrations/053_ProjectionThreadLinkedPullRequest.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsUnsettledAt.ts";
import Migration0055 from "./Migrations/048_ClearAutomaticProjectModelDefaults.ts";
import Migration0056 from "./Migrations/049_ProjectionProjectsAutoPull.ts";
import Migration0057 from "./Migrations/050_ProjectionThreadLineageConvergenceAfterUpstreamTail.ts";
import Migration0058 from "./Migrations/051_RepairAutomaticSettlementTimestamps.ts";
import Migration0059 from "./Migrations/052_ProjectionProjectIcon.ts";
import Migration0060 from "./Migrations/060_MagiCoreMigrationCompatibility.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadParentRelation", Migration0033],
  [34, "BackfillEmptyProjectionThreadRootIds", Migration0034],
  [35, "ThreadColdArchive", Migration0035],
  [36, "DeletedThreadCleanupQueue", Migration0036],
  [37, "SubagentColdArchiveGlue", Migration0037],
  [38, "ProjectionThreadsSettled", Migration0038],
  [39, "ProjectionThreadsSnoozed", Migration0039],
  [40, "ProjectionThreadTitleRegeneration", Migration0040],
  [41, "ThreadColdArchiveCompatibility", Migration0041],
  [42, "ProjectionThreadsPinned", Migration0042],
  [43, "ProjectionTurnsKeysetIndex", Migration0043],
  [44, "ProjectionThreadsPinOrderKey", Migration0044],
  [45, "ProjectionProjectsDefaultThreadEnvMode", Migration0045],
  [46, "ProjectionProjectFaviconPath", Migration0046],
  [47, "ThreadStorageLifecycleCompatibility", Migration0047],
  [48, "MagiProjections", Migration0048],
  [49, "MagiActiveConversationUniqueness", Migration0049],
  [50, "MagiProposalTerminology", Migration0050],
  [51, "MagiThreadColdArchiveGlue", Migration0051],
  [52, "AuthSessionClientConnection", Migration0052],
  [53, "ProjectionThreadLinkedPullRequest", Migration0053],
  [54, "ProjectionThreadsUnsettledAt", Migration0054],
  [55, "ClearAutomaticProjectModelDefaults", Migration0055],
  [56, "ProjectionProjectsAutoPull", Migration0056],
  [57, "ProjectionThreadLineageConvergenceAfterUpstreamTail", Migration0057],
  [58, "RepairAutomaticSettlementTimestamps", Migration0058],
  [59, "ProjectionProjectIcon", Migration0059],
  [60, "MagiCoreMigrationCompatibility", Migration0060],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

const normalizeDivergentMigrationHistory = Effect.fn("normalizeDivergentMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const migrationTable = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if ((migrationTable[0]?.count ?? 0) === 0) {
      return;
    }

    const upstreamTitleAt35 = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM effect_sql_migrations
      WHERE migration_id = 35 AND name = 'ProjectionThreadTitleRegeneration'
    `;
    if (upstreamTitleAt35.length === 0) {
      return;
    }

    yield* Effect.logInfo("normalizing divergent upstream migration history", {
      migrationId: 35,
      name: upstreamTitleAt35[0]?.name,
    });

    // Upstream published title regeneration, pinning, project mode, project
    // favicon, authentication, pull-request, settlement, and icon migrations
    // at ids 35 through 47
    // after the fork had already published cold storage there. Remove only
    // those upstream history markers: all schema changes are idempotent, so
    // the canonical fork sequence can replay 35 through 47 without deleting
    // upstream-created columns, indexes, or data.
    yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE
        (migration_id = 35 AND name = 'ProjectionThreadTitleRegeneration') OR
        (migration_id = 36 AND name = 'ProjectionThreadsPinned') OR
        (migration_id = 37 AND name = 'ProjectionTurnsKeysetIndex') OR
        (migration_id = 38 AND name = 'ProjectionThreadsPinOrderKey') OR
        (migration_id = 39 AND name = 'ProjectionProjectsDefaultThreadEnvMode') OR
        (migration_id = 40 AND name = 'ProjectionProjectFaviconPath') OR
        (migration_id = 41 AND name = 'AuthSessionClientConnection') OR
        (migration_id = 42 AND name = 'ProjectionThreadLinkedPullRequest') OR
        (migration_id = 43 AND name = 'ProjectionThreadsUnsettledAt') OR
        (migration_id = 44 AND name = 'ClearAutomaticProjectModelDefaults') OR
        (migration_id = 45 AND name = 'ProjectionProjectsAutoPull') OR
        (migration_id = 46 AND name = 'RepairAutomaticSettlementTimestamps') OR
        (migration_id = 47 AND name = 'ProjectionProjectIcon')
    `;
  },
);

const normalizeLegacyMagiMigrationHistory = Effect.fn("normalizeLegacyMagiMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) {
      return;
    }

    yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE
        (name = 'MagiProjections' AND migration_id <> 48) OR
        (name = 'MagiActiveConversationUniqueness' AND migration_id <> 49) OR
        (name = 'MagiProposalTerminology' AND migration_id <> 50) OR
        (name = 'MagiCoreMigrationCompatibility' AND migration_id <> 60)
    `;
  },
);

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* normalizeDivergentMigrationHistory();
  yield* normalizeLegacyMagiMigrationHistory();
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import { migrationEntries } from "./Migrations.ts";

import Upstream33 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Upstream34 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Upstream35 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Upstream36 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Upstream37 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Upstream38 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Upstream39 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Upstream40 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Upstream41 from "./Migrations/041_AuthSessionClientConnection.ts";
import Upstream42 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Upstream43 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Upstream44 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Upstream45 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Upstream46 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Upstream47 from "./Migrations/047_ProjectionProjectIcon.ts";
import Upstream48 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Upstream49 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Upstream50 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Upstream51 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Upstream52 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Upstream53 from "./Migrations/053_PullRequestFilesViewed.ts";
import Upstream54 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Upstream55 from "./Migrations/055_OrchestrationV2.ts";
import Upstream56 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Upstream57 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Upstream58 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Upstream59 from "./Migrations/059_McpAppModelContext.ts";
import Upstream60 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Upstream61 from "./Migrations/061_PullRequestReviewGuides.ts";
import Upstream62 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Upstream63 from "./Migrations/063_DropUnusedV1Projections.ts";

import Upstream64 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";

import Upstream65 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";

import Upstream66 from "./Migrations/066_RepairClientSettlementTimestamps.ts";

import Upstream67 from "./Migrations/067_WebhookDedupe.ts";

import Upstream68 from "./Migrations/068_ShellStopRequestIndex.ts";

/** Actual upstream schema and ledger, without pre-seeding fork-only tables. */
const upstreamEntries = [
  ...migrationEntries.filter(([id]) => id <= 32),
  [33, "ProjectionThreadsSettled", Upstream33],
  [34, "ProjectionThreadsSnoozed", Upstream34],
  [35, "ProjectionThreadTitleRegeneration", Upstream35],
  [36, "ProjectionThreadsPinned", Upstream36],
  [37, "ProjectionTurnsKeysetIndex", Upstream37],
  [38, "ProjectionThreadsPinOrderKey", Upstream38],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Upstream39],
  [40, "ProjectionProjectFaviconPath", Upstream40],
  [41, "AuthSessionClientConnection", Upstream41],
  [42, "ProjectionThreadLinkedPullRequest", Upstream42],
  [43, "ProjectionThreadsUnsettledAt", Upstream43],
  [44, "ClearAutomaticProjectModelDefaults", Upstream44],
  [45, "ProjectionProjectsAutoPull", Upstream45],
  [46, "RepairAutomaticSettlementTimestamps", Upstream46],
  [47, "ProjectionProjectIcon", Upstream47],
  [48, "ProjectionThreadBranchPullRequest", Upstream48],
  [49, "ProjectionThreadsActiveOrderKey", Upstream49],
  [50, "ProjectionThreadPullRequests", Upstream50],
  [51, "ProjectionThreadMessageContext", Upstream51],
  [52, "ProjectionThreadTitleState", Upstream52],
  [53, "PullRequestFilesViewed", Upstream53],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Upstream54],
  [55, "OrchestrationV2", Upstream55],
  [56, "RemoveRedundantProjectionIndexes", Upstream56],
  [57, "ScheduledTaskWebhooks", Upstream57],
  [58, "WebhookRelayDeliveries", Upstream58],
  [59, "McpAppModelContext", Upstream59],
  [60, "ThreadSnapshotWindowIndexes", Upstream60],
  [61, "PullRequestReviewGuides", Upstream61],
  [62, "ThreadFailureLookupIndex", Upstream62],
  [63, "DropUnusedV1Projections", Upstream63],
  [64, "CanonicalizeThreadPullRequestLinks", Upstream64],
  [65, "CodexUsageNativeTurnIndex", Upstream65],
  [66, "RepairClientSettlementTimestamps", Upstream66],
  [67, "WebhookDedupe", Upstream67],
  [68, "ShellStopRequestIndex", Upstream68],
] as const;

export const upstreamMigrationManifest = upstreamEntries.map(([id, name]) => [id, name] as const);

export const seedUpstreamLedger = (throughId: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        upstreamEntries
          .filter(([id]) => id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  }).pipe(Effect.asVoid);

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import Upstream78 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import Upstream79 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Upstream80 from "./Migrations/080_ScheduledTaskThreadMode.ts";
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
import Upstream69 from "./Migrations/069_ThreadMessageSearch.ts";
import Upstream70 from "./Migrations/070_PeerLinks.ts";
import Upstream71 from "./Migrations/071_PeerLinkFence.ts";
import Upstream72 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Upstream73 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Upstream74 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Upstream75 from "./Migrations/075_SubagentDeliveryState.ts";
import Upstream76 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import Upstream77 from "./Migrations/077_RepairBooleanSettledOverride.ts";

import Upstream81 from "./Migrations/081_ProjectionMessageSearchText.ts";
import Upstream82 from "./Migrations/082_TurnItemConversationIndex.ts";
import Upstream83 from "./Migrations/083_CommandReadIndexes.ts";
import Upstream84 from "./Migrations/084_LastExecutedRunIndex.ts";
import Upstream85 from "./Migrations/085_TurnItemCounts.ts";
import Upstream86 from "./Migrations/086_QueuedTurnInputIndex.ts";
import Upstream87 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import Upstream88 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import Upstream89 from "./Migrations/089_ShellThreadReadIndexes.ts";
import Upstream90 from "./Migrations/090_AuthConnectDevices.ts";
import Upstream91 from "./Migrations/091_AuthConnectDeniedRequests.ts";
import Upstream92 from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import Upstream93 from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import Upstream94 from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import Upstream95 from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import Upstream96 from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import Upstream97 from "./Migrations/097_IssueTrackerBindings.ts";
import Upstream98 from "./Migrations/098_ActiveShellIndexIndexes.ts";
import Upstream99 from "./Migrations/099_BackgroundRecoveryIndexes.ts";
import Upstream100 from "./Migrations/100_TurnStartReadIndexes.ts";
import Upstream101 from "./Migrations/101_DelegatedTaskReadIndexes.ts";
import Upstream102 from "./Migrations/102_ThreadItemCounts.ts";
import Upstream103 from "./Migrations/103_IssueTrackerAdditionalScopes.ts";
import Upstream104 from "./Migrations/104_ProjectionProjectsTrackedFolders.ts";
import Upstream105 from "./Migrations/105_TaskFolders.ts";
import Upstream106 from "./Migrations/106_WorktreePathKeyIndex.ts";
import Upstream107 from "./Migrations/107_DeferredSlashCommandIndex.ts";
import Upstream108 from "./Migrations/108_AgentFeedback.ts";
import Upstream109 from "./Migrations/109_IssueTrackerAccounts.ts";
import Upstream110 from "./Migrations/110_Workflows.ts";
import Upstream111 from "./Migrations/111_SupersededRunAttemptIndex.ts";
import Upstream112 from "./Migrations/112_LayoutCommandApprovals.ts";
import Upstream113 from "./Migrations/113_WorkflowSkippedRuns.ts";
import Upstream114 from "./Migrations/114_WorkflowRunIndexes.ts";
import Upstream115 from "./Migrations/115_WorkflowRunTags.ts";
import Upstream116 from "./Migrations/116_ForkHistoryMembership.ts";
import Upstream117 from "./Migrations/117_WorkflowMailSender.ts";
import Upstream118 from "./Migrations/118_WorkflowPools.ts";
import Upstream119 from "./Migrations/119_WorkflowRunSubject.ts";

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
  [69, "ThreadMessageSearch", Upstream69],
  [70, "PeerLinks", Upstream70],
  [71, "PeerLinkFence", Upstream71],
  [72, "WaitingLinkRequestIndex", Upstream72],
  [73, "ActiveTurnItemIndexes", Upstream73],
  [74, "ExcludeAttachmentPlaceholdersFromSearch", Upstream74],
  [75, "SubagentDeliveryState", Upstream75],
  [76, "ProjectionProjectsPinArchive", Upstream76],
  [77, "RepairBooleanSettledOverride", Upstream77],
  [78, "DropOrchestrationEventCorrelationIndex", Upstream78],
  [79, "DelegatedRecoveryIndexes", Upstream79],
  [80, "ScheduledTaskThreadMode", Upstream80],
  [81, "ProjectionMessageSearchText", Upstream81],
  [82, "TurnItemConversationIndex", Upstream82],
  [83, "CommandReadIndexes", Upstream83],
  [84, "LastExecutedRunIndex", Upstream84],
  [85, "TurnItemCounts", Upstream85],
  [86, "QueuedTurnInputIndex", Upstream86],
  [87, "ProjectionProjectsCustomTitle", Upstream87],
  [88, "TurnItemTypeStatusIndex", Upstream88],
  [89, "ShellThreadReadIndexes", Upstream89],
  [90, "AuthConnectDevices", Upstream90],
  [91, "AuthConnectDeniedRequests", Upstream91],
  [92, "QueuedTurnInputIndexJsonValid", Upstream92],
  [93, "ProviderTurnAttemptIndex", Upstream93],
  [94, "TurnItemMessageOrdinalIndex", Upstream94],
  [95, "TurnItemInlineWorkOutput", Upstream95],
  [96, "RepairStaleTitleRegeneration", Upstream96],
  [97, "IssueTrackerBindings", Upstream97],
  [98, "ActiveShellIndexIndexes", Upstream98],
  [99, "BackgroundRecoveryIndexes", Upstream99],
  [100, "TurnStartReadIndexes", Upstream100],
  [101, "DelegatedTaskReadIndexes", Upstream101],
  [102, "ThreadItemCounts", Upstream102],
  [103, "IssueTrackerAdditionalScopes", Upstream103],
  [104, "ProjectionProjectsTrackedFolders", Upstream104],
  [105, "TaskFolders", Upstream105],
  [106, "WorktreePathKeyIndex", Upstream106],
  [107, "DeferredSlashCommandIndex", Upstream107],
  [108, "AgentFeedback", Upstream108],
  [109, "IssueTrackerAccounts", Upstream109],
  [110, "Workflows", Upstream110],
  [111, "SupersededRunAttemptIndex", Upstream111],
  [112, "LayoutCommandApprovals", Upstream112],
  [113, "WorkflowSkippedRuns", Upstream113],
  [114, "WorkflowRunIndexes", Upstream114],
  [115, "WorkflowRunTags", Upstream115],
  [116, "ForkHistoryMembership", Upstream116],
  [117, "WorkflowMailSender", Upstream117],
  [118, "WorkflowPools", Upstream118],
  [119, "WorkflowRunSubject", Upstream119],
] as const;

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

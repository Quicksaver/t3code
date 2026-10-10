import {
  exactDuplicateMagiParticipantGroups,
  isMagiRunTerminal,
  type MagiArbitrationStance,
  type MagiBallot,
  type MagiMemberState,
  type MagiParticipantDraft,
  type MagiRunDetail,
  type MagiRunConfig,
  type MagiRunState,
  type MagiRunSummary,
} from "@t3tools/contracts";

/** Pure Magi presentation shared by the web panel and the mobile sheet. */

export type MagiParticipantIndicator =
  | "neutral"
  | "working"
  | "warning"
  | "supports"
  | "opposes"
  | "abstained";

export interface MagiParticipantStatusInput {
  readonly runState: MagiRunState;
  readonly memberState: MagiMemberState;
  readonly finalStance: MagiArbitrationStance | null;
  readonly finalBallot: MagiBallot | null;
}

const isUnfinishedMemberState = (state: MagiMemberState) =>
  state === "failed" || state === "timed-out" || state === "cancelled";

/** A participant's status light: its counted stance once the run succeeds, else its progress. */
export function magiParticipantIndicator(
  input: MagiParticipantStatusInput,
): MagiParticipantIndicator {
  if (input.runState === "succeeded" && input.finalStance !== null) {
    if (input.finalStance === "supports") return "supports";
    if (input.finalStance === "opposes") return "opposes";
    return input.memberState === "settled" && input.finalBallot === "abstain"
      ? "abstained"
      : "warning";
  }
  if (isMagiRunTerminal(input.runState)) {
    return isUnfinishedMemberState(input.memberState) ? "warning" : "neutral";
  }
  if (input.memberState === "running") return "working";
  return isUnfinishedMemberState(input.memberState) ? "warning" : "neutral";
}

/** The words that accompany a participant's status light. */
export function magiParticipantStatusLabel(input: MagiParticipantStatusInput): string {
  const indicator = magiParticipantIndicator(input);
  if (indicator === "supports") return "Voted for consensus";
  if (indicator === "opposes") return "Voted against consensus";
  if (indicator === "abstained") return "Abstained";
  if (indicator === "warning") {
    return input.finalStance === "unclear"
      ? "No valid final vote"
      : input.memberState.replaceAll("-", " ");
  }
  if (indicator === "working") return "Working";
  return input.memberState === "pending" ? "Waiting" : "Finished";
}

const MAGI_RUN_STATE_LABELS: Record<MagiRunState, string> = {
  initializing: "Initializing",
  "awaiting-main-tool": "Awaiting main agent",
  deliberating: "Deliberating",
  "awaiting-arbitration": "Awaiting arbitration",
  "awaiting-actions": "Awaiting actions",
  "awaiting-next-turn": "Awaiting next turn",
  "awaiting-main-approval": "Awaiting approval",
  "awaiting-main-input": "Awaiting input",
  "awaiting-action-reconciliation": "Awaiting action review",
  paused: "Paused",
  cancelling: "Cancelling",
  succeeded: "Consensus reached",
  "turn-limit-reached": "Failed to reach consensus",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** User-facing run state for panels, history rows and the timeline. */
export function magiRunStateLabel(state: MagiRunState): string {
  return MAGI_RUN_STATE_LABELS[state];
}

/** Ids of participants whose model, options and personality exactly match another's. */
export function exactDuplicateMagiParticipantIds(
  participants: ReadonlyArray<MagiParticipantDraft>,
): ReadonlySet<string> {
  return new Set(exactDuplicateMagiParticipantGroups(participants).flat());
}

/**
 * The issued action batch the main agent has not recorded yet, or null. The server keeps the batch
 * through action reconciliation, where its actions are already listed as recorded actions; a pause
 * or stop leaves an unrecorded batch in place.
 */
export function unrecordedMagiActionBatch(
  detail: Pick<MagiRunDetail, "actions" | "issuedActionBatch">,
): MagiRunDetail["issuedActionBatch"] {
  const batch = detail.issuedActionBatch;
  if (!batch) return null;
  const recorded = new Set(detail.actions.map((action) => action.actionId));
  return batch.actions.some((action) => recorded.has(action.actionId)) ? null : batch;
}

/** Elapsed run time: live runs read the clock, finished runs stop at completion. */
export function magiRunElapsedMs(
  run: Pick<MagiRunSummary, "startedAt" | "completedAt">,
  nowMs: number,
): number {
  return Math.max(
    0,
    (run.completedAt === null ? nowMs : Date.parse(run.completedAt)) - Date.parse(run.startedAt),
  );
}

/** Who started a run and its turn progress; the collapsed summary of the run's prompt. */
export function magiRunStartedCopy(
  summary: Pick<MagiRunSummary, "source" | "completedMagiTurns">,
  magiTurnLimit: number | null,
): string {
  const starter = summary.source === "user-arm" ? "User" : "Agent";
  const limit = magiTurnLimit === null ? "" : `/${magiTurnLimit}`;
  return `Started by ${starter} · ${summary.completedMagiTurns}${limit} turns`;
}

/** Tracks unsent edits separately from writes, so an older acknowledgment cannot erase a newer edit. */
export function createMagiArmConfigAdoption() {
  let version = 0;
  let edited = false;
  let synchronizingVersion: number | null = null;
  return {
    get hasUnsentEdits() {
      return edited && synchronizingVersion !== version;
    },
    markEdited() {
      edited = true;
      return ++version;
    },
    beginWrite(editVersion = version) {
      if (editVersion === version) synchronizingVersion = editVersion;
      return editVersion;
    },
    acknowledge(editVersion: number) {
      if (editVersion === version) edited = false;
    },
    cancelPendingWrite() {
      // Canceled synchronization follows the server; edits never submitted remain local.
      if (synchronizingVersion === version) edited = false;
      synchronizingVersion = null;
    },
    reset() {
      version += 1;
      edited = false;
      synchronizingVersion = null;
    },
    adopt(config: MagiRunConfig): MagiRunConfig | null {
      return edited ? null : config;
    },
  };
}

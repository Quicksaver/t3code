import type {
  MagiParticipantId,
  MagiProposalEvaluation,
  MagiProposalId,
  MagiRunConfig,
  MagiRunTurnDetail,
} from "@t3tools/contracts";

/** Consensus threshold bounds of the Magi panel; the run contract alone also accepts 1..50. */
export const MOBILE_MAGI_MIN_THRESHOLD_PERCENT = 51;
export const MOBILE_MAGI_MAX_THRESHOLD_PERCENT = 100;

/** The threshold a typed value commits to: clamped to the panel bounds, or `fallback` when blank. */
export function mobileMagiThresholdFromInput(text: string, fallback: number): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    MOBILE_MAGI_MAX_THRESHOLD_PERCENT,
    Math.max(MOBILE_MAGI_MIN_THRESHOLD_PERCENT, value),
  );
}

/** Conversation state that keeps a new arm from starting the intended next turn. */
export interface MobileMagiArmReadiness {
  readonly activeTurn?: boolean;
  readonly pendingApproval?: boolean;
  readonly pendingUserInput?: boolean;
  readonly submitting?: boolean;
}

/** Why arming is unavailable right now, or null when the conversation is idle. */
export function mobileMagiArmBlockedReason(
  readiness: MobileMagiArmReadiness & { readonly activeMagiRun: boolean },
): string | null {
  if (readiness.activeMagiRun) return "A Magi run is already active in this conversation.";
  if (readiness.pendingApproval) return "Answer the pending approval before arming Magi.";
  if (readiness.pendingUserInput) return "Answer the pending question before arming Magi.";
  if (readiness.activeTurn) return "Wait for the current turn to finish before arming Magi.";
  if (readiness.submitting) return "Wait for the first message to finish sending.";
  return null;
}

/** Display names of the distinct provider instances a roster sends conversation data to. */
export function mobileMagiRosterInstanceNames(
  config: MagiRunConfig,
  providerInstances: ReadonlyArray<{
    readonly instanceId: string;
    readonly displayName: string;
  }>,
): ReadonlyArray<string> {
  const instanceIds = [
    ...new Set(config.participants.map((item) => item.modelSelection.instanceId)),
  ];
  return instanceIds.map(
    (instanceId) =>
      providerInstances.find((provider) => provider.instanceId === instanceId)?.displayName ??
      instanceId,
  );
}

/** Every participant evaluation of one proposal, in turn order. */
export function mobileMagiProposalEvaluations(
  turns: ReadonlyArray<MagiRunTurnDetail>,
  proposalId: MagiProposalId,
): ReadonlyArray<
  MagiProposalEvaluation & { readonly magiTurn: number; readonly participantId: MagiParticipantId }
> {
  return turns.flatMap((turn) =>
    turn.settlements.flatMap((settlement) =>
      (settlement.parsed?.proposalEvaluations ?? [])
        .filter((evaluation) => evaluation.proposalId === proposalId)
        .map((evaluation) => ({
          ...evaluation,
          magiTurn: turn.magiTurn,
          participantId: settlement.participantId,
        })),
    ),
  );
}

/**
 * Runs the sheet's arm and disarm writes one at a time. When the last queued write finishes,
 * `onDrained` learns whether a write asked for the server arm to be reapplied, which a rejected
 * write needs because refreshing an unchanged server value changes nothing the sheet observes.
 */
export function createMobileMagiArmQueue(onDrained: (reconcile: boolean) => void) {
  let chain = Promise.resolve();
  let pending = 0;
  let reconcile = false;
  return {
    /** Queued writes, counting the one running until it finishes. */
    get pending() {
      return pending;
    },
    requestReconcile() {
      if (pending === 0) onDrained(true);
      else reconcile = true;
    },
    enqueue(task: () => Promise<void>): Promise<void> {
      pending += 1;
      const next = chain.then(async () => {
        try {
          await task();
        } finally {
          pending -= 1;
          if (pending === 0) {
            const requested = reconcile;
            reconcile = false;
            onDrained(requested);
          }
        }
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

import {
  magiExclusiveDecisionSetFingerprint,
  magiProposalIdentity,
  type MagiDecisionSetId,
  type MagiCandidateFingerprint,
  type MagiExclusiveDecisionSetInput,
  type MagiKnownDecisionSet,
  type MagiProposal,
  type MagiParticipantDraft,
  type MagiParticipantAssessment,
  type MagiParticipantSettlement,
  type MagiRunId,
  type MagiProposalId,
} from "@t3tools/contracts";

import { resolveMagiProposalReference } from "./MagiTerminalProposalDigest.ts";

export function structuredMagiCandidateSupportWeight(input: {
  readonly participants: ReadonlyArray<MagiParticipantDraft>;
  readonly settlements: ReadonlyArray<MagiParticipantSettlement>;
  readonly candidateFingerprint: MagiCandidateFingerprint;
}): number {
  const weights = new Map(
    input.participants.map((participant) => [participant.participantId, participant.weight]),
  );
  return input.settlements.reduce(
    (total, settlement) =>
      settlement.state === "settled" &&
      settlement.parsed?.ballot === "approve" &&
      settlement.parsed.candidateFingerprint === input.candidateFingerprint
        ? total + (weights.get(settlement.participantId) ?? 0)
        : total,
    0,
  );
}

export function hasPendingMagiProtocolWork(input: {
  readonly pendingProposalCount: number;
  readonly hasPendingDecisionSet: boolean;
  readonly hasClarificationRequest: boolean;
  readonly requiresCandidateConfirmation: boolean;
  readonly requestedOutcome: "consensus" | "continue";
}): boolean {
  return (
    input.pendingProposalCount > 0 ||
    input.hasPendingDecisionSet ||
    input.hasClarificationRequest ||
    input.requiresCandidateConfirmation ||
    input.requestedOutcome === "continue"
  );
}

export function normalizeMagiArbitrationAssessments(input: {
  readonly participants: ReadonlyArray<MagiParticipantDraft>;
  readonly settlements: ReadonlyArray<MagiParticipantSettlement>;
  readonly recordedAssessments: ReadonlyArray<MagiParticipantAssessment>;
  readonly candidateChanged: boolean;
}): ReadonlyArray<MagiParticipantAssessment> {
  return input.participants.map((participant) => {
    const settlement = input.settlements.find(
      (item) => item.participantId === participant.participantId,
    );
    const recorded = input.recordedAssessments.find(
      (assessment) => assessment.participantId === participant.participantId,
    );
    const hasEvidence =
      settlement !== undefined &&
      (settlement.parsed !== null || settlement.rawText.trim().length > 0);
    // Structured output and candidate fingerprints help the main conversation
    // inspect evidence. They are not an independent vote gate: the arbitrator
    // may classify an explicit candidate-relative ballot from raw prose or a
    // response whose advisory fingerprint was omitted or malformed.
    const comparable = hasEvidence && !input.candidateChanged;
    return {
      participantId: participant.participantId,
      stance: comparable && recorded ? recorded.stance : "unclear",
      evidence: recorded?.evidence ?? "No arbitration assessment was recorded.",
      clarificationNeeded: comparable && (recorded?.clarificationNeeded ?? false),
      clarificationQuestion: comparable ? (recorded?.clarificationQuestion ?? null) : null,
    };
  });
}

export {
  calculateMagiDirectTransition,
  calculateMagiPostActionTransition,
  calculateMagiThreshold,
  currentMagiTurnVoteTotals,
  isMagiThresholdReachable,
} from "@t3tools/contracts";

export type KnownMagiProposal = MagiProposal;

type LegacyKnownMagiProposal = Pick<
  KnownMagiProposal,
  "proposalId" | "proposal" | "originParticipantIds" | "firstMagiTurn"
> &
  Partial<
    Pick<
      KnownMagiProposal,
      | "decision"
      | "decisionBasis"
      | "evaluationRounds"
      | "decisionMagiTurn"
      | "approvalWeight"
      | "rejectionWeight"
      | "integration"
    >
  >;

export const normalizeKnownMagiProposal = (
  proposal: LegacyKnownMagiProposal,
): KnownMagiProposal => ({
  ...proposal,
  decision: proposal.decision ?? "open",
  decisionBasis: proposal.decisionBasis ?? "pending",
  evaluationRounds: proposal.evaluationRounds ?? 0,
  decisionMagiTurn: proposal.decisionMagiTurn ?? null,
  approvalWeight: proposal.approvalWeight ?? 0,
  rejectionWeight: proposal.rejectionWeight ?? 0,
  integration: proposal.integration ?? "not-applicable",
});

export const isActiveMagiProposal = (proposal: KnownMagiProposal): boolean =>
  proposal.decision === "open" || proposal.decision === "reconsidering";

export const activeMagiProposals = (
  proposals: ReadonlyArray<KnownMagiProposal>,
): ReadonlyArray<KnownMagiProposal> => proposals.filter(isActiveMagiProposal);

export type KnownMagiDecisionSet = MagiKnownDecisionSet;

type LegacyKnownMagiDecisionSet = Pick<
  KnownMagiDecisionSet,
  "decisionSetId" | "proposalIds" | "rationale" | "firstMagiTurn"
> &
  Partial<
    Pick<
      KnownMagiDecisionSet,
      "decision" | "evaluationRounds" | "winningProposalId" | "decisionMagiTurn"
    >
  >;

export const normalizeKnownMagiDecisionSet = (
  decisionSet: LegacyKnownMagiDecisionSet,
): KnownMagiDecisionSet => ({
  ...decisionSet,
  decision: decisionSet.decision ?? "open",
  evaluationRounds: decisionSet.evaluationRounds ?? 0,
  winningProposalId: decisionSet.winningProposalId ?? null,
  decisionMagiTurn: decisionSet.decisionMagiTurn ?? null,
});

export const activeMagiDecisionSets = (
  decisionSets: ReadonlyArray<KnownMagiDecisionSet>,
): ReadonlyArray<KnownMagiDecisionSet> =>
  decisionSets.filter(
    (decisionSet) => decisionSet.decision === "open" || decisionSet.decision === "reconsidering",
  );

export function collectMagiProposals(
  runId: MagiRunId,
  magiTurn: number,
  settlements: ReadonlyArray<MagiParticipantSettlement>,
  known: ReadonlyArray<KnownMagiProposal>,
): ReadonlyArray<KnownMagiProposal> {
  const byId = new Map(
    known.map((proposal) => {
      const normalized = normalizeKnownMagiProposal(proposal);
      return [normalized.proposalId, normalized] as const;
    }),
  );
  for (const settlement of settlements) {
    for (const submittedProposal of settlement.parsed?.proposals ?? []) {
      const resolvedSupersedesProposalId = resolveMagiProposalReference(
        [...byId.values()],
        submittedProposal.supersedesProposalId,
      );
      const proposal =
        resolvedSupersedesProposalId === null
          ? submittedProposal
          : { ...submittedProposal, supersedesProposalId: resolvedSupersedesProposalId };
      const proposalId = magiProposalIdentity(runId, proposal);
      const previous = byId.get(proposalId);
      if (previous) {
        if (!previous.originParticipantIds.includes(settlement.participantId)) {
          byId.set(proposalId, {
            ...previous,
            originParticipantIds: [...previous.originParticipantIds, settlement.participantId],
          });
        }
      } else {
        const superseded =
          proposal.supersedesProposalId === undefined || proposal.supersedesProposalId === null
            ? undefined
            : byId.get(proposal.supersedesProposalId);
        if (
          superseded &&
          (superseded.decision === "rejected" || superseded.decision === "unresolved")
        ) {
          byId.set(superseded.proposalId, {
            ...superseded,
            decision: "superseded",
            decisionBasis: "superseded",
            decisionMagiTurn: magiTurn,
            integration: "not-applicable",
          });
        }
        byId.set(proposalId, {
          proposalId,
          proposal,
          originParticipantIds: [settlement.participantId],
          firstMagiTurn: magiTurn,
          decision: "open",
          decisionBasis: "pending",
          evaluationRounds: 0,
          decisionMagiTurn: null,
          approvalWeight: 0,
          rejectionWeight: 0,
          integration: "not-applicable",
        });
      }
    }
  }
  return [...byId.values()];
}

export function collectMagiDecisionSets(
  runId: MagiRunId,
  magiTurn: number,
  inputs: ReadonlyArray<MagiExclusiveDecisionSetInput>,
  known: ReadonlyArray<KnownMagiDecisionSet>,
): ReadonlyArray<KnownMagiDecisionSet> {
  const byId = new Map(
    known.map((decision) => {
      const normalized = normalizeKnownMagiDecisionSet(decision);
      return [normalized.decisionSetId, normalized] as const;
    }),
  );
  for (const input of inputs) {
    const decisionSetId = magiExclusiveDecisionSetFingerprint(runId, input.proposalIds);
    byId.set(decisionSetId, {
      decisionSetId,
      proposalIds: [...input.proposalIds],
      rationale: input.rationale,
      firstMagiTurn: byId.get(decisionSetId)?.firstMagiTurn ?? magiTurn,
      decision: byId.get(decisionSetId)?.decision ?? "open",
      evaluationRounds: byId.get(decisionSetId)?.evaluationRounds ?? 0,
      winningProposalId: byId.get(decisionSetId)?.winningProposalId ?? null,
      decisionMagiTurn: byId.get(decisionSetId)?.decisionMagiTurn ?? null,
    });
  }
  return [...byId.values()];
}

export interface MagiProposalOutcome {
  readonly proposalId: MagiProposalId;
  readonly approvalWeight: number;
  readonly rejectionWeight: number;
  readonly evaluatedParticipantIds: ReadonlyArray<string>;
  readonly decision: KnownMagiProposal["decision"];
  readonly decisionBasis: KnownMagiProposal["decisionBasis"];
  readonly evaluationRounds: number;
  readonly resolvedThisTurn: boolean;
  readonly pending: boolean;
}

/** Only explicit current-turn ballots count. Missing ballots, abstentions, and
 * failed participants add no weight to either side. A threshold-capable panel
 * gets one ordinary evaluation and one focused reconsideration before a
 * no-threshold proposal becomes terminally unresolved. */
export function calculateMagiProposalOutcomes(input: {
  readonly magiTurn: number;
  readonly proposals: ReadonlyArray<KnownMagiProposal>;
  readonly participants: ReadonlyArray<MagiParticipantDraft>;
  readonly settlements: ReadonlyArray<MagiParticipantSettlement>;
  readonly requiredWeight: number;
}): ReadonlyArray<MagiProposalOutcome> {
  const weights = new Map(
    input.participants.map((participant) => [participant.participantId, participant.weight]),
  );
  return input.proposals.map((proposal) => {
    if (!isActiveMagiProposal(proposal)) {
      return {
        proposalId: proposal.proposalId,
        approvalWeight: proposal.approvalWeight,
        rejectionWeight: proposal.rejectionWeight,
        evaluatedParticipantIds: [],
        decision: proposal.decision,
        decisionBasis: proposal.decisionBasis,
        evaluationRounds: proposal.evaluationRounds,
        resolvedThisTurn: false,
        pending: false,
      };
    }
    const evaluations = input.settlements.flatMap((settlement) =>
      (settlement.state === "settled" ? (settlement.parsed?.proposalEvaluations ?? []) : [])
        .filter((evaluation) => evaluation.proposalId === proposal.proposalId)
        .slice(0, 1)
        .map((evaluation) => ({ participantId: settlement.participantId, evaluation })),
    );
    const evaluatedParticipantIds = [
      ...new Set(evaluations.map(({ participantId }) => participantId)),
    ];
    const approvalWeight = evaluations.reduce(
      (total, { participantId, evaluation }) =>
        total + (evaluation.ballot === "approve" ? (weights.get(participantId) ?? 0) : 0),
      0,
    );
    const rejectionWeight = evaluations.reduce(
      (total, { participantId, evaluation }) =>
        total + (evaluation.ballot === "reject" ? (weights.get(participantId) ?? 0) : 0),
      0,
    );
    const introducedNow = proposal.firstMagiTurn >= input.magiTurn;
    const settledParticipantIds = [
      ...new Set(
        input.settlements
          .filter((settlement) => settlement.state === "settled" && settlement.parsed !== null)
          .map((settlement) => settlement.participantId),
      ),
    ];
    const settledWeight = settledParticipantIds.reduce(
      (total, participantId) => total + (weights.get(participantId) ?? 0),
      0,
    );
    if (introducedNow || settledWeight < input.requiredWeight) {
      return {
        proposalId: proposal.proposalId,
        approvalWeight,
        rejectionWeight,
        evaluatedParticipantIds,
        decision: proposal.decision,
        decisionBasis: "pending" as const,
        evaluationRounds: proposal.evaluationRounds,
        resolvedThisTurn: false,
        pending: true,
      };
    }
    const evaluationRounds = proposal.evaluationRounds + 1;
    const decision =
      approvalWeight >= input.requiredWeight
        ? ("accepted" as const)
        : rejectionWeight >= input.requiredWeight
          ? ("rejected" as const)
          : proposal.decision === "open"
            ? ("reconsidering" as const)
            : ("unresolved" as const);
    const terminal = decision !== "reconsidering";
    return {
      proposalId: proposal.proposalId,
      approvalWeight,
      rejectionWeight,
      evaluatedParticipantIds,
      decision,
      decisionBasis:
        decision === "accepted" || decision === "rejected"
          ? ("panel-threshold" as const)
          : decision === "unresolved"
            ? ("panel-deadlock" as const)
            : ("pending" as const),
      evaluationRounds,
      resolvedThisTurn: terminal,
      pending: !terminal,
    };
  });
}

export const applyMagiProposalOutcomes = (
  proposals: ReadonlyArray<KnownMagiProposal>,
  outcomes: ReadonlyArray<MagiProposalOutcome>,
  magiTurn: number,
): ReadonlyArray<KnownMagiProposal> => {
  const byId = new Map(outcomes.map((outcome) => [outcome.proposalId, outcome]));
  return proposals.map((proposal) => {
    const outcome = byId.get(proposal.proposalId);
    if (!outcome || !isActiveMagiProposal(proposal)) return proposal;
    return {
      ...proposal,
      decision: outcome.decision,
      decisionBasis: outcome.decisionBasis,
      evaluationRounds: outcome.evaluationRounds,
      decisionMagiTurn: outcome.resolvedThisTurn ? magiTurn : null,
      approvalWeight: outcome.approvalWeight,
      rejectionWeight: outcome.rejectionWeight,
      integration: outcome.decision === "accepted" ? "awaiting-arbitration" : "not-applicable",
    };
  });
};

export interface MagiDecisionSetOutcome {
  readonly decisionSetId: MagiDecisionSetId;
  readonly winningProposalId: MagiProposalId | null;
  readonly decision: KnownMagiDecisionSet["decision"];
  readonly evaluationRounds: number;
  readonly resolvedThisTurn: boolean;
  readonly pending: boolean;
}

export function calculateMagiDecisionSetOutcomes(input: {
  readonly magiTurn: number;
  readonly decisionSets: ReadonlyArray<KnownMagiDecisionSet>;
  readonly participants: ReadonlyArray<MagiParticipantDraft>;
  readonly settlements: ReadonlyArray<MagiParticipantSettlement>;
  readonly requiredWeight: number;
}): ReadonlyArray<MagiDecisionSetOutcome> {
  const weights = new Map(
    input.participants.map((participant) => [participant.participantId, participant.weight]),
  );
  return input.decisionSets.map((decisionSet) => {
    if (decisionSet.decision === "resolved" || decisionSet.decision === "unresolved") {
      return {
        decisionSetId: decisionSet.decisionSetId,
        winningProposalId: decisionSet.winningProposalId,
        decision: decisionSet.decision,
        evaluationRounds: decisionSet.evaluationRounds,
        resolvedThisTurn: false,
        pending: false,
      };
    }
    const evaluations = input.settlements.flatMap((settlement) =>
      (settlement.state === "settled" ? (settlement.parsed?.exclusiveSetEvaluations ?? []) : [])
        .filter((evaluation) => evaluation.decisionSetId === decisionSet.decisionSetId)
        .slice(0, 1)
        .map((evaluation) => ({ participantId: settlement.participantId, evaluation })),
    );
    const settledParticipantIds = [
      ...new Set(
        input.settlements
          .filter((settlement) => settlement.state === "settled" && settlement.parsed !== null)
          .map((settlement) => settlement.participantId),
      ),
    ];
    const support = new Map<MagiProposalId, number>();
    for (const { participantId, evaluation } of evaluations) {
      if (
        evaluation.selectedProposalId !== null &&
        decisionSet.proposalIds.includes(evaluation.selectedProposalId)
      ) {
        support.set(
          evaluation.selectedProposalId,
          (support.get(evaluation.selectedProposalId) ?? 0) + (weights.get(participantId) ?? 0),
        );
      }
    }
    const winners = [...support.entries()].filter(([, weight]) => weight >= input.requiredWeight);
    const introducedNow = decisionSet.firstMagiTurn >= input.magiTurn;
    const settledWeight = settledParticipantIds.reduce(
      (total, participantId) => total + (weights.get(participantId) ?? 0),
      0,
    );
    if (introducedNow || settledWeight < input.requiredWeight) {
      return {
        decisionSetId: decisionSet.decisionSetId,
        winningProposalId: null,
        decision: decisionSet.decision,
        evaluationRounds: decisionSet.evaluationRounds,
        resolvedThisTurn: false,
        pending: true,
      };
    }
    const winningProposalId = winners.length === 1 ? winners[0]![0] : null;
    const evaluationRounds = decisionSet.evaluationRounds + 1;
    const decision =
      winningProposalId !== null
        ? ("resolved" as const)
        : decisionSet.decision === "open"
          ? ("reconsidering" as const)
          : ("unresolved" as const);
    const terminal = decision === "resolved" || decision === "unresolved";
    return {
      decisionSetId: decisionSet.decisionSetId,
      winningProposalId,
      decision,
      evaluationRounds,
      resolvedThisTurn: terminal,
      pending: !terminal,
    };
  });
}

export const applyMagiDecisionSetOutcomes = (
  decisionSets: ReadonlyArray<KnownMagiDecisionSet>,
  outcomes: ReadonlyArray<MagiDecisionSetOutcome>,
  magiTurn: number,
): ReadonlyArray<KnownMagiDecisionSet> => {
  const byId = new Map(outcomes.map((outcome) => [outcome.decisionSetId, outcome]));
  return decisionSets.map((decisionSet) => {
    const outcome = byId.get(decisionSet.decisionSetId);
    if (!outcome || decisionSet.decision === "resolved" || decisionSet.decision === "unresolved") {
      return decisionSet;
    }
    return {
      ...decisionSet,
      decision: outcome.decision,
      evaluationRounds: outcome.evaluationRounds,
      winningProposalId: outcome.winningProposalId,
      decisionMagiTurn: outcome.resolvedThisTurn ? magiTurn : null,
    };
  });
};

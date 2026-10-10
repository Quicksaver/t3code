import type {
  MagiActionReconciliation,
  MagiKnownDecisionSet,
  MagiParticipantEvidence,
  MagiParticipantSettlement,
  MagiProposal,
  MagiRunDetail,
  MagiRunTurnDetail,
} from "@t3tools/contracts";

export const projectMagiParticipantEvidence = (
  settlement: MagiParticipantSettlement,
  representation: "best-available" | "raw" = "best-available",
): MagiParticipantEvidence => {
  const { rawText, parsed, ...metadata } = settlement;
  return {
    ...metadata,
    response:
      representation === "best-available" && parsed !== null
        ? { format: "structured", value: parsed }
        : { format: "raw", value: rawText },
    rawTextAvailable: rawText.length > 0,
  };
};

export const projectMagiParticipantEvidenceList = (
  settlements: ReadonlyArray<MagiParticipantSettlement>,
): ReadonlyArray<MagiParticipantEvidence> =>
  settlements.map((settlement) => projectMagiParticipantEvidence(settlement));

export const projectMagiRunDetail = (input: {
  readonly detail: MagiRunDetail;
  readonly turns: ReadonlyArray<MagiRunTurnDetail>;
  readonly proposals: ReadonlyArray<MagiProposal>;
  readonly decisionSets: ReadonlyArray<MagiKnownDecisionSet>;
  readonly reconciliations: ReadonlyArray<MagiActionReconciliation>;
  readonly initialPrompt: string;
  readonly includeDiagnostics: boolean;
}): MagiRunDetail => {
  const latestTurn = input.turns.at(-1) ?? null;
  const latestArbitratedTurn = input.turns.findLast((turn) => turn.arbitration !== null) ?? null;
  const {
    magiTurns: _magiTurns,
    proposals: _proposals,
    exclusiveDecisionSets: _exclusiveDecisionSets,
    actionReconciliations: _actionReconciliations,
    initialPrompt: _initialPrompt,
    ...detail
  } = input.detail;
  // Unknown usage stays unknown: the count is omitted when no settlement reported tokens.
  const tokenCount = detail.settlements.some(
    (settlement) => settlement.inputTokens !== null || settlement.outputTokens !== null,
  )
    ? detail.settlements.reduce(
        (total, settlement) =>
          total + (settlement.inputTokens ?? 0) + (settlement.outputTokens ?? 0),
        0,
      )
    : undefined;
  const { tokenCount: _storedTokenCount, ...storedSummary } = detail.summary;
  // The same leading-outcome fields run listings carry, so either summary renders alike.
  const listedSummary = {
    ...storedSummary,
    leadingAgreementWeight: detail.activity.leadingAgreementWeight,
    leadingAgreementLabel: detail.activity.leadingAgreementLabel,
    requiredWeight: detail.activity.requiredWeight,
  };
  const summary = tokenCount === undefined ? listedSummary : { ...listedSummary, tokenCount };
  const compactTurns = input.turns.map((turn) => ({
    ...turn,
    settlements: turn.settlements.map((settlement) => ({ ...settlement, rawText: "" })),
  }));
  const finalParticipantVotes = detail.config.participants.map((participant) => ({
    participantId: participant.participantId,
    stance:
      latestArbitratedTurn?.arbitration?.assessments.find(
        (assessment) => assessment.participantId === participant.participantId,
      )?.stance ?? null,
    ballot:
      latestTurn?.settlements.find(
        (settlement) => settlement.participantId === participant.participantId,
      )?.parsed?.ballot ?? null,
  }));

  if (!input.includeDiagnostics) {
    return {
      ...detail,
      summary,
      settlements: [],
      finalParticipantVotes,
      magiTurns: compactTurns,
      proposals: input.proposals,
      exclusiveDecisionSets: input.decisionSets,
      actionReconciliations: input.reconciliations,
    };
  }

  return {
    ...detail,
    summary,
    finalParticipantVotes,
    initialPrompt: input.initialPrompt,
    magiTurns: input.turns,
    proposals: input.proposals,
    exclusiveDecisionSets: input.decisionSets,
    actionReconciliations: input.reconciliations,
  };
};

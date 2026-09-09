import { describe, expect, it } from "@effect/vitest";
import {
  MagiParticipantId,
  MagiCandidateFingerprint,
  MagiDecisionSetId,
  MagiRunId,
  MagiProposalId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  magiProposalIdentity,
  type MagiParticipantDraft,
  type MagiParticipantSettlement,
  type MagiProposalInput,
} from "@t3tools/contracts";

import {
  applyMagiDecisionSetOutcomes,
  applyMagiProposalOutcomes,
  calculateMagiDecisionSetOutcomes,
  calculateMagiProposalOutcomes,
  collectMagiProposals,
  hasPendingMagiProtocolWork,
  normalizeMagiArbitrationAssessments,
  structuredMagiCandidateSupportWeight,
} from "./MagiConsensusCalculator.ts";
import { magiTerminalProposalReference } from "./MagiTerminalProposalDigest.ts";

const proposal: MagiProposalInput = {
  kind: "optional",
  change: "Add a rollback check.",
  rationale: "It makes recovery observable.",
  expectedVoteEffect: "No candidate vote change.",
  atomicSetKey: null,
};
const participants: ReadonlyArray<MagiParticipantDraft> = [2, 1, 1].map((weight, index) => ({
  participantId: MagiParticipantId.make(`p${index + 1}`),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  personalityId: null,
  weight,
}));
const settlement = (
  participant: MagiParticipantDraft,
  evaluations: MagiParticipantSettlement["parsed"] extends infer _
    ? ReadonlyArray<{
        readonly proposalId: ReturnType<typeof magiProposalIdentity>;
        readonly ballot: "approve" | "reject" | "abstain";
        readonly rationale: string;
      }>
    : never,
): MagiParticipantSettlement => ({
  participantId: participant.participantId,
  participantThreadId: ThreadId.make(`thread-${participant.participantId}`),
  participantTurnId: TurnId.make(`turn-${participant.participantId}`),
  rawText: "{}",
  parsed: {
    recommendation: "Proceed.",
    rationale: ["Reasoned."],
    assumptions: [],
    risks: [],
    confidence: 80,
    candidateFingerprint: null,
    ballot: "approve",
    proposals: [],
    proposalEvaluations: evaluations,
    exclusiveSetEvaluations: [],
  },
  parseMode: "structured",
  state: "settled",
  durationMs: 1,
  inputTokens: null,
  outputTokens: null,
  retryCount: 0,
  failureClass: null,
  providerAttempts: 1,
  structuralRepairCount: 0,
  reconstructed: false,
  contextCompressed: false,
});

describe("Magi proposal accounting", () => {
  it("does not count proposal creation as an originator vote", () => {
    const runId = MagiRunId.make("run");
    const created = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 1,
        proposals: created,
        participants,
        settlements: participants.map((participant) => settlement(participant, [])),
        requiredWeight: 3,
      })[0],
    ).toMatchObject({ approvalWeight: 0, rejectionWeight: 0, decision: "open", pending: true });
  });

  it("resolves a compact terminal reference before recording a material revision", () => {
    const runId = MagiRunId.make("run-compact-supersession");
    const [created] = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    const rejected = {
      ...created!,
      decision: "rejected" as const,
      decisionBasis: "panel-threshold" as const,
      decisionMagiTurn: 2,
    };
    const reference = magiTerminalProposalReference(rejected.proposalId, [rejected.proposalId]);
    const revision = {
      ...proposal,
      change: "Add a rollback check backed by the newly observed failure.",
      supersedesProposalId: MagiProposalId.make(reference),
    };
    const collected = collectMagiProposals(
      runId,
      3,
      [
        {
          ...settlement(participants[1]!, []),
          parsed: { ...settlement(participants[1]!, []).parsed!, proposals: [revision] },
        },
      ],
      [rejected],
    );

    expect(collected.find((item) => item.proposalId === rejected.proposalId)?.decision).toBe(
      "superseded",
    );
    expect(
      collected.find((item) => item.proposalId !== rejected.proposalId)?.proposal,
    ).toMatchObject({ supersedesProposalId: rejected.proposalId });
  });

  it("uses threshold weight without turning a missing ballot into a rejection", () => {
    const runId = MagiRunId.make("run");
    const proposalId = magiProposalIdentity(runId, proposal);
    const proposals = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    const evaluations = participants.map((participant, index) =>
      settlement(
        participant,
        index < 2 ? [{ proposalId, ballot: "approve", rationale: "Yes." }] : [],
      ),
    );
    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 2,
        proposals,
        participants,
        settlements: evaluations,
        requiredWeight: 3,
      })[0],
    ).toMatchObject({
      approvalWeight: 3,
      rejectionWeight: 0,
      decision: "accepted",
      pending: false,
    });
    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 2,
        proposals,
        participants,
        settlements: participants.map((participant) =>
          settlement(participant, [{ proposalId, ballot: "approve", rationale: "Yes." }]),
        ),
        requiredWeight: 3,
      })[0],
    ).toMatchObject({
      approvalWeight: 4,
      rejectionWeight: 0,
      decision: "accepted",
      pending: false,
    });
  });

  it("does not leave a proposal pending for a participant whose turn failed", () => {
    const runId = MagiRunId.make("run-failed-participant");
    const proposalId = magiProposalIdentity(runId, proposal);
    const proposals = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    const settlements = [
      settlement(participants[0]!, [{ proposalId, ballot: "approve", rationale: "Yes." }]),
      settlement(participants[1]!, [{ proposalId, ballot: "approve", rationale: "Yes." }]),
      {
        ...settlement(participants[2]!, []),
        rawText: "",
        parsed: null,
        state: "failed" as const,
      },
    ];

    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 2,
        proposals,
        participants,
        settlements,
        requiredWeight: 3,
      })[0],
    ).toMatchObject({
      approvalWeight: 3,
      rejectionWeight: 0,
      decision: "accepted",
      pending: false,
    });
  });

  it("does not count parsed proposal approvals from failed settlements", () => {
    const runId = MagiRunId.make("run-failed-parsed-participant");
    const proposalId = magiProposalIdentity(runId, proposal);
    const proposals = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    const failed = {
      ...settlement(participants[0]!, [
        { proposalId, ballot: "approve" as const, rationale: "Stale approval." },
      ]),
      state: "failed" as const,
    };

    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 2,
        proposals,
        participants,
        settlements: [
          failed,
          settlement(participants[1]!, [
            { proposalId, ballot: "approve", rationale: "Live approval." },
          ]),
          settlement(participants[2]!, [{ proposalId, ballot: "reject", rationale: "No." }]),
        ],
        requiredWeight: 3,
      })[0],
    ).toMatchObject({ approvalWeight: 1, rejectionWeight: 1, decision: "open", pending: true });
  });

  it("closes an explicit rejection threshold without another confirmation turn", () => {
    const runId = MagiRunId.make("run-negative-consensus");
    const proposalId = magiProposalIdentity(runId, proposal);
    const [registeredProposal] = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );

    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 2,
        proposals: [registeredProposal!],
        participants,
        settlements: participants.map((participant) =>
          settlement(participant, [{ proposalId, ballot: "reject", rationale: "Invalid." }]),
        ),
        requiredWeight: 3,
      })[0],
    ).toMatchObject({
      approvalWeight: 0,
      rejectionWeight: 4,
      decision: "rejected",
      decisionBasis: "panel-threshold",
      pending: false,
    });
  });

  it("allows one focused reconsideration and then closes a persistent split", () => {
    const runId = MagiRunId.make("run-finite-reconsideration");
    const proposalId = magiProposalIdentity(runId, proposal);
    const [created] = collectMagiProposals(
      runId,
      1,
      [
        {
          ...settlement(participants[0]!, []),
          parsed: { ...settlement(participants[0]!, []).parsed!, proposals: [proposal] },
        },
      ],
      [],
    );
    const split = [
      settlement(participants[0]!, [{ proposalId, ballot: "abstain", rationale: "Unsure." }]),
      settlement(participants[1]!, [{ proposalId, ballot: "approve", rationale: "Yes." }]),
      settlement(participants[2]!, [{ proposalId, ballot: "reject", rationale: "No." }]),
    ];
    const firstOutcome = calculateMagiProposalOutcomes({
      magiTurn: 2,
      proposals: [created!],
      participants,
      settlements: split,
      requiredWeight: 3,
    });
    const reconsidering = applyMagiProposalOutcomes([created!], firstOutcome, 2);
    expect(firstOutcome[0]).toMatchObject({ decision: "reconsidering", pending: true });

    expect(
      calculateMagiProposalOutcomes({
        magiTurn: 3,
        proposals: reconsidering,
        participants,
        settlements: split,
        requiredWeight: 3,
      })[0],
    ).toMatchObject({
      decision: "unresolved",
      decisionBasis: "panel-deadlock",
      pending: false,
    });
  });

  it("does not count parsed exclusive-set choices from failed settlements", () => {
    const decisionSetId = MagiDecisionSetId.make("decision-set");
    const firstProposalId = MagiProposalId.make("proposal-one");
    const secondProposalId = MagiProposalId.make("proposal-two");
    const choose = (selectedProposalId: MagiProposalId) => ({
      decisionSetId,
      selectedProposalId,
      rationale: "Choose it.",
    });
    const withChoice = (participant: MagiParticipantDraft, selectedProposalId: MagiProposalId) => ({
      ...settlement(participant, []),
      parsed: {
        ...settlement(participant, []).parsed!,
        exclusiveSetEvaluations: [choose(selectedProposalId)],
      },
    });

    expect(
      calculateMagiDecisionSetOutcomes({
        magiTurn: 2,
        decisionSets: [
          {
            decisionSetId,
            proposalIds: [firstProposalId, secondProposalId],
            rationale: "Choose one.",
            firstMagiTurn: 1,
            decision: "open",
            evaluationRounds: 0,
            winningProposalId: null,
            decisionMagiTurn: null,
          },
        ],
        participants,
        settlements: [
          { ...withChoice(participants[0]!, firstProposalId), state: "failed" as const },
          withChoice(participants[1]!, secondProposalId),
          withChoice(participants[2]!, secondProposalId),
        ],
        requiredWeight: 3,
      })[0],
    ).toMatchObject({ winningProposalId: null, decision: "open", pending: true });
  });

  it("closes an exclusive set after one inconclusive reconsideration", () => {
    const decisionSetId = MagiDecisionSetId.make("decision-set-finite");
    const firstProposalId = MagiProposalId.make("proposal-one");
    const secondProposalId = MagiProposalId.make("proposal-two");
    const decisionSet = {
      decisionSetId,
      proposalIds: [firstProposalId, secondProposalId],
      rationale: "Choose one.",
      firstMagiTurn: 1,
      decision: "open" as const,
      evaluationRounds: 0,
      winningProposalId: null,
      decisionMagiTurn: null,
    };
    const split = participants.map((participant, index) => ({
      ...settlement(participant, []),
      parsed: {
        ...settlement(participant, []).parsed!,
        exclusiveSetEvaluations: [
          {
            decisionSetId,
            selectedProposalId: index === 0 ? firstProposalId : secondProposalId,
            rationale: "Choice.",
          },
        ],
      },
    }));
    const firstOutcome = calculateMagiDecisionSetOutcomes({
      magiTurn: 2,
      decisionSets: [decisionSet],
      participants,
      settlements: split,
      requiredWeight: 3,
    });
    const reconsidering = applyMagiDecisionSetOutcomes([decisionSet], firstOutcome, 2);
    expect(firstOutcome[0]).toMatchObject({ decision: "reconsidering", pending: true });

    expect(
      calculateMagiDecisionSetOutcomes({
        magiTurn: 3,
        decisionSets: reconsidering,
        participants,
        settlements: split,
        requiredWeight: 3,
      })[0],
    ).toMatchObject({ decision: "unresolved", pending: false });
  });
});

describe("Magi arbitration evidence", () => {
  it("counts only settled approvals for the offered candidate fingerprint", () => {
    const fingerprint = MagiCandidateFingerprint.make("candidate-test");
    const settlements = participants.map((participant, index) => ({
      ...settlement(participant, []),
      parsed: {
        ...settlement(participant, []).parsed!,
        ballot: index === 2 ? ("reject" as const) : ("approve" as const),
        candidateFingerprint: fingerprint,
      },
    }));

    expect(
      structuredMagiCandidateSupportWeight({
        participants,
        settlements,
        candidateFingerprint: fingerprint,
      }),
    ).toBe(3);
  });

  it("keeps explicit semantic support when advisory fingerprints are absent", () => {
    const settlements = participants.map((participant) => settlement(participant, []));
    const assessments = normalizeMagiArbitrationAssessments({
      participants,
      settlements,
      recordedAssessments: participants.map((participant) => ({
        participantId: participant.participantId,
        stance: "supports" as const,
        evidence: "Explicitly approved candidate 17.",
        clarificationNeeded: false,
        clarificationQuestion: null,
      })),
      candidateChanged: false,
    });

    expect(assessments.map((assessment) => assessment.stance)).toEqual([
      "supports",
      "supports",
      "supports",
    ]);
  });

  it("allows the arbitrator to classify useful raw prose after schema failure", () => {
    const raw = {
      ...settlement(participants[0]!, []),
      rawText: "I approve candidate 42.",
      parsed: null,
      parseMode: "raw" as const,
    };
    const [assessment] = normalizeMagiArbitrationAssessments({
      participants: [participants[0]!],
      settlements: [raw],
      recordedAssessments: [
        {
          participantId: participants[0]!.participantId,
          stance: "supports",
          evidence: "The raw response explicitly approves 42.",
          clarificationNeeded: false,
          clarificationQuestion: null,
        },
      ],
      candidateChanged: false,
    });

    expect(assessment?.stance).toBe("supports");
  });

  it("normalizes a missing assessment to unclear instead of throwing", () => {
    const assessments = normalizeMagiArbitrationAssessments({
      participants: [participants[0]!],
      settlements: [settlement(participants[0]!, [])],
      recordedAssessments: [],
      candidateChanged: false,
    });

    expect(assessments).toEqual([
      {
        participantId: participants[0]!.participantId,
        stance: "unclear",
        evidence: "No arbitration assessment was recorded.",
        clarificationNeeded: false,
        clarificationQuestion: null,
      },
    ]);
  });
});

describe("Magi protocol work", () => {
  it("does not treat accepted, fully evaluated proposals as pending by themselves", () => {
    expect(
      hasPendingMagiProtocolWork({
        pendingProposalCount: 0,
        hasPendingDecisionSet: false,
        hasClarificationRequest: false,
        requiresCandidateConfirmation: false,
        requestedOutcome: "consensus",
      }),
    ).toBe(false);
  });

  it("keeps explicit continuation and unresolved evaluations pending", () => {
    expect(
      hasPendingMagiProtocolWork({
        pendingProposalCount: 1,
        hasPendingDecisionSet: false,
        hasClarificationRequest: false,
        requiresCandidateConfirmation: false,
        requestedOutcome: "consensus",
      }),
    ).toBe(true);
    expect(
      hasPendingMagiProtocolWork({
        pendingProposalCount: 0,
        hasPendingDecisionSet: false,
        hasClarificationRequest: false,
        requiresCandidateConfirmation: false,
        requestedOutcome: "continue",
      }),
    ).toBe(true);
  });

  it("requires one candidate-confirmation turn for newly accepted proposals", () => {
    expect(
      hasPendingMagiProtocolWork({
        pendingProposalCount: 0,
        hasPendingDecisionSet: false,
        hasClarificationRequest: false,
        requiresCandidateConfirmation: true,
        requestedOutcome: "consensus",
      }),
    ).toBe(true);
  });
});

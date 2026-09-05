import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ContextReadInput,
  DEFAULT_MAGI_ARBITRATOR_PROMPT,
  MagiActionRecordId,
  MagiArbitrationRecord,
  MagiCandidate as MagiCandidateSchema,
  MagiDeliberateInput,
  MagiGetTerminalProposalsInput,
  MagiGetOptionsResult,
  MagiGetRunDetailInput,
  MagiMemberState,
  MagiParticipantId,
  MagiParticipantResponse,
  MagiRecordArbitrationInput,
  MagiRunConfig,
  MagiRunId,
  MagiSettings,
  MagiProposalId,
  calculateMagiActivityMetrics,
  calculateMagiDirectTransition,
  calculateMagiPostActionTransition,
  calculateMagiThreshold,
  currentMagiTurnVoteTotals,
  deriveMagiActionObligation,
  deterministicMagiActionRecordId,
  exactDuplicateMagiParticipantGroups,
  failedMagiRunTitle,
  hasExplicitOriginatorEvaluation,
  hasMagiTurnRemaining,
  isMagiThresholdReachable,
  isMaterialMagiCandidateChange,
  magiActionLogDigest,
  magiActionReconciliationState,
  magiActionsRequiringReassessment,
  magiCandidateFingerprint,
  magiContextualClarifications,
  magiContextArtifactId,
  magiExclusiveDecisionSetFingerprint,
  magiParticipantVoteWeights,
  magiProposalIdentity,
  minimumValidMagiThresholdPercent,
  normalizeMagiProposal,
  normalizeMagiTurnLimit,
  pendingMagiEvaluationParticipantIds,
  pendingMagiRunTitle,
  requiredMagiWeight,
  totalMagiWeight,
  validateMagiRoster,
  type MagiCandidate,
  type MagiParticipantDraft,
  type MagiParticipantAssessment,
  type MagiRecordedAction,
  type MagiProposalEvaluation,
  type MagiProposalInput,
} from "./magi.ts";
import { ContextArtifactId, EventId } from "./baseSchemas.ts";

const decodeRunConfig = Schema.decodeUnknownSync(MagiRunConfig);
const encodeRunConfig = Schema.encodeSync(MagiRunConfig);
const decodeMagiArbitrationRecord = Schema.decodeUnknownSync(MagiArbitrationRecord);
const decodeMagiRecordArbitrationInput = Schema.decodeUnknownSync(MagiRecordArbitrationInput);
const decodeMagiGetTerminalProposalsInput = Schema.decodeUnknownSync(MagiGetTerminalProposalsInput);
const decodeMagiGetOptionsResult = Schema.decodeUnknownSync(MagiGetOptionsResult);
const decodeMagiGetRunDetailInput = Schema.decodeUnknownSync(MagiGetRunDetailInput);
const decodeMagiSettings = Schema.decodeUnknownSync(MagiSettings);
const decodeContextReadInput = Schema.decodeUnknownSync(ContextReadInput);
const decodeMagiMemberState = Schema.decodeUnknownSync(MagiMemberState);

const participant = (
  id: string,
  weight: number,
  model = "gpt-5",
  personalityId: string | null = null,
): MagiParticipantDraft => ({
  participantId: MagiParticipantId.make(id),
  modelSelection: {
    instanceId: "codex" as MagiParticipantDraft["modelSelection"]["instanceId"],
    model,
  },
  personalityId: personalityId as MagiParticipantDraft["personalityId"],
  weight,
});

const candidate = (conclusion: string): MagiCandidate => ({
  conclusion,
  rationale: ["Evidence"],
  recommendedActions: [],
  caveats: [],
});

const action = (
  id: string,
  status: MagiRecordedAction["status"],
  obligation: MagiRecordedAction["obligation"] = "required",
  unforeseenConsequence: string | null = null,
): MagiRecordedAction => ({
  actionId: MagiActionRecordId.make(id),
  summary: "Apply the accepted change",
  status,
  relatedProposalIds: [],
  obligation,
  details: "Recorded result",
  unforeseenConsequence,
});

describe("Magi schemas", () => {
  it("keeps panel configuration out of the option catalogue", () => {
    expect(
      decodeMagiGetOptionsResult({
        providerInstances: [],
        personalities: [],
        bounds: {
          minimumParticipants: 2,
          maximumParticipants: 9,
          minimumWeight: 1,
          maximumWeight: 100,
          maximumContextActivityIds: 32,
        },
        defaults: {
          participants: [],
          consensusThresholdPercent: 67,
          magiTurnLimit: 3,
        },
      }),
    ).toEqual({
      providerInstances: [],
      personalities: [],
      bounds: {
        minimumParticipants: 2,
        maximumParticipants: 9,
        minimumWeight: 1,
        maximumWeight: 100,
        maximumContextActivityIds: 32,
      },
    });
  });

  it("defaults diagnostic detail delivery to disabled", () => {
    expect(decodeMagiGetRunDetailInput({ runId: "run-1" }).includeDiagnostics).toBe(false);
    expect(
      decodeMagiSettings({
        arbitratorPrompt: "Arbitrate.",
        lastPanelRoster: [],
        lastPanelConsensusThresholdPercent: 100,
        lastPanelMagiTurnLimit: 1,
        personalities: [],
      }).showRunDetailsAndDiagnostics,
    ).toBe(false);
  });

  it("derives provider-neutral context artifact ids deterministically", () => {
    const runId = MagiRunId.make("run-artifact");
    const activityId = EventId.make("activity-1");
    expect(magiContextArtifactId(runId, 1, activityId)).toBe(
      magiContextArtifactId(runId, 1, activityId),
    );
    expect(magiContextArtifactId(runId, 1, activityId)).not.toBe(
      magiContextArtifactId(runId, 2, activityId),
    );
  });

  it("accepts one or more context artifact ids in one read", () => {
    expect(
      decodeContextReadInput({ artifactIds: ["artifact-one", "artifact-two"] }).artifactIds,
    ).toEqual([ContextArtifactId.make("artifact-one"), ContextArtifactId.make("artifact-two")]);
    expect(() => decodeContextReadInput({ artifactIds: [] })).toThrow();
  });

  it("does not represent participant exclusion as a member state", () => {
    expect(() => decodeMagiMemberState("excluded")).toThrow();
  });

  it("keeps internal run bookkeeping out of the user-facing report", () => {
    expect(DEFAULT_MAGI_ARBITRATOR_PROMPT).toContain(
      "Participant ids are internal bookkeeping and never belong in user-facing text",
    );
    expect(DEFAULT_MAGI_ARBITRATOR_PROMPT).toContain(
      "Starting the run, dispatching participants, collecting responses, calling tools, and arbitrating are workflow steps",
    );
  });

  it("decodes the shared task-neutral run config", () => {
    const decoded = decodeRunConfig({
      participants: [participant("one", 2), participant("two", 1)],
      consensusThresholdPercent: 67,
      magiTurnLimit: 1,
    });

    expect(decoded.participants).toHaveLength(2);
    expect(decoded.consensusThresholdPercent).toBe(67);
  });

  it("rejects non-model and task-specific participant fields at the schema boundary", () => {
    const encoded = encodeRunConfig(
      decodeRunConfig({
        participants: [participant("one", 1), participant("two", 1)],
        consensusThresholdPercent: 100,
        magiTurnLimit: 1,
      }),
    );

    expect(JSON.stringify(encoded)).not.toMatch(
      /taskMode|participantType|evidenceProcessor|resultType/,
    );
    expect(() =>
      decodeRunConfig({
        participants: [
          { participantId: "one", participantType: "human", weight: 1 },
          participant("two", 1),
        ],
        consensusThresholdPercent: 100,
        magiTurnLimit: 1,
      }),
    ).toThrow();
  });

  it("does not limit rationale, proposal, or evaluation array lengths", () => {
    const items = Array.from({ length: 65 }, (_, index) => `Item ${index}`);
    const candidateInput = {
      conclusion: "Keep every item",
      rationale: items,
      recommendedActions: items,
      caveats: items,
    };
    const participantResponse = Schema.decodeUnknownSync(MagiParticipantResponse)({
      recommendation: "Keep every item",
      rationale: items,
      assumptions: items,
      risks: items,
      confidence: 100,
      candidateFingerprint: null,
      ballot: "not-applicable",
      proposals: items.map((item) => ({
        kind: "optional",
        change: item,
        rationale: item,
        expectedVoteEffect: item,
        atomicSetKey: null,
      })),
      proposalEvaluations: items.map((item, index) => ({
        proposalId: `proposal-${index}`,
        ballot: "approve",
        rationale: item,
      })),
      exclusiveSetEvaluations: items.map((item, index) => ({
        decisionSetId: `decision-set-${index}`,
        selectedProposalId: null,
        rationale: item,
      })),
    });
    const candidateResult = Schema.decodeUnknownSync(MagiCandidateSchema)(candidateInput);
    const arbitration = Schema.decodeUnknownSync(MagiArbitrationRecord)({
      candidate: candidateInput,
      assessments: [],
      disagreements: items,
      proposalDispositions: [],
      exclusiveDecisionSets: [],
      nextTurnBrief: null,
      authorizedExecutionActions: [],
      requestedOutcome: "continue",
      terminalProposalDigest: items.map((item, index) => ({
        proposalId: `proposal-${index}`,
        summary: index === 0 ? `${item}${" detail".repeat(3_000)}` : item,
      })),
    });
    const deliberation = Schema.decodeUnknownSync(MagiDeliberateInput)({
      runId: "run-1",
      candidate: candidateInput,
      contextActivityIds: [],
    });

    expect(participantResponse.rationale).toHaveLength(65);
    expect(participantResponse.assumptions).toHaveLength(65);
    expect(participantResponse.risks).toHaveLength(65);
    expect(participantResponse.proposals).toHaveLength(65);
    expect(participantResponse.proposalEvaluations).toHaveLength(65);
    expect(participantResponse.exclusiveSetEvaluations).toHaveLength(65);
    expect(candidateResult.rationale).toHaveLength(65);
    expect(candidateResult.recommendedActions).toHaveLength(65);
    expect(candidateResult.caveats).toHaveLength(65);
    expect(arbitration.disagreements).toHaveLength(65);
    expect(arbitration.terminalProposalDigest).toHaveLength(65);
    expect(arbitration.terminalProposalDigest?.[0]?.summary.length).toBeGreaterThan(16_000);
    expect(deliberation.contextActivityIds).toEqual([]);
  });

  it("decodes historical arbitration without a digest but requires digest updates for new input", () => {
    const historicalRecord = {
      candidate: { conclusion: "Candidate", rationale: [], recommendedActions: [], caveats: [] },
      assessments: [],
      disagreements: [],
      proposalDispositions: [],
      exclusiveDecisionSets: [],
      nextTurnBrief: null,
      authorizedExecutionActions: [],
      requestedOutcome: "continue",
    };

    expect(decodeMagiArbitrationRecord(historicalRecord)).toMatchObject(historicalRecord);
    expect(() =>
      decodeMagiRecordArbitrationInput({
        runId: "run-1",
        magiTurn: 1,
        record: historicalRecord,
      }),
    ).toThrow();
    expect(
      decodeMagiRecordArbitrationInput({
        runId: "run-1",
        magiTurn: 1,
        record: { ...historicalRecord, terminalProposalDigestUpdates: [] },
      }).record.terminalProposalDigestUpdates,
    ).toEqual([]);
  });

  it("bounds terminal proposal recovery pages", () => {
    expect(
      decodeMagiGetTerminalProposalsInput({
        runId: "run-1",
        scope: "missing-digest",
        offset: 0,
        limit: 20,
        includePersistedDigest: false,
      }).limit,
    ).toBe(20);
    expect(() =>
      decodeMagiGetTerminalProposalsInput({
        runId: "run-1",
        scope: "all-terminal",
        offset: 0,
        limit: 21,
        includePersistedDigest: true,
      }),
    ).toThrow();
  });
});

describe("weighted threshold rules", () => {
  it("distinguishes [2, 1, 1] at 50 and 51 percent", () => {
    const roster = [participant("one", 2), participant("two", 1), participant("three", 1)];
    expect(calculateMagiThreshold(roster, 50)).toEqual({
      totalWeight: 4,
      requiredWeight: 2,
      thresholdPercent: 50,
      valid: false,
    });
    expect(calculateMagiThreshold(roster, 51)).toEqual({
      totalWeight: 4,
      requiredWeight: 3,
      thresholdPercent: 51,
      valid: true,
    });
  });

  it("finds the minimum draw-proof percentage for every total through the v1 maximum", () => {
    for (let total = 2; total <= 900; total += 1) {
      const percentage = minimumValidMagiThresholdPercent(total);
      expect(requiredMagiWeight(total, percentage)).toBeGreaterThan(total / 2);
      if (percentage > 1) {
        expect(requiredMagiWeight(total, percentage - 1)).toBeLessThanOrEqual(total / 2);
      }
    }
  });

  it("keeps exact total and required weight for all integer percentages", () => {
    const roster = [participant("one", 100), participant("two", 99), participant("three", 1)];
    expect(totalMagiWeight(roster)).toBe(200);
    for (let percentage = 1; percentage <= 100; percentage += 1) {
      expect(requiredMagiWeight(200, percentage)).toBe(Math.ceil((200 * percentage) / 100));
    }
  });

  it("computes reachability without lowering the denominator", () => {
    expect(isMagiThresholdReachable(6, 3, 3)).toBe(true);
    expect(isMagiThresholdReachable(6, 3, 2)).toBe(false);
  });

  it("totals candidate votes by participant weight", () => {
    const roster = [participant("one", 5), participant("two", 2), participant("three", 1)];
    expect(
      magiParticipantVoteWeights(roster, [
        { participantId: roster[0]!.participantId, stance: "supports" },
        { participantId: roster[1]!.participantId, stance: "opposes" },
        { participantId: roster[2]!.participantId, stance: "unclear" },
      ]),
    ).toEqual({ agreedWeight: 5, opposedWeight: 2 });
  });

  it("ignores vote records that are not in the configured roster", () => {
    const roster = [participant("known", 3)];
    expect(
      magiParticipantVoteWeights(roster, [
        { participantId: MagiParticipantId.make("unknown"), stance: "supports" },
      ]),
    ).toEqual({ agreedWeight: 0, opposedWeight: 0 });
  });
});

describe("fingerprints and proposals", () => {
  it("changes the candidate fingerprint when durable action state changes", () => {
    const runCandidate = candidate("Ship the feature");
    const before = magiCandidateFingerprint(runCandidate, []);
    const completed = magiCandidateFingerprint(runCandidate, [action("a-1", "completed")]);
    const impeded = magiCandidateFingerprint(runCandidate, [action("a-1", "not-completed")]);

    expect(before).not.toBe(completed);
    expect(completed).not.toBe(impeded);
    expect(magiActionLogDigest([action("a-1", "completed")])).toBe(
      magiActionLogDigest([action("a-1", "completed")]),
    );
  });

  it("derives stable action ids from the idempotency tuple", () => {
    const runId = MagiRunId.make("run-1");
    expect(deterministicMagiActionRecordId(runId, 2, 0, "record-call")).toBe(
      deterministicMagiActionRecordId(runId, 2, 0, "record-call"),
    );
    expect(deterministicMagiActionRecordId(runId, 2, 0, "record-call")).not.toBe(
      deterministicMagiActionRecordId(runId, 2, 1, "record-call"),
    );
  });

  it("uses exact deterministic normalization without semantic merging", () => {
    const runId = MagiRunId.make("run-1");
    const base: MagiProposalInput = {
      kind: "optional",
      change: " Add  focused   tests ",
      rationale: "Prevent regression",
      expectedVoteEffect: "Raises confidence",
      atomicSetKey: null,
    };
    const whitespaceVariant = { ...base, change: "Add focused tests" };
    const semanticVariant = { ...base, change: "Add regression coverage" };

    expect(normalizeMagiProposal(base)).toBe(normalizeMagiProposal(whitespaceVariant));
    expect(magiProposalIdentity(runId, base)).toBe(magiProposalIdentity(runId, whitespaceVariant));
    expect(magiProposalIdentity(runId, base)).not.toBe(
      magiProposalIdentity(runId, semanticVariant),
    );
  });

  it("fingerprints exclusive sets independently of member order", () => {
    const runId = MagiRunId.make("run-1");
    const one = MagiProposalId.make("one");
    const two = MagiProposalId.make("two");
    expect(magiExclusiveDecisionSetFingerprint(runId, [one, two])).toBe(
      magiExclusiveDecisionSetFingerprint(runId, [two, one]),
    );
  });

  it("recognizes material candidate changes", () => {
    expect(isMaterialMagiCandidateChange(candidate("Ship"), candidate("Ship"))).toBe(false);
    expect(isMaterialMagiCandidateChange(candidate("Ship"), candidate("Do not ship"))).toBe(true);
  });
});

describe("evaluations and action consequences", () => {
  const assessment = (
    id: string,
    stance: MagiParticipantAssessment["stance"],
    clarificationNeeded = false,
  ): MagiParticipantAssessment => ({
    participantId: MagiParticipantId.make(id),
    stance,
    evidence: "Evidence",
    clarificationNeeded,
    clarificationQuestion: clarificationNeeded ? "What did this ballot mean?" : null,
  });

  it("counts only the supplied current-turn assessments", () => {
    const totals = currentMagiTurnVoteTotals(
      [assessment("one", "supports"), assessment("two", "opposes")],
      new Map([
        ["one", 3],
        ["two", 2],
        ["old-turn-only", 50],
      ]),
    );
    expect(totals).toEqual({ supportWeight: 3, opposingWeight: 2, unclearWeight: 0 });
  });

  it("requires the proposal originator to evaluate explicitly", () => {
    const proposalId = MagiProposalId.make("proposal-1");
    const evaluation: MagiProposalEvaluation = {
      proposalId,
      ballot: "approve",
      rationale: "Still useful",
    };
    expect(hasExplicitOriginatorEvaluation(proposalId, MagiParticipantId.make("origin"), [])).toBe(
      false,
    );
    expect(
      hasExplicitOriginatorEvaluation(proposalId, MagiParticipantId.make("origin"), [
        { participantId: MagiParticipantId.make("origin"), evaluation },
      ]),
    ).toBe(true);
  });

  it("reports pending evaluations and full-panel clarifications", () => {
    expect(
      pendingMagiEvaluationParticipantIds(
        [MagiParticipantId.make("one"), MagiParticipantId.make("two")],
        new Set(["one"]),
      ),
    ).toEqual(["two"]);
    expect(
      magiContextualClarifications([
        assessment("one", "unclear", true),
        assessment("two", "supports"),
      ]).map((item) => item.participantId),
    ).toEqual(["one"]);
  });

  it("applies required-wins action obligations", () => {
    const optional = MagiProposalId.make("optional");
    const required = MagiProposalId.make("required");
    const kinds = new Map([
      [optional as string, "optional" as const],
      [required as string, "vote-changing" as const],
    ]);
    expect(deriveMagiActionObligation([], kinds)).toBe("required");
    expect(deriveMagiActionObligation([optional], kinds)).toBe("optional");
    expect(deriveMagiActionObligation([optional, required], kinds)).toBe("required");
  });

  it("forces reassessment for consequences, required failures, and unknown outcomes", () => {
    const actions = [
      action("completed", "completed"),
      action("consequence", "completed", "required", "Unexpected migration cost"),
      action("required-failure", "not-completed"),
      action("optional-skip", "not-completed", "optional"),
      action("unknown", "unknown"),
    ];
    expect(magiActionsRequiringReassessment(actions).map((item) => item.actionId)).toEqual([
      "consequence",
      "required-failure",
      "unknown",
    ]);
    expect(magiActionReconciliationState(actions)).toBe("awaiting-action-reconciliation");
    expect(magiActionReconciliationState([action("done", "completed")])).toBe("reconciled");
  });
});

describe("transitions, metrics, titles, and roster validation", () => {
  it("normalizes unlimited turn limits and enforces finite limits", () => {
    expect(normalizeMagiTurnLimit("")).toBeNull();
    expect(normalizeMagiTurnLimit(0)).toBeNull();
    expect(normalizeMagiTurnLimit(null)).toBeNull();
    expect(normalizeMagiTurnLimit(3)).toBe(3);
    expect(hasMagiTurnRemaining(500, null)).toBe(true);
    expect(hasMagiTurnRemaining(1, 1)).toBe(false);
  });

  it("keeps direct and post-action transitions authoritative", () => {
    expect(
      calculateMagiDirectTransition({
        consensusReached: true,
        pendingEvaluations: false,
        completedMagiTurns: 1,
        magiTurnLimit: 1,
      }),
    ).toBe("consensus-reached");
    expect(
      calculateMagiDirectTransition({
        consensusReached: true,
        pendingEvaluations: true,
        completedMagiTurns: 1,
        magiTurnLimit: 1,
      }),
    ).toBe("turn-limit-reached");
    expect(calculateMagiPostActionTransition(1, 1)).toBe("turn-limit-reached");
    expect(calculateMagiPostActionTransition(1, 2)).toBe("continue");
  });

  it("selects deterministic activity-box leading agreement", () => {
    const metrics = calculateMagiActivityMetrics({
      runId: MagiRunId.make("run-1"),
      source: "agent-tool",
      state: "awaiting-arbitration",
      completedMagiTurns: 2,
      magiTurnLimit: 4,
      totalWeight: 7,
      requiredWeight: 6,
      comparableOutcomes: [
        { label: "Reject candidate", weight: 5 },
        { label: "Support candidate", weight: 5 },
      ],
    });
    expect(metrics.leadingAgreementWeight).toBe(5);
    expect(metrics.leadingAgreementLabel).toBe("Reject candidate");
  });

  it("uses only Magi run as the pending or failure fallback title", () => {
    expect(pendingMagiRunTitle()).toEqual({ state: "pending", title: "Magi run" });
    expect(failedMagiRunTitle()).toEqual({
      state: "failed",
      title: "Magi run",
      diagnostic: "Title generation failed",
    });
  });

  it("allows duplicate configurations but rejects duplicate ids and draw-capable rules", () => {
    const duplicateConfig = [participant("one", 1), participant("two", 1)];
    expect(exactDuplicateMagiParticipantGroups(duplicateConfig)).toEqual([["one", "two"]]);
    expect(
      validateMagiRoster({
        participants: duplicateConfig,
        consensusThresholdPercent: 100,
        magiTurnLimit: 1,
      }),
    ).toEqual([]);

    expect(
      validateMagiRoster({
        participants: [participant("same", 2), participant("same", 2)],
        consensusThresholdPercent: 50,
        magiTurnLimit: 1,
      }).map((issue) => issue.reason),
    ).toEqual(["duplicate-participant-id", "draw-capable-threshold"]);
  });
});

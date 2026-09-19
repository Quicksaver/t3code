import { describe, expect, it } from "vite-plus/test";

import {
  MagiParticipantId,
  MagiRunId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type MagiParticipantSettlement,
  type MagiRunDetail,
  type MagiRunTurnDetail,
} from "@t3tools/contracts";

import { projectMagiParticipantEvidence, projectMagiRunDetail } from "./MagiResultProjection.ts";

const settlement = (parsed: MagiParticipantSettlement["parsed"]): MagiParticipantSettlement => ({
  participantId: MagiParticipantId.make("participant-1"),
  participantThreadId: ThreadId.make("thread-1"),
  participantTurnId: TurnId.make("turn-1"),
  rawText: '{"recommendation":"Use the parsed response"}',
  parsed,
  parseMode: parsed === null ? "raw" : "structured",
  state: parsed === null ? "failed" : "settled",
  durationMs: 10,
  inputTokens: 20,
  outputTokens: 30,
  retryCount: 0,
  providerAttempts: 1,
  structuralRepairCount: 0,
  reconstructed: false,
  failureClass: parsed === null ? "parse-failed" : null,
  contextCompressed: false,
});

const parsedResponse: NonNullable<MagiParticipantSettlement["parsed"]> = {
  recommendation: "Use the parsed response",
  rationale: ["It is canonical."],
  assumptions: [],
  risks: [],
  confidence: 90,
  candidateFingerprint: null,
  ballot: "not-applicable",
  proposals: [],
  proposalEvaluations: [],
  exclusiveSetEvaluations: [],
};

describe("projectMagiParticipantEvidence", () => {
  it("returns parsed evidence once and omits its duplicate raw provider text", () => {
    const projected = projectMagiParticipantEvidence(settlement(parsedResponse));

    expect(projected.response).toEqual({ format: "structured", value: parsedResponse });
    expect(projected).not.toHaveProperty("rawText");
    expect(projected).not.toHaveProperty("parsed");
    expect(projected.rawTextAvailable).toBe(true);
  });

  it("keeps raw evidence when parsing failed or raw recovery was requested", () => {
    expect(projectMagiParticipantEvidence(settlement(null)).response.format).toBe("raw");
    expect(projectMagiParticipantEvidence(settlement(parsedResponse), "raw").response).toEqual({
      format: "raw",
      value: '{"recommendation":"Use the parsed response"}',
    });
  });
});

describe("projectMagiRunDetail", () => {
  const participantId = MagiParticipantId.make("participant-1");
  const participantConfig = {
    participantId,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    personalityId: null,
    weight: 1,
  };
  const runSettlement = settlement(parsedResponse);
  const detail = {
    summary: {
      runId: MagiRunId.make("run-1"),
      rootThreadId: ThreadId.make("root-1"),
      source: "agent-tool",
      title: { state: "generated", title: "Projection test" },
      state: "succeeded",
      objective: "Project compact detail.",
      completedMagiTurns: 1,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: "2026-08-26T00:01:00.000Z",
    },
    config: {
      participants: [participantConfig],
      consensusThresholdPercent: 100,
      magiTurnLimit: 1,
    },
    totalWeight: 1,
    requiredWeight: 1,
    activity: {
      runId: MagiRunId.make("run-1"),
      source: "agent-tool",
      state: "succeeded",
      completedMagiTurns: 1,
      magiTurnLimit: 1,
      totalWeight: 1,
      leadingAgreementWeight: 1,
      leadingAgreementLabel: "Candidate",
      requiredWeight: 1,
    },
    participants: [],
    settlements: [runSettlement],
    candidate: null,
    actions: [{ actionId: "action-1" }],
    issuedActionBatch: null,
    proposals: [{ proposalId: "proposal-1" }],
    magiTurns: [{ magiTurn: 99 }],
  } as unknown as MagiRunDetail;
  const turns = [
    {
      magiTurn: 1,
      settlements: [runSettlement],
      activities: [
        {
          activityId: "activity-1",
          kind: "tool",
          summary: "Inspected state",
          result: { large: "payload" },
        },
      ],
      arbitration: {
        assessments: [{ participantId, stance: "supports" }],
      },
    },
  ] as unknown as ReadonlyArray<MagiRunTurnDetail>;

  it("keeps compact protocol data while omitting raw diagnostic payloads", () => {
    const projected = projectMagiRunDetail({
      detail,
      turns,
      proposals: [],
      decisionSets: [],
      reconciliations: [],
      initialPrompt: "Initial request",
      includeDiagnostics: false,
    });

    expect(projected.settlements).toEqual([]);
    expect(projected.actions).toEqual([{ actionId: "action-1" }]);
    expect(projected.summary.tokenCount).toBe(50);
    expect(projected.magiTurns?.[0]?.settlements[0]?.rawText).toBe("");
    expect(projected.magiTurns?.[0]?.activities[0]).not.toHaveProperty("result");
    expect(projected.proposals).toEqual([]);
    expect(projected).not.toHaveProperty("initialPrompt");
    expect(projected.finalParticipantVotes).toEqual([
      { participantId, stance: "supports", ballot: "not-applicable" },
    ]);
  });

  it("keeps the latest arbitrated stance while using the latest turn ballot", () => {
    const latestSettlement = settlement({ ...parsedResponse, ballot: "approve" });
    const projected = projectMagiRunDetail({
      detail,
      turns: [
        ...turns,
        {
          magiTurn: 2,
          settlements: [latestSettlement],
          activities: [],
          arbitration: null,
        } as unknown as MagiRunTurnDetail,
      ],
      proposals: [],
      decisionSets: [],
      reconciliations: [],
      initialPrompt: "Initial request",
      includeDiagnostics: false,
    });

    expect(projected.finalParticipantVotes).toEqual([
      { participantId, stance: "supports", ballot: "approve" },
    ]);
  });

  it("includes diagnostics but strips raw activity results", () => {
    const projected = projectMagiRunDetail({
      detail,
      turns,
      proposals: [],
      decisionSets: [],
      reconciliations: [],
      initialPrompt: "Initial request",
      includeDiagnostics: true,
    });

    expect(projected.settlements).toEqual([runSettlement]);
    expect(projected.actions).toEqual([{ actionId: "action-1" }]);
    expect(projected.initialPrompt).toBe("Initial request");
    expect(projected.magiTurns?.[0]?.activities[0]).not.toHaveProperty("result");
  });
});

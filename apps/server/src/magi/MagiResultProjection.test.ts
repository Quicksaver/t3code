import { describe, expect, it } from "vite-plus/test";

import { MagiParticipantId, ThreadId, type MagiParticipantSettlement } from "@t3tools/contracts";

import { projectMagiParticipantEvidence } from "./MagiResultProjection.ts";

const settlement = (parsed: MagiParticipantSettlement["parsed"]): MagiParticipantSettlement => ({
  participantId: MagiParticipantId.make("participant-1"),
  participantThreadId: ThreadId.make("thread-1"),
  participantRunId: null,
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

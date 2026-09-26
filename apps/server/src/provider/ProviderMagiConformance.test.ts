import { describe, expect, it } from "@effect/vitest";

import { parseMagiParticipantResponse } from "../magi/MagiResponseParser.ts";
import {
  BUILT_IN_MAGI_CONFORMANCE_CASES,
  providerMagiConformanceFailures,
} from "./ProviderMagiConformance.ts";

describe.each(BUILT_IN_MAGI_CONFORMANCE_CASES)("$driver Magi conformance", (subject) => {
  it("passes the shared capability and participant-role profile", () => {
    expect(providerMagiConformanceFailures(subject)).toEqual([]);
  });
});

describe("Magi structured-output fallback", () => {
  it("retains raw assistant text when decoding fails", () => {
    expect(parseMagiParticipantResponse("plain assistant evidence")).toEqual({
      parsed: null,
      parseMode: "raw",
    });
  });

  it("repairs a fenced schema response without dropping the raw envelope", () => {
    const response = {
      recommendation: "Proceed carefully.",
      rationale: ["Evidence supports it."],
      assumptions: ["The constraint holds."],
      risks: ["The constraint may change."],
      confidence: 70,
      candidateFingerprint: null,
      ballot: "not-applicable",
      proposals: [],
      proposalEvaluations: [],
      exclusiveSetEvaluations: [],
    };
    const parsed = parseMagiParticipantResponse(
      `Evidence first.\n\`\`\`json\n${JSON.stringify(response)}\n\`\`\``,
    );
    expect(parsed.parseMode).toBe("repaired");
    expect(parsed.parsed?.recommendation).toBe("Proceed carefully.");
  });

  it("extracts one balanced JSON object without swallowing trailing braces", () => {
    const response = {
      recommendation: "Proceed with {care}.",
      rationale: ["Evidence supports it."],
      assumptions: [],
      risks: [],
      confidence: 70,
      candidateFingerprint: null,
      ballot: "not-applicable",
      proposals: [],
      proposalEvaluations: [],
      exclusiveSetEvaluations: [],
    };
    const parsed = parseMagiParticipantResponse(
      `Evidence first.\n${JSON.stringify(response)}\nTrailing prose with a stray } brace.`,
    );

    expect(parsed.parseMode).toBe("repaired");
    expect(parsed.parsed?.recommendation).toBe("Proceed with {care}.");
  });

  it("finds a balanced response after an unmatched prose brace", () => {
    const response = {
      recommendation: "Proceed.",
      rationale: [],
      assumptions: [],
      risks: [],
      confidence: 70,
      candidateFingerprint: null,
      ballot: "not-applicable",
      proposals: [],
      proposalEvaluations: [],
      exclusiveSetEvaluations: [],
    };
    const parsed = parseMagiParticipantResponse(
      `An unmatched prose brace { appears first.\n${JSON.stringify(response)}`,
    );

    expect(parsed.parseMode).toBe("repaired");
    expect(parsed.parsed?.recommendation).toBe("Proceed.");
  });

  it("decodes every response array beyond 64 items", () => {
    const items = Array.from({ length: 75 }, (_, index) => `Item ${index}`);
    const parsed = parseMagiParticipantResponse(
      JSON.stringify({
        recommendation: "Evaluate every active proposal.",
        rationale: items,
        assumptions: items,
        risks: items,
        confidence: 90,
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
      }),
    );

    expect(parsed.parseMode).toBe("structured");
    expect(parsed.parsed?.rationale).toHaveLength(75);
    expect(parsed.parsed?.proposals).toHaveLength(75);
    expect(parsed.parsed?.proposalEvaluations).toHaveLength(75);
    expect(parsed.parsed?.exclusiveSetEvaluations).toHaveLength(75);
  });
});

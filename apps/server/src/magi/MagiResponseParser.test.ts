import { describe, expect, it } from "@effect/vitest";

import { parseMagiParticipantResponse } from "./MagiResponseParser.ts";

const response = (ballot: "approve" | "reject") =>
  JSON.stringify({
    recommendation: `Ballot ${ballot}`,
    rationale: [`The participant chose ${ballot}.`],
    assumptions: [],
    risks: [],
    confidence: 70,
    candidateFingerprint: null,
    ballot,
    proposals: [],
    proposalEvaluations: [],
    exclusiveSetEvaluations: [],
  });

const fenced = (body: string) => ["```json", body, "```"].join("\n");

describe("parseMagiParticipantResponse", () => {
  it("decodes a bare response object as structured", () => {
    expect(parseMagiParticipantResponse(response("approve"))).toMatchObject({
      parseMode: "structured",
      parsed: { ballot: "approve" },
    });
  });

  it("uses the last fenced response when an earlier fence holds a replaced draft", () => {
    const text = [
      "My first draft was:",
      fenced(response("approve")),
      "On reflection I corrected it:",
      fenced(response("reject")),
    ].join("\n");
    expect(parseMagiParticipantResponse(text)).toMatchObject({
      parseMode: "repaired",
      parsed: { ballot: "reject" },
    });
  });

  it("returns raw text when the last fence is malformed instead of an earlier fence", () => {
    const text = [fenced(response("approve")), "Final:", fenced("{ not json")].join("\n");
    expect(parseMagiParticipantResponse(text)).toEqual({ parsed: null, parseMode: "raw" });
  });

  it("prefers the final unfenced object over a quoted peer object", () => {
    const text = `A peer answered ${response("approve")}. My answer: ${response("reject")}`;
    expect(parseMagiParticipantResponse(text).parsed?.ballot).toBe("reject");
  });

  it("treats an unjustified ballot as undecodable so the repair turn runs", () => {
    const unjustified = JSON.stringify({ ...JSON.parse(response("approve")), rationale: [] });
    expect(parseMagiParticipantResponse(unjustified)).toEqual({ parsed: null, parseMode: "raw" });
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  mobileMagiParticipantIndicator,
  mobileMagiParticipantStatusLabel,
} from "./MagiPanelSheet.logic";

describe("mobile Magi participant status", () => {
  it("shows active participants as working or waiting without exposing settled", () => {
    expect(
      mobileMagiParticipantIndicator({
        runState: "deliberating",
        memberState: "running",
        finalStance: null,
        finalBallot: null,
      }),
    ).toBe("working");
    expect(
      mobileMagiParticipantStatusLabel({
        runState: "awaiting-next-turn",
        memberState: "settled",
        finalStance: "supports",
        finalBallot: "approve",
      }),
    ).toBe("Finished");
  });

  it("shows support and opposition only after successful finalization", () => {
    const active = {
      runState: "awaiting-arbitration" as const,
      memberState: "settled" as const,
      finalStance: "supports" as const,
      finalBallot: "approve" as const,
    };
    expect(mobileMagiParticipantIndicator(active)).toBe("neutral");
    expect(mobileMagiParticipantIndicator({ ...active, runState: "succeeded" })).toBe("supports");
    expect(
      mobileMagiParticipantIndicator({
        ...active,
        runState: "succeeded",
        finalStance: "opposes",
        finalBallot: "reject",
      }),
    ).toBe("opposes");
  });

  it("distinguishes abstentions and invalid final votes", () => {
    expect(
      mobileMagiParticipantStatusLabel({
        runState: "succeeded",
        memberState: "settled",
        finalStance: "unclear",
        finalBallot: "abstain",
      }),
    ).toBe("Abstained");
    expect(
      mobileMagiParticipantStatusLabel({
        runState: "succeeded",
        memberState: "settled",
        finalStance: "unclear",
        finalBallot: "not-applicable",
      }),
    ).toBe("No valid final vote");
  });
});

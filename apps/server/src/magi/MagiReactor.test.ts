import { describe, expect, it } from "@effect/vitest";
import { MagiParticipantId, ThreadId, TurnId } from "@t3tools/contracts";

import { completedMagiTurnsAfterArbitration, latestMagiMemberState } from "./MagiReactor.ts";

describe("latestMagiMemberState", () => {
  it("projects the latest settlement state into run history", () => {
    const participantId = MagiParticipantId.make("member-1");
    expect(
      latestMagiMemberState(participantId, "pending", [
        {
          participantId,
          participantThreadId: ThreadId.make("child-1"),
          participantTurnId: TurnId.make("turn-1"),
          rawText: "response",
          parsed: null,
          parseMode: "raw",
          state: "settled",
          durationMs: 10,
          inputTokens: null,
          outputTokens: null,
          retryCount: 0,
          providerAttempts: 1,
          structuralRepairCount: 0,
          reconstructed: false,
          failureClass: null,
          contextCompressed: false,
        },
      ]),
    ).toBe("settled");
  });
});

describe("completedMagiTurnsAfterArbitration", () => {
  it("does not count arbitration as another participant turn", () => {
    expect(completedMagiTurnsAfterArbitration(2, 2)).toBe(2);
  });

  it("advances stale progress to the arbitrated participant turn", () => {
    expect(completedMagiTurnsAfterArbitration(1, 2)).toBe(2);
  });
});

import { MagiParticipantId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { cancelledMagiParticipantSettlement, cancelMagiMemberState } from "./MagiCancellation.ts";

describe("Magi cancellation", () => {
  it("cancels only members that still have work in flight", () => {
    expect(cancelMagiMemberState("pending")).toBe("cancelled");
    expect(cancelMagiMemberState("running")).toBe("cancelled");
    expect(cancelMagiMemberState("settled")).toBe("settled");
    expect(cancelMagiMemberState("failed")).toBe("failed");
  });

  it("returns a terminal participant result without retrying cancelled work", () => {
    expect(
      cancelledMagiParticipantSettlement({
        participantId: MagiParticipantId.make("participant-1"),
        participantThreadId: ThreadId.make("thread-1"),
        durationMs: 125,
      }),
    ).toMatchObject({
      participantTurnId: "cancelled",
      state: "cancelled",
      failureClass: "cancelled",
      retryCount: 0,
      providerAttempts: 0,
      durationMs: 125,
    });
  });
});

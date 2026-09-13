import {
  TurnId,
  type MagiMemberState,
  type MagiParticipantDraft,
  type MagiParticipantSettlement,
  type ThreadId,
} from "@t3tools/contracts";

export function cancelMagiMemberState(state: MagiMemberState): MagiMemberState {
  return state === "pending" || state === "running" ? "cancelled" : state;
}

export function cancelledMagiParticipantSettlement(input: {
  readonly participantId: MagiParticipantDraft["participantId"];
  readonly participantThreadId: ThreadId;
  readonly durationMs: number;
}): MagiParticipantSettlement {
  return {
    participantId: input.participantId,
    participantThreadId: input.participantThreadId,
    participantTurnId: TurnId.make("cancelled"),
    rawText: "",
    parsed: null,
    parseMode: "raw",
    state: "cancelled",
    durationMs: input.durationMs,
    inputTokens: null,
    outputTokens: null,
    retryCount: 0,
    providerAttempts: 0,
    structuralRepairCount: 0,
    reconstructed: false,
    failureClass: "cancelled",
    contextCompressed: false,
  };
}

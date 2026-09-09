import type {
  MagiMemberState,
  MagiParticipantId,
  MagiParticipantSettlement,
} from "@t3tools/contracts";

export function latestMagiMemberState(
  participantId: MagiParticipantId,
  currentState: MagiMemberState,
  settlements: ReadonlyArray<MagiParticipantSettlement>,
): MagiMemberState {
  return (
    settlements.findLast((settlement) => settlement.participantId === participantId)?.state ??
    currentState
  );
}

export function completedMagiTurnsAfterArbitration(
  currentCompletedMagiTurns: number,
  arbitratedMagiTurn: number,
): number {
  return Math.max(currentCompletedMagiTurns, arbitratedMagiTurn);
}

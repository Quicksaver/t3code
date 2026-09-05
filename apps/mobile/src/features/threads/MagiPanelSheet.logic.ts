import {
  isMagiRunTerminal,
  type MagiArbitrationStance,
  type MagiBallot,
  type MagiMemberState,
  type MagiRunState,
} from "@t3tools/contracts";

export type MobileMagiParticipantIndicator =
  | "neutral"
  | "working"
  | "warning"
  | "supports"
  | "opposes"
  | "abstained";

export interface MobileMagiParticipantStatusInput {
  readonly runState: MagiRunState;
  readonly memberState: MagiMemberState;
  readonly finalStance: MagiArbitrationStance | null;
  readonly finalBallot: MagiBallot | null;
}

export function mobileMagiParticipantIndicator(
  input: MobileMagiParticipantStatusInput,
): MobileMagiParticipantIndicator {
  if (input.runState === "succeeded" && input.finalStance !== null) {
    if (input.finalStance === "supports") return "supports";
    if (input.finalStance === "opposes") return "opposes";
    return input.memberState === "settled" && input.finalBallot === "abstain"
      ? "abstained"
      : "warning";
  }

  if (isMagiRunTerminal(input.runState)) {
    return input.memberState === "failed" ||
      input.memberState === "timed-out" ||
      input.memberState === "cancelled"
      ? "warning"
      : "neutral";
  }

  if (input.memberState === "running") return "working";
  if (
    input.memberState === "failed" ||
    input.memberState === "timed-out" ||
    input.memberState === "cancelled"
  ) {
    return "warning";
  }
  return "neutral";
}

export function mobileMagiParticipantStatusLabel(input: MobileMagiParticipantStatusInput): string {
  const indicator = mobileMagiParticipantIndicator(input);
  if (indicator === "supports") return "Voted for consensus";
  if (indicator === "opposes") return "Voted against consensus";
  if (indicator === "abstained") return "Abstained";
  if (indicator === "warning") {
    return input.finalStance === "unclear"
      ? "No valid final vote"
      : input.memberState.replaceAll("-", " ");
  }
  if (indicator === "working") return "Working";
  return input.memberState === "pending" ? "Waiting" : "Finished";
}

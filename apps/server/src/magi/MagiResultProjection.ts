import type { MagiParticipantEvidence, MagiParticipantSettlement } from "@t3tools/contracts";

export const projectMagiParticipantEvidence = (
  settlement: MagiParticipantSettlement,
  representation: "best-available" | "raw" = "best-available",
): MagiParticipantEvidence => {
  const { rawText, parsed, ...metadata } = settlement;
  return {
    ...metadata,
    response:
      representation === "best-available" && parsed !== null
        ? { format: "structured", value: parsed }
        : { format: "raw", value: rawText },
    rawTextAvailable: rawText.length > 0,
  };
};

export const projectMagiParticipantEvidenceList = (
  settlements: ReadonlyArray<MagiParticipantSettlement>,
): ReadonlyArray<MagiParticipantEvidence> =>
  settlements.map((settlement) => projectMagiParticipantEvidence(settlement));

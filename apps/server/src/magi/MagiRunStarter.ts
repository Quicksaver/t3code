import {
  normalizeMagiTurnLimit,
  type MagiGetOptionsResult,
  type MagiParticipantDraft,
  type MagiArmThreadResult,
  type MagiRunConfig,
  type MagiRunSource,
} from "@t3tools/contracts";

export interface UnavailableMagiParticipant {
  readonly participantId: MagiParticipantDraft["participantId"];
  readonly model: string;
  readonly reason: string;
}

export const listUnavailableMagiParticipants = (
  participants: ReadonlyArray<MagiParticipantDraft>,
  providerInstances: MagiGetOptionsResult["providerInstances"],
): ReadonlyArray<UnavailableMagiParticipant> =>
  participants.flatMap((participant) => {
    const provider = providerInstances.find(
      (candidate) => candidate.instanceId === participant.modelSelection.instanceId,
    );
    return !provider?.available || !provider.models.includes(participant.modelSelection.model)
      ? [
          {
            participantId: participant.participantId,
            model: participant.modelSelection.model,
            reason:
              provider?.unavailableReason ??
              `Provider or model '${participant.modelSelection.model}' is unavailable.`,
          },
        ]
      : [];
  });

export const normalizeMagiStartConfig = (config: MagiRunConfig): MagiRunConfig => ({
  ...config,
  magiTurnLimit: normalizeMagiTurnLimit(config.magiTurnLimit),
});

/** Resolves the one canonical start snapshot shared by server arms and the
 * main agent's magi_start call. */
export function resolveMagiStartSnapshot(input: {
  readonly arm: MagiArmThreadResult | null;
  readonly requestedConfig: MagiRunConfig;
  readonly toolCallId: string;
}): {
  readonly config: MagiRunConfig;
  readonly source: MagiRunSource;
  readonly initiatingReferenceId: string;
} {
  return input.arm
    ? {
        config: normalizeMagiStartConfig(input.arm.config),
        source: "user-arm",
        initiatingReferenceId: input.arm.armId,
      }
    : {
        config: normalizeMagiStartConfig(input.requestedConfig),
        source: "agent-tool",
        initiatingReferenceId: input.toolCallId,
      };
}

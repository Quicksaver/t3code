import {
  normalizeMagiTurnLimit,
  type MagiGetOptionsResult,
  type MagiParticipantDraft,
  type MagiArmThreadResult,
  type MagiRunConfig,
  type MagiRunSource,
  type ModelSelection,
} from "@t3tools/contracts";

export interface UnavailableMagiParticipant {
  readonly participantId: MagiParticipantDraft["participantId"];
  readonly model: string;
  readonly reason: string;
}

/**
 * Why a selected model option cannot be applied, or null when every selection matches an option
 * the model advertises: a known id, a boolean for a toggle, and a listed or prompt-injected choice
 * for a select. A model without option metadata is not checked; one that advertises an empty list
 * accepts no options.
 */
const unsupportedModelOptionReason = (
  modelSelection: ModelSelection,
  providerInstances: MagiGetOptionsResult["providerInstances"],
): string | null => {
  const descriptors = providerInstances
    .find((provider) => provider.instanceId === modelSelection.instanceId)
    ?.modelOptions?.find((model) => model.model === modelSelection.model)?.optionDescriptors;
  if (descriptors === undefined) return null;
  for (const option of modelSelection.options ?? []) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    const supported =
      descriptor?.type === "boolean"
        ? typeof option.value === "boolean"
        : descriptor?.type === "select" &&
          typeof option.value === "string" &&
          (descriptor.options.some((choice) => choice.id === option.value) ||
            (descriptor.promptInjectedValues ?? []).includes(option.value));
    if (!supported) {
      return `Option '${option.id}' = ${JSON.stringify(option.value)} is not supported by model '${modelSelection.model}'.`;
    }
  }
  return null;
};

export const listUnavailableMagiParticipants = (
  participants: ReadonlyArray<MagiParticipantDraft>,
  providerInstances: MagiGetOptionsResult["providerInstances"],
): ReadonlyArray<UnavailableMagiParticipant> =>
  participants.flatMap((participant) => {
    const provider = providerInstances.find(
      (candidate) => candidate.instanceId === participant.modelSelection.instanceId,
    );
    const reason =
      !provider?.available || !provider.models.includes(participant.modelSelection.model)
        ? (provider?.unavailableReason ??
          `Provider or model '${participant.modelSelection.model}' is unavailable.`)
        : unsupportedModelOptionReason(participant.modelSelection, providerInstances);
    return reason === null
      ? []
      : [
          {
            participantId: participant.participantId,
            model: participant.modelSelection.model,
            reason,
          },
        ];
  });

/**
 * The selection a participant's thread starts with. Like a chat composer, it leaves out choices
 * that are the model's default: some providers reject an explicit default but apply it when the
 * option is absent, as Cursor does for Grok 4.7's 500K context.
 */
export const participantDispatchModelSelection = (
  modelSelection: ModelSelection,
  providerInstances: MagiGetOptionsResult["providerInstances"],
): ModelSelection => {
  const descriptors =
    providerInstances
      .find((provider) => provider.instanceId === modelSelection.instanceId)
      ?.modelOptions?.find((model) => model.model === modelSelection.model)?.optionDescriptors ??
    [];
  const options = modelSelection.options?.filter((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    return (
      descriptor?.type !== "select" ||
      descriptor.options.find((choice) => choice.isDefault)?.id !== option.value
    );
  });
  if (options === undefined || options.length === modelSelection.options?.length) {
    return modelSelection;
  }
  const { options: _, ...selection } = modelSelection;
  return options.length === 0 ? selection : { ...selection, options };
};

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

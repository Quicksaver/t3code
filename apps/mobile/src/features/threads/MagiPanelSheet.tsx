import {
  DEFAULT_RUNTIME_MODE,
  type ActiveMagiRunSummary,
  type EnvironmentId,
  type MagiGetOptionsResult,
  type MagiRunConfig,
  type MagiRunId,
  type MagiSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerConfig as T3ServerConfig,
  isMagiRunTerminal,
  magiParticipantVoteWeights,
  normalizeMagiTurnLimit,
  type ThreadId,
  requiredMagiWeight,
  totalMagiWeight,
  validateMagiRoster,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { MagiConsensusIcon } from "../../components/MagiConsensusIcon";
import { buildModelOptions, groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { magiEnvironment } from "../../state/magi";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { makeMobileMagiParticipantId } from "./magiParticipantIds";
import {
  mobileMagiParticipantIndicator,
  mobileMagiParticipantStatusLabel,
  type MobileMagiParticipantIndicator,
} from "./MagiPanelSheet.logic";
import { EmbeddedThreadModelSettingsPicker } from "./ThreadSettingsSheet";

type MagiSheetRoute =
  | { readonly name: "overview" }
  | { readonly name: "participant"; readonly index: number }
  | { readonly name: "model"; readonly index: number }
  | { readonly name: "personality"; readonly index: number }
  | { readonly name: "history" }
  | { readonly name: "run"; readonly runId: MagiRunId };

const buttonClass =
  "min-h-11 items-center justify-center rounded-xl bg-foreground px-4 active:opacity-70";
const secondaryButtonClass =
  "min-h-11 items-center justify-center rounded-xl border border-border bg-card px-4 active:bg-subtle";
const inputClass =
  "min-h-11 rounded-xl border border-input-border bg-input px-3 text-base text-foreground";

function initialConfig(options: MagiGetOptionsResult, settings: MagiSettings): MagiRunConfig {
  const rememberedConfig: MagiRunConfig = {
    participants: settings.lastPanelRoster,
    consensusThresholdPercent: settings.lastPanelConsensusThresholdPercent,
    magiTurnLimit: settings.lastPanelMagiTurnLimit,
  };
  if (rememberedConfig.participants.length >= options.bounds.minimumParticipants) {
    return rememberedConfig;
  }
  const provider = options.providerInstances.find((entry) => entry.available && entry.models[0]);
  if (!provider?.models[0]) return rememberedConfig;
  return {
    ...rememberedConfig,
    participants: Array.from({ length: options.bounds.minimumParticipants }, () => ({
      participantId: makeMobileMagiParticipantId(),
      modelSelection: { instanceId: provider.instanceId, model: provider.models[0]! },
      personalityId: null,
      weight: 1,
    })),
  };
}

function participantStatusIcon(indicator: MobileMagiParticipantIndicator) {
  if (indicator === "supports") {
    return { name: "checkmark.circle" as const, color: "#16a34a" };
  }
  if (indicator === "opposes") {
    return { name: "xmark.circle.fill" as const, color: "#dc2626" };
  }
  if (indicator === "abstained") {
    return { name: "minus.circle" as const, color: "#737373" };
  }
  if (indicator === "warning") {
    return { name: "exclamationmark.triangle" as const, color: "#d97706" };
  }
  if (indicator === "working") {
    return { name: "circle.dotted" as const, color: "#2563eb" };
  }
  return { name: "circle" as const, color: "#737373" };
}

function participantModelPresentation(
  serverConfig: T3ServerConfig | null,
  modelOptions: ReadonlyArray<ModelOption>,
  selection: ModelSelection,
): { readonly label: string; readonly capabilities: ModelCapabilities | null } {
  const modelOption = modelOptions.find(
    (option) =>
      option.selection.instanceId === selection.instanceId &&
      option.selection.model === selection.model,
  );
  const providerModel = serverConfig?.providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model);
  return {
    label: providerModel?.name ?? modelOption?.label ?? selection.model,
    capabilities: providerModel?.capabilities ?? modelOption?.capabilities ?? null,
  };
}

function exactDuplicateParticipantIds(config: MagiRunConfig): ReadonlySet<string> {
  const groups = new Map<string, string[]>();
  for (const participant of config.participants) {
    const key = JSON.stringify([
      participant.modelSelection.instanceId,
      participant.modelSelection.model,
      participant.modelSelection.options ?? [],
      participant.personalityId,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), participant.participantId]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}

export function MagiPanelSheet(props: {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activeRun: ActiveMagiRunSummary | null;
  readonly draftArm?: MagiRunConfig | null;
  readonly onDraftArmChange?: (config: MagiRunConfig | null) => void;
  readonly onClose: () => void;
}) {
  const [routes, setRoutes] = useState<ReadonlyArray<MagiSheetRoute>>([{ name: "overview" }]);
  const didSelectInitialRoute = useRef(false);
  const current = routes.at(-1) ?? { name: "overview" as const };
  const insets = useSafeAreaInsets();
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const optionsQuery = useEnvironmentQuery(
    magiEnvironment.options({ environmentId: props.environmentId, input: {} }),
  );
  const settingsQuery = useEnvironmentQuery(
    magiEnvironment.settings({ environmentId: props.environmentId, input: {} }),
  );
  const historyQuery = useEnvironmentQuery(
    magiEnvironment.history({
      environmentId: props.environmentId,
      input: { rootThreadId: props.threadId, limit: 25 },
    }),
  );
  const armQuery = useEnvironmentQuery(
    magiEnvironment.arm({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const detailQuery = useEnvironmentQuery(
    current.name === "run"
      ? magiEnvironment.detail({
          environmentId: props.environmentId,
          input: { runId: current.runId, includeDiagnostics: false },
        })
      : null,
  );
  const [config, setConfig] = useState<MagiRunConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const arm = useAtomCommand(magiEnvironment.armThread, { reportFailure: false });
  const disarm = useAtomCommand(magiEnvironment.disarmThread, { reportFailure: false });
  const cancel = useAtomCommand(magiEnvironment.cancelRun, { reportFailure: false });
  const continueRun = useAtomCommand(magiEnvironment.continueRun, { reportFailure: false });

  useEffect(() => {
    if (config === null && optionsQuery.data && settingsQuery.data) {
      setConfig(props.draftArm ?? initialConfig(optionsQuery.data, settingsQuery.data));
      setArmed(props.draftArm !== null && props.draftArm !== undefined);
    }
  }, [config, optionsQuery.data, props.draftArm, settingsQuery.data]);
  useEffect(() => {
    if (!props.onDraftArmChange) {
      if (armQuery.data === null) {
        setRevision(0);
        setArmed(false);
      } else if (armQuery.data && armQuery.data.revision !== revision) {
        setConfig(armQuery.data.config);
        setRevision(armQuery.data.revision);
        setArmed(true);
      }
    }
  }, [armQuery.data, props.onDraftArmChange, revision]);
  useEffect(() => {
    if (!props.visible) {
      didSelectInitialRoute.current = false;
      setRoutes([{ name: "overview" }]);
      return;
    }
    if (didSelectInitialRoute.current || historyQuery.data == null) return;
    const preferredRunId = props.activeRun?.runId ?? historyQuery.data.runs[0]?.runId;
    setRoutes(preferredRunId ? [{ name: "run", runId: preferredRunId }] : [{ name: "overview" }]);
    didSelectInitialRoute.current = true;
  }, [historyQuery.data, props.activeRun?.runId, props.visible]);

  const validationIssues = useMemo(() => (config ? validateMagiRoster(config) : []), [config]);
  const thresholdWarning =
    validationIssues.find((issue) => issue.reason === "draw-capable-threshold")?.message ?? null;
  const validationError =
    validationIssues.find((issue) => issue.reason !== "draw-capable-threshold")?.message ?? null;
  const duplicateIds = useMemo(
    () => (config ? exactDuplicateParticipantIds(config) : new Set<string>()),
    [config],
  );
  const totalWeight = config ? totalMagiWeight(config.participants) : 0;
  const requiredWeight = config
    ? requiredMagiWeight(totalWeight, config.consensusThresholdPercent)
    : 0;
  const hasPromptOnlyParticipant = (config?.participants ?? []).some((participant) => {
    const provider = optionsQuery.data?.providerInstances.find(
      (entry) => entry.instanceId === participant.modelSelection.instanceId,
    );
    return provider?.magi.readOnly === "prompt-only";
  });
  const participantModelOptions = useMemo(() => {
    const eligible = new Map(
      (optionsQuery.data?.providerInstances ?? [])
        .filter((provider) => provider.available)
        .map((provider) => [provider.instanceId, new Set(provider.models)]),
    );
    return buildModelOptions(serverConfig, null).filter((option) =>
      eligible.get(option.selection.instanceId)?.has(option.selection.model),
    );
  }, [optionsQuery.data?.providerInstances, serverConfig]);
  const participantProviderGroups = useMemo(
    () => groupByProvider(participantModelOptions),
    [participantModelOptions],
  );
  const push = (route: MagiSheetRoute) => setRoutes((value) => [...value, route]);
  const pop = () => setRoutes((value) => (value.length > 1 ? value.slice(0, -1) : value));

  if (!optionsQuery.data || !config) {
    return (
      <Modal
        visible={props.visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={props.onClose}
      >
        <View
          className="flex-1 items-center justify-center bg-screen"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <Text>Loading Magi…</Text>
        </View>
      </Modal>
    );
  }

  const options = optionsQuery.data;
  const replaceParticipant = (
    index: number,
    update: (
      participant: MagiRunConfig["participants"][number],
    ) => MagiRunConfig["participants"][number],
  ) =>
    setConfig((value) =>
      value
        ? {
            ...value,
            participants: value.participants.map((item, itemIndex) =>
              itemIndex === index ? update(item) : item,
            ),
          }
        : value,
    );

  const title =
    current.name === "participant"
      ? `Participant ${current.index + 1}`
      : current.name === "model"
        ? "Provider and model"
        : current.name === "personality"
          ? "Personality"
          : current.name === "history"
            ? "Run history"
            : current.name === "run"
              ? (detailQuery.data?.summary.title.title ?? "Magi run")
              : "Magi";

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        {current.name !== "model" ? (
          <View className="min-h-14 flex-row items-center gap-3 border-b border-border px-4">
            {routes.length > 1 ? (
              <Pressable
                className="w-16"
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={pop}
              >
                <Text className="text-base font-t3-medium">Back</Text>
              </Pressable>
            ) : (
              <View className="w-16" />
            )}
            <View className="min-w-0 flex-1 flex-row items-center justify-center gap-2">
              <View className="shrink-0">
                <MagiConsensusIcon size={20} />
              </View>
              <Text className="min-w-0 shrink text-lg font-t3-bold" numberOfLines={1}>
                {title}
              </Text>
            </View>
            <Pressable
              className="w-16 items-end"
              accessibilityRole="button"
              accessibilityLabel="Close Magi"
              onPress={props.onClose}
            >
              <Text className="text-base font-t3-medium">Done</Text>
            </Pressable>
          </View>
        ) : null}

        {current.name === "overview" ? (
          <ScrollView contentContainerClassName="gap-4 p-4 pb-10">
            <Text className="text-sm text-foreground-muted">
              Configure the participants and voting rules for the next Magi run.
            </Text>
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="font-t3-bold">Participants</Text>
                <Text className="text-sm text-foreground-muted">
                  {config.participants.length}/9
                </Text>
              </View>
              {config.participants.map((participant, index) => (
                <View
                  key={participant.participantId}
                  className="gap-3 rounded-2xl border border-border bg-card p-4"
                >
                  <Pressable
                    onPress={() => push({ name: "participant", index })}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit participant ${index + 1}`}
                  >
                    <Text className="font-t3-medium">Participant {index + 1}</Text>
                    <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={1}>
                      {
                        participantModelPresentation(
                          serverConfig,
                          participantModelOptions,
                          participant.modelSelection,
                        ).label
                      }{" "}
                      · weight {participant.weight}
                    </Text>
                    {duplicateIds.has(participant.participantId) ? (
                      <Text className="mt-1 text-sm text-danger-foreground">
                        Exact duplicate participant.
                      </Text>
                    ) : null}
                  </Pressable>
                  <View className="flex-row gap-2">
                    <Pressable
                      className="min-h-11 flex-1 items-center justify-center rounded-xl border border-border"
                      disabled={index === 0}
                      accessibilityRole="button"
                      accessibilityLabel={`Move participant ${index + 1} up`}
                      onPress={() => {
                        if (index === 0) return;
                        const participants = [...config.participants];
                        [participants[index - 1], participants[index]] = [
                          participants[index]!,
                          participants[index - 1]!,
                        ];
                        setConfig({ ...config, participants });
                      }}
                    >
                      <Text className="text-sm font-t3-medium">Move up</Text>
                    </Pressable>
                    <Pressable
                      className="min-h-11 flex-1 items-center justify-center rounded-xl border border-border"
                      disabled={index === config.participants.length - 1}
                      accessibilityRole="button"
                      accessibilityLabel={`Move participant ${index + 1} down`}
                      onPress={() => {
                        if (index === config.participants.length - 1) return;
                        const participants = [...config.participants];
                        [participants[index], participants[index + 1]] = [
                          participants[index + 1]!,
                          participants[index]!,
                        ];
                        setConfig({ ...config, participants });
                      }}
                    >
                      <Text className="text-sm font-t3-medium">Move down</Text>
                    </Pressable>
                    <Pressable
                      className="min-h-11 flex-1 items-center justify-center rounded-xl border border-border"
                      disabled={config.participants.length >= options.bounds.maximumParticipants}
                      accessibilityRole="button"
                      accessibilityLabel={`Duplicate participant ${index + 1}`}
                      onPress={() => {
                        if (config.participants.length >= options.bounds.maximumParticipants)
                          return;
                        const duplicate = {
                          ...participant,
                          participantId: makeMobileMagiParticipantId(),
                        };
                        setConfig({
                          ...config,
                          participants: [
                            ...config.participants.slice(0, index + 1),
                            duplicate,
                            ...config.participants.slice(index + 1),
                          ],
                        });
                      }}
                    >
                      <Text className="text-sm font-t3-medium">Duplicate</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
              <Pressable
                className={secondaryButtonClass}
                disabled={config.participants.length >= options.bounds.maximumParticipants}
                onPress={() => {
                  const provider = options.providerInstances.find(
                    (entry) => entry.available && entry.models[0],
                  );
                  if (!provider?.models[0]) return;
                  setConfig({
                    ...config,
                    participants: [
                      ...config.participants,
                      {
                        participantId: makeMobileMagiParticipantId(),
                        modelSelection: {
                          instanceId: provider.instanceId,
                          model: provider.models[0],
                        },
                        personalityId: null,
                        weight: 1,
                      },
                    ],
                  });
                }}
              >
                <Text className="font-t3-medium">Add participant</Text>
              </Pressable>
            </View>
            <View className="gap-4 rounded-2xl bg-card p-4">
              <View>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-sm font-t3-medium">Consensus threshold</Text>
                  <TextInput
                    className={`${inputClass} w-20`}
                    keyboardType="number-pad"
                    value={String(config.consensusThresholdPercent)}
                    onChangeText={(value) =>
                      setConfig({
                        ...config,
                        consensusThresholdPercent: Math.round(Number(value) || 0),
                      })
                    }
                    accessibilityLabel="Consensus threshold"
                  />
                  <Text className="text-sm text-foreground-muted">%</Text>
                </View>
                <Text className="mt-1 text-sm text-foreground-muted">
                  {totalWeight} total voting weight · {requiredWeight} needed for consensus.
                  {thresholdWarning ? (
                    <Text className="text-danger-foreground"> {thresholdWarning}</Text>
                  ) : null}
                </Text>
              </View>
              <View>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-sm font-t3-medium">Turn limit</Text>
                  <TextInput
                    className={`${inputClass} w-20`}
                    keyboardType="number-pad"
                    value={String(config.magiTurnLimit ?? 0)}
                    onChangeText={(value) =>
                      setConfig({
                        ...config,
                        magiTurnLimit: normalizeMagiTurnLimit(
                          Math.max(0, Math.round(Number(value) || 0)),
                        ),
                      })
                    }
                    accessibilityLabel="Magi turn limit"
                  />
                </View>
                <Text className="mt-1 text-sm text-foreground-muted">
                  {config.magiTurnLimit === null || config.magiTurnLimit === 0
                    ? "Unlimited turns. Provider cost is unbounded."
                    : `${config.participants.length * config.magiTurnLimit} base participant turns; up to ${config.participants.length * config.magiTurnLimit * 3} provider attempts with retries and repairs.`}
                </Text>
              </View>
            </View>
            {validationError ? (
              <Text className="text-sm text-danger-foreground">{validationError}</Text>
            ) : null}
            {status ? <Text className="text-sm text-foreground-muted">{status}</Text> : null}
            <Pressable
              className={buttonClass}
              disabled={validationIssues.length > 0 || Boolean(props.activeRun)}
              onPress={() =>
                void (async () => {
                  if (props.onDraftArmChange) {
                    props.onDraftArmChange(config);
                    setArmed(true);
                    setStatus("Magi will start with the first message.");
                    return;
                  }
                  const result = await arm({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, expectedRevision: revision, config },
                  });
                  if (result._tag === "Success") {
                    setRevision(result.value.revision);
                    setArmed(true);
                    setStatus("Magi is armed for the next message.");
                  } else setStatus("Magi could not be armed.");
                })()
              }
            >
              <Text className="font-t3-bold text-screen">
                {armed ? "Update arm" : "Arm next message"}
              </Text>
            </Pressable>
            {armed ? (
              <Pressable
                className={secondaryButtonClass}
                onPress={() =>
                  void (async () => {
                    if (props.onDraftArmChange) {
                      props.onDraftArmChange(null);
                      setArmed(false);
                      setStatus("Magi arm removed.");
                      return;
                    }
                    const result = await disarm({
                      environmentId: props.environmentId,
                      input: { threadId: props.threadId, expectedRevision: revision },
                    });
                    if (result._tag === "Success") {
                      setRevision(0);
                      setArmed(false);
                      setStatus("Magi arm removed.");
                    }
                  })()
                }
              >
                <Text className="font-t3-medium">Disarm</Text>
              </Pressable>
            ) : null}
            {hasPromptOnlyParticipant ? (
              <View className="flex-row items-start gap-2 px-1 opacity-60">
                <SymbolView
                  name="exclamationmark.triangle"
                  size={15}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text className="flex-1 text-sm text-foreground-muted">
                  Some providers are instructed not to mutate state, but T3 cannot enforce that
                  policy.
                </Text>
              </View>
            ) : null}
            {historyQuery.data?.runs.length ? (
              <Pressable className={secondaryButtonClass} onPress={() => push({ name: "history" })}>
                <Text className="font-t3-medium">Run history</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : null}

        {current.name === "participant"
          ? (() => {
              const participant = config.participants[current.index];
              if (!participant) return null;
              const provider = options.providerInstances.find(
                (entry) => entry.instanceId === participant.modelSelection.instanceId,
              );
              const modelPresentation = participantModelPresentation(
                serverConfig,
                participantModelOptions,
                participant.modelSelection,
              );
              const personality = options.personalities.find(
                (item) => item.id === participant.personalityId,
              );
              return (
                <ScrollView contentContainerClassName="gap-4 p-4 pb-10">
                  <View className="flex-row flex-wrap gap-2">
                    <Pressable
                      className={`${secondaryButtonClass} min-w-44 flex-1`}
                      onPress={() => push({ name: "model", index: current.index })}
                    >
                      <Text className="font-t3-medium">Provider, model, and traits</Text>
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {provider?.displayName ?? participant.modelSelection.instanceId} ·{" "}
                        {modelPresentation.label}
                      </Text>
                    </Pressable>
                    <Pressable
                      className={`${secondaryButtonClass} min-w-36 flex-1`}
                      onPress={() => push({ name: "personality", index: current.index })}
                    >
                      <Text className="font-t3-medium">Personality</Text>
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {personality?.name ?? "Empty / default"}
                      </Text>
                    </Pressable>
                  </View>
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-sm font-t3-medium">Weight</Text>
                    <TextInput
                      className={`${inputClass} w-20`}
                      keyboardType="number-pad"
                      value={String(participant.weight)}
                      onChangeText={(value) =>
                        replaceParticipant(current.index, (item) => ({
                          ...item,
                          weight: Math.max(1, Math.min(100, Math.round(Number(value) || 1))),
                        }))
                      }
                      accessibilityLabel={`Participant ${current.index + 1} weight`}
                    />
                  </View>
                  <Pressable
                    className={secondaryButtonClass}
                    disabled={config.participants.length <= options.bounds.minimumParticipants}
                    onPress={() => {
                      setConfig({
                        ...config,
                        participants: config.participants.filter(
                          (_, index) => index !== current.index,
                        ),
                      });
                      pop();
                    }}
                  >
                    <Text className="font-t3-medium text-danger-foreground">
                      Remove participant
                    </Text>
                  </Pressable>
                </ScrollView>
              );
            })()
          : null}

        {current.name === "model"
          ? (() => {
              const participant = config.participants[current.index];
              if (!participant) return null;
              const selectedOption =
                participantModelOptions.find(
                  (option) =>
                    option.selection.instanceId === participant.modelSelection.instanceId &&
                    option.selection.model === participant.modelSelection.model,
                ) ?? null;
              const optionDescriptors = resolveProviderOptionDescriptors({
                capabilities: selectedOption?.capabilities,
                selections: participant.modelSelection.options,
              });
              return (
                <EmbeddedThreadModelSettingsPicker
                  environmentId={props.environmentId}
                  providerGroups={participantProviderGroups}
                  selectedModel={participant.modelSelection}
                  onSelectModel={(option) =>
                    replaceParticipant(current.index, (value) => ({
                      ...value,
                      modelSelection: option.selection,
                    }))
                  }
                  optionDescriptors={optionDescriptors}
                  onUpdateOptionSelections={(selections) =>
                    replaceParticipant(current.index, (value) => ({
                      ...value,
                      modelSelection: { ...value.modelSelection, options: selections },
                    }))
                  }
                  runtimeMode={DEFAULT_RUNTIME_MODE}
                  onUpdateRuntimeMode={() => {}}
                  showRuntime={false}
                  title={`Participant ${current.index + 1}`}
                  onClose={pop}
                />
              );
            })()
          : null}

        {current.name === "personality"
          ? (() => {
              const participant = config.participants[current.index];
              if (!participant) return null;
              return (
                <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
                  {[null, ...options.personalities.filter((item) => item.included)].map((item) => {
                    const id = item?.id ?? null;
                    const selected = participant.personalityId === id;
                    return (
                      <Pressable
                        key={id ?? "default"}
                        className={selected ? buttonClass : secondaryButtonClass}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => {
                          replaceParticipant(current.index, (value) => ({
                            ...value,
                            personalityId: id,
                          }));
                          pop();
                        }}
                      >
                        <Text
                          className={selected ? "font-t3-medium text-screen" : "font-t3-medium"}
                        >
                          {item?.name ?? "Empty / default"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              );
            })()
          : null}

        {current.name === "history" ? (
          <ScrollView contentContainerClassName="gap-2 p-4 pb-10">
            {historyQuery.data?.runs.map((run) => (
              <Pressable
                key={run.runId}
                className="rounded-2xl border border-border bg-card p-4 active:bg-subtle"
                onPress={() => push({ name: "run", runId: run.runId })}
              >
                <Text className="font-t3-medium">{run.title.title}</Text>
                <Text className="mt-1 text-sm text-foreground-muted">
                  {run.state.replaceAll("-", " ")} · {run.completedMagiTurns} turns
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {current.name === "run" ? (
          <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
            {detailQuery.data ? (
              <>
                <View className="flex-row gap-2">
                  <Pressable
                    className={`${secondaryButtonClass} flex-1`}
                    accessibilityRole="button"
                    accessibilityLabel="New Magi run"
                    onPress={() => setRoutes([{ name: "overview" }])}
                  >
                    <Text className="font-t3-medium">New run</Text>
                  </Pressable>
                  <Pressable
                    className={`${secondaryButtonClass} flex-1`}
                    accessibilityRole="button"
                    accessibilityLabel="Magi run history"
                    onPress={() => push({ name: "history" })}
                  >
                    <Text className="font-t3-medium">Run history</Text>
                  </Pressable>
                </View>
                <View className="gap-2 rounded-2xl border border-border bg-card p-4">
                  <View className="flex-row items-start justify-between gap-3">
                    <Text className="flex-1 font-t3-bold">Status</Text>
                    <Text className="text-right text-sm font-t3-medium text-foreground-muted">
                      {detailQuery.data.summary.state.replaceAll("-", " ")}
                    </Text>
                  </View>
                  <Text className="text-sm text-foreground-muted">
                    {detailQuery.data.summary.completedMagiTurns}
                    {detailQuery.data.config.magiTurnLimit === null
                      ? ""
                      : `/${detailQuery.data.config.magiTurnLimit}`}{" "}
                    turns
                  </Text>
                  <Text>{detailQuery.data.summary.objective ?? "No focused objective."}</Text>
                </View>
                {detailQuery.data.candidate ? (
                  <View className="gap-3 rounded-2xl border border-border bg-card p-4">
                    <Text className="font-t3-bold">Current candidate</Text>
                    <Text>{detailQuery.data.candidate.conclusion}</Text>
                    <View className="flex-row flex-wrap gap-x-5 gap-y-2 border-t border-border-subtle pt-3">
                      <View className="flex-row items-center gap-1.5">
                        <SymbolView
                          name="checkmark.circle"
                          size={17}
                          tintColor="#16a34a"
                          type="monochrome"
                        />
                        <Text className="text-sm">
                          {
                            magiParticipantVoteWeights(
                              detailQuery.data.config.participants,
                              detailQuery.data.finalParticipantVotes,
                            ).agreedWeight
                          }{" "}
                          agreed votes
                        </Text>
                      </View>
                      <View className="flex-row items-center gap-1.5">
                        <SymbolView
                          name="xmark.circle.fill"
                          size={17}
                          tintColor="#dc2626"
                          type="monochrome"
                        />
                        <Text className="text-sm">
                          {
                            magiParticipantVoteWeights(
                              detailQuery.data.config.participants,
                              detailQuery.data.finalParticipantVotes,
                            ).opposedWeight
                          }{" "}
                          opposed votes
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : null}
                <Text className="font-t3-bold">Participants</Text>
                {detailQuery.data.participants.map((participant) => {
                  const vote = detailQuery.data!.finalParticipantVotes?.find(
                    (item) => item.participantId === participant.participantId,
                  );
                  const memberState =
                    detailQuery.data!.summary.state === "cancelled" &&
                    (participant.state === "pending" || participant.state === "running")
                      ? ("cancelled" as const)
                      : participant.state;
                  const statusInput = {
                    runState: detailQuery.data!.summary.state,
                    memberState,
                    finalStance: vote?.stance ?? null,
                    finalBallot: vote?.ballot ?? null,
                  };
                  const indicator = mobileMagiParticipantIndicator(statusInput);
                  const statusLabel = mobileMagiParticipantStatusLabel(statusInput);
                  const statusIcon = participantStatusIcon(indicator);
                  const modelPresentation = participantModelPresentation(
                    serverConfig,
                    participantModelOptions,
                    participant.modelSelection,
                  );
                  const optionLabels = resolveProviderOptionDescriptors({
                    capabilities: modelPresentation.capabilities,
                    selections: participant.modelSelection.options,
                  }).flatMap((descriptor) => {
                    const value = getProviderOptionCurrentLabel(descriptor);
                    return value ? [`${descriptor.label}: ${value}`] : [];
                  });
                  return (
                    <View
                      key={participant.participantId}
                      className="flex-row items-start gap-3 rounded-2xl border border-border bg-card p-4"
                    >
                      <View className="min-h-7 justify-center">
                        <SymbolView
                          name={statusIcon.name}
                          size={20}
                          tintColor={statusIcon.color}
                          type="monochrome"
                        />
                      </View>
                      <View className="min-w-0 flex-1 gap-1.5">
                        <View className="flex-row flex-wrap items-center gap-2">
                          <Text className="font-t3-medium">{modelPresentation.label}</Text>
                          {optionLabels.map((label) => (
                            <View key={label} className="rounded-lg bg-subtle px-2 py-1">
                              <Text className="text-xs text-foreground-muted">{label}</Text>
                            </View>
                          ))}
                        </View>
                        <Text className="text-sm text-foreground-muted">
                          {statusLabel} · weight {participant.weight}
                        </Text>
                        <Text className="text-sm text-foreground-muted">
                          {participant.personality?.name ?? "No personality"}
                        </Text>
                      </View>
                    </View>
                  );
                })}
                <View className="gap-4 rounded-2xl border border-border bg-card p-4">
                  <View>
                    <View className="flex-row items-center justify-between gap-3">
                      <Text className="font-t3-bold">Consensus threshold</Text>
                      <Text className="font-t3-medium">
                        {detailQuery.data.config.consensusThresholdPercent}%
                      </Text>
                    </View>
                    <Text className="mt-1 text-sm text-foreground-muted">
                      {detailQuery.data.activity.leadingAgreementWeight ?? 0}/
                      {detailQuery.data.totalWeight} agreed weight ·{" "}
                      {detailQuery.data.requiredWeight} needed for consensus.
                    </Text>
                  </View>
                  <View className="border-t border-border-subtle pt-4">
                    <View className="flex-row items-center justify-between gap-3">
                      <Text className="font-t3-bold">Turn limit</Text>
                      <Text className="font-t3-medium">
                        {detailQuery.data.config.magiTurnLimit ?? "Unlimited"}
                      </Text>
                    </View>
                    <Text className="mt-1 text-sm text-foreground-muted">
                      {detailQuery.data.config.magiTurnLimit === null
                        ? "Unlimited turns. Provider cost is unbounded."
                        : `${detailQuery.data.config.participants.length * detailQuery.data.config.magiTurnLimit} base participant turns; up to ${detailQuery.data.config.participants.length * detailQuery.data.config.magiTurnLimit * 3} provider attempts with retries and repairs.`}
                    </Text>
                  </View>
                </View>
                {detailQuery.data.summary.state === "paused" ? (
                  <Pressable
                    className={buttonClass}
                    accessibilityRole="button"
                    accessibilityLabel="Continue Magi"
                    onPress={() =>
                      void continueRun({
                        environmentId: props.environmentId,
                        input: { runId: detailQuery.data!.summary.runId },
                      })
                    }
                  >
                    <Text className="font-t3-medium text-screen">Continue Magi</Text>
                  </Pressable>
                ) : null}
                {!isMagiRunTerminal(detailQuery.data.summary.state) ? (
                  <Pressable
                    className={secondaryButtonClass}
                    accessibilityRole="button"
                    accessibilityLabel="Stop Magi"
                    onPress={() =>
                      Alert.alert(
                        "Stop this Magi run?",
                        "All active participants will stop. This run cannot be resumed.",
                        [
                          { text: "Keep running", style: "cancel" },
                          {
                            text: "Stop Magi",
                            style: "destructive",
                            onPress: () =>
                              void cancel({
                                environmentId: props.environmentId,
                                input: { runId: detailQuery.data!.summary.runId },
                              }),
                          },
                        ],
                      )
                    }
                  >
                    <Text className="font-t3-medium text-danger-foreground">Stop Magi</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <Text>Loading run detail…</Text>
            )}
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

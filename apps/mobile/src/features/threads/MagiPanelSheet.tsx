import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { MAGI_THREAD_RUNS_LIMIT } from "@t3tools/client-runtime/state/magi";
import {
  createMagiArmConfigAdoption,
  exactDuplicateMagiParticipantIds,
  magiParticipantIndicator,
  magiParticipantStatusLabel,
  type MagiParticipantIndicator,
  magiRunElapsedMs,
  magiRunStartedCopy,
  magiRunStateLabel,
} from "@t3tools/client-runtime/state/magiPresentation";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  isMagiRunTerminal,
  type MagiGetArmResult,
  type MagiGetOptionsResult,
  type MagiParticipantId,
  type MagiRunConfig,
  type MagiRunDetail,
  type MagiRunId,
  type MagiRunSummary,
  type MagiSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerConfig as T3ServerConfig,
  magiParticipantVoteWeights,
  normalizeMagiTurnLimit,
  type ThreadId,
  requiredMagiWeight,
  totalMagiWeight,
  validateMagiRoster,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
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
import { appAtomRegistry } from "../../state/atom-registry";
import { makeMobileMagiParticipantId } from "./magiParticipantIds";
import {
  MOBILE_MAGI_MAX_THRESHOLD_PERCENT,
  MOBILE_MAGI_MIN_THRESHOLD_PERCENT,
  mobileMagiArmBlockedReason,
  type MobileMagiArmReadiness,
  mobileMagiRosterInstanceNames,
  mobileMagiThresholdFromInput,
  createMobileMagiArmQueue,
} from "./MagiPanelSheet.logic";
import {
  MagiRunActionsScreen,
  MagiRunInitialPromptScreen,
  MagiRunParticipantScreen,
  MagiRunProposalsScreen,
  MagiRunTurnScreen,
} from "./MagiRunDetailScreens";
import { EmbeddedThreadModelSettingsPicker } from "./ThreadSettingsSheet";

type MagiSheetRoute =
  | { readonly name: "overview" }
  | { readonly name: "participant"; readonly index: number }
  | { readonly name: "model"; readonly index: number }
  | { readonly name: "personality"; readonly index: number }
  | { readonly name: "history" }
  | { readonly name: "run"; readonly runId: MagiRunId }
  | { readonly name: "runProposals"; readonly runId: MagiRunId }
  | { readonly name: "runActions"; readonly runId: MagiRunId }
  | { readonly name: "runPrompt"; readonly runId: MagiRunId }
  | { readonly name: "runTurn"; readonly runId: MagiRunId; readonly magiTurn: number }
  | {
      readonly name: "runParticipant";
      readonly runId: MagiRunId;
      readonly participantId: MagiParticipantId;
    };

const IDLE_ARM_ATOM = Atom.make(AsyncResult.initial<MagiGetArmResult, never>()).pipe(
  Atom.withLabel("environment-data:magi:arm:idle"),
);

function commandFailureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

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

function participantStatusIcon(indicator: MagiParticipantIndicator) {
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

function pluralizeTurns(count: number): string {
  return `${count} ${count === 1 ? "turn" : "turns"}`;
}

/** Ticks once a second while the run is active; kept small so only this text re-renders. */
function MagiRunElapsedText(props: { readonly run: MagiRunDetail["summary"] }) {
  const { startedAt, completedAt, state } = props.run;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (isMagiRunTerminal(state)) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state]);
  return <>{formatDuration(magiRunElapsedMs({ startedAt, completedAt }, nowMs))}</>;
}

/** A card collapsed to its one-line summary, which expands it. */
function MagiDisclosureCard(props: {
  readonly accessibilityLabel: string;
  readonly summary: ReactNode;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="rounded-2xl border border-border bg-card">
      <Pressable
        className="min-h-11 flex-row items-center gap-3 rounded-2xl px-4 py-3 active:bg-subtle"
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        {props.summary}
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded ? (
        <View className="border-t border-border-subtle px-4 pb-4 pt-3">{props.children}</View>
      ) : null}
    </View>
  );
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

/** One older page of run history, fetched on demand from the live list's cursor. */
function MagiOlderRunsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly isLast: boolean;
  readonly excludeRunIds: ReadonlySet<string>;
  readonly renderRun: (run: MagiRunSummary) => ReactNode;
  readonly onLoadOlder: (cursor: string) => void;
}) {
  const page = useEnvironmentQuery(
    magiEnvironment.runsPage({
      environmentId: props.environmentId,
      input: {
        rootThreadId: props.threadId,
        cursor: props.cursor,
        limit: MAGI_THREAD_RUNS_LIMIT,
      },
    }),
  );
  if (!page.data) {
    return page.error ? (
      <Pressable
        className={secondaryButtonClass}
        accessibilityRole="button"
        accessibilityLabel="Retry loading older Magi runs"
        onPress={page.refresh}
      >
        <Text className="font-t3-medium">Could not load older runs. Retry</Text>
      </Pressable>
    ) : (
      <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
        Loading older runs…
      </Text>
    );
  }
  const nextCursor = page.data.nextCursor;
  return (
    <>
      {page.data.runs.filter((run) => !props.excludeRunIds.has(run.runId)).map(props.renderRun)}
      {props.isLast && nextCursor ? (
        <Pressable
          className={secondaryButtonClass}
          accessibilityRole="button"
          onPress={() => props.onLoadOlder(nextCursor)}
        >
          <Text className="font-t3-medium">Load older runs</Text>
        </Pressable>
      ) : null}
    </>
  );
}

export function MagiPanelSheet(props: {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Conversation activity that blocks a new arm; the server rejects arming a busy thread too. */
  readonly readiness?: MobileMagiArmReadiness;
  readonly draftArm?: MagiRunConfig | null;
  readonly onDraftArmChange?: (config: MagiRunConfig | null) => void;
  readonly onClose: () => void;
}) {
  const [routes, setRoutes] = useState<ReadonlyArray<MagiSheetRoute>>([{ name: "overview" }]);
  const didSelectInitialRoute = useRef(false);
  const current = routes.at(-1) ?? { name: "overview" as const };
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  // A draft has no server conversation yet. Server data loads only while the sheet is open.
  const isDraft = props.onDraftArmChange !== undefined;
  const optionsQuery = useEnvironmentQuery(
    props.visible
      ? magiEnvironment.options({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const settingsQuery = useEnvironmentQuery(
    props.visible
      ? magiEnvironment.settings({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const historyQuery = useEnvironmentQuery(
    props.visible && !isDraft
      ? magiEnvironment.threadRuns({
          environmentId: props.environmentId,
          input: { rootThreadId: props.threadId, limit: MAGI_THREAD_RUNS_LIMIT },
        })
      : null,
  );
  // Runs owned by subagents are listed too, but only this conversation's own run blocks arming.
  const ownActiveRun =
    historyQuery.data?.runs.find(
      (run) => run.rootThreadId === props.threadId && !isMagiRunTerminal(run.state),
    ) ?? null;
  const armAtom =
    props.visible && !isDraft
      ? magiEnvironment.arm({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : IDLE_ARM_ATOM;
  const armResult = useAtomValue(armAtom);
  const refreshArm = useAtomRefresh(armAtom);
  const serverArm = Option.getOrNull(AsyncResult.value(armResult));
  const serverArmLoaded = Option.isSome(AsyncResult.value(armResult));
  const showDiagnostics = settingsQuery.data?.showRunDetailsAndDiagnostics ?? false;
  const runRouteId = "runId" in current ? current.runId : null;
  const detailQuery = useEnvironmentQuery(
    props.visible && runRouteId !== null && settingsQuery.data
      ? magiEnvironment.runDetail({
          environmentId: props.environmentId,
          input: { runId: runRouteId, includeDiagnostics: showDiagnostics },
        })
      : null,
  );
  const [config, setConfig] = useState<MagiRunConfig | null>(null);
  const [armConfigAdoption] = useState(createMagiArmConfigAdoption);
  const armRevisionRef = useRef(0);
  // Edits of an armed configuration reach the server debounced and one at a time.
  const armSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armQueueDrainedRef = useRef((_reconcile: boolean) => {});
  const [armQueue] = useState(() =>
    createMobileMagiArmQueue((reconcile) => armQueueDrainedRef.current(reconcile)),
  );
  const [armReconcileRequest, setArmReconcileRequest] = useState(0);
  // Bumped by every disarm and rejected arm so arm updates queued before it skip.
  const armIntentGenerationRef = useRef(0);
  const seenActiveRunRef = useRef<MagiRunId | null>(null);
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [olderCursors, setOlderCursors] = useState<ReadonlyArray<string>>([]);
  const arm = useAtomCommand(magiEnvironment.armThread, { reportFailure: false });
  const disarm = useAtomCommand(magiEnvironment.disarmThread, { reportFailure: false });
  const canArm = useAtomValue(magiEnvironment.armThread.permissionAtom(props.environmentId));
  const canDisarm = useAtomValue(magiEnvironment.disarmThread.permissionAtom(props.environmentId));
  const canMutateArm = isDraft || (canArm && canDisarm);
  const canMutateArmNow = () =>
    isDraft ||
    (appAtomRegistry.get(magiEnvironment.armThread.permissionAtom(props.environmentId)) &&
      appAtomRegistry.get(magiEnvironment.disarmThread.permissionAtom(props.environmentId)));
  useEffect(() => {
    armConfigAdoption.reset();
  }, [armConfigAdoption, isDraft, props.environmentId, props.threadId]);
  // Install before the permission-loss effect: an idle queue can request reconciliation immediately.
  useEffect(() => {
    armQueueDrainedRef.current = (reconcile) => {
      if (armSyncTimerRef.current !== null) return;
      refreshArm();
      if (reconcile) setArmReconcileRequest((request) => request + 1);
    };
  });
  useEffect(() => {
    if (canMutateArm) return;
    if (armSyncTimerRef.current !== null) clearTimeout(armSyncTimerRef.current);
    armSyncTimerRef.current = null;
    armIntentGenerationRef.current += 1;
    armConfigAdoption.cancelPendingWrite();
    armQueue.requestReconcile();
  }, [armConfigAdoption, armQueue, canMutateArm]);

  useEffect(() => {
    if (config === null && optionsQuery.data && settingsQuery.data) {
      setConfig(props.draftArm ?? initialConfig(optionsQuery.data, settingsQuery.data));
      setArmed(props.draftArm !== null && props.draftArm !== undefined);
    }
  }, [config, optionsQuery.data, props.draftArm, settingsQuery.data]);
  // The server arm is authoritative whenever none of this sheet's own updates are in flight.
  useEffect(() => {
    if (isDraft || !serverArmLoaded) return;
    if (armSyncTimerRef.current !== null || armQueue.pending > 0) return;
    armRevisionRef.current = serverArm?.revision ?? 0;
    setArmed(serverArm !== null);
    if (serverArm !== null) {
      const adopted = armConfigAdoption.adopt(serverArm.config);
      if (adopted !== null) setConfig(adopted);
    }
  }, [
    armConfigAdoption,
    armQueue,
    armReconcileRequest,
    canMutateArm,
    isDraft,
    serverArm,
    serverArmLoaded,
  ]);
  // The sheet stays mounted while hidden, and another client or a sent message can change the arm.
  useEffect(() => {
    if (props.visible && !isDraft) refreshArm();
  }, [isDraft, props.visible, refreshArm]);
  const ownActiveRunId = ownActiveRun?.runId ?? null;
  useEffect(() => {
    if (ownActiveRunId === null || seenActiveRunRef.current === ownActiveRunId) return;
    seenActiveRunRef.current = ownActiveRunId;
    if (armSyncTimerRef.current !== null) {
      clearTimeout(armSyncTimerRef.current);
      armSyncTimerRef.current = null;
    }
    refreshArm();
  }, [ownActiveRunId, refreshArm]);
  useEffect(
    () => () => {
      if (armSyncTimerRef.current !== null) clearTimeout(armSyncTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!props.visible) {
      didSelectInitialRoute.current = false;
      setRoutes([{ name: "overview" }]);
      setOlderCursors([]);
      return;
    }
    if (didSelectInitialRoute.current || (!isDraft && historyQuery.data == null)) return;
    const preferredRunId = ownActiveRun?.runId ?? historyQuery.data?.runs[0]?.runId;
    setRoutes(preferredRunId ? [{ name: "run", runId: preferredRunId }] : [{ name: "overview" }]);
    didSelectInitialRoute.current = true;
  }, [ownActiveRun?.runId, historyQuery.data, isDraft, props.visible]);

  const validationIssues = useMemo(() => (config ? validateMagiRoster(config) : []), [config]);
  const thresholdWarning =
    validationIssues.find((issue) => issue.reason === "draw-capable-threshold")?.message ?? null;
  const validationError =
    validationIssues.find((issue) => issue.reason !== "draw-capable-threshold")?.message ?? null;
  const armBlockedReason = mobileMagiArmBlockedReason({
    ...props.readiness,
    activeMagiRun: ownActiveRun !== null,
  });
  const duplicateIds = useMemo(
    () => (config ? exactDuplicateMagiParticipantIds(config.participants) : new Set<string>()),
    [config],
  );
  const totalWeight = config ? totalMagiWeight(config.participants) : 0;
  const requiredWeight = config
    ? requiredMagiWeight(totalWeight, config.consensusThresholdPercent)
    : 0;
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
  /** The sheet is a modal over the conversation, so it closes before the child conversation opens. */
  const openParticipantConversation = (threadId: ThreadId) => {
    props.onClose();
    navigation.navigate("Thread", {
      environmentId: String(props.environmentId),
      threadId: String(threadId),
    });
  };
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
  const cancelPendingArmSync = () => {
    if (armSyncTimerRef.current !== null) clearTimeout(armSyncTimerRef.current);
    armSyncTimerRef.current = null;
    armConfigAdoption.cancelPendingWrite();
  };
  const armServer = (next: MagiRunConfig, editVersion = armConfigAdoption.beginWrite()) => {
    if (!canMutateArmNow()) return;
    const generation = armIntentGenerationRef.current;
    const superseded = () => generation !== armIntentGenerationRef.current;
    void armQueue.enqueue(async () => {
      if (superseded() || !canMutateArmNow()) return;
      const result = await arm({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, expectedRevision: armRevisionRef.current, config: next },
      });
      if (result._tag === "Success") {
        // The queued disarm needs the new revision even when it superseded this arm.
        armRevisionRef.current = result.value.revision;
        armConfigAdoption.acknowledge(editVersion);
        if (superseded()) return;
        setArmed(true);
        setStatus(null);
      } else if (!superseded()) {
        // A rejected arm leaves the server's arm authoritative; queued edits of it are dropped.
        setStatus(commandFailureMessage(result, "Magi could not be armed."));
        cancelPendingArmSync();
        armIntentGenerationRef.current += 1;
        armQueue.requestReconcile();
      }
    });
  };
  /** Disarms right away in the sheet; a rejected disarm reapplies the server's arm once writes settle. */
  const disarmServer = (successStatus: string) => {
    if (!canMutateArmNow()) return;
    cancelPendingArmSync();
    armIntentGenerationRef.current += 1;
    setArmed(false);
    void armQueue.enqueue(async () => {
      if (!canMutateArmNow()) return;
      const result = await disarm({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, expectedRevision: armRevisionRef.current },
      });
      if (result._tag === "Success") {
        armRevisionRef.current = 0;
        setStatus(successStatus);
      } else {
        setStatus(commandFailureMessage(result, "Magi could not be disarmed."));
        // An Arm queued behind this disarm is newer intent and settles the sheet itself.
        if (armQueue.pending === 1) armQueue.requestReconcile();
      }
    });
  };
  /** Edits follow an armed configuration until its message is accepted; invalid edits disarm. */
  const updateConfig = (next: MagiRunConfig) => {
    armConfigAdoption.markEdited();
    setConfig(next);
    if (!armed || !canMutateArmNow()) return;
    if (validateMagiRoster(next).length > 0) {
      const removed = "Magi arm removed until the configuration is valid.";
      if (props.onDraftArmChange) {
        setArmed(false);
        props.onDraftArmChange(null);
        setStatus(removed);
      } else disarmServer(removed);
      return;
    }
    if (props.onDraftArmChange) {
      props.onDraftArmChange(next);
      return;
    }
    cancelPendingArmSync();
    const editVersion = armConfigAdoption.beginWrite();
    armSyncTimerRef.current = setTimeout(() => {
      armSyncTimerRef.current = null;
      armServer(next, editVersion);
    }, 250);
  };
  const replaceParticipant = (
    index: number,
    update: (
      participant: MagiRunConfig["participants"][number],
    ) => MagiRunConfig["participants"][number],
  ) =>
    updateConfig({
      ...config,
      participants: config.participants.map((item, itemIndex) =>
        itemIndex === index ? update(item) : item,
      ),
    });
  const rosterInstanceNames = mobileMagiRosterInstanceNames(config, options.providerInstances);
  const labelParticipant = (detail: MagiRunDetail) => (participantId: MagiParticipantId) => {
    const index = detail.participants.findIndex((item) => item.participantId === participantId);
    const participant = detail.participants[index];
    if (!participant) return participantId;
    const model = participantModelPresentation(
      serverConfig,
      participantModelOptions,
      participant.modelSelection,
    ).label;
    return `Participant ${index + 1} · ${model}`;
  };
  const liveRunIds = new Set<string>(historyQuery.data?.runs.map((run) => run.runId) ?? []);
  const renderRunItem = (run: MagiRunSummary) => (
    <Pressable
      key={run.runId}
      className="rounded-2xl border border-border bg-card p-4 active:bg-subtle"
      accessibilityRole="button"
      onPress={() => push({ name: "run", runId: run.runId })}
    >
      <Text className="font-t3-medium">{run.title.title}</Text>
      <Text className="mt-1 text-sm text-foreground-muted">
        {run.rootThreadId === props.threadId ? "" : `Subagent: ${run.ownerTitle ?? "Untitled"} · `}
        {magiRunStateLabel(run.state)} · {pluralizeTurns(run.completedMagiTurns)}
      </Text>
    </Pressable>
  );
  const runDetail = detailQuery.data;
  const candidateVoteWeights = runDetail
    ? magiParticipantVoteWeights(runDetail.config.participants, runDetail.finalParticipantVotes)
    : null;

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
              ? (runDetail?.summary.title.title ?? "Magi run")
              : current.name === "runProposals"
                ? "Proposals"
                : current.name === "runActions"
                  ? "Actions"
                  : current.name === "runPrompt"
                    ? "Initial prompt"
                    : current.name === "runTurn"
                      ? `Turn ${current.magiTurn}`
                      : current.name === "runParticipant"
                        ? runDetail
                          ? labelParticipant(runDetail)(current.participantId)
                          : "Participant"
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

        {!isDraft && historyQuery.data === null ? (
          <Text
            accessibilityLiveRegion="polite"
            className="px-4 py-3 text-sm text-foreground-muted"
          >
            {historyQuery.error ? "Could not load Magi runs." : "Loading Magi runs…"}
          </Text>
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
                  {config.participants.length}/{options.bounds.maximumParticipants}
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
                        updateConfig({ ...config, participants });
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
                        updateConfig({ ...config, participants });
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
                        updateConfig({
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
                  updateConfig({
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
                    value={thresholdDraft ?? String(config.consensusThresholdPercent)}
                    onChangeText={(value) => {
                      setThresholdDraft(value);
                      const typed = Number(value);
                      if (
                        Number.isInteger(typed) &&
                        typed >= MOBILE_MAGI_MIN_THRESHOLD_PERCENT &&
                        typed <= MOBILE_MAGI_MAX_THRESHOLD_PERCENT &&
                        typed !== config.consensusThresholdPercent
                      ) {
                        updateConfig({ ...config, consensusThresholdPercent: typed });
                      }
                    }}
                    onEndEditing={() => {
                      const committed = mobileMagiThresholdFromInput(
                        thresholdDraft ?? "",
                        config.consensusThresholdPercent,
                      );
                      setThresholdDraft(null);
                      if (committed !== config.consensusThresholdPercent) {
                        updateConfig({ ...config, consensusThresholdPercent: committed });
                      }
                    }}
                    accessibilityLabel="Consensus threshold"
                    accessibilityHint={`Between ${MOBILE_MAGI_MIN_THRESHOLD_PERCENT} and ${MOBILE_MAGI_MAX_THRESHOLD_PERCENT} percent`}
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
                      updateConfig({
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
            <View className="gap-2">
              <Text className="text-sm text-foreground-muted">
                Participants are asked to stay read-only, but they run with this conversation&apos;s
                access mode and tools. The rule is an instruction, not an enforced restriction.
              </Text>
              {rosterInstanceNames.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  This conversation&apos;s request and selected evidence are sent to:{" "}
                  {rosterInstanceNames.join(", ")}.
                </Text>
              ) : null}
            </View>
            {validationError ? (
              <Text className="text-sm text-danger-foreground">{validationError}</Text>
            ) : null}
            {status ? (
              <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                {status}
              </Text>
            ) : null}
            {!canMutateArm ? (
              <Text className="text-sm text-foreground-muted">
                This connection cannot change the Magi arm. Edits stay in this panel.
              </Text>
            ) : null}
            {armed ? (
              <>
                <Text className="text-sm text-foreground-muted">
                  {isDraft
                    ? "Magi will start with the first message. Edits update the arm."
                    : armConfigAdoption.hasUnsentEdits
                      ? "Magi remains armed with its saved configuration. These edits have not been saved."
                      : canMutateArm
                        ? "Magi is armed for the next message. Edits update the arm."
                        : "Magi is armed for the next message."}
                </Text>
                <Pressable
                  className={secondaryButtonClass}
                  accessibilityRole="button"
                  disabled={!canMutateArm}
                  accessibilityState={{ disabled: !canMutateArm }}
                  onPress={() => {
                    if (!canMutateArmNow()) return;
                    if (props.onDraftArmChange) {
                      props.onDraftArmChange(null);
                      setArmed(false);
                      setStatus("Magi arm removed.");
                      return;
                    }
                    disarmServer("Magi arm removed.");
                  }}
                >
                  <Text className="font-t3-medium">Disarm</Text>
                </Pressable>
              </>
            ) : (
              (() => {
                const disabled =
                  !canMutateArm || validationIssues.length > 0 || armBlockedReason !== null;
                return (
                  <>
                    {armBlockedReason ? (
                      <Text className="text-sm text-foreground-muted">{armBlockedReason}</Text>
                    ) : null}
                    <Pressable
                      className={disabled ? `${buttonClass} opacity-50` : buttonClass}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityState={{ disabled }}
                      onPress={() => {
                        if (!canMutateArmNow()) return;
                        if (props.onDraftArmChange) {
                          props.onDraftArmChange(config);
                          setArmed(true);
                          setStatus(null);
                          return;
                        }
                        // Armed before the request so edits made while it runs queue behind it;
                        // a rejected arm reapplies the server's arm once the queue drains.
                        setArmed(true);
                        setStatus(null);
                        armServer(config);
                      }}
                    >
                      <Text className="font-t3-bold text-screen">Arm next message</Text>
                    </Pressable>
                  </>
                );
              })()
            )}
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
                      updateConfig({
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
            {historyQuery.data?.runs.map(renderRunItem)}
            {historyQuery.data?.nextCursor && olderCursors.length === 0 ? (
              <Pressable
                className={secondaryButtonClass}
                accessibilityRole="button"
                onPress={() => setOlderCursors([historyQuery.data!.nextCursor!])}
              >
                <Text className="font-t3-medium">Load older runs</Text>
              </Pressable>
            ) : null}
            {olderCursors.map((cursor, index) => (
              <MagiOlderRunsPage
                key={cursor}
                environmentId={props.environmentId}
                threadId={props.threadId}
                cursor={cursor}
                isLast={index === olderCursors.length - 1}
                excludeRunIds={liveRunIds}
                renderRun={renderRunItem}
                onLoadOlder={(next) => setOlderCursors((value) => [...value, next])}
              />
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
                      {magiRunStateLabel(detailQuery.data.summary.state)}
                    </Text>
                  </View>
                </View>
                <MagiDisclosureCard
                  key={`${current.runId}:prompt`}
                  accessibilityLabel="Run prompt"
                  summary={
                    <Text className="flex-1 text-sm text-foreground-muted">
                      {magiRunStartedCopy(
                        detailQuery.data.summary,
                        detailQuery.data.config.magiTurnLimit,
                      )}{" "}
                      · <MagiRunElapsedText run={detailQuery.data.summary} /> elapsed
                    </Text>
                  }
                >
                  <Text>{detailQuery.data.summary.objective ?? "No focused objective."}</Text>
                </MagiDisclosureCard>
                {detailQuery.data.candidate ? (
                  <MagiDisclosureCard
                    key={`${current.runId}:candidate`}
                    accessibilityLabel={`Current candidate, ${candidateVoteWeights?.agreedWeight ?? 0} agreed weight, ${candidateVoteWeights?.opposedWeight ?? 0} opposed weight`}
                    // Phone widths fit the counter as icon and number; the label carries the words.
                    summary={
                      <>
                        <Text className="flex-1 font-t3-bold" numberOfLines={1}>
                          Current candidate
                        </Text>
                        <View className="flex-row items-center gap-3">
                          <View className="flex-row items-center gap-1">
                            <SymbolView
                              name="checkmark.circle"
                              size={15}
                              tintColor="#16a34a"
                              type="monochrome"
                            />
                            <Text className="text-sm">
                              {candidateVoteWeights?.agreedWeight ?? 0}
                            </Text>
                          </View>
                          <View className="flex-row items-center gap-1">
                            <SymbolView
                              name="xmark.circle.fill"
                              size={15}
                              tintColor="#dc2626"
                              type="monochrome"
                            />
                            <Text className="text-sm">
                              {candidateVoteWeights?.opposedWeight ?? 0}
                            </Text>
                          </View>
                        </View>
                      </>
                    }
                  >
                    <Text>{detailQuery.data.candidate.conclusion}</Text>
                  </MagiDisclosureCard>
                ) : null}
                <View className="gap-2">
                  <Text accessibilityRole="header" className="font-t3-bold">
                    Review
                  </Text>
                  {[
                    {
                      label: `Proposals · ${detailQuery.data.proposals?.length ?? 0}`,
                      route: { name: "runProposals", runId: current.runId } as const,
                    },
                    {
                      label: `Actions · ${detailQuery.data.actions.length}`,
                      route: { name: "runActions", runId: current.runId } as const,
                    },
                    // Present only when the detail was fetched with diagnostics.
                    ...(showDiagnostics && detailQuery.data.initialPrompt
                      ? [
                          {
                            label: "Initial prompt",
                            route: { name: "runPrompt", runId: current.runId } as const,
                          },
                        ]
                      : []),
                    ...(detailQuery.data.magiTurns ?? []).map((turn) => ({
                      label: `Turn ${turn.magiTurn} · ${turn.arbitration ? "arbitrated" : "awaiting arbitration"}${turn.arbitration?.disagreements.length ? ` · ${turn.arbitration.disagreements.length} dissent` : ""}`,
                      route: {
                        name: "runTurn",
                        runId: current.runId,
                        magiTurn: turn.magiTurn,
                      } as const,
                    })),
                  ].map((entry) => (
                    <Pressable
                      key={entry.label}
                      className={`${secondaryButtonClass} items-start`}
                      accessibilityRole="button"
                      onPress={() => push(entry.route)}
                    >
                      <Text className="font-t3-medium">{entry.label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text accessibilityRole="header" className="font-t3-bold">
                  Participants
                </Text>
                {detailQuery.data.participants.map((participant, index) => {
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
                  const indicator = magiParticipantIndicator(statusInput);
                  const statusLabel = magiParticipantStatusLabel(statusInput);
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
                    <Pressable
                      key={participant.participantId}
                      className="flex-row items-start gap-3 rounded-2xl border border-border bg-card p-4 active:bg-subtle"
                      accessibilityRole="button"
                      accessibilityLabel={`Participant ${index + 1}, ${modelPresentation.label}, ${statusLabel}`}
                      accessibilityHint="Opens this participant's responses"
                      onPress={() =>
                        push({
                          name: "runParticipant",
                          runId: current.runId,
                          participantId: participant.participantId,
                        })
                      }
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
                    </Pressable>
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
              </>
            ) : (
              <Text>Loading run detail…</Text>
            )}
          </ScrollView>
        ) : null}

        {current.name !== "run" && "runId" in current && !runDetail ? (
          <Text className="p-4">Loading run detail…</Text>
        ) : null}
        {current.name === "runProposals" && runDetail ? (
          <MagiRunProposalsScreen
            detail={runDetail}
            labelParticipant={labelParticipant(runDetail)}
          />
        ) : null}
        {current.name === "runActions" && runDetail ? (
          <MagiRunActionsScreen detail={runDetail} />
        ) : null}
        {current.name === "runPrompt" && runDetail ? (
          <MagiRunInitialPromptScreen detail={runDetail} />
        ) : null}
        {current.name === "runTurn" && runDetail ? (
          <MagiRunTurnScreen
            detail={runDetail}
            magiTurn={current.magiTurn}
            showDiagnostics={showDiagnostics}
            labelParticipant={labelParticipant(runDetail)}
          />
        ) : null}
        {current.name === "runParticipant" && runDetail ? (
          <MagiRunParticipantScreen
            detail={runDetail}
            participantId={current.participantId}
            showDiagnostics={showDiagnostics}
            onOpenConversation={openParticipantConversation}
          />
        ) : null}
      </View>
    </Modal>
  );
}

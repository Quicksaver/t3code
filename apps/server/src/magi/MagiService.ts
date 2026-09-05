import {
  CommandId,
  DEFAULT_MAGI_SETTINGS,
  EventId,
  MAGI_MAX_CONTEXT_ACTIVITY_IDS,
  MAGI_MAX_PARTICIPANTS,
  MAGI_MAX_WEIGHT,
  MAGI_MIN_PARTICIPANTS,
  MAGI_MIN_WEIGHT,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  MagiActionBatchId,
  MagiActionRecordId,
  MagiArmId,
  MagiRunId,
  MagiProposalId,
  MagiValidationError,
  ThreadId,
  TurnId,
  calculateMagiActivityMetrics,
  calculateMagiDirectTransition,
  calculateMagiThreshold,
  calculateMagiPostActionTransition,
  currentMagiTurnVoteTotals,
  deterministicMagiActionRecordId,
  deriveMagiActionObligation,
  failedMagiRunTitle,
  isMagiRunTerminal,
  isMaterialMagiCandidateChange,
  magiActionReconciliationState,
  magiActionsRequiringReassessment,
  magiCandidateFingerprint,
  pendingMagiRunTitle,
  validateMagiRoster,
  type ContextReadInput,
  type ContextReadResult,
  type MagiActivityReference,
  type MagiArbitrationRecord,
  type MagiArmThreadInput,
  type MagiArmThreadResult,
  type MagiCandidate,
  type MagiDeliberateInput,
  type MagiDeliberationResult,
  type MagiDiagnosticsInput,
  type MagiDiagnosticsResult,
  type MagiGetOptionsResult,
  type MagiGetRunDetailInput,
  type MagiGetArmResult,
  type MagiGetTerminalProposalsInput,
  type MagiGetTerminalProposalsResult,
  type MagiRecoverRunContextInput,
  type MagiRecoverRunContextResult,
  type MagiRecoverTurnResultInput,
  type MagiRecoverTurnResult,
  type MagiListContextActivitiesResult,
  type MagiListRunsInput,
  type MagiListRunsResult,
  type MagiMemberState,
  type MagiParticipantDraft,
  type MagiParticipantSettlement,
  type MagiPersonality,
  type MagiRecordActionsInput,
  type MagiRecordActionsResult,
  type MagiRecordArbitrationInput,
  type MagiRecordArbitrationResult,
  type MagiRecordedAction,
  type MagiReconcileActionsInput,
  MagiRunConfig,
  type MagiRunDetail,
  type MagiRunSource,
  type MagiRunState,
  type MagiSettings,
  type MagiSettingsPatch,
  type MagiStartInput,
  type MagiStartResult,
  type MagiTerminalProposalDigestEntry,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ProviderContextUsage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";

import * as MagiControlBroker from "../mcp/MagiControlBroker.ts";
import * as ContextArtifactBroker from "../mcp/ContextArtifactBroker.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionMagiRepositoryLive } from "../persistence/Layers/ProjectionMagi.ts";
import {
  ProjectionMagiRepository,
  type PersistedMagiRun,
} from "../persistence/Services/ProjectionMagi.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  increment,
  magiActionsTotal,
  magiParticipantTurnsTotal,
  magiParticipantTurnDuration,
  magiParticipantTokensTotal,
  magiRunsTotal,
  magiProposalsTotal,
  magiTurnsTotal,
  metricAttributes,
} from "../observability/Metrics.ts";
import {
  buildMagiArbitratorPreTurnInstructions,
  buildMagiParticipantPrompt,
  MAGI_ARBITRATOR_RESULT_PROTOCOL,
  MAGI_PARTICIPANT_OUTPUT_SCHEMA,
  renderMagiTerminalProposalDigest,
} from "./MagiPrompts.ts";
import {
  calculateMagiDecisionSetOutcomes,
  calculateMagiProposalOutcomes,
  activeMagiDecisionSets,
  activeMagiProposals,
  applyMagiDecisionSetOutcomes,
  applyMagiProposalOutcomes,
  collectMagiDecisionSets,
  collectMagiProposals,
  hasPendingMagiProtocolWork,
  normalizeMagiArbitrationAssessments,
  normalizeKnownMagiDecisionSet,
  normalizeKnownMagiProposal,
  type KnownMagiDecisionSet,
  type KnownMagiProposal,
} from "./MagiConsensusCalculator.ts";
import { parseMagiParticipantResponse } from "./MagiResponseParser.ts";
import {
  isMagiTerminalProposalDigestWithinLimit,
  MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS,
  mergeMagiTerminalProposalDigest,
  pageMagiTerminalProposals,
  terminalMagiProposals,
} from "./MagiTerminalProposalDigest.ts";
import { completedMagiTurnsAfterArbitration, latestMagiMemberState } from "./MagiReactor.ts";
import {
  listUnavailableMagiParticipants,
  normalizeMagiStartConfig,
  resolveMagiStartSnapshot,
} from "./MagiRunStarter.ts";
import { cancelledMagiParticipantSettlement, cancelMagiMemberState } from "./MagiCancellation.ts";
import {
  listMagiContextActivities,
  readMagiContextArtifacts,
  resolveMagiContextActivities,
} from "./MagiContextAssembler.ts";
import {
  projectMagiParticipantEvidence,
  projectMagiParticipantEvidenceList,
  projectMagiRunDetail,
} from "./MagiResultProjection.ts";

interface ProtocolMember {
  readonly participant: MagiParticipantDraft;
  readonly personality: MagiPersonality | null;
  readonly threadId: ThreadId;
  readonly state: MagiMemberState;
}

interface ProtocolTurn {
  readonly magiTurn: number;
  readonly candidate: MagiCandidate | null;
  readonly settlements: ReadonlyArray<MagiParticipantSettlement>;
  readonly arbitration: MagiArbitrationRecord | null;
  readonly activities?: ReadonlyArray<MagiActivityReference>;
}

interface MagiProtocolState {
  readonly members: ReadonlyArray<ProtocolMember>;
  readonly turns: ReadonlyArray<ProtocolTurn>;
  readonly pendingContextArtifacts: ReadonlyArray<MagiActivityReference>;
  readonly proposals: ReadonlyArray<KnownMagiProposal>;
  readonly terminalProposalDigest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
  readonly decisionSets: ReadonlyArray<KnownMagiDecisionSet>;
  readonly actions: ReadonlyArray<MagiRecordedAction>;
  readonly reconciliations: ReadonlyArray<{
    readonly reconciliationId: string;
    readonly batchId: MagiActionBatchId;
    readonly actions: ReadonlyArray<MagiRecordedAction>;
    readonly recordedAt: string;
  }>;
  readonly stateBeforePause: MagiRunState | null;
  readonly cleanupPending: boolean;
  readonly pendingBatch: null | {
    readonly batchId: MagiActionBatchId;
    readonly magiTurn: number;
    readonly actions: ReadonlyArray<{
      readonly actionId: MagiActionRecordId;
      readonly summary: string;
      readonly relatedProposalIds: ReadonlyArray<MagiProposalId>;
      readonly obligation: "required" | "optional";
    }>;
  };
}

const asProtocol = (value: unknown): MagiProtocolState => {
  const protocol = value as MagiProtocolState;
  return {
    ...protocol,
    proposals: (protocol.proposals ?? []).map(normalizeKnownMagiProposal),
    terminalProposalDigest: protocol.terminalProposalDigest ?? [],
    decisionSets: (protocol.decisionSets ?? []).map(normalizeKnownMagiDecisionSet),
    pendingContextArtifacts: protocol.pendingContextArtifacts ?? [],
    reconciliations: protocol.reconciliations ?? [],
    stateBeforePause: protocol.stateBeforePause ?? null,
    cleanupPending: protocol.cleanupPending ?? false,
  };
};
const encodeRunConfig = Schema.encodeSync(Schema.fromJsonString(MagiRunConfig));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const magiParticipantTurnIdempotencyKey = (input: {
  readonly runId: string;
  readonly magiTurn: number;
  readonly participantId: string;
  readonly stage: "turn" | "repair";
}): string => `${input.runId}:${input.magiTurn}:${input.participantId}:${input.stage}`;

export const recoverMagiProviderEvent = <A, E, R>(
  event: Pick<ProviderRuntimeEvent, "threadId" | "type">,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logError("Failed to project Magi provider event; continuing event stream.", {
        error,
        eventType: event.type,
        threadId: event.threadId,
      }),
    ),
  );
const arbitratorResultInstructions = (run: PersistedMagiRun): string =>
  `${run.arbitratorPrompt}\n\n${MAGI_ARBITRATOR_RESULT_PROTOCOL}\n\nParticipant labels for user-facing text:\n${run.detail.participants
    .map(
      (participant) =>
        `- ${participant.participantId} = ${participant.modelSelection.model}${participant.personality ? ` (${participant.personality.name})` : ""}`,
    )
    .join(
      "\n",
    )}\nUse the label after each equals sign in user-facing text. Keep the participant id on the left inside the tool protocol.`;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const validation = (
  reason: ConstructorParameters<typeof MagiValidationError>[0]["reason"],
  message: string,
  field: string | null = null,
) => new MagiValidationError({ reason, message, field });

const requireAvailableMagiRoster = Effect.fn("MagiService.requireAvailableMagiRoster")(function* (
  participants: ReadonlyArray<MagiParticipantDraft>,
  providerInstances: MagiGetOptionsResult["providerInstances"],
) {
  const unavailableParticipants = listUnavailableMagiParticipants(participants, providerInstances);
  if (unavailableParticipants.length === 0) return;
  const unavailableSummary = unavailableParticipants
    .map(
      (participant) => `${participant.participantId} (${participant.model}): ${participant.reason}`,
    )
    .join("; ");
  return yield* new MagiValidationError({
    reason: "unavailable-model",
    message: `Magi cannot start the participant turn because the configured roster is unavailable: ${unavailableSummary}. No participant was removed. Follow any explicit instruction for this situation; otherwise ask the user how to proceed.`,
    field: "participants",
  });
});

export const pendingMagiComparableOutcomes = (
  activity: Pick<MagiRunDetail["activity"], "leadingAgreementLabel" | "leadingAgreementWeight">,
): ReadonlyArray<{ readonly label: string; readonly weight: number }> =>
  activity.leadingAgreementLabel !== null && activity.leadingAgreementWeight !== null
    ? [{ label: activity.leadingAgreementLabel, weight: activity.leadingAgreementWeight }]
    : [];

const latestUserInstruction = (thread: OrchestrationThread): string | null => {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") return message.text;
  }
  return null;
};

export const makeMagiOptionCatalogue = (
  providerInstances: MagiGetOptionsResult["providerInstances"],
  personalities: MagiGetOptionsResult["personalities"],
): MagiGetOptionsResult => ({
  providerInstances,
  personalities,
  bounds: {
    minimumParticipants: MAGI_MIN_PARTICIPANTS,
    maximumParticipants: MAGI_MAX_PARTICIPANTS,
    minimumWeight: MAGI_MIN_WEIGHT,
    maximumWeight: MAGI_MAX_WEIGHT,
    maximumContextActivityIds: MAGI_MAX_CONTEXT_ACTIVITY_IDS,
  },
});

export interface MagiServiceShape {
  readonly getArmedTurnInstructions: (
    threadId: ThreadId,
    initiatingInstruction: string,
  ) => Effect.Effect<string | null, MagiValidationError>;
  readonly getOptions: Effect.Effect<MagiGetOptionsResult, MagiValidationError>;
  readonly getSettings: Effect.Effect<MagiSettings>;
  readonly updateSettings: (
    patch: MagiSettingsPatch,
  ) => Effect.Effect<MagiSettings, MagiValidationError>;
  readonly resetSettings: (
    target: "arbitrator-prompt" | "included-personalities",
  ) => Effect.Effect<MagiSettings>;
  readonly armThread: (
    input: MagiArmThreadInput,
  ) => Effect.Effect<MagiArmThreadResult, MagiValidationError>;
  readonly getArm: (threadId: ThreadId) => Effect.Effect<MagiGetArmResult, MagiValidationError>;
  readonly disarmThread: (
    threadId: ThreadId,
    expectedRevision: number,
  ) => Effect.Effect<void, MagiValidationError>;
  readonly startFromTool: (
    threadId: ThreadId,
    input: MagiStartInput,
    initiatingReferenceId: string,
  ) => Effect.Effect<MagiStartResult, MagiValidationError>;
  readonly deliberate: (
    threadId: ThreadId,
    input: MagiDeliberateInput,
  ) => Effect.Effect<MagiDeliberationResult, MagiValidationError>;
  readonly recordArbitration: (
    threadId: ThreadId,
    input: MagiRecordArbitrationInput,
  ) => Effect.Effect<MagiRecordArbitrationResult, MagiValidationError>;
  readonly getTerminalProposals: (
    threadId: ThreadId,
    input: MagiGetTerminalProposalsInput,
  ) => Effect.Effect<MagiGetTerminalProposalsResult, MagiValidationError>;
  readonly recoverTurnResult: (
    threadId: ThreadId,
    input: MagiRecoverTurnResultInput,
  ) => Effect.Effect<MagiRecoverTurnResult, MagiValidationError>;
  readonly recoverRunContext: (
    threadId: ThreadId,
    input: MagiRecoverRunContextInput,
  ) => Effect.Effect<MagiRecoverRunContextResult, MagiValidationError>;
  readonly recordActions: (
    threadId: ThreadId,
    input: MagiRecordActionsInput,
  ) => Effect.Effect<MagiRecordActionsResult, MagiValidationError>;
  readonly cancelRun: (runId: MagiRunId) => Effect.Effect<void, MagiValidationError>;
  readonly continueRun: (runId: MagiRunId) => Effect.Effect<void, MagiValidationError>;
  readonly reconcileActions: (
    input: MagiReconcileActionsInput,
  ) => Effect.Effect<void, MagiValidationError>;
  readonly listRuns: (
    input: MagiListRunsInput,
  ) => Effect.Effect<MagiListRunsResult, MagiValidationError>;
  readonly getRunDetail: (
    input: MagiGetRunDetailInput,
  ) => Effect.Effect<MagiRunDetail, MagiValidationError>;
  readonly listContextActivities: (
    threadId: ThreadId,
  ) => Effect.Effect<MagiListContextActivitiesResult, MagiValidationError>;
  readonly exportDiagnostics: (
    input: MagiDiagnosticsInput,
  ) => Effect.Effect<MagiDiagnosticsResult, MagiValidationError>;
}

export const MAGI_PARTICIPANT_TURN_CONCURRENCY = "unbounded" as const;
export const MAGI_PARTICIPANT_TURN_TIMEOUT = Duration.minutes(30);

export const awaitMagiParticipantTurnTerminal = <A>(
  terminal: Deferred.Deferred<A>,
  isTurnActive: Effect.Effect<boolean>,
  timeout: Duration.Input = MAGI_PARTICIPANT_TURN_TIMEOUT,
): Effect.Effect<A | null> =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Deferred.await(terminal).pipe(Effect.timeoutOption(timeout));
      if (Option.isSome(event)) return event.value;
      if (!(yield* isTurnActive)) return null;
    }
  });

export const runMagiTerminalCleanup = Effect.fn("runMagiTerminalCleanup")(function* (input: {
  readonly markPending: Effect.Effect<void>;
  readonly stopParticipants: Effect.Effect<boolean>;
  readonly clearCancellation: Effect.Effect<void>;
  readonly markComplete: Effect.Effect<void>;
}) {
  yield* input.markPending;
  if (!(yield* input.stopParticipants)) return false;
  yield* input.clearCancellation;
  yield* input.markComplete;
  return true;
});

export const shouldPersistMagiDeliberationContext = (
  state: MagiRunState | null,
  cancellationRequested: boolean,
): boolean => state !== null && !cancellationRequested && !isMagiRunTerminal(state);

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

export const isDeletedRootMagiPersistenceError = (error: unknown): boolean =>
  isPersistenceSqlError(error) &&
  error.operation === "ProjectionMagi.putRun" &&
  error.detail === "The root thread does not exist or was deleted.";

const deletedRootMagiValidationMessage =
  "The Magi root thread was deleted while the run was active.";

export const recoverInterruptedMagiState = (
  interruptedState: MagiRunState,
  stateBeforePause: MagiRunState | null,
): { readonly state: MagiRunState; readonly stateBeforePause: MagiRunState | null } => {
  if (interruptedState === "cancelling") return { state: "cancelled", stateBeforePause: null };
  if (interruptedState === "initializing" || interruptedState === "deliberating") {
    return { state: "failed", stateBeforePause: null };
  }
  if (interruptedState === "awaiting-main-approval" || interruptedState === "awaiting-main-input") {
    return {
      state: "paused",
      stateBeforePause: stateBeforePause ?? "awaiting-next-turn",
    };
  }
  return { state: interruptedState, stateBeforePause };
};

export const recoverMagiRunContextContinuation = (
  state: MagiRunState,
  issuedActionBatch: MagiRecoverRunContextResult["issuedActionBatch"],
): Pick<MagiRecoverRunContextResult, "issuedActionBatch" | "nextRequiredTool"> => ({
  issuedActionBatch,
  nextRequiredTool:
    state === "awaiting-next-turn"
      ? "magi_deliberate"
      : state === "awaiting-arbitration"
        ? "magi_recover_turn_result"
        : state === "awaiting-actions" || state === "awaiting-action-reconciliation"
          ? "magi_record_actions"
          : "none",
});

export interface MagiPromptCapacityInput {
  readonly usage: ProviderContextUsage | null;
  readonly fullPromptTokens: number;
  readonly compressedPromptTokens: number;
  readonly historyCompaction: "explicit-native" | "automatic-native" | "unsupported" | undefined;
  readonly compact: Effect.Effect<boolean>;
  readonly readUsage: Effect.Effect<ProviderContextUsage | null>;
}

export interface MagiPromptCapacityOutcome {
  readonly usage: ProviderContextUsage | null;
  readonly dispatchPrompt: "full" | "compressed";
  readonly contextCompressed: boolean;
  readonly exceeded: boolean;
}

export const resolveMagiPromptCapacity = (
  input: MagiPromptCapacityInput,
): Effect.Effect<MagiPromptCapacityOutcome> =>
  Effect.gen(function* () {
    let usage = input.usage;
    let dispatchPrompt: MagiPromptCapacityOutcome["dispatchPrompt"] = "full";
    let contextCompressed = false;
    if (usage?.limitTokens === null || usage?.limitTokens === undefined) {
      return { usage, dispatchPrompt, contextCompressed, exceeded: false };
    }
    if (usage.usedTokens + input.fullPromptTokens >= usage.limitTokens) {
      if (input.historyCompaction === "explicit-native") {
        contextCompressed = yield* input.compact;
        usage = yield* input.readUsage;
      }
      if (
        usage?.limitTokens !== null &&
        usage?.limitTokens !== undefined &&
        usage.usedTokens + input.fullPromptTokens >= usage.limitTokens &&
        input.historyCompaction !== "automatic-native"
      ) {
        dispatchPrompt = "compressed";
        contextCompressed = true;
      }
      if (
        dispatchPrompt === "compressed" &&
        usage?.limitTokens !== null &&
        usage?.limitTokens !== undefined &&
        usage.usedTokens + input.compressedPromptTokens >= usage.limitTokens
      ) {
        return { usage, dispatchPrompt, contextCompressed, exceeded: true };
      }
    }
    return { usage, dispatchPrompt, contextCompressed, exceeded: false };
  });

export type MagiOperationLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export const makeMagiOperationLock: Effect.Effect<MagiOperationLock> = Effect.gen(function* () {
  const locks = yield* Ref.make(new Map<string, Deferred.Deferred<void>>());
  return <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const previous = yield* Ref.modify(locks, (current) => {
          const previous = current.get(key);
          const next = new Map(current);
          next.set(key, gate);
          return [previous, next] as const;
        });
        if (previous) yield* Deferred.await(previous);
        return gate;
      }),
      () => effect,
      (gate) =>
        Deferred.succeed(gate, undefined).pipe(
          Effect.andThen(
            Ref.update(locks, (current) => {
              if (current.get(key) !== gate) return current;
              const next = new Map(current);
              next.delete(key);
              return next;
            }),
          ),
          Effect.ignore,
        ),
    );
});

type MagiLifecycleProviderEventType = Extract<
  ProviderRuntimeEvent["type"],
  | "request.opened"
  | "user-input.requested"
  | "request.resolved"
  | "user-input.resolved"
  | "runtime.error"
  | "turn.aborted"
>;

export const resolveMagiProviderEventTransition = (input: {
  readonly currentState: MagiRunState;
  readonly stateBeforePause: MagiRunState | null;
  readonly eventType: MagiLifecycleProviderEventType;
}): { readonly state: MagiRunState | null; readonly stateBeforePause: MagiRunState | null } => {
  let state: MagiRunState | null = null;
  let stateBeforePause = input.stateBeforePause;
  if (input.eventType === "request.opened") {
    state = "awaiting-main-approval";
    stateBeforePause ??= input.currentState;
  } else if (input.eventType === "user-input.requested") {
    state = "awaiting-main-input";
    stateBeforePause ??= input.currentState;
  } else if (input.eventType === "request.resolved" || input.eventType === "user-input.resolved") {
    if (
      input.currentState === "awaiting-main-approval" ||
      input.currentState === "awaiting-main-input"
    ) {
      state = stateBeforePause ?? "awaiting-arbitration";
      stateBeforePause = null;
    }
  } else if (input.eventType === "runtime.error" || input.eventType === "turn.aborted") {
    state = "paused";
    stateBeforePause ??= input.currentState;
  }
  return { state, stateBeforePause };
};

export const runMagiInitializationCompensation = (input: {
  readonly deletePlannedMembers: Effect.Effect<void>;
  readonly persistFailedRun: Effect.Effect<void>;
  readonly cleanupTerminalRun: Effect.Effect<void>;
}): Effect.Effect<void> =>
  input.deletePlannedMembers.pipe(
    Effect.andThen(input.persistFailedRun),
    Effect.andThen(input.cleanupTerminalRun),
  );

/** @internal Exported for service-boundary tests. */
export const makeMagiService = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* ProjectionMagiRepository;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerService = yield* ProviderService.ProviderService;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const withRunLock = yield* makeMagiOperationLock;
  const withArmLock = yield* makeMagiOperationLock;
  const runCancellations = yield* Ref.make(new Map<string, Deferred.Deferred<void>>());

  const getRunCancellation = Effect.fn("MagiService.getRunCancellation")(function* (
    runId: MagiRunId,
  ) {
    const fresh = yield* Deferred.make<void>();
    return yield* Ref.modify(runCancellations, (cancellations) => {
      const current = cancellations.get(runId);
      if (current) return [current, cancellations] as const;
      const next = new Map(cancellations);
      next.set(runId, fresh);
      return [fresh, next] as const;
    });
  });

  const signalRunCancellation = Effect.fn("MagiService.signalRunCancellation")(function* (
    runId: MagiRunId,
  ) {
    const cancellation = yield* getRunCancellation(runId);
    yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
  });

  const clearRunCancellation = (runId: MagiRunId) =>
    Ref.update(runCancellations, (cancellations) => {
      if (!cancellations.has(runId)) return cancellations;
      const next = new Map(cancellations);
      next.delete(runId);
      return next;
    });

  const withStartLock = withArmLock;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.magi ?? DEFAULT_MAGI_SETTINGS),
    Effect.orDie,
  );

  const getOptions = Effect.gen(function* () {
    const [providerSnapshots, settings] = yield* Effect.all([providers.getProviders, readSettings]);
    const providerInstances = yield* Effect.forEach(providerSnapshots, (provider) =>
      (
        providerService.getCapabilities?.(provider.instanceId) ??
        Effect.succeed({ sessionModelSwitch: "unsupported" as const })
      ).pipe(
        Effect.map((capabilities) => ({
          instanceId: provider.instanceId,
          displayName: provider.displayName ?? provider.driver,
          models: provider.models.map((model) => model.slug),
          modelOptions: provider.models.map((model) => ({
            model: model.slug,
            optionDescriptors: model.capabilities?.optionDescriptors ?? [],
          })),
          magi: capabilities.magi ?? {
            instructions: "prompt-envelope" as const,
            structuredOutput: "prompt-only" as const,
            readOnly: "prompt-only" as const,
            controlTools: "unsupported" as const,
            webSearch: "unsupported" as const,
            historyCompaction: "unsupported" as const,
          },
          available:
            provider.enabled &&
            provider.installed &&
            provider.availability !== "unavailable" &&
            capabilities.magi !== undefined,
          unavailableReason:
            provider.unavailableReason ??
            (capabilities.magi === undefined ? "Provider has not passed Magi conformance." : null),
        })),
        Effect.catch(() =>
          Effect.succeed({
            instanceId: provider.instanceId,
            displayName: provider.displayName ?? provider.driver,
            models: provider.models.map((model) => model.slug),
            modelOptions: provider.models.map((model) => ({
              model: model.slug,
              optionDescriptors: model.capabilities?.optionDescriptors ?? [],
            })),
            magi: {
              instructions: "prompt-envelope" as const,
              structuredOutput: "prompt-only" as const,
              readOnly: "prompt-only" as const,
              controlTools: "unsupported" as const,
              webSearch: "unsupported" as const,
              historyCompaction: "unsupported" as const,
            },
            available: false,
            unavailableReason: "Provider capabilities are unavailable.",
          }),
        ),
      ),
    );
    return makeMagiOptionCatalogue(providerInstances, settings.personalities);
  });

  const validateParticipantAvailability = Effect.fn("MagiService.validateParticipantAvailability")(
    function* (participants: ReadonlyArray<MagiParticipantDraft>) {
      const options = yield* getOptions;
      yield* requireAvailableMagiRoster(participants, options.providerInstances);
    },
  );

  const updateSettings = (patch: MagiSettingsPatch) =>
    settingsService.updateSettings({ magi: patch }).pipe(
      Effect.map((settings) => settings.magi ?? DEFAULT_MAGI_SETTINGS),
      Effect.mapError(() => validation("invalid-config", "Could not save Magi settings.")),
    );
  const resetSettings = (target: "arbitrator-prompt" | "included-personalities") =>
    settingsService
      .updateSettings({
        magi:
          target === "arbitrator-prompt"
            ? { arbitratorPrompt: DEFAULT_MAGI_SETTINGS.arbitratorPrompt }
            : { personalities: DEFAULT_MAGI_SETTINGS.personalities },
      })
      .pipe(
        Effect.map((settings) => settings.magi ?? DEFAULT_MAGI_SETTINGS),
        Effect.orDie,
      );

  const armThread = (input: MagiArmThreadInput) =>
    withArmLock(
      input.threadId,
      Effect.gen(function* () {
        const config = normalizeMagiStartConfig(input.config);
        const issues = validateMagiRoster(config);
        if (issues[0]) return yield* validation("invalid-config", issues[0].message, "config");
        if (Option.isSome(yield* repository.findActiveRun(input.threadId).pipe(Effect.orDie))) {
          return yield* validation(
            "magi-run-active",
            "This thread already has an active Magi run.",
          );
        }
        const current = yield* repository.getArm(input.threadId).pipe(Effect.orDie);
        const revision = Option.match(current, { onNone: () => 0, onSome: (arm) => arm.revision });
        if (revision !== input.expectedRevision) {
          if (
            input.expectedRevision === 0 &&
            Option.isSome(current) &&
            Equal.equals(normalizeMagiStartConfig(current.value.config), config)
          ) {
            return current.value;
          }
          return yield* validation(
            "invalid-protocol-state",
            "The Magi arm changed on another client.",
            "expectedRevision",
          );
        }
        const arm: MagiArmThreadResult = {
          armId: MagiArmId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: input.threadId,
          revision: revision + 1,
          config,
          armedAt: yield* nowIso,
        };
        yield* settingsService
          .updateSettings({
            magi: {
              lastPanelRoster: config.participants,
              lastPanelConsensusThresholdPercent: config.consensusThresholdPercent,
              lastPanelMagiTurnLimit: config.magiTurnLimit,
            },
          })
          .pipe(Effect.orDie);
        yield* repository.putArm(arm).pipe(Effect.orDie);
        return arm;
      }),
    );

  const getArm = (threadId: ThreadId) =>
    repository.getArm(threadId).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(() => validation("invalid-protocol-state", "Could not load the Magi arm.")),
    );

  const disarmThread = (threadId: ThreadId, expectedRevision: number) =>
    withArmLock(
      threadId,
      Effect.gen(function* () {
        const current = yield* repository.getArm(threadId).pipe(Effect.orDie);
        if (Option.isNone(current) || current.value.revision !== expectedRevision) {
          return yield* validation(
            "invalid-protocol-state",
            "The Magi arm changed on another client.",
            "expectedRevision",
          );
        }
        yield* repository.deleteArm(threadId).pipe(Effect.orDie);
      }),
    );

  const getArmedTurnInstructions = (threadId: ThreadId, initiatingInstruction: string) =>
    Effect.gen(function* () {
      const armed = yield* repository.getArm(threadId).pipe(Effect.orDie);
      if (Option.isNone(armed)) return null;
      const settings = yield* readSettings;
      return `The user armed Magi for this turn. Call magi_start now, before unrelated work.

Use this panel configuration exactly:
${encodeRunConfig(armed.value.config)}

Use the user's message as the initiating instruction:
${initiatingInstruction}

${buildMagiArbitratorPreTurnInstructions(settings.arbitratorPrompt)}`;
    });

  const resolveConversationContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const detail = yield* snapshots.getThreadDetailSnapshot(threadId).pipe(Effect.orDie);
      if (Option.isNone(detail))
        return yield* validation("invalid-protocol-state", "The conversation no longer exists.");
      const shell = yield* snapshots.getShellSnapshot().pipe(Effect.orDie);
      const project = shell.projects.find(
        (candidate) => candidate.id === detail.value.thread.projectId,
      );
      if (!project)
        return yield* validation(
          "invalid-protocol-state",
          "The conversation project no longer exists.",
        );
      return {
        thread: detail.value.thread,
        cwd: detail.value.thread.worktreePath ?? project.workspaceRoot,
      };
    });

  const listContextActivities = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* resolveConversationContext(threadId);
      return { activities: listMagiContextActivities(root.thread) };
    });

  const readContextArtifact = (
    scope: McpInvocationScope,
    input: ContextReadInput,
  ): Effect.Effect<ContextReadResult, MagiValidationError> =>
    Effect.gen(function* () {
      const found = yield* repository
        .findRunByParticipantThreadId(scope.threadId)
        .pipe(Effect.orDie);
      if (Option.isNone(found)) {
        return yield* validation(
          "foreign-activity",
          "This participant conversation does not own a Magi context artifact.",
          "artifactIds",
        );
      }
      const protocol = asProtocol(found.value.protocol);
      const member = protocol.members.find((candidate) => candidate.threadId === scope.threadId);
      if (!member || member.participant.modelSelection.instanceId !== scope.providerInstanceId) {
        return yield* validation(
          "foreign-activity",
          "This MCP session is not the participant authorized for the requested artifact.",
          "artifactIds",
        );
      }
      const availableActivities = [
        ...protocol.pendingContextArtifacts,
        ...protocol.turns.flatMap((turn) => turn.activities ?? []),
      ];
      return yield* readMagiContextArtifacts({
        availableActivities,
        artifactIds: input.artifactIds,
      });
    });

  const waitForParticipantTurn = (
    threadId: ThreadId,
    expectedTurnId: Deferred.Deferred<TurnId>,
    ready: Deferred.Deferred<void>,
  ) =>
    Effect.gen(function* () {
      const rawText = yield* Ref.make("");
      const terminal = yield* Deferred.make<ProviderRuntimeEvent>();
      const events = yield* providerService.subscribeEvents;
      yield* Deferred.succeed(ready, undefined);
      yield* events.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const turnId = yield* Deferred.await(expectedTurnId);
            if (event.turnId !== undefined && event.turnId !== turnId) return;
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              yield* Ref.update(rawText, (text) => text + event.payload.delta);
              return;
            }
            if (
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error"
            ) {
              yield* Deferred.succeed(terminal, event).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkScoped,
      );
      const event = yield* awaitMagiParticipantTurnTerminal(
        terminal,
        Effect.gen(function* () {
          const turnId = yield* Deferred.await(expectedTurnId);
          const sessions = yield* providerService.listSessions();
          const session = sessions.find((candidate) => candidate.threadId === threadId);
          return (
            session !== undefined &&
            (session.activeTurnId === turnId ||
              (session.status === "running" && session.activeTurnId === undefined))
          );
        }),
      );
      return { event, rawText: yield* Ref.get(rawText) };
    });

  const runParticipant = (input: {
    readonly rootThread: OrchestrationThread;
    readonly cwd: string;
    readonly runId: MagiRunId;
    readonly source: MagiRunSource;
    readonly initiatingInstruction: string;
    readonly objective: string | null;
    readonly config: MagiRunConfig;
    readonly member: ProtocolMember;
    readonly magiTurn: number;
    readonly candidate: MagiCandidate | null;
    readonly recordedActions: ReadonlyArray<MagiRecordedAction>;
    readonly unresolvedDisagreements: ReadonlyArray<string>;
    readonly activities: ReadonlyArray<MagiActivityReference>;
    readonly onStateChange: (state: MagiMemberState) => Effect.Effect<void>;
    readonly priorSettlements: ReadonlyArray<MagiParticipantSettlement>;
    readonly priorArbitration: ProtocolTurn["arbitration"];
    readonly activeProposals: ReadonlyArray<KnownMagiProposal>;
    readonly activeDecisionSets: ReadonlyArray<KnownMagiDecisionSet>;
    readonly terminalProposals: ReadonlyArray<KnownMagiProposal>;
    readonly terminalProposalDigest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
    readonly cancellation: Deferred.Deferred<void>;
  }): Effect.Effect<MagiParticipantSettlement, never> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const providerFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* input.onStateChange("running");
          const prompt = buildMagiParticipantPrompt({
            runId: input.runId,
            source: input.source,
            initiatingInstruction: input.initiatingInstruction,
            objective: input.objective,
            magiTurn: input.magiTurn,
            participant: input.member.participant,
            personality: input.member.personality,
            candidate: input.candidate,
            recordedActions: input.recordedActions,
            unresolvedDisagreements: input.unresolvedDisagreements,
            activities: input.activities,
            priorSettlements: input.priorSettlements,
            priorArbitration: input.priorArbitration,
            activeProposals: input.activeProposals,
            activeDecisionSets: input.activeDecisionSets,
            terminalProposals: input.terminalProposals,
            terminalProposalDigest: input.terminalProposalDigest,
          });
          const compressedPrompt = buildMagiParticipantPrompt({
            runId: input.runId,
            source: input.source,
            initiatingInstruction: input.initiatingInstruction,
            objective: input.objective,
            magiTurn: input.magiTurn,
            participant: input.member.participant,
            personality: input.member.personality,
            candidate: input.candidate,
            recordedActions: input.recordedActions,
            unresolvedDisagreements: input.unresolvedDisagreements,
            activities: input.activities,
            priorSettlements: input.priorSettlements.map((settlement) => ({
              ...settlement,
              rawText:
                settlement.parsed === null
                  ? "[Free-form peer evidence compressed by T3; inspect the durable transcript for the original.]"
                  : settlement.rawText,
            })),
            priorArbitration: input.priorArbitration,
            activeProposals: input.activeProposals,
            activeDecisionSets: input.activeDecisionSets,
            terminalProposals: input.terminalProposals,
            terminalProposalDigest: input.terminalProposalDigest,
          });
          if (
            prompt.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS &&
            compressedPrompt.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
          ) {
            return {
              participantId: input.member.participant.participantId,
              participantThreadId: input.member.threadId,
              participantTurnId: TurnId.make("unstarted"),
              rawText: "",
              parsed: null,
              parseMode: "raw" as const,
              state: "failed" as const,
              durationMs: (yield* Clock.currentTimeMillis) - startedAt,
              inputTokens: null,
              outputTokens: null,
              retryCount: 0,
              providerAttempts: 0,
              structuralRepairCount: 0,
              reconstructed: false,
              failureClass: "context-window-exceeded",
              contextCompressed: true,
            };
          }
          const sessionInput = {
            threadId: input.member.threadId,
            providerInstanceId: input.member.participant.modelSelection.instanceId,
            cwd: input.cwd,
            runtimeMode: input.rootThread.runtimeMode,
            modelSelection: input.member.participant.modelSelection,
            control: {
              executionProfile: "magi-read-only",
            },
          } as const;
          let session = yield* providerService
            .startSession(input.member.threadId, sessionInput)
            .pipe(Effect.option);
          let reconstructed = false;
          if (Option.isNone(session)) {
            session = yield* providerService
              .startSession(input.member.threadId, {
                ...sessionInput,
                // A deliberately non-native cursor bypasses a stale persisted
                // native id. The bounded durable transcript is already in the
                // participant prompt, so the same logical member can continue
                // without changing its provider, model options, personality,
                // weight, or T3 conversation id.
                resumeCursor: { magiReconstruction: true },
              })
              .pipe(Effect.option);
            reconstructed = Option.isSome(session);
          }
          if (Option.isNone(session)) {
            return {
              participantId: input.member.participant.participantId,
              participantThreadId: input.member.threadId,
              participantTurnId: TurnId.make("unstarted"),
              rawText: "",
              parsed: null,
              parseMode: "raw" as const,
              state: "failed" as const,
              durationMs: (yield* Clock.currentTimeMillis) - startedAt,
              inputTokens: null,
              outputTokens: null,
              retryCount: 0,
              providerAttempts: 0,
              structuralRepairCount: 0,
              reconstructed: false,
              failureClass: "session-start-failed",
              contextCompressed: false,
            };
          }
          const capabilities = yield* providerService
            .getCapabilities(input.member.participant.modelSelection.instanceId)
            .pipe(Effect.option);
          let usage = yield* (
            providerService.getContextUsage?.(input.member.threadId) ?? Effect.succeed(null)
          ).pipe(Effect.orElseSucceed(() => null));
          let dispatchPrompt = prompt;
          const promptTokens = (value: string) => Math.ceil(value.length / 4);
          const capacity = yield* resolveMagiPromptCapacity({
            usage,
            fullPromptTokens: promptTokens(prompt),
            compressedPromptTokens: promptTokens(compressedPrompt),
            historyCompaction: Option.getOrNull(capabilities)?.magi?.historyCompaction,
            compact:
              providerService.compactSession === undefined
                ? Effect.succeed(false)
                : providerService.compactSession(input.member.threadId).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  ),
            readUsage: (
              providerService.getContextUsage?.(input.member.threadId) ?? Effect.succeed(null)
            ).pipe(Effect.orElseSucceed(() => null)),
          });
          usage = capacity.usage;
          if (
            capacity.dispatchPrompt === "compressed" ||
            prompt.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
          ) {
            dispatchPrompt = compressedPrompt;
          }
          const contextCompressed =
            capacity.contextCompressed || dispatchPrompt === compressedPrompt;
          if (capacity.exceeded) {
            return {
              participantId: input.member.participant.participantId,
              participantThreadId: input.member.threadId,
              participantTurnId: TurnId.make("unstarted"),
              rawText: "",
              parsed: null,
              parseMode: "raw" as const,
              state: "failed" as const,
              durationMs: (yield* Clock.currentTimeMillis) - startedAt,
              inputTokens: usage?.usedTokens ?? null,
              outputTokens: null,
              retryCount: 0,
              providerAttempts: 0,
              structuralRepairCount: 0,
              reconstructed,
              failureClass: "context-window-exceeded",
              contextCompressed,
            };
          }
          let providerAttempts = 0;
          const participantTurnIdempotencyKey = magiParticipantTurnIdempotencyKey({
            runId: input.runId,
            magiTurn: input.magiTurn,
            participantId: input.member.participant.participantId,
            stage: "turn",
          });
          const dispatch = (attemptPrompt: string, idempotencyKey: string) =>
            Effect.gen(function* () {
              providerAttempts += 1;
              const expectedTurnId = yield* Deferred.make<TurnId>();
              const ready = yield* Deferred.make<void>();
              const waiter = yield* Effect.forkScoped(
                waitForParticipantTurn(input.member.threadId, expectedTurnId, ready),
              );
              yield* Deferred.await(ready);
              const turn = yield* providerService
                .sendTurn({
                  threadId: input.member.threadId,
                  input: attemptPrompt,
                  interactionMode: "default",
                  modelSelection: input.member.participant.modelSelection,
                  control: {
                    executionProfile: "magi-read-only",
                    outputSchema: MAGI_PARTICIPANT_OUTPUT_SCHEMA,
                    idempotencyKey,
                  },
                })
                .pipe(Effect.option);
              if (Option.isNone(turn)) {
                yield* Fiber.interrupt(waiter);
                return Option.none<{
                  readonly turnId: TurnId;
                  readonly result: {
                    readonly event: ProviderRuntimeEvent | null;
                    readonly rawText: string;
                  };
                }>();
              }
              yield* Deferred.succeed(expectedTurnId, turn.value.turnId);
              return Option.some({
                turnId: turn.value.turnId,
                result: yield* Fiber.join(waiter),
              });
            });
          let attempt = yield* dispatch(dispatchPrompt, participantTurnIdempotencyKey);
          let retryCount = 0;
          let structuralRepairCount = 0;
          const transientFailure = () =>
            Option.isNone(attempt) ||
            attempt.value.result.event === null ||
            attempt.value.result.event?.type === "runtime.error" ||
            attempt.value.result.event?.type === "turn.aborted";
          if (transientFailure()) {
            retryCount = 1;
            attempt = yield* dispatch(dispatchPrompt, participantTurnIdempotencyKey);
          }
          if (Option.isNone(attempt)) {
            return {
              participantId: input.member.participant.participantId,
              participantThreadId: input.member.threadId,
              participantTurnId: TurnId.make("unstarted"),
              rawText: "",
              parsed: null,
              parseMode: "raw" as const,
              state: "failed" as const,
              durationMs: (yield* Clock.currentTimeMillis) - startedAt,
              inputTokens: null,
              outputTokens: null,
              retryCount,
              providerAttempts,
              structuralRepairCount,
              reconstructed,
              failureClass: "turn-start-failed",
              contextCompressed: false,
            };
          }
          let result = attempt.value.result;
          let participantTurnId = attempt.value.turnId;
          let parsed = parseMagiParticipantResponse(result.rawText);
          if (
            result.event?.type === "turn.completed" &&
            result.event.payload.state === "completed" &&
            parsed.parsed === null
          ) {
            retryCount += 1;
            structuralRepairCount = 1;
            const repaired = yield* dispatch(
              `Your last Magi response could not be decoded with the required schema. Preserve its substantive assessment and return only one JSON object matching this schema:\n${encodeUnknownJson(MAGI_PARTICIPANT_OUTPUT_SCHEMA)}\n\nYour preceding response:\n${result.rawText.slice(0, 24_000)}`,
              magiParticipantTurnIdempotencyKey({
                runId: input.runId,
                magiTurn: input.magiTurn,
                participantId: input.member.participant.participantId,
                stage: "repair",
              }),
            );
            if (Option.isSome(repaired)) {
              result = repaired.value.result;
              participantTurnId = repaired.value.turnId;
              parsed = parseMagiParticipantResponse(result.rawText);
            }
          }
          const completed =
            result.event?.type === "turn.completed" && result.event.payload.state === "completed";
          const finalUsage = yield* (
            providerService.getContextUsage?.(input.member.threadId) ?? Effect.succeed(null)
          ).pipe(Effect.orElseSucceed(() => null));
          const state: MagiParticipantSettlement["state"] = completed ? "settled" : "failed";
          return {
            participantId: input.member.participant.participantId,
            participantThreadId: input.member.threadId,
            participantTurnId,
            rawText: result.rawText,
            parsed: parsed.parsed,
            parseMode: parsed.parseMode,
            state,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
            inputTokens: finalUsage?.usedTokens ?? null,
            outputTokens: null,
            retryCount,
            providerAttempts,
            structuralRepairCount,
            reconstructed,
            failureClass: completed
              ? null
              : result.event === null
                ? "turn-event-timeout"
                : "provider-failure",
            contextCompressed,
          } satisfies MagiParticipantSettlement;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("Magi participant failed unexpectedly", cause);
              const failedAt = yield* Clock.currentTimeMillis;
              return {
                participantId: input.member.participant.participantId,
                participantThreadId: input.member.threadId,
                participantTurnId: TurnId.make("failed"),
                rawText: "",
                parsed: null,
                parseMode: "raw" as const,
                state: "failed" as const,
                durationMs: failedAt - startedAt,
                inputTokens: null,
                outputTokens: null,
                retryCount: 0,
                providerAttempts: 0,
                structuralRepairCount: 0,
                reconstructed: false,
                failureClass: "unexpected",
                contextCompressed: false,
              };
            }),
          ),
        ),
      ).pipe(Effect.forkDetach);
      return yield* Effect.raceFirst(
        Fiber.join(providerFiber),
        Effect.gen(function* () {
          yield* Deferred.await(input.cancellation);
          yield* Fiber.interrupt(providerFiber).pipe(Effect.forkDetach);
          return cancelledMagiParticipantSettlement({
            participantId: input.member.participant.participantId,
            participantThreadId: input.member.threadId,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          });
        }),
      );
    });

  const persist = (run: PersistedMagiRun) =>
    repository.putRun(run).pipe(
      Effect.catch((error) => {
        if (!isDeletedRootMagiPersistenceError(error)) return Effect.die(error);
        return Effect.gen(function* () {
          const cancellation = yield* getRunCancellation(run.detail.summary.runId);
          yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
          const stopped = yield* Effect.forEach(
            asProtocol(run.protocol).members,
            (member) =>
              providerService.stopSession({ threadId: member.threadId }).pipe(
                Effect.as(true),
                Effect.catch((stopError) =>
                  Effect.logError("Failed to stop deleted-root Magi participant session.", {
                    runId: run.detail.summary.runId,
                    participantThreadId: member.threadId,
                    error: stopError,
                  }).pipe(Effect.as(false)),
                ),
              ),
            { concurrency: MAGI_PARTICIPANT_TURN_CONCURRENCY },
          ).pipe(Effect.map((results) => results.every(Boolean)));
          if (stopped) yield* clearRunCancellation(run.detail.summary.runId);
          return yield* validation("invalid-protocol-state", deletedRootMagiValidationMessage);
        });
      }),
    );

  const cleanupTerminalRun = (run: PersistedMagiRun) =>
    runMagiTerminalCleanup({
      markPending: repository.getRun(run.detail.summary.runId).pipe(
        Effect.orDie,
        Effect.flatMap((latest) =>
          Option.isNone(latest)
            ? Effect.void
            : repository
                .putRun({
                  ...latest.value,
                  protocol: {
                    ...asProtocol(latest.value.protocol),
                    cleanupPending: true,
                  } satisfies MagiProtocolState,
                })
                .pipe(Effect.orDie),
        ),
      ),
      stopParticipants: Effect.forEach(
        asProtocol(run.protocol).members,
        (member) =>
          providerService.stopSession({ threadId: member.threadId }).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logError("Failed to stop terminal Magi participant session.", {
                runId: run.detail.summary.runId,
                participantThreadId: member.threadId,
                error,
              }).pipe(Effect.as(false)),
            ),
          ),
        { concurrency: MAGI_PARTICIPANT_TURN_CONCURRENCY },
      ).pipe(Effect.map((results) => results.every(Boolean))),
      clearCancellation: clearRunCancellation(run.detail.summary.runId),
      markComplete: repository.getRun(run.detail.summary.runId).pipe(
        Effect.orDie,
        Effect.flatMap((latest) =>
          Option.isNone(latest)
            ? Effect.void
            : repository
                .putRun({
                  ...latest.value,
                  protocol: {
                    ...asProtocol(latest.value.protocol),
                    cleanupPending: false,
                  } satisfies MagiProtocolState,
                })
                .pipe(Effect.orDie),
        ),
      ),
    });

  const runDeliberation = (initialRun: PersistedMagiRun, request: MagiDeliberateInput) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "magi.run_id": initialRun.detail.summary.runId,
        "magi.root_thread_id": initialRun.detail.summary.rootThreadId,
      });
      const cancellation = yield* getRunCancellation(initialRun.detail.summary.runId);
      const stoppedResult = (
        stoppedRun: PersistedMagiRun,
        cancellationRequested: boolean,
      ): MagiDeliberationResult => {
        const stoppedProtocol = asProtocol(stoppedRun.protocol);
        const stoppedCandidate = stoppedProtocol.turns.at(-1)?.arbitration?.candidate ?? null;
        const threshold = calculateMagiThreshold(
          stoppedRun.detail.config.participants,
          stoppedRun.detail.config.consensusThresholdPercent,
        );
        const state = stoppedRun.detail.summary.state;
        const instruction =
          cancellationRequested || state === "cancelled"
            ? "The user cancelled this Magi run. Acknowledge the cancellation and finish the main turn. Do not deliberate, retry, or arbitrate it again."
            : `This Magi run ended with state ${state}. Report that terminal state and make no further Magi calls for this run.`;
        return {
          runId: stoppedRun.detail.summary.runId,
          magiTurn: stoppedProtocol.turns.length + 1,
          candidateFingerprint:
            stoppedCandidate === null
              ? null
              : magiCandidateFingerprint(stoppedCandidate, stoppedProtocol.actions),
          participants: [],
          totalWeight: threshold.totalWeight,
          requiredWeight: threshold.requiredWeight,
          thresholdReachable: false,
          pendingProposalIds: [],
          controlInstructions: `${MAGI_ARBITRATOR_RESULT_PROTOCOL}\n\n${instruction}`,
        };
      };
      const latestBeforeWork = yield* repository
        .getRun(initialRun.detail.summary.runId)
        .pipe(Effect.orDie);
      const cancellationBeforeWork = Option.isSome(yield* Deferred.poll(cancellation));
      if (Option.isNone(latestBeforeWork)) {
        yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
        return yield* validation("invalid-protocol-state", deletedRootMagiValidationMessage);
      }
      const stateBeforeWork = Option.match(latestBeforeWork, {
        onNone: () => null,
        onSome: (latest) => latest.detail.summary.state,
      });
      if (!shouldPersistMagiDeliberationContext(stateBeforeWork, cancellationBeforeWork)) {
        yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
        return stoppedResult(latestBeforeWork.value, cancellationBeforeWork);
      }
      const runBeforeWork = Option.getOrThrow(latestBeforeWork);
      const protocolBeforeWork = asProtocol(runBeforeWork.protocol);
      const root = yield* resolveConversationContext(runBeforeWork.detail.summary.rootThreadId);
      const magiTurn = protocolBeforeWork.turns.length + 1;
      const activities =
        protocolBeforeWork.pendingContextArtifacts.length > 0
          ? protocolBeforeWork.pendingContextArtifacts
          : yield* resolveMagiContextActivities({
              thread: root.thread,
              activityIds: request.contextActivityIds,
              runId: runBeforeWork.detail.summary.runId,
              magiTurn,
            });
      const latestBeforePersist = yield* repository
        .getRun(runBeforeWork.detail.summary.runId)
        .pipe(Effect.orDie);
      const cancellationBeforePersist = Option.isSome(yield* Deferred.poll(cancellation));
      if (Option.isNone(latestBeforePersist)) {
        yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
        return yield* validation("invalid-protocol-state", deletedRootMagiValidationMessage);
      }
      const stateBeforePersist = Option.match(latestBeforePersist, {
        onNone: () => null,
        onSome: (latest) => latest.detail.summary.state,
      });
      if (!shouldPersistMagiDeliberationContext(stateBeforePersist, cancellationBeforePersist)) {
        yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
        return stoppedResult(latestBeforePersist.value, cancellationBeforePersist);
      }
      const run = Option.getOrThrow(latestBeforePersist);
      const protocol = asProtocol(run.protocol);
      const priorTurn = protocol.turns.at(-1);
      const candidate = priorTurn?.arbitration?.candidate ?? null;
      const unresolvedDisagreements = priorTurn?.arbitration?.disagreements ?? [];
      const recordedActions = protocol.actions;
      const updatedAt = yield* nowIso;
      yield* persist({
        ...run,
        protocol: {
          ...protocol,
          pendingContextArtifacts: activities,
        } satisfies MagiProtocolState,
        updatedAt,
      });
      const progressMutex = yield* Semaphore.make(1);
      const publishMemberState = (
        participantId: MagiParticipantDraft["participantId"] | null,
        state: MagiMemberState,
      ) =>
        progressMutex.withPermits(1)(
          Effect.gen(function* () {
            const latest = yield* repository.getRun(run.detail.summary.runId).pipe(Effect.orDie);
            if (Option.isNone(latest) || isMagiRunTerminal(latest.value.detail.summary.state))
              return;
            const latestProtocol = asProtocol(latest.value.protocol);
            const updateState = <
              T extends {
                readonly participantId: MagiParticipantDraft["participantId"];
                readonly state: MagiMemberState;
              },
            >(
              member: T,
            ): T =>
              participantId === null || member.participantId === participantId
                ? { ...member, state }
                : member;
            const updatedAt = yield* nowIso;
            yield* persist({
              ...latest.value,
              detail: {
                ...latest.value.detail,
                summary: { ...latest.value.detail.summary, state: "deliberating" },
                activity: {
                  ...latest.value.detail.activity,
                  state: "deliberating",
                },
                participants: latest.value.detail.participants.map(updateState),
              },
              protocol: {
                ...latestProtocol,
                members: latestProtocol.members.map((member) => ({
                  ...member,
                  state:
                    participantId === null || member.participant.participantId === participantId
                      ? state
                      : member.state,
                })),
              } satisfies MagiProtocolState,
              updatedAt,
            });
          }),
        );
      yield* publishMemberState(null, "pending");
      const currentActiveProposals = activeMagiProposals(protocol.proposals);
      const currentActiveDecisionSets = activeMagiDecisionSets(protocol.decisionSets);
      const settlements = yield* Effect.forEach(
        protocol.members,
        (member) =>
          runParticipant({
            rootThread: root.thread,
            cwd: root.cwd,
            runId: run.detail.summary.runId,
            source: run.detail.summary.source,
            initiatingInstruction: run.initiatingInstruction,
            objective: run.focusedObjective,
            config: run.detail.config,
            member,
            magiTurn,
            candidate,
            recordedActions,
            unresolvedDisagreements,
            activities,
            onStateChange: (state) =>
              publishMemberState(member.participant.participantId, state).pipe(Effect.ignore),
            priorSettlements: priorTurn?.settlements ?? [],
            priorArbitration: priorTurn?.arbitration ?? null,
            activeProposals: currentActiveProposals,
            activeDecisionSets: currentActiveDecisionSets,
            terminalProposals: terminalMagiProposals(protocol.proposals),
            terminalProposalDigest: protocol.terminalProposalDigest,
            cancellation,
          })
            .pipe(
              Effect.withSpan("magi.participant", {
                attributes: {
                  "magi.run_id": run.detail.summary.runId,
                  "magi.participant_id": member.participant.participantId,
                  "provider.instance_id": member.participant.modelSelection.instanceId,
                },
              }),
            )
            .pipe(
              Effect.tap((settlement) =>
                publishMemberState(settlement.participantId, settlement.state),
              ),
            ),
        { concurrency: MAGI_PARTICIPANT_TURN_CONCURRENCY },
      );
      const totalWeight = calculateMagiThreshold(
        run.detail.config.participants,
        run.detail.config.consensusThresholdPercent,
      );
      const candidateFingerprint =
        candidate === null ? null : magiCandidateFingerprint(candidate, recordedActions);
      const latestAfterParticipants = yield* repository
        .getRun(run.detail.summary.runId)
        .pipe(Effect.orDie);
      const cancellationRequested = Option.isSome(yield* Deferred.poll(cancellation));
      if (
        cancellationRequested ||
        (Option.isSome(latestAfterParticipants) &&
          isMagiRunTerminal(latestAfterParticipants.value.detail.summary.state))
      ) {
        return {
          runId: run.detail.summary.runId,
          magiTurn,
          candidateFingerprint,
          participants: projectMagiParticipantEvidenceList(settlements),
          totalWeight: totalWeight.totalWeight,
          requiredWeight: totalWeight.requiredWeight,
          thresholdReachable: false,
          pendingProposalIds: [],
          controlInstructions: `${MAGI_ARBITRATOR_RESULT_PROTOCOL}\n\n${
            cancellationRequested ||
            (Option.isSome(latestAfterParticipants) &&
              latestAfterParticipants.value.detail.summary.state === "cancelled")
              ? "The user cancelled this Magi run. Acknowledge the cancellation and finish the main turn. Do not deliberate, retry, or arbitrate it again."
              : `This Magi run ended with state ${Option.getOrThrow(latestAfterParticipants).detail.summary.state}. Report that terminal state and make no further Magi calls for this run.`
          }`,
        } satisfies MagiDeliberationResult;
      }
      const proposals = collectMagiProposals(
        run.detail.summary.runId,
        magiTurn,
        settlements,
        protocol.proposals,
      );
      const proposalOutcomes = calculateMagiProposalOutcomes({
        magiTurn,
        proposals,
        participants: run.detail.config.participants,
        settlements,
        requiredWeight: totalWeight.requiredWeight,
      });
      const members = protocol.members.map((member) => ({
        ...member,
        state: latestMagiMemberState(member.participant.participantId, member.state, settlements),
      }));
      const nextProtocol: MagiProtocolState = {
        ...protocol,
        pendingContextArtifacts: [],
        members,
        proposals,
        turns: [
          ...protocol.turns,
          {
            magiTurn,
            candidate,
            settlements,
            arbitration: null,
            activities,
          },
        ],
      };
      const completedAt = yield* nowIso;
      const latestRun = Option.getOrElse(
        yield* repository.getRun(run.detail.summary.runId).pipe(Effect.orDie),
        () => run,
      );
      const detail: MagiRunDetail = {
        ...latestRun.detail,
        summary: {
          ...latestRun.detail.summary,
          state: "awaiting-arbitration",
          completedMagiTurns: magiTurn,
        },
        activity: calculateMagiActivityMetrics({
          runId: run.detail.summary.runId,
          source: run.detail.summary.source,
          state: "awaiting-arbitration",
          completedMagiTurns: magiTurn,
          magiTurnLimit: run.detail.config.magiTurnLimit,
          totalWeight: totalWeight.totalWeight,
          requiredWeight: totalWeight.requiredWeight,
          comparableOutcomes: pendingMagiComparableOutcomes(latestRun.detail.activity),
        }),
        settlements: [...latestRun.detail.settlements, ...settlements],
        participants: latestRun.detail.participants.map((participant) => ({
          ...participant,
          state: latestMagiMemberState(participant.participantId, participant.state, settlements),
        })),
        candidate,
        actions: recordedActions,
      };
      const next = {
        ...latestRun,
        detail,
        protocol: nextProtocol,
        updatedAt: completedAt,
      } satisfies PersistedMagiRun;
      yield* persist(next);
      yield* increment(magiTurnsTotal, { source: run.detail.summary.source });
      yield* Effect.forEach(settlements, (settlement) =>
        Effect.all(
          [
            increment(magiParticipantTurnsTotal, {
              state: settlement.state,
              parseMode: settlement.parseMode,
              failureClass: settlement.failureClass,
              retryCount: settlement.retryCount,
              contextCompressed: settlement.contextCompressed,
            }),
            Metric.update(
              Metric.withAttributes(
                magiParticipantTurnDuration,
                metricAttributes({ state: settlement.state }),
              ),
              Duration.millis(settlement.durationMs),
            ),
            settlement.inputTokens === null
              ? Effect.void
              : increment(
                  magiParticipantTokensTotal,
                  { direction: "input" },
                  settlement.inputTokens,
                ),
            settlement.outputTokens === null
              ? Effect.void
              : increment(
                  magiParticipantTokensTotal,
                  { direction: "output" },
                  settlement.outputTokens,
                ),
          ],
          { discard: true },
        ),
      );
      return {
        runId: run.detail.summary.runId,
        magiTurn,
        candidateFingerprint,
        participants: projectMagiParticipantEvidenceList(settlements),
        totalWeight: totalWeight.totalWeight,
        requiredWeight: totalWeight.requiredWeight,
        thresholdReachable:
          settlements
            .filter((settlement) => settlement.state === "settled")
            .reduce(
              (weight, settlement) =>
                weight +
                (run.detail.config.participants.find(
                  (participant) => participant.participantId === settlement.participantId,
                )?.weight ?? 0),
              0,
            ) >= totalWeight.requiredWeight,
        pendingProposalIds: proposalOutcomes
          .filter((outcome) => outcome.pending)
          .map((outcome) => outcome.proposalId),
        controlInstructions: arbitratorResultInstructions(run),
      } satisfies MagiDeliberationResult;
    });

  const createMembers = (
    root: OrchestrationThread,
    runId: MagiRunId,
    members: ReadonlyArray<ProtocolMember>,
    createdAt: string,
  ) =>
    Effect.forEach(
      members,
      (member) =>
        Effect.gen(function* () {
          yield* orchestration
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              threadId: member.threadId,
              projectId: root.projectId,
              title: `Magi: ${member.participant.participantId}`,
              modelSelection: member.participant.modelSelection,
              runtimeMode: root.runtimeMode,
              interactionMode: "default",
              branch: root.branch,
              worktreePath: root.worktreePath,
              parentRelation: {
                kind: "magi",
                rootThreadId: root.id,
                parentThreadId: root.id,
                runId,
                participantId: member.participant.participantId,
                providerThreadId: member.threadId,
                depth: 1,
                startedAt: createdAt,
                completedAt: null,
                status: "running",
              },
              createdAt,
            })
            .pipe(Effect.orDie);
        }),
      { concurrency: 1, discard: true },
    );

  const deletePlannedMembers = (members: ReadonlyArray<ProtocolMember>) =>
    Effect.forEach(
      members,
      (member) =>
        Effect.gen(function* () {
          yield* orchestration
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              threadId: member.threadId,
            })
            .pipe(Effect.ignore);
        }),
      { concurrency: 1, discard: true },
    );

  const startRun = (input: {
    readonly rootThreadId: ThreadId;
    readonly config: MagiRunConfig;
    readonly source: MagiRunSource;
    readonly objective: string;
    readonly initiatingReferenceId: string | null;
    readonly initiatingInstruction: string;
    readonly contextActivityIds: ReadonlyArray<EventId>;
  }) =>
    Effect.gen(function* () {
      const issues = validateMagiRoster(input.config);
      if (issues[0]) return yield* validation("invalid-config", issues[0].message, "config");
      if (Option.isSome(yield* repository.findActiveRun(input.rootThreadId).pipe(Effect.orDie))) {
        return yield* validation("magi-run-active", "This thread already has an active Magi run.");
      }
      yield* validateParticipantAvailability(input.config.participants);
      const root = yield* resolveConversationContext(input.rootThreadId);
      const settings = yield* readSettings;
      const runId = MagiRunId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const activities = yield* resolveMagiContextActivities({
        thread: root.thread,
        activityIds: input.contextActivityIds,
        runId,
        magiTurn: 1,
      });
      const startedAt = yield* nowIso;
      const members = yield* Effect.forEach(input.config.participants, (participant) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          return {
            participant,
            personality:
              settings.personalities.find(
                (personality) => personality.id === participant.personalityId,
              ) ?? null,
            threadId,
            state: "pending" as const,
          } satisfies ProtocolMember;
        }),
      );
      const threshold = calculateMagiThreshold(
        input.config.participants,
        input.config.consensusThresholdPercent,
      );
      const initializing: PersistedMagiRun = {
        detail: {
          summary: {
            runId,
            rootThreadId: input.rootThreadId,
            source: input.source,
            title: pendingMagiRunTitle(),
            state: "initializing",
            objective: input.objective,
            completedMagiTurns: 0,
            startedAt,
            completedAt: null,
          },
          config: input.config,
          totalWeight: threshold.totalWeight,
          requiredWeight: threshold.requiredWeight,
          activity: calculateMagiActivityMetrics({
            runId,
            source: input.source,
            state: "initializing",
            completedMagiTurns: 0,
            magiTurnLimit: input.config.magiTurnLimit,
            totalWeight: threshold.totalWeight,
            requiredWeight: threshold.requiredWeight,
            comparableOutcomes: [],
          }),
          participants: members.map((member) => ({
            participantId: member.participant.participantId,
            modelSelection: member.participant.modelSelection,
            personality: member.personality,
            weight: member.participant.weight,
            state: member.state,
            childThreadId: member.threadId,
          })),
          settlements: [],
          candidate: null,
          actions: [],
          issuedActionBatch: null,
        },
        initiatingReferenceId: input.initiatingReferenceId,
        initiatingInstruction: input.initiatingInstruction,
        focusedObjective: input.objective,
        arbitratorPrompt: settings.arbitratorPrompt,
        protocol: {
          members,
          turns: [],
          pendingContextArtifacts: activities,
          proposals: [],
          terminalProposalDigest: [],
          decisionSets: [],
          actions: [],
          reconciliations: [],
          stateBeforePause: null,
          cleanupPending: false,
          pendingBatch: null,
        } satisfies MagiProtocolState,
        updatedAt: startedAt,
        mainTurnId: root.thread.latestTurn?.turnId ?? null,
        mainMessageId: root.thread.latestTurn?.assistantMessageId ?? null,
      };
      yield* persist(initializing);
      yield* createMembers(root.thread, runId, members, startedAt).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const failedAt = yield* nowIso;
            const failed: PersistedMagiRun = {
              ...initializing,
              updatedAt: failedAt,
              detail: {
                ...initializing.detail,
                summary: {
                  ...initializing.detail.summary,
                  state: "failed",
                  completedAt: failedAt,
                },
                activity: { ...initializing.detail.activity, state: "failed" },
              },
            };
            yield* runMagiInitializationCompensation({
              deletePlannedMembers: deletePlannedMembers(members),
              persistFailedRun: persist(failed).pipe(Effect.ignore),
              cleanupTerminalRun: cleanupTerminalRun(failed),
            });
            return yield* validation(
              "invalid-protocol-state",
              "Magi participant initialization failed and was compensated.",
            );
          }),
        ),
      );
      const detail: MagiRunDetail = {
        summary: {
          runId,
          rootThreadId: input.rootThreadId,
          source: input.source,
          title: pendingMagiRunTitle(),
          state: "deliberating",
          objective: input.objective,
          completedMagiTurns: 0,
          startedAt,
          completedAt: null,
        },
        config: input.config,
        totalWeight: threshold.totalWeight,
        requiredWeight: threshold.requiredWeight,
        activity: calculateMagiActivityMetrics({
          runId,
          source: input.source,
          state: "deliberating",
          completedMagiTurns: 0,
          magiTurnLimit: input.config.magiTurnLimit,
          totalWeight: threshold.totalWeight,
          requiredWeight: threshold.requiredWeight,
          comparableOutcomes: [],
        }),
        participants: members.map((member) => ({
          participantId: member.participant.participantId,
          modelSelection: member.participant.modelSelection,
          personality: member.personality,
          weight: member.participant.weight,
          state: member.state,
          childThreadId: member.threadId,
        })),
        settlements: [],
        candidate: null,
        actions: [],
        issuedActionBatch: null,
      };
      const persisted: PersistedMagiRun = {
        detail,
        initiatingReferenceId: input.initiatingReferenceId,
        initiatingInstruction: input.initiatingInstruction,
        focusedObjective: input.objective,
        arbitratorPrompt: settings.arbitratorPrompt,
        protocol: {
          members,
          turns: [],
          pendingContextArtifacts: activities,
          proposals: [],
          terminalProposalDigest: [],
          decisionSets: [],
          actions: [],
          reconciliations: [],
          stateBeforePause: null,
          cleanupPending: false,
          pendingBatch: null,
        } satisfies MagiProtocolState,
        updatedAt: startedAt,
        mainTurnId: root.thread.latestTurn?.turnId ?? null,
        mainMessageId: root.thread.latestTurn?.assistantMessageId ?? null,
      };
      yield* persist(persisted);
      yield* increment(magiRunsTotal, { source: input.source, phase: "started" });
      yield* repository.deleteArm(input.rootThreadId).pipe(Effect.orDie);
      const titleEffect =
        textGeneration.generateMagiRunTitle === undefined
          ? textGeneration.generateThreadTitle({
              cwd: root.cwd,
              message: input.initiatingInstruction,
              modelSelection: root.thread.modelSelection,
            })
          : textGeneration.generateMagiRunTitle({
              cwd: root.cwd,
              initiatingInstruction: input.initiatingInstruction,
              objective: input.objective,
              modelSelection: root.thread.modelSelection,
            });
      yield* titleEffect.pipe(
        Effect.flatMap((generated) =>
          withRunLock(
            runId,
            repository.getRun(runId).pipe(
              Effect.orDie,
              Effect.flatMap((latest) =>
                Option.isSome(latest)
                  ? persist({
                      ...latest.value,
                      detail: {
                        ...latest.value.detail,
                        summary: {
                          ...latest.value.detail.summary,
                          title: { state: "generated", title: generated.title },
                        },
                      },
                    })
                  : Effect.void,
              ),
            ),
          ),
        ),
        Effect.catch((_cause) =>
          withRunLock(
            runId,
            repository.getRun(runId).pipe(
              Effect.orDie,
              Effect.flatMap((latest) =>
                Option.isSome(latest)
                  ? persist({
                      ...latest.value,
                      detail: {
                        ...latest.value.detail,
                        summary: {
                          ...latest.value.detail.summary,
                          title: failedMagiRunTitle(),
                        },
                      },
                    })
                  : Effect.void,
              ),
            ),
          ),
        ),
        Effect.forkDetach,
      );
      return yield* withRunLock(
        runId,
        runDeliberation(persisted, {
          runId,
          contextActivityIds: input.contextActivityIds,
        }).pipe(
          Effect.withSpan("magi.turn", {
            attributes: { "magi.run_id": runId, "magi.turn": 1 },
          }),
        ),
      );
    });

  const startFromTool = (
    threadId: ThreadId,
    input: MagiStartInput,
    initiatingReferenceId: string,
  ) =>
    withStartLock(
      threadId,
      Effect.gen(function* () {
        const requestedConfig = normalizeMagiStartConfig(input.config);
        const root = yield* resolveConversationContext(threadId);
        const turnScopedReference = `${initiatingReferenceId}:${threadId}:${root.thread.latestTurn?.turnId ?? "no-turn"}`;
        const arm = yield* repository.getArm(threadId).pipe(Effect.orDie);
        const existingByReference = yield* repository
          .findRunByInitiatingReferenceId(turnScopedReference)
          .pipe(Effect.orDie);
        const existing = Option.isSome(existingByReference)
          ? existingByReference
          : yield* repository.findActiveRun(threadId).pipe(Effect.orDie);
        if (Option.isSome(existing)) {
          const protocol = asProtocol(existing.value.protocol);
          const latest = protocol.turns.at(-1);
          if (
            latest &&
            existing.value.focusedObjective === input.objective &&
            encodeRunConfig(normalizeMagiStartConfig(existing.value.detail.config)) ===
              encodeRunConfig(requestedConfig)
          ) {
            const threshold = calculateMagiThreshold(
              existing.value.detail.config.participants,
              existing.value.detail.config.consensusThresholdPercent,
            );
            const pendingProposalIds = calculateMagiProposalOutcomes({
              magiTurn: latest.magiTurn,
              proposals: protocol.proposals,
              participants: existing.value.detail.config.participants,
              settlements: latest.settlements,
              requiredWeight: threshold.requiredWeight,
            })
              .filter((outcome) => outcome.pending)
              .map((outcome) => outcome.proposalId);
            return {
              runId: existing.value.detail.summary.runId,
              magiTurn: latest.magiTurn,
              candidateFingerprint:
                latest.candidate === null
                  ? null
                  : magiCandidateFingerprint(latest.candidate, protocol.actions),
              participants: projectMagiParticipantEvidenceList(latest.settlements),
              totalWeight: threshold.totalWeight,
              requiredWeight: threshold.requiredWeight,
              thresholdReachable:
                latest.settlements
                  .filter((settlement) => settlement.state === "settled")
                  .reduce(
                    (weight, settlement) =>
                      weight +
                      (existing.value.detail.config.participants.find(
                        (participant) => participant.participantId === settlement.participantId,
                      )?.weight ?? 0),
                    0,
                  ) >= threshold.requiredWeight,
              pendingProposalIds,
              controlInstructions: arbitratorResultInstructions(existing.value),
            } satisfies MagiStartResult;
          }
        }
        const startSnapshot = resolveMagiStartSnapshot({
          arm: Option.getOrNull(arm),
          requestedConfig,
          toolCallId: turnScopedReference,
        });
        return yield* startRun({
          rootThreadId: threadId,
          config: startSnapshot.config,
          source: startSnapshot.source,
          objective: input.objective,
          initiatingReferenceId: startSnapshot.initiatingReferenceId,
          initiatingInstruction: latestUserInstruction(root.thread) ?? input.objective,
          contextActivityIds: input.contextActivityIds,
        });
      }),
    );

  const requireRun = (runId: MagiRunId, threadId?: ThreadId) =>
    repository.getRun(runId).pipe(
      Effect.orDie,
      Effect.flatMap((run) =>
        Option.isSome(run)
          ? Effect.succeed(run.value)
          : Effect.fail(validation("magi-run-not-active", "The Magi run does not exist.")),
      ),
      Effect.filterOrFail(
        (run) => threadId === undefined || run.detail.summary.rootThreadId === threadId,
        () => validation("foreign-turn", "The active main turn does not own this Magi run."),
      ),
    );

  const deliberate = (threadId: ThreadId, input: MagiDeliberateInput) =>
    withRunLock(
      input.runId,
      Effect.gen(function* () {
        const run = yield* requireRun(input.runId, threadId);
        if (run.detail.summary.state !== "awaiting-next-turn")
          return yield* validation(
            "invalid-protocol-state",
            "Magi is not awaiting another deliberation.",
          );
        yield* validateParticipantAvailability(run.detail.config.participants);
        return yield* runDeliberation(run, input);
      }),
    );

  const recordArbitration = (threadId: ThreadId, input: MagiRecordArbitrationInput) =>
    withRunLock(
      input.runId,
      Effect.gen(function* () {
        const run = yield* requireRun(input.runId, threadId);
        if (run.detail.summary.state !== "awaiting-arbitration")
          return yield* validation("invalid-protocol-state", "Magi is not awaiting arbitration.");
        const protocol = asProtocol(run.protocol);
        const turn = protocol.turns.at(-1);
        if (!turn || turn.magiTurn !== input.magiTurn)
          return yield* validation(
            "foreign-turn",
            "The arbitration does not match the active Magi turn.",
          );
        const weights = new Map(
          run.detail.config.participants.map((participant) => [
            participant.participantId,
            participant.weight,
          ]),
        );
        const configuredIds = new Set(
          run.detail.config.participants.map((participant) => participant.participantId),
        );
        const assessmentIds = input.record.assessments.map(
          (assessment) => assessment.participantId,
        );
        if (
          new Set(assessmentIds).size !== assessmentIds.length ||
          assessmentIds.length !== configuredIds.size ||
          assessmentIds.some((participantId) => !configuredIds.has(participantId))
        ) {
          return yield* validation(
            "invalid-protocol-state",
            "Arbitration must classify every configured participant exactly once.",
            "record.assessments",
          );
        }
        const threshold = calculateMagiThreshold(
          run.detail.config.participants,
          run.detail.config.consensusThresholdPercent,
        );
        const { terminalProposalDigestUpdates, ...arbitrationRecord } = input.record;
        const candidateChanged =
          turn.candidate !== null &&
          isMaterialMagiCandidateChange(turn.candidate, arbitrationRecord.candidate);
        const assessments = normalizeMagiArbitrationAssessments({
          participants: run.detail.config.participants,
          settlements: turn.settlements,
          recordedAssessments: input.record.assessments,
          candidateChanged,
        });
        const totals = currentMagiTurnVoteTotals(assessments, weights);
        const completedMagiTurns = completedMagiTurnsAfterArbitration(
          run.detail.summary.completedMagiTurns,
          input.magiTurn,
        );
        const proposalIds = new Set(protocol.proposals.map((proposal) => proposal.proposalId));
        const dispositions = input.record.proposalDispositions;
        if (
          new Set(dispositions.map((item) => item.proposalId)).size !== dispositions.length ||
          dispositions.some((item) => !proposalIds.has(item.proposalId))
        ) {
          return yield* validation(
            "invalid-protocol-state",
            "Proposal dispositions must use unique proposal ids from this run.",
            "record.proposalDispositions",
          );
        }
        const declaredDecisionSetIds = new Set<string>();
        const assignedExclusiveProposalIds = new Set<string>();
        for (const decision of input.record.exclusiveDecisionSets) {
          const uniqueProposalIds = new Set(decision.proposalIds);
          if (
            decision.decisionSetId !==
              collectMagiDecisionSets(run.detail.summary.runId, input.magiTurn, [decision], [])[0]
                ?.decisionSetId ||
            uniqueProposalIds.size !== decision.proposalIds.length ||
            declaredDecisionSetIds.has(decision.decisionSetId) ||
            decision.proposalIds.some(
              (proposalId) =>
                !proposalIds.has(proposalId) || assignedExclusiveProposalIds.has(proposalId),
            )
          ) {
            return yield* validation(
              "invalid-protocol-state",
              "Exclusive decision sets must use their deterministic id and known proposals.",
              "record.exclusiveDecisionSets",
            );
          }
          declaredDecisionSetIds.add(decision.decisionSetId);
          for (const proposalId of decision.proposalIds) {
            assignedExclusiveProposalIds.add(proposalId);
          }
        }
        const proposalOutcomes = calculateMagiProposalOutcomes({
          magiTurn: input.magiTurn,
          proposals: protocol.proposals,
          participants: run.detail.config.participants,
          settlements: turn.settlements,
          requiredWeight: threshold.requiredWeight,
        });
        const decisionSets = collectMagiDecisionSets(
          run.detail.summary.runId,
          input.magiTurn,
          input.record.exclusiveDecisionSets,
          protocol.decisionSets,
        );
        const decisionOutcomes = calculateMagiDecisionSetOutcomes({
          magiTurn: input.magiTurn,
          decisionSets,
          participants: run.detail.config.participants,
          settlements: turn.settlements,
          requiredWeight: threshold.requiredWeight,
        });
        const evolvedDecisionSets = applyMagiDecisionSetOutcomes(
          decisionSets,
          decisionOutcomes,
          input.magiTurn,
        );
        const exclusiveProposalIds = new Set(
          evolvedDecisionSets.flatMap((decision) => decision.proposalIds),
        );
        const evolvedProposals = applyMagiProposalOutcomes(
          protocol.proposals,
          proposalOutcomes,
          input.magiTurn,
        ).map((proposal) => {
          const relatedDecisionSet = evolvedDecisionSets.find((decisionSet) =>
            decisionSet.proposalIds.includes(proposal.proposalId),
          );
          if (!relatedDecisionSet || !exclusiveProposalIds.has(proposal.proposalId)) {
            return proposal;
          }
          if (
            relatedDecisionSet.decision === "open" ||
            relatedDecisionSet.decision === "reconsidering"
          ) {
            return {
              ...proposal,
              decision: "reconsidering" as const,
              decisionBasis: "pending" as const,
              decisionMagiTurn: null,
              integration: "not-applicable" as const,
            };
          }
          if (
            relatedDecisionSet.decision === "resolved" &&
            relatedDecisionSet.winningProposalId === proposal.proposalId
          ) {
            return {
              ...proposal,
              decision: "accepted" as const,
              decisionBasis: "panel-threshold" as const,
              decisionMagiTurn: input.magiTurn,
              integration: "awaiting-arbitration" as const,
            };
          }
          if (relatedDecisionSet.decision === "resolved") {
            return {
              ...proposal,
              decision: "superseded" as const,
              decisionBasis: "superseded" as const,
              decisionMagiTurn: input.magiTurn,
              integration: "not-applicable" as const,
            };
          }
          return {
            ...proposal,
            decision: "unresolved" as const,
            decisionBasis: "panel-deadlock" as const,
            decisionMagiTurn: input.magiTurn,
            integration: "not-applicable" as const,
          };
        });
        const outcomeByProposalId = new Map(
          proposalOutcomes.map((outcome) => [outcome.proposalId, outcome]),
        );
        const acceptedProposalIds = [
          ...new Set(
            evolvedProposals
              .filter(
                (proposal) =>
                  proposal.decision === "accepted" &&
                  proposal.decisionMagiTurn === input.magiTurn &&
                  (outcomeByProposalId.get(proposal.proposalId)?.resolvedThisTurn === true ||
                    decisionOutcomes.some(
                      (outcome) =>
                        outcome.resolvedThisTurn &&
                        outcome.winningProposalId === proposal.proposalId,
                    )),
              )
              .map((proposal) => proposal.proposalId),
          ),
        ];
        const rejectedProposalIds = evolvedProposals
          .filter(
            (proposal) =>
              proposal.decision === "rejected" && proposal.decisionMagiTurn === input.magiTurn,
          )
          .map((proposal) => proposal.proposalId);
        const unresolvedProposalIds = evolvedProposals
          .filter(
            (proposal) =>
              proposal.decision === "unresolved" && proposal.decisionMagiTurn === input.magiTurn,
          )
          .map((proposal) => proposal.proposalId);
        const pendingProposalIds = activeMagiProposals(evolvedProposals).map(
          (proposal) => proposal.proposalId,
        );
        const dispositionByProposalId = new Map(
          dispositions.map((disposition) => [disposition.proposalId, disposition]),
        );
        if (
          acceptedProposalIds.some((proposalId) => {
            const disposition = dispositionByProposalId.get(proposalId);
            return disposition === undefined || disposition.disposition === "needs-reassessment";
          })
        ) {
          return yield* validation(
            "invalid-protocol-state",
            "Every newly accepted proposal must be incorporated or explicitly omitted before candidate confirmation.",
            "record.proposalDispositions",
          );
        }
        const pendingProtocolWork = hasPendingMagiProtocolWork({
          pendingProposalCount: pendingProposalIds.length,
          hasPendingDecisionSet: activeMagiDecisionSets(evolvedDecisionSets).length > 0,
          hasClarificationRequest: assessments.some((assessment) => assessment.clarificationNeeded),
          requiresCandidateConfirmation: acceptedProposalIds.length > 0,
          requestedOutcome: input.record.requestedOutcome,
        });
        const direct = calculateMagiDirectTransition({
          consensusReached: totals.supportWeight >= threshold.requiredWeight,
          pendingEvaluations: pendingProtocolWork,
          completedMagiTurns,
          magiTurnLimit: run.detail.config.magiTurnLimit,
        });
        const batchId = MagiActionBatchId.make(
          `batch_${run.detail.summary.runId}_${input.magiTurn}`,
        );
        const proposalKinds = new Map(
          protocol.proposals.map((proposal) => [proposal.proposalId, proposal.proposal.kind]),
        );
        for (const action of input.record.authorizedExecutionActions) {
          if (
            action.relatedProposalIds.some(
              (proposalId) => !acceptedProposalIds.includes(proposalId),
            ) ||
            action.obligation !==
              deriveMagiActionObligation(action.relatedProposalIds, proposalKinds)
          ) {
            return yield* validation(
              "invalid-protocol-state",
              "Authorized actions must reference accepted proposals and use the server-derived obligation.",
              "record.authorizedExecutionActions",
            );
          }
        }
        const pendingBatch =
          input.record.authorizedExecutionActions.length === 0
            ? null
            : {
                batchId,
                magiTurn: input.magiTurn,
                actions: input.record.authorizedExecutionActions.map((action, index) => ({
                  actionId: deterministicMagiActionRecordId(
                    run.detail.summary.runId,
                    input.magiTurn,
                    index,
                    batchId,
                  ),
                  ...action,
                })),
              };
        const actionProposalIds = new Set(
          input.record.authorizedExecutionActions.flatMap((action) => action.relatedProposalIds),
        );
        const arbitratedProposals = evolvedProposals.map((proposal) => {
          if (!acceptedProposalIds.includes(proposal.proposalId)) return proposal;
          const disposition = dispositionByProposalId.get(proposal.proposalId)!;
          return {
            ...proposal,
            integration:
              disposition.disposition === "do-not-apply"
                ? ("omitted" as const)
                : actionProposalIds.has(proposal.proposalId)
                  ? ("action-pending" as const)
                  : ("incorporated" as const),
          };
        });
        const terminalProposals = terminalMagiProposals(arbitratedProposals);
        const mergedDigest = mergeMagiTerminalProposalDigest({
          terminalProposals,
          persistedDigest: protocol.terminalProposalDigest,
          updates: terminalProposalDigestUpdates,
        });
        if (mergedDigest.issues.length > 0) {
          return yield* validation(
            "invalid-protocol-state",
            `The merged terminal proposal digest must contain exactly one entry for every post-arbitration terminal proposal (${mergedDigest.issues.join("; ")}). Read missing records with magi_get_terminal_proposals and resubmit the arbitration updates.`,
            "record.terminalProposalDigestUpdates",
          );
        }
        const terminalProposalDigest = mergedDigest.digest;
        const renderedTerminalProposalDigest = renderMagiTerminalProposalDigest({
          terminalProposals,
          digest: terminalProposalDigest,
        });
        if (!isMagiTerminalProposalDigestWithinLimit(renderedTerminalProposalDigest)) {
          return yield* validation(
            "invalid-protocol-state",
            `The complete terminal proposal digest renders to ${renderedTerminalProposalDigest.length} characters; shorten the arbitrator-authored summaries and resubmit within the ${MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS}-character aggregate limit. No content was truncated or persisted.`,
            "record.terminalProposalDigestUpdates",
          );
        }
        const persistedArbitrationRecord = {
          ...arbitrationRecord,
          terminalProposalDigest,
        };
        const transition: MagiRecordArbitrationResult["transition"] = pendingBatch
          ? {
              state: "actions-required",
              batchId,
              actions: input.record.authorizedExecutionActions,
              afterActions: calculateMagiPostActionTransition(
                completedMagiTurns,
                run.detail.config.magiTurnLimit,
              ),
            }
          : { state: direct };
        const state: MagiRunState = pendingBatch
          ? "awaiting-actions"
          : direct === "consensus-reached"
            ? "succeeded"
            : direct === "continue"
              ? "awaiting-next-turn"
              : "turn-limit-reached";
        const updatedAt = yield* nowIso;
        const completedAt = isMagiRunTerminal(state) ? updatedAt : null;
        const nextProtocol: MagiProtocolState = {
          ...protocol,
          proposals: arbitratedProposals,
          terminalProposalDigest,
          decisionSets: evolvedDecisionSets,
          pendingBatch,
          turns: protocol.turns.map((item) =>
            item.magiTurn === input.magiTurn
              ? { ...item, arbitration: persistedArbitrationRecord }
              : item,
          ),
        };
        const next: PersistedMagiRun = {
          ...run,
          protocol: nextProtocol,
          updatedAt,
          detail: {
            ...run.detail,
            summary: { ...run.detail.summary, state, completedMagiTurns, completedAt },
            candidate: arbitrationRecord.candidate,
            issuedActionBatch: pendingBatch,
            activity: calculateMagiActivityMetrics({
              runId: run.detail.summary.runId,
              source: run.detail.summary.source,
              state,
              completedMagiTurns,
              magiTurnLimit: run.detail.config.magiTurnLimit,
              totalWeight: threshold.totalWeight,
              requiredWeight: threshold.requiredWeight,
              comparableOutcomes: [
                { label: arbitrationRecord.candidate.conclusion, weight: totals.supportWeight },
              ],
            }),
          },
        };
        yield* persist(next);
        if (isMagiRunTerminal(state)) {
          yield* increment(magiRunsTotal, {
            source: run.detail.summary.source,
            phase: "terminal",
            outcome: state,
            consensusTurn: state === "succeeded" ? completedMagiTurns : null,
            limitExhausted: state === "turn-limit-reached",
          });
          yield* cleanupTerminalRun(next);
        }
        yield* increment(
          magiProposalsTotal,
          { disposition: "accepted" },
          acceptedProposalIds.length,
        );
        yield* Effect.forEach(acceptedProposalIds, (proposalId) =>
          Effect.void.pipe(
            Effect.withSpan("magi.proposal", {
              attributes: {
                "magi.run_id": input.runId,
                "magi.proposal_id": proposalId,
                "magi.turn": input.magiTurn,
              },
            }),
          ),
        );
        yield* increment(magiActionsTotal, { phase: "issued" }, pendingBatch?.actions.length ?? 0);
        yield* Effect.forEach(pendingBatch?.actions ?? [], (action) =>
          Effect.void.pipe(
            Effect.withSpan("magi.action", {
              attributes: {
                "magi.run_id": input.runId,
                "magi.action_id": action.actionId,
                "magi.turn": input.magiTurn,
              },
            }),
          ),
        );
        return {
          runId: input.runId,
          ...totals,
          acceptedProposalIds,
          rejectedProposalIds,
          unresolvedProposalIds,
          pendingProposalIds,
          transition,
        };
      }),
    );

  const recordActions = (threadId: ThreadId, input: MagiRecordActionsInput) =>
    withRunLock(
      input.runId,
      Effect.gen(function* () {
        const run = yield* requireRun(input.runId, threadId);
        const protocol = asProtocol(run.protocol);
        const batch = protocol.pendingBatch;
        if (
          (run.detail.summary.state !== "awaiting-actions" &&
            run.detail.summary.state !== "awaiting-action-reconciliation") ||
          !batch ||
          batch.batchId !== input.record.batchId ||
          batch.magiTurn !== input.magiTurn
        ) {
          return yield* validation(
            "invalid-protocol-state",
            "This is not the exact issued Magi action batch.",
          );
        }
        if (
          input.record.actions.length !== batch.actions.length ||
          input.record.actions.some(
            (action, index) =>
              action.actionId !== batch.actions[index]?.actionId ||
              action.summary !== batch.actions[index]?.summary,
          )
        ) {
          return yield* validation(
            "invalid-protocol-state",
            "Action outcomes must match the issued batch exactly.",
            "record.actions",
          );
        }
        const recordedActions = input.record.actions.map((action, index) => ({
          ...batch.actions[index]!,
          status: action.status,
          details: action.details,
          unforeseenConsequence: action.unforeseenConsequence,
        }));
        const reconciliation = magiActionReconciliationState(recordedActions);
        const mandatory = magiActionsRequiringReassessment(recordedActions).map(
          (action) => action.actionId,
        );
        const postAction = calculateMagiPostActionTransition(
          run.detail.summary.completedMagiTurns,
          run.detail.config.magiTurnLimit,
        );
        const state: MagiRunState =
          reconciliation === "awaiting-action-reconciliation"
            ? "awaiting-action-reconciliation"
            : postAction === "turn-limit-reached"
              ? "turn-limit-reached"
              : "awaiting-next-turn";
        const updatedAt = yield* nowIso;
        const reconciledActions = [...protocol.actions];
        for (const action of recordedActions) {
          const existingIndex = reconciledActions.findIndex(
            (item) => item.actionId === action.actionId,
          );
          if (existingIndex >= 0) reconciledActions[existingIndex] = action;
          else reconciledActions.push(action);
        }
        const reconciledProposals = protocol.proposals.map((proposal) => {
          if (
            proposal.integration !== "action-pending" &&
            proposal.integration !== "action-impeded"
          ) {
            return proposal;
          }
          const relatedActions = reconciledActions.filter((action) =>
            action.relatedProposalIds.includes(proposal.proposalId),
          );
          if (relatedActions.length === 0) return proposal;
          if (
            relatedActions.every(
              (action) => action.status === "completed" && action.unforeseenConsequence === null,
            )
          ) {
            return { ...proposal, integration: "action-completed" as const };
          }
          if (
            relatedActions.some(
              (action) =>
                action.status === "not-completed" || action.unforeseenConsequence !== null,
            )
          ) {
            return { ...proposal, integration: "action-impeded" as const };
          }
          return { ...proposal, integration: "action-pending" as const };
        });
        const reconciliationEntry =
          run.detail.summary.state === "awaiting-action-reconciliation"
            ? [
                {
                  reconciliationId: `${batch.batchId}:${input.record.actions.map((action) => `${action.actionId}:${action.status}`).join("|")}`,
                  batchId: batch.batchId,
                  actions: recordedActions,
                  recordedAt: updatedAt,
                },
              ]
            : [];
        const next: PersistedMagiRun = {
          ...run,
          updatedAt,
          protocol: {
            ...protocol,
            actions: reconciledActions,
            proposals: reconciledProposals,
            reconciliations: [...protocol.reconciliations, ...reconciliationEntry],
            pendingBatch: reconciliation === "awaiting-action-reconciliation" ? batch : null,
          },
          detail: {
            ...run.detail,
            summary: {
              ...run.detail.summary,
              state,
              completedAt: isMagiRunTerminal(state) ? updatedAt : null,
            },
            actions: reconciledActions,
            issuedActionBatch: reconciliation === "awaiting-action-reconciliation" ? batch : null,
            activity: { ...run.detail.activity, state },
          },
        };
        yield* persist(next);
        if (isMagiRunTerminal(state)) {
          yield* increment(magiRunsTotal, {
            source: run.detail.summary.source,
            phase: "terminal",
            outcome: state,
            consensusTurn: null,
            limitExhausted: state === "turn-limit-reached",
          });
          yield* cleanupTerminalRun(next);
        }
        yield* increment(
          magiActionsTotal,
          { phase: "reconciled", reconciliation },
          recordedActions.length,
        );
        return {
          runId: input.runId,
          transition:
            reconciliation === "awaiting-action-reconciliation"
              ? "awaiting-action-reconciliation"
              : postAction,
          mandatoryReassessmentActionIds: mandatory,
        } satisfies MagiRecordActionsResult;
      }),
    );

  const cancelRun = (runId: MagiRunId) =>
    Effect.gen(function* () {
      // Wake an in-flight deliberation before waiting for its serialization
      // lock. Otherwise cancellation would wait behind the participant work it
      // is intended to interrupt.
      yield* signalRunCancellation(runId);
      yield* withRunLock(
        runId,
        Effect.gen(function* () {
          const run = yield* requireRun(runId);
          if (isMagiRunTerminal(run.detail.summary.state)) {
            yield* clearRunCancellation(runId);
            return;
          }
          const updatedAt = yield* nowIso;
          const protocol = asProtocol(run.protocol);
          yield* persist({
            ...run,
            updatedAt,
            protocol: {
              ...protocol,
              members: protocol.members.map((member) => ({
                ...member,
                state: cancelMagiMemberState(member.state),
              })),
            },
            detail: {
              ...run.detail,
              summary: { ...run.detail.summary, state: "cancelled", completedAt: updatedAt },
              activity: { ...run.detail.activity, state: "cancelled" },
              participants: run.detail.participants.map((participant) => ({
                ...participant,
                state: cancelMagiMemberState(participant.state),
              })),
            },
          });
          yield* increment(magiRunsTotal, {
            source: run.detail.summary.source,
            phase: "terminal",
            outcome: "cancelled",
            consensusTurn: null,
            limitExhausted: false,
          });
          yield* cleanupTerminalRun({
            ...run,
            updatedAt,
            protocol: {
              ...protocol,
              members: protocol.members.map((member) => ({
                ...member,
                state: cancelMagiMemberState(member.state),
              })),
            },
            detail: {
              ...run.detail,
              summary: { ...run.detail.summary, state: "cancelled", completedAt: updatedAt },
              activity: { ...run.detail.activity, state: "cancelled" },
            },
          });
        }),
      );
    });
  const continueRun = (runId: MagiRunId) =>
    withRunLock(
      runId,
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (run.detail.summary.state !== "paused")
          return yield* validation("invalid-protocol-state", "This Magi run is not paused.");
        const protocol = asProtocol(run.protocol);
        const state: MagiRunState =
          protocol.stateBeforePause === "deliberating"
            ? "awaiting-next-turn"
            : (protocol.stateBeforePause ?? "awaiting-next-turn");
        const next = {
          ...run,
          updatedAt: yield* nowIso,
          protocol: {
            ...protocol,
            stateBeforePause: null,
          },
          detail: {
            ...run.detail,
            summary: { ...run.detail.summary, state },
            activity: { ...run.detail.activity, state },
          },
        };
        yield* persist(next);
      }),
    );
  const reconcileActions = (input: MagiReconcileActionsInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId);
      const pendingBatch = asProtocol(run.protocol).pendingBatch;
      if (pendingBatch === null) {
        return yield* validation(
          "invalid-protocol-state",
          "No Magi action batch is awaiting reconciliation.",
        );
      }
      yield* recordActions(run.detail.summary.rootThreadId, {
        runId: input.runId,
        magiTurn: pendingBatch.magiTurn,
        record: { batchId: input.batchId, actions: input.actions },
      });
    });

  const listRuns = (input: MagiListRunsInput) =>
    repository
      .listRuns(input)
      .pipe(
        Effect.mapError(() => validation("invalid-protocol-state", "Could not load Magi history.")),
      );
  const getTerminalProposals = (threadId: ThreadId, input: MagiGetTerminalProposalsInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId, threadId);
      const protocol = asProtocol(run.protocol);
      const terminalProposals = terminalMagiProposals(protocol.proposals);
      const page = pageMagiTerminalProposals({
        terminalProposals,
        persistedDigest: protocol.terminalProposalDigest,
        scope: input.scope,
        offset: input.offset,
        limit: input.limit,
      });
      return {
        runId: input.runId,
        terminalProposalCount: terminalProposals.length,
        missingDigestCount: page.missingDigestCount,
        persistedDigestEntryCount: protocol.terminalProposalDigest.length,
        proposals: page.proposals,
        nextOffset: page.nextOffset,
        persistedDigest: input.includePersistedDigest ? protocol.terminalProposalDigest : null,
      } satisfies MagiGetTerminalProposalsResult;
    });
  const recoverTurnResult = (threadId: ThreadId, input: MagiRecoverTurnResultInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId, threadId);
      const turn = asProtocol(run.protocol).turns.find(
        (candidate) => candidate.magiTurn === input.magiTurn,
      );
      if (!turn) {
        return yield* validation(
          "foreign-turn",
          "The requested Magi turn does not exist in this run.",
          "magiTurn",
        );
      }
      const settlement = turn.settlements[input.participantIndex];
      if (!settlement) {
        return yield* validation(
          "invalid-protocol-state",
          `participantIndex must be between 0 and ${Math.max(0, turn.settlements.length - 1)}.`,
          "participantIndex",
        );
      }
      return {
        runId: input.runId,
        magiTurn: input.magiTurn,
        participantCount: turn.settlements.length,
        participantIndex: input.participantIndex,
        participant: projectMagiParticipantEvidence(settlement, input.representation),
        nextParticipantIndex:
          input.participantIndex + 1 < turn.settlements.length ? input.participantIndex + 1 : null,
      } satisfies MagiRecoverTurnResult;
    });
  const recoverRunContext = (threadId: ThreadId, input: MagiRecoverRunContextInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId, threadId);
      const protocol = asProtocol(run.protocol);
      const turn = protocol.turns.at(-1);
      const candidate = turn?.arbitration?.candidate ?? turn?.candidate ?? run.detail.candidate;
      const threshold = calculateMagiThreshold(
        run.detail.config.participants,
        run.detail.config.consensusThresholdPercent,
      );
      const settledWeight =
        turn?.settlements
          .filter((settlement) => settlement.state === "settled")
          .reduce(
            (weight, settlement) =>
              weight +
              (run.detail.config.participants.find(
                (participant) => participant.participantId === settlement.participantId,
              )?.weight ?? 0),
            0,
          ) ?? 0;
      const pendingProposals = activeMagiProposals(protocol.proposals);
      const continuation = recoverMagiRunContextContinuation(
        run.detail.summary.state,
        run.detail.issuedActionBatch,
      );
      return {
        runId: input.runId,
        state: run.detail.summary.state,
        completedMagiTurns: run.detail.summary.completedMagiTurns,
        latestMagiTurn: turn?.magiTurn ?? null,
        participantIds: run.detail.config.participants.map(
          (participant) => participant.participantId,
        ),
        totalWeight: threshold.totalWeight,
        requiredWeight: threshold.requiredWeight,
        thresholdReachable: settledWeight >= threshold.requiredWeight,
        candidate,
        candidateFingerprint:
          candidate === null ? null : magiCandidateFingerprint(candidate, protocol.actions),
        recordedActions: protocol.actions,
        issuedActionBatch: continuation.issuedActionBatch,
        unresolvedDisagreements: turn?.arbitration?.disagreements ?? [],
        pendingProposalIds: pendingProposals.map((proposal) => proposal.proposalId),
        pendingProposals,
        activeDecisionSets: activeMagiDecisionSets(protocol.decisionSets),
        nextRequiredTool: continuation.nextRequiredTool,
        controlInstructions: arbitratorResultInstructions(run),
      } satisfies MagiRecoverRunContextResult;
    });
  const getRunDetail = (input: MagiGetRunDetailInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId);
      const settings = yield* readSettings;
      const protocol = asProtocol(run.protocol);
      return projectMagiRunDetail({
        detail: run.detail,
        turns: protocol.turns.map((turn) => ({
          ...turn,
          activities: turn.activities ?? [],
        })),
        proposals: protocol.proposals,
        decisionSets: protocol.decisionSets,
        reconciliations: protocol.reconciliations,
        initialPrompt: run.initiatingInstruction,
        includeDiagnostics: input.includeDiagnostics && settings.showRunDetailsAndDiagnostics,
      });
    });
  const exportDiagnostics = (input: MagiDiagnosticsInput) =>
    Effect.gen(function* () {
      const listed = yield* listRuns({ rootThreadId: input.rootThreadId, limit: input.limit });
      const runs = yield* Effect.forEach(listed.runs, (summary) =>
        requireRun(summary.runId).pipe(
          Effect.map((run) => ({
            summary: run.detail.summary,
            totalWeight: run.detail.totalWeight,
            requiredWeight: run.detail.requiredWeight,
            participants: run.detail.participants.map((participant) => ({
              participantId: participant.participantId,
              childThreadId: participant.childThreadId,
              providerInstanceId: participant.modelSelection.instanceId,
              model: participant.modelSelection.model,
              state: participant.state,
              weight: participant.weight,
            })),
            settlements: run.detail.settlements.map((settlement) => ({
              participantId: settlement.participantId,
              participantThreadId: settlement.participantThreadId,
              participantTurnId: settlement.participantTurnId,
              state: settlement.state,
              parseMode: settlement.parseMode,
              durationMs: settlement.durationMs,
              inputTokens: settlement.inputTokens,
              outputTokens: settlement.outputTokens,
              retryCount: settlement.retryCount,
              providerAttempts: settlement.providerAttempts,
              structuralRepairCount: settlement.structuralRepairCount,
              reconstructed: settlement.reconstructed,
              failureClass: settlement.failureClass,
              contextCompressed: settlement.contextCompressed,
            })),
            actions: run.detail.actions.map((action) => ({
              actionId: action.actionId,
              status: action.status,
              obligation: action.obligation,
              relatedProposalIds: action.relatedProposalIds,
            })),
          })),
        ),
      );
      return { generatedAt: yield* nowIso, redacted: true, runs } satisfies MagiDiagnosticsResult;
    });
  const service: MagiServiceShape = {
    getArmedTurnInstructions,
    getOptions,
    getSettings: readSettings,
    updateSettings,
    resetSettings,
    armThread,
    getArm,
    disarmThread,
    startFromTool,
    deliberate,
    recordArbitration,
    getTerminalProposals,
    recoverTurnResult,
    recoverRunContext,
    recordActions,
    cancelRun,
    continueRun,
    reconcileActions,
    listRuns,
    getRunDetail,
    listContextActivities,
    exportDiagnostics,
  };

  yield* MagiControlBroker.installActiveHandlers({
    getArmedTurnInstructions: service.getArmedTurnInstructions,
    getPanelOptions: () => service.getOptions,
    getSettings: () => service.getSettings,
    updateSettings: service.updateSettings,
    resetSettings: service.resetSettings,
    armThread: service.armThread,
    getArm: service.getArm,
    disarmThread: service.disarmThread,
    cancelRun: service.cancelRun,
    continueRun: service.continueRun,
    reconcileActions: service.reconcileActions,
    listRuns: service.listRuns,
    getRunDetail: service.getRunDetail,
    exportDiagnostics: service.exportDiagnostics,
    getOptions: () => service.getOptions,
    listContextActivities: (scope) => service.listContextActivities(scope.threadId),
    start: (scope, input) => service.startFromTool(scope.threadId, input, scope.providerSessionId),
    deliberate: (scope, input) => service.deliberate(scope.threadId, input),
    recordArbitration: (scope, input) => service.recordArbitration(scope.threadId, input),
    getTerminalProposals: (scope, input) => service.getTerminalProposals(scope.threadId, input),
    recoverTurnResult: (scope, input) => service.recoverTurnResult(scope.threadId, input),
    recoverRunContext: (scope, input) => service.recoverRunContext(scope.threadId, input),
    recordActions: (scope, input) => service.recordActions(scope.threadId, input),
  });

  yield* ContextArtifactBroker.installActiveHandlers({
    read: readContextArtifact,
  });

  const recoverable = yield* repository.listRecoverableRuns().pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(recoverable, (run) =>
    Effect.gen(function* () {
      const protocol = asProtocol(run.protocol);
      const interruptedState = run.detail.summary.state;
      if (protocol.cleanupPending) {
        yield* cleanupTerminalRun(run);
        return;
      }
      const recovery = recoverInterruptedMagiState(interruptedState, protocol.stateBeforePause);
      const state = recovery.state;
      if (state === interruptedState) {
        yield* repository.setActiveSummary(run.detail.summary.rootThreadId).pipe(Effect.ignore);
        return;
      }
      if (interruptedState === "initializing") {
        yield* deletePlannedMembers(protocol.members);
      }
      const updatedAt = yield* nowIso;
      const recovered: PersistedMagiRun = {
        ...run,
        updatedAt,
        protocol: {
          ...protocol,
          stateBeforePause: recovery.stateBeforePause,
        },
        detail: {
          ...run.detail,
          summary: {
            ...run.detail.summary,
            state,
            completedAt: isMagiRunTerminal(state) ? updatedAt : null,
          },
          activity: { ...run.detail.activity, state },
        },
      };
      yield* persist(recovered).pipe(
        Effect.catch((error) =>
          error.reason === "invalid-protocol-state" &&
          error.message === deletedRootMagiValidationMessage
            ? repository.deleteByOwnerThreadId(run.detail.summary.rootThreadId).pipe(Effect.orDie)
            : Effect.fail(error),
        ),
      );
      if (isMagiRunTerminal(state)) yield* cleanupTerminalRun(recovered);
    }),
  );
  yield* providerService.streamEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "request.opened" ||
        event.type === "user-input.requested" ||
        event.type === "request.resolved" ||
        event.type === "user-input.resolved" ||
        event.type === "runtime.error" ||
        event.type === "turn.aborted",
    ),
    Stream.runForEach((event) =>
      recoverMagiProviderEvent(
        event,
        repository.findActiveRun(event.threadId).pipe(
          Effect.orElseSucceed(() => Option.none()),
          Effect.flatMap((active) => {
            if (Option.isNone(active)) return Effect.void;
            return withRunLock(
              active.value.detail.summary.runId,
              Effect.gen(function* () {
                const latest = yield* requireRun(active.value.detail.summary.runId);
                if (
                  latest.mainTurnId !== null &&
                  event.turnId !== undefined &&
                  event.turnId !== latest.mainTurnId
                ) {
                  return;
                }
                const protocol = asProtocol(latest.protocol);
                const { state, stateBeforePause } = resolveMagiProviderEventTransition({
                  currentState: latest.detail.summary.state,
                  stateBeforePause: protocol.stateBeforePause,
                  eventType: event.type,
                });
                if (state === null || state === latest.detail.summary.state) return;
                const updatedAt = yield* nowIso;
                yield* persist({
                  ...latest,
                  updatedAt,
                  protocol: { ...protocol, stateBeforePause },
                  detail: {
                    ...latest.detail,
                    summary: { ...latest.detail.summary, state },
                    activity: { ...latest.detail.activity, state },
                  },
                });
              }),
            );
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  return service;
});

export class MagiService extends Context.Service<MagiService, MagiServiceShape>()(
  "t3/magi/MagiService",
) {}

export const layer = Layer.effect(MagiService, makeMagiService).pipe(
  Layer.provide(ProjectionMagiRepositoryLive),
);

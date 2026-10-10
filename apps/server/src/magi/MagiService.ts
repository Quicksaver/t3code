import {
  type ChatAttachment,
  CommandId,
  ComposerContextId,
  DEFAULT_MAGI_SETTINGS,
  isProviderAvailable,
  MAGI_ARM_CONTEXT_KIND,
  MAGI_MAX_CONTEXT_ACTIVITY_IDS,
  MAGI_MAX_PARTICIPANTS,
  MAGI_MAX_WEIGHT,
  MAGI_MIN_PARTICIPANTS,
  MAGI_MIN_WEIGHT,
  MagiActionBatchId,
  MagiActionRecordId,
  MagiArmId,
  MagiRunId,
  MagiProposalId,
  MagiValidationError,
  MessageId,
  ThreadId,
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
  magiExclusiveDecisionSetFingerprint,
  pendingMagiRunTitle,
  validateMagiRoster,
  type ContextReadInput,
  type ContextReadResult,
  type MagiActivityReference,
  type MagiArbitrationRecord,
  type MagiArmThreadInput,
  type MagiArmThreadResult,
  type MagiCandidate,
  type MagiDecisionSetId,
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
  type MagiControlRunInput,
  MagiRunConfig,
  type MagiRunDetail,
  type MagiRunSource,
  type MagiRunState,
  type MagiSettings,
  type MagiSettingsPatch,
  type MagiStartInput,
  type MagiStartResult,
  type MagiSubscribeThreadRunsInput,
  type MagiTerminalProposalDigestEntry,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ProviderContextUsage,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
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
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";

import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { isNativeMaintenanceCommand } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionMagiRepositoryLive } from "../persistence/ProjectionMagi.ts";
import { ProjectionMagiRepository, type PersistedMagiRun } from "../persistence/ProjectionMagi.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
  participantDispatchModelSelection,
  resolveMagiStartSnapshot,
} from "./MagiRunStarter.ts";
import { cancelledMagiParticipantSettlement, cancelMagiMemberState } from "./MagiCancellation.ts";
import {
  listMagiContextActivities,
  MAGI_EVIDENCE_TURN_ITEM_STATUSES,
  MAGI_EVIDENCE_TURN_ITEM_TYPES,
  orderMagiContextArtifacts,
  resolveMagiContextActivities,
} from "./MagiContextAssembler.ts";
import {
  projectMagiParticipantEvidence,
  projectMagiParticipantEvidenceList,
  projectMagiRunDetail,
} from "./MagiResultProjection.ts";
import { sumMagiRunTokenUsage } from "./MagiTokenUsage.ts";
import * as MagiParticipantPolicy from "./MagiParticipantPolicy.ts";

/** The conversation calling a Magi tool, as identified by its MCP credential. */
export type MagiCaller = McpThreadCaller;

interface ProtocolMember {
  readonly participant: MagiParticipantDraft;
  readonly personality: MagiPersonality | null;
  /** Deterministic V2 child thread id; the thread exists once its first turn is dispatched. */
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
  /** The owner run started to continue the protocol after a premature end; at most one per run. */
  readonly controlContinuationRunId: RunId | null;
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
    controlContinuationRunId: protocol.controlContinuationRunId ?? null,
  };
};

/** States in which the owner's agent must call the next Magi tool before its turn ends. */
const OWNER_PROTOCOL_WORK_STATES: ReadonlySet<MagiRunState> = new Set([
  "awaiting-arbitration",
  "awaiting-actions",
  "awaiting-next-turn",
  "awaiting-action-reconciliation",
]);

/** States a pause can hold while a deliberation finishes underneath it. */
const MAGI_PAUSE_STATES: ReadonlySet<MagiRunState> = new Set([
  "paused",
  "awaiting-main-approval",
  "awaiting-main-input",
]);

const magiControlContinuationPrompt = (runId: MagiRunId, state: MagiRunState) =>
  `Your previous turn ended while Magi run ${runId} was still in state ${state}. Continue the Magi protocol now: call magi_recover_run_context with runId "${runId}" and follow its nextRequiredTool and control instructions until the run reaches a terminal state, then give your final report. If this turn also ends before that, the run fails.`;
const encodeRunConfig = Schema.encodeSync(Schema.fromJsonString(MagiRunConfig));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
    message: `Magi cannot start the participant turn because the configured roster is unavailable: ${unavailableSummary}. No participant was removed. Follow any explicit instruction for this situation; otherwise pause an existing run with magi_control_run (action "pause"), then ask the user how to proceed.`,
    field: "participants",
  });
});

export const pendingMagiComparableOutcomes = (
  activity: Pick<MagiRunDetail["activity"], "leadingAgreementLabel" | "leadingAgreementWeight">,
): ReadonlyArray<{ readonly label: string; readonly weight: number }> =>
  activity.leadingAgreementLabel !== null && activity.leadingAgreementWeight !== null
    ? [{ label: activity.leadingAgreementLabel, weight: activity.leadingAgreementWeight }]
    : [];

/** Weight of the participants whose turn settled, the most the panel can still approve with. */
const settledMagiWeight = (
  config: MagiRunConfig,
  settlements: ReadonlyArray<MagiParticipantSettlement>,
): number =>
  settlements
    .filter((settlement) => settlement.state === "settled")
    .reduce(
      (weight, settlement) =>
        weight +
        (config.participants.find(
          (participant) => participant.participantId === settlement.participantId,
        )?.weight ?? 0),
      0,
    );
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

/** A user message rewritten to carry a consumed arm to the owning agent. */
export interface MagiArmedMessage {
  readonly armId: MagiArmThreadResult["armId"];
  readonly text: string;
  readonly context: OrchestrationMessageContext;
}

export interface MagiServiceShape {
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
  /**
   * Sends a user message through `send`, consuming the conversation's pending arm into it: the
   * message carries a Magi context record telling the agent to call magi_start with the arm id.
   * The message goes unchanged when unarmed, when it is a native maintenance command such as
   * `/compact` (an arm would turn it into a prompt), or when it was already accepted, so a
   * replayed command never consumes a newer arm. A retry of a message that already carries an
   * arm gets the same arm. `config` arms a brand-new thread in the same step (first-message
   * drafts).
   *
   * From attachment until `send` finishes, a failure or interruption returns the arm to pending
   * (or clears an arm created from `config`) once the message is known not to exist; an accepted
   * or uncertain message keeps it. Fails without touching the pending arm when it cannot tell
   * whether the message was already accepted.
   */
  readonly sendArmedMessage: <A, E, R>(
    input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly text: string;
      readonly context: OrchestrationMessageContext | undefined;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly config?: MagiRunConfig;
    },
    send: (message: {
      readonly text: string;
      readonly context?: OrchestrationMessageContext;
    }) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MagiValidationError, R>;
  readonly startFromTool: (
    caller: MagiCaller,
    input: MagiStartInput,
  ) => Effect.Effect<MagiStartResult, MagiValidationError>;
  readonly deliberate: (
    caller: MagiCaller,
    input: MagiDeliberateInput,
  ) => Effect.Effect<MagiDeliberationResult, MagiValidationError>;
  readonly recordArbitration: (
    caller: MagiCaller,
    input: MagiRecordArbitrationInput,
  ) => Effect.Effect<MagiRecordArbitrationResult, MagiValidationError>;
  readonly getTerminalProposals: (
    caller: MagiCaller,
    input: MagiGetTerminalProposalsInput,
  ) => Effect.Effect<MagiGetTerminalProposalsResult, MagiValidationError>;
  readonly recoverTurnResult: (
    caller: MagiCaller,
    input: MagiRecoverTurnResultInput,
  ) => Effect.Effect<MagiRecoverTurnResult, MagiValidationError>;
  readonly recoverRunContext: (
    caller: MagiCaller,
    input: MagiRecoverRunContextInput,
  ) => Effect.Effect<MagiRecoverRunContextResult, MagiValidationError>;
  readonly recordActions: (
    caller: MagiCaller,
    input: MagiRecordActionsInput,
  ) => Effect.Effect<MagiRecordActionsResult, MagiValidationError>;
  readonly cancelRun: (runId: MagiRunId) => Effect.Effect<void, MagiValidationError>;
  readonly controlRun: (
    caller: MagiCaller,
    input: MagiControlRunInput,
  ) => Effect.Effect<MagiRecoverRunContextResult, MagiValidationError>;
  readonly listRuns: (
    input: MagiListRunsInput,
  ) => Effect.Effect<MagiListRunsResult, MagiValidationError>;
  readonly getRunDetail: (
    input: MagiGetRunDetailInput,
  ) => Effect.Effect<MagiRunDetail, MagiValidationError>;
  /** The conversation's run list now and after every run change. */
  readonly subscribeThreadRuns: (
    input: MagiSubscribeThreadRunsInput,
  ) => Stream.Stream<MagiListRunsResult, MagiValidationError>;
  /** One run's detail now and after every change to it. */
  readonly subscribeRunDetail: (
    input: MagiGetRunDetailInput,
  ) => Stream.Stream<MagiRunDetail, MagiValidationError>;
  readonly listContextActivities: (
    caller: MagiCaller,
  ) => Effect.Effect<MagiListContextActivitiesResult, MagiValidationError>;
  /** Reads artifacts addressed to the caller's own conversation. */
  readonly readContextArtifacts: (
    caller: MagiCaller,
    input: ContextReadInput,
  ) => Effect.Effect<ContextReadResult, MagiValidationError>;
  readonly exportDiagnostics: (
    input: MagiDiagnosticsInput,
  ) => Effect.Effect<MagiDiagnosticsResult, MagiValidationError>;
}

export const MAGI_PARTICIPANT_TURN_CONCURRENCY = "unbounded" as const;
const encodeInvocationReference = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
    state === "paused"
      ? "magi_control_run"
      : state === "awaiting-next-turn"
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

/** Lifecycle signals from the owning conversation's run that pause or resume Magi. */
type MagiLifecycleProviderEventType =
  | "request.opened"
  | "user-input.requested"
  | "request.resolved"
  | "user-input.resolved"
  | "turn.aborted";

export const resolveMagiProviderEventTransition = (input: {
  readonly currentState: MagiRunState;
  readonly stateBeforePause: MagiRunState | null;
  readonly eventType: MagiLifecycleProviderEventType;
}): { readonly state: MagiRunState | null; readonly stateBeforePause: MagiRunState | null } => {
  let state: MagiRunState | null = null;
  let stateBeforePause = input.stateBeforePause;
  // A finished run never pauses or resumes again.
  if (isMagiRunTerminal(input.currentState)) return { state, stateBeforePause };
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
  } else if (input.eventType === "turn.aborted") {
    state = "paused";
    stateBeforePause ??= input.currentState;
  }
  return { state, stateBeforePause };
};

const armedTurnInstructions = (armId: string, arbitratorPrompt: string) =>
  `The user armed Magi for this message. Before unrelated work, call magi_start with armId "${armId}" and a focused objective drawn from this message; the server applies the armed panel configuration.

${buildMagiArbitratorPreTurnInstructions(arbitratorPrompt)}`;

/** Appends the arm to a user message as a referenced context record the provider receives. */
export const withMagiArmContext = (input: {
  readonly armId: string;
  readonly instructions: string;
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
}): Pick<MagiArmedMessage, "text" | "context"> => {
  const contextId = ComposerContextId.make(`magi-arm-${input.armId}`);
  const reference = formatComposerContextReference({
    kind: MAGI_ARM_CONTEXT_KIND,
    contextId,
    label: "Magi",
  });
  return {
    text: input.text.trim().length > 0 ? `${input.text}\n\n${reference}` : reference,
    context: {
      version: 1,
      records: [
        ...(input.context?.records ?? []),
        {
          version: 1,
          kind: MAGI_ARM_CONTEXT_KIND,
          contextId,
          label: "Magi",
          payload: { armId: input.armId, instructions: input.instructions },
        },
      ],
    },
  };
};

interface MagiConversationContext {
  readonly thread: OrchestrationV2AppThread;
  /** The caller's active run; Magi turns and selected evidence belong to it. */
  readonly currentRun: OrchestrationV2Run & {
    readonly rootNodeId: NonNullable<OrchestrationV2Run["rootNodeId"]>;
  };
  readonly initiatingInstruction: string | null;
  readonly cwd: string | null;
}

interface ParticipantUsage {
  readonly usage: ProviderContextUsage | null;
  readonly automatic: boolean;
}

const participantLabel = (member: Pick<ProtocolMember, "participant" | "personality">) =>
  `${member.participant.modelSelection.model}${member.personality ? ` (${member.personality.name})` : ""}`;

/** A run changed; every conversation in its audience refreshes its Magi history. */
interface MagiRunChange {
  readonly runId: MagiRunId;
  readonly audienceThreadIds: ReadonlyArray<ThreadId>;
}

const participantCommandId = (runId: MagiRunId, participantId: string) =>
  CommandId.make(`magi:${runId}:${participantId}:participant`);

const participantTurnKey = (input: {
  readonly runId: MagiRunId;
  readonly magiTurn: number;
  readonly participantId: string;
  readonly stage: "turn" | "retry" | "repair" | "compact" | "interrupt";
}) => `magi:${input.runId}:${input.magiTurn}:${input.participantId}:${input.stage}`;

/** @internal Exported for service-boundary tests. */
export const makeMagiService = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* ProjectionMagiRepository;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const participantPolicy = yield* MagiParticipantPolicy.MagiParticipantPolicy;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Every run lock section is short: participants run outside it, while the run's
  // `deliberating` state keeps other protocol operations out.
  const withRunLock = yield* makeMagiOperationLock;
  const withArmLock = yield* makeMagiOperationLock;
  // Serializes starts per owner and is released before turn-1 participants run, so message
  // dispatch and arming, which take the arm lock, never wait on a deliberation.
  const withStartLock = yield* makeMagiOperationLock;
  const runCancellations = yield* Ref.make(new Map<string, Deferred.Deferred<void>>());
  const changes = yield* PubSub.unbounded<MagiRunChange>();
  // Deliberations run in the service scope, so a cancelled tool call does not abandon its turn.
  const serviceScope = yield* Effect.scope;
  /** Each in-flight deliberation's outcome, which a retried tool call can wait for. */
  const liveDeliberations = yield* Ref.make(
    new Map<string, Deferred.Deferred<MagiDeliberationResult, MagiValidationError>>(),
  );
  const inService = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkIn(effect, serviceScope).pipe(Effect.flatMap(Fiber.join));

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

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.magi ?? DEFAULT_MAGI_SETTINGS),
    Effect.orDie,
  );

  const getOptions = Effect.gen(function* () {
    const [providerSnapshots, settings, adapterIds] = yield* Effect.all([
      providers.getProviders,
      readSettings,
      adapters.list(),
    ]);
    const childCapable = new Set(adapterIds);
    const providerInstances = providerSnapshots.map((provider) => {
      const unavailableReason =
        provider.compatibilityAdvisory?.status === "broken"
          ? (provider.compatibilityAdvisory.message ??
            "This provider version is known to be incompatible with this T3 Code release.")
          : !childCapable.has(provider.instanceId)
            ? "This provider cannot run T3 child conversations."
            : !provider.enabled
              ? "Provider instance is disabled."
              : !provider.installed
                ? "Provider executable is not installed."
                : !isProviderAvailable(provider)
                  ? (provider.unavailableReason ?? "Provider is unavailable.")
                  : null;
      return {
        instanceId: provider.instanceId,
        displayName: provider.displayName ?? provider.driver,
        models: provider.models.map((model) => model.slug),
        // A model without option metadata gets no entry, so its options go unchecked.
        modelOptions: provider.models.flatMap((model) => {
          const optionDescriptors = model.capabilities?.optionDescriptors;
          return optionDescriptors === undefined ? [] : [{ model: model.slug, optionDescriptors }];
        }),
        available: unavailableReason === null,
        unavailableReason,
      };
    });
    return makeMagiOptionCatalogue(providerInstances, settings.personalities);
  });

  /** Fails unless every participant can start; returns the instances dispatch reads options from. */
  const validateParticipantAvailability = Effect.fn("MagiService.validateParticipantAvailability")(
    function* (participants: ReadonlyArray<MagiParticipantDraft>) {
      const options = yield* getOptions;
      yield* requireAvailableMagiRoster(participants, options.providerInstances);
      return options.providerInstances;
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

  const rememberPanelConfig = (config: MagiRunConfig) =>
    settingsService
      .updateSettings({
        magi: {
          lastPanelRoster: config.participants,
          lastPanelConsensusThresholdPercent: config.consensusThresholdPercent,
          lastPanelMagiTurnLimit: config.magiTurnLimit,
        },
      })
      .pipe(Effect.orDie);

  /** Reads a conversation, treating only a missing thread as absent. */
  const readThreadRecords = <K extends Parameters<typeof threads.getThreadRecords>[1][number]>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: Parameters<typeof threads.getThreadRecords>[2],
  ) =>
    threads.getThreadRecords(threadId, fields, filter).pipe(
      Effect.asSome,
      Effect.catchIf(MagiParticipantPolicy.isMagiThreadNotFound, () => Effect.succeedNone),
    );

  /** Whether the message exists, does not, or could not be read. */
  const messageAcceptance = (threadId: ThreadId, messageId: MessageId) =>
    readThreadRecords(threadId, ["messages"], { messageIds: [messageId] }).pipe(
      Effect.map((records) =>
        Option.isSome(records) && records.value.messages.some((message) => message.id === messageId)
          ? ("accepted" as const)
          : ("absent" as const),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read whether a Magi-armed message was accepted.", {
          threadId,
          messageId,
          cause,
        }).pipe(Effect.as("unknown" as const)),
      ),
    );

  /** Arming needs an idle conversation: no unfinished turn, approval, or user-input request. */
  const requireIdleConversation = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* readThreadRecords(threadId, ["runs", "runtimeRequests"]).pipe(
        Effect.mapError(() =>
          validation(
            "invalid-protocol-state",
            "Could not read this conversation's state to arm Magi; try again.",
          ),
        ),
      );
      // A first-message draft has no conversation yet and is idle.
      if (Option.isNone(records)) return;
      const pendingRequests = records.value.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const busyReason = records.value.runs.some(
        (run) => !ThreadManagement.isTerminalRunStatus(run.status),
      )
        ? "has a turn in progress"
        : pendingRequests.some((request) => request.kind === "user_input")
          ? "is waiting for user input"
          : pendingRequests.length > 0
            ? "is waiting for an approval"
            : null;
      if (busyReason !== null) {
        return yield* validation(
          "invalid-protocol-state",
          `Magi can be armed only while the conversation is idle; this conversation ${busyReason}.`,
        );
      }
    });

  /** Rejects a participant personality that no longer exists instead of running it as Default. */
  const requireKnownPersonalities = (participants: ReadonlyArray<MagiParticipantDraft>) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const unknown = participants.find(
        (participant) =>
          participant.personalityId !== null &&
          !settings.personalities.some(
            (personality) => personality.id === participant.personalityId,
          ),
      );
      if (unknown !== undefined) {
        return yield* validation(
          "unknown-personality",
          `Participant ${unknown.participantId} uses personality ${unknown.personalityId}, which no longer exists. Choose an existing personality or Default.`,
          "config",
        );
      }
      return settings;
    });

  const validateArmConfig = (threadId: ThreadId, input: MagiRunConfig) =>
    Effect.gen(function* () {
      const config = normalizeMagiStartConfig(input);
      const issues = validateMagiRoster(config);
      if (issues[0]) return yield* validation("invalid-config", issues[0].message, "config");
      yield* requireKnownPersonalities(config.participants);
      if (Option.isSome(yield* repository.findActiveRun(threadId).pipe(Effect.orDie))) {
        return yield* validation("magi-run-active", "This thread already has an active Magi run.");
      }
      yield* requireIdleConversation(threadId);
      return config;
    });

  /** A new arm whose revision continues the conversation's counter across disarms. */
  const makeArm = (threadId: ThreadId, config: MagiRunConfig) =>
    Effect.gen(function* () {
      return {
        armId: MagiArmId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        threadId,
        revision: (yield* repository.getArmRevision(threadId).pipe(Effect.orDie)) + 1,
        config,
        armedAt: yield* nowIso,
      } satisfies MagiArmThreadResult;
    });

  /** A pending arm; an arm a message already carried is no longer pending. */
  const pendingArm = (threadId: ThreadId) =>
    repository
      .getArm(threadId)
      .pipe(Effect.orDie, Effect.map(Option.filter((stored) => stored.attachedMessageId === null)));

  const armThread = (input: MagiArmThreadInput) =>
    withArmLock(
      input.threadId,
      Effect.gen(function* () {
        const config = yield* validateArmConfig(input.threadId, input.config);
        const current = yield* pendingArm(input.threadId);
        const revision = Option.match(current, {
          onNone: () => 0,
          onSome: (stored) => stored.arm.revision,
        });
        if (revision !== input.expectedRevision) {
          if (
            input.expectedRevision === 0 &&
            Option.isSome(current) &&
            Equal.equals(normalizeMagiStartConfig(current.value.arm.config), config)
          ) {
            return current.value.arm;
          }
          return yield* validation(
            "invalid-protocol-state",
            "The Magi arm changed on another client.",
            "expectedRevision",
          );
        }
        const arm = yield* makeArm(input.threadId, config);
        yield* repository.putArm(arm).pipe(Effect.orDie);
        return arm;
      }),
    );

  const getArm = (threadId: ThreadId) =>
    pendingArm(threadId).pipe(
      Effect.map((stored) => (Option.isSome(stored) ? stored.value.arm : null)),
    );

  const disarmThread = (threadId: ThreadId, expectedRevision: number) =>
    withArmLock(
      threadId,
      Effect.gen(function* () {
        const current = yield* pendingArm(threadId);
        if (Option.isNone(current) || current.value.arm.revision !== expectedRevision) {
          return yield* validation(
            "invalid-protocol-state",
            "The Magi arm changed on another client.",
            "expectedRevision",
          );
        }
        yield* repository
          .deleteArm({ threadId, armId: current.value.arm.armId })
          .pipe(Effect.orDie);
      }),
    );

  /**
   * Attaches the pending arm, or a new one from `config`, to the message and returns the
   * rewritten message; none when there is nothing to attach. Persisting is its last step.
   */
  const attachArmToMessage = (input: Parameters<MagiServiceShape["sendArmedMessage"]>[0]) =>
    isNativeMaintenanceCommand(input)
      ? Effect.succeedNone
      : withArmLock(
          input.threadId,
          Effect.gen(function* () {
            const stored = yield* repository.getArm(input.threadId).pipe(Effect.orDie);
            const armedMessage = (arm: MagiArmThreadResult) =>
              readSettings.pipe(
                Effect.map((settings): MagiArmedMessage => ({
                  armId: arm.armId,
                  ...withMagiArmContext({
                    armId: arm.armId,
                    instructions: armedTurnInstructions(arm.armId, settings.arbitratorPrompt),
                    text: input.text,
                    context: input.context,
                  }),
                })),
              );
            if (Option.isSome(stored) && stored.value.attachedMessageId === input.messageId) {
              // A retried message keeps the arm it already carries.
              return Option.some(yield* armedMessage(stored.value.arm));
            }
            const pending =
              Option.isSome(stored) && stored.value.attachedMessageId === null
                ? stored.value.arm
                : null;
            if (input.config === undefined && pending === null) return Option.none();
            // A replayed command whose message was already accepted must not take a newer arm.
            const acceptance = yield* messageAcceptance(input.threadId, input.messageId);
            if (acceptance === "accepted") return Option.none();
            if (acceptance === "unknown") {
              return yield* validation(
                "invalid-protocol-state",
                "Could not confirm whether this message was already sent, so Magi stayed armed; try sending it again.",
              );
            }
            const created =
              input.config === undefined
                ? null
                : yield* makeArm(
                    input.threadId,
                    yield* validateArmConfig(input.threadId, input.config),
                  );
            const arm = created ?? pending;
            if (arm === null) return Option.none();
            const message = yield* armedMessage(arm);
            if (created !== null) yield* repository.putArm(created).pipe(Effect.orDie);
            yield* repository
              .setArmAttachment({
                threadId: input.threadId,
                armId: arm.armId,
                messageId: input.messageId,
              })
              .pipe(
                Effect.orDie,
                Effect.onError(() =>
                  created === null
                    ? Effect.void
                    : repository
                        .deleteArm({ threadId: input.threadId, armId: created.armId })
                        .pipe(Effect.ignore),
                ),
              );
            return Option.some(message);
          }),
        );

  /**
   * Call when the message's send failed or was interrupted. Only once the message is known not
   * to exist is the arm returned to pending, or with `discard` cleared; an accepted or uncertain
   * message keeps it.
   */
  const releaseArmAttachment = (input: {
    readonly threadId: ThreadId;
    readonly armId: MagiArmThreadResult["armId"];
    readonly messageId: MessageId;
    readonly discard: boolean;
  }) =>
    withArmLock(
      input.threadId,
      Effect.gen(function* () {
        if ((yield* messageAcceptance(input.threadId, input.messageId)) !== "absent") return;
        yield* input.discard
          ? repository.deleteArm({ threadId: input.threadId, armId: input.armId })
          : repository.setArmAttachment({
              threadId: input.threadId,
              armId: input.armId,
              messageId: null,
            });
      }),
    ).pipe(Effect.ignore);

  // Attachment runs uninterruptibly, so an interruption can land only inside `send`, where the
  // release already covers it.
  const sendArmedMessage: MagiServiceShape["sendArmedMessage"] = (input, send) =>
    Effect.uninterruptibleMask((restore) =>
      attachArmToMessage(input).pipe(
        Effect.flatMap((armed) =>
          Option.isNone(armed)
            ? restore(
                send(
                  input.context === undefined
                    ? { text: input.text }
                    : { text: input.text, context: input.context },
                ),
              )
            : restore(send({ text: armed.value.text, context: armed.value.context })).pipe(
                Effect.onError(() =>
                  releaseArmAttachment({
                    threadId: input.threadId,
                    armId: armed.value.armId,
                    messageId: input.messageId,
                    discard: input.config !== undefined,
                  }),
                ),
              ),
        ),
      ),
    );

  const resolveConversationContext = (
    caller: Pick<MagiCaller, "threadId" | "providerInstanceId">,
  ) =>
    Effect.gen(function* () {
      const records = yield* readThreadRecords(caller.threadId, ["runs", "messages"]).pipe(
        Effect.mapError(() =>
          validation(
            "invalid-protocol-state",
            "Could not read this conversation's state; retry the Magi call.",
          ),
        ),
      );
      if (Option.isNone(records)) {
        return yield* validation("invalid-protocol-state", "The conversation no longer exists.");
      }
      const projection = records.value;
      if (projection.thread.deletedAt !== null) {
        return yield* validation("invalid-protocol-state", "The conversation no longer exists.");
      }
      const currentRun = projection.runs
        .filter(ThreadManagement.isActiveRun)
        .filter((run) => run.providerInstanceId === caller.providerInstanceId)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (currentRun === undefined || currentRun.rootNodeId === null) {
        return yield* validation(
          "invalid-protocol-state",
          "Magi tools require an active run in this conversation.",
        );
      }
      const project = yield* projects
        .get(projection.thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return {
        thread: projection.thread,
        currentRun: { ...currentRun, rootNodeId: currentRun.rootNodeId },
        initiatingInstruction:
          projection.messages.find((message) => message.id === currentRun.userMessageId)?.text ??
          null,
        cwd:
          projection.thread.worktreePath ??
          (Option.isSome(project) ? project.value.workspaceRoot : null),
      } satisfies MagiConversationContext;
    });

  const loadRunToolItems = (root: MagiConversationContext) =>
    threads
      .getThreadRecords(root.thread.id, ["turnItems"], {
        turnItemRunIds: [root.currentRun.id],
        turnItemTypes: MAGI_EVIDENCE_TURN_ITEM_TYPES,
        turnItemStatuses: MAGI_EVIDENCE_TURN_ITEM_STATUSES,
      })
      .pipe(
        Effect.map((records) => records.turnItems),
        Effect.mapError(() =>
          validation("invalid-protocol-state", "Could not read this conversation's tool results."),
        ),
      );

  const listContextActivities = (caller: MagiCaller) =>
    Effect.gen(function* () {
      const root = yield* resolveConversationContext(caller);
      const items = yield* loadRunToolItems(root);
      return { activities: listMagiContextActivities(items) };
    });

  /** Snapshots selected results and addresses them to every participant of the run. */
  const resolveAndStoreContextArtifacts = (input: {
    readonly root: MagiConversationContext;
    readonly activityIds: ReadonlyArray<TurnItemId>;
    readonly run: PersistedMagiRun;
    readonly magiTurn: number;
  }) =>
    Effect.gen(function* () {
      if (input.activityIds.length === 0) return [];
      const resolved = yield* resolveMagiContextActivities({
        items: yield* loadRunToolItems(input.root),
        currentRunId: input.root.currentRun.id,
        activityIds: input.activityIds,
        runId: input.run.detail.summary.runId,
        magiTurn: input.magiTurn,
      });
      yield* repository
        .putContextArtifacts({
          runId: input.run.detail.summary.runId,
          artifacts: resolved.artifacts,
          participantThreadIds: asProtocol(input.run.protocol).members.map(
            (member) => member.threadId,
          ),
        })
        .pipe(Effect.orDie);
      return resolved.references;
    });

  const readContextArtifacts: MagiServiceShape["readContextArtifacts"] = (caller, input) =>
    repository
      .readContextArtifacts({
        participantThreadId: caller.threadId,
        artifactIds: input.artifactIds,
      })
      .pipe(
        Effect.orDie,
        Effect.flatMap((granted) =>
          orderMagiContextArtifacts({ granted, artifactIds: input.artifactIds }),
        ),
      );

  /** A run's audience: the owner followed by the conversations that delegated to it. */
  const subagentLineage = participantPolicy.subagentLineage;

  /** Participants and their subagents cannot start Magi; see `MagiParticipantPolicy`. */
  const rejectParticipantStart = (threadId: ThreadId) =>
    participantPolicy
      .decide({ action: "start-magi", callerThreadId: threadId })
      .pipe(
        Effect.flatMap((decision) =>
          decision.allowed
            ? Effect.void
            : Effect.fail(validation("recursive-start", decision.message)),
        ),
      );

  const nowMeasuredAt = nowIso;

  const readParticipantUsage = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(threadId, ["providerThreads"]);
      const providerThread =
        records.providerThreads.find(
          (candidate) => candidate.id === records.thread.activeProviderThreadId,
        ) ?? records.providerThreads.at(-1);
      const snapshot = providerThread?.contextUsage ?? null;
      if (snapshot === null) return null;
      return {
        usage: {
          usedTokens: snapshot.usedTokens,
          limitTokens: snapshot.maxTokens ?? null,
          measuredAt: yield* nowMeasuredAt,
        },
        automatic: snapshot.compactsAutomatically === true,
      } satisfies ParticipantUsage;
    }).pipe(Effect.orElseSucceed(() => null));

  const readRunTokens = (threadId: ThreadId, runIds: ReadonlyArray<RunId>) =>
    threads.getThreadRecords(threadId, ["runs", "attempts", "providerTurns"], { runIds }).pipe(
      Effect.map((records) => sumMagiRunTokenUsage({ ...records, runIds })),
      Effect.orElseSucceed(() => ({ inputTokens: null, outputTokens: null })),
    );

  /** The run's stored record when it is already terminal. */
  const readTerminalRun = (threadId: ThreadId, runId: RunId) =>
    threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map((records) =>
        Option.fromNullishOr(
          records.runs.find(
            (run) => run.id === runId && ThreadManagement.isTerminalRunStatus(run.status),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Option.none<OrchestrationV2Run>()),
    );

  /**
   * Waits for a participant run's terminal record. The event stream replays from `afterSequence`,
   * so a failed stream is resubscribed without missing the event. None means the outcome is
   * unknown and the run may still be working, so callers must not start another turn for it.
   */
  const awaitRunTerminal = (threadId: ThreadId, runId: RunId, afterSequence: number) =>
    threads.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.map((stored) => stored.event),
      Stream.filter(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          ThreadManagement.isTerminalRunStatus(event.payload.status),
      ),
      Stream.runHead,
      Effect.map(
        Option.flatMap((event) =>
          event.type === "run.updated" ? Option.some(event.payload) : Option.none(),
        ),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Magi lost a participant run's event stream; resubscribing.", {
          threadId,
          runId,
          error,
        }),
      ),
      Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }),
      Effect.catch(() => readTerminalRun(threadId, runId)),
    );

  const readRunText = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["messages", "turnItems"], {
        messageRunIds: [run.id],
        turnItemRunIds: [run.id],
        turnItemTypes: ["assistant_message", "error"],
      })
      .pipe(
        Effect.map((records) => subagentResultForRun(records, run).text),
        Effect.orElseSucceed(() => ""),
      );

  /**
   * Starts one participant turn: the first turn creates the participant as a delegated child of
   * the owner's current run; later turns, retries, and repairs continue the same child thread.
   */
  const startParticipantTurn = (input: {
    readonly owner: MagiConversationContext;
    readonly runId: MagiRunId;
    readonly member: ProtocolMember;
    readonly magiTurn: number;
    readonly stage: "turn" | "retry" | "repair" | "compact";
    readonly text: string;
    readonly providerInstances: MagiGetOptionsResult["providerInstances"];
  }) =>
    Effect.gen(function* () {
      if (input.magiTurn === 1 && input.stage === "turn") {
        const commandId = participantCommandId(input.runId, input.member.participant.participantId);
        const result = yield* threads.dispatch({
          type: "delegated_task.request",
          createdBy: "system",
          creationSource: "server",
          commandId,
          parentThreadId: input.owner.thread.id,
          parentRunId: input.owner.currentRun.id,
          parentNodeId: input.owner.currentRun.rootNodeId,
          task: input.text,
          title: `Magi: ${participantLabel(input.member)}`,
          modelSelection: participantDispatchModelSelection(
            input.member.participant.modelSelection,
            input.providerInstances,
          ),
          runtimeMode: input.owner.thread.runtimeMode,
          interactionMode: input.owner.thread.interactionMode,
          completionWake: "settled_only",
        });
        // Magi collects participant results itself; the owner's run is never woken by them.
        const task = result.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
        );
        if (task?.event.type === "subagent.updated") {
          yield* threads
            .dispatch({
              type: "delegated_task.completion-delivery.dispose",
              commandId: CommandId.make(`${commandId}:dispose`),
              parentThreadId: input.owner.thread.id,
              taskId: task.event.payload.id,
            })
            .pipe(Effect.ignore);
        }
        const childRun = result.storedEvents.find(
          (stored) =>
            (stored.event.type === "run.created" || stored.event.type === "run.updated") &&
            stored.event.threadId === input.member.threadId,
        );
        if (childRun?.event.type !== "run.created" && childRun?.event.type !== "run.updated") {
          return yield* Effect.fail("participant-run-missing" as const);
        }
        return { runId: childRun.event.payload.id, sequence: result.sequence };
      }
      const key = participantTurnKey({
        runId: input.runId,
        magiTurn: input.magiTurn,
        participantId: input.member.participant.participantId,
        stage: input.stage,
      });
      const sent = yield* threads.sendToThread({
        projectId: input.owner.thread.projectId,
        commandId: CommandId.make(key),
        threadId: input.member.threadId,
        messageId: MessageId.make(key),
        text: input.text,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
      return { runId: sent.run.id, sequence: sent.dispatch.sequence };
    });

  const interruptParticipantRun = (input: {
    readonly owner: Pick<MagiConversationContext, "thread">;
    readonly runId: MagiRunId;
    readonly member: ProtocolMember;
    readonly magiTurn: number;
  }) =>
    threads
      .interruptThread({
        projectId: input.owner.thread.projectId,
        commandId: CommandId.make(
          participantTurnKey({
            runId: input.runId,
            magiTurn: input.magiTurn,
            participantId: input.member.participant.participantId,
            stage: "interrupt",
          }),
        ),
        threadId: input.member.threadId,
        reason: "The Magi run was stopped.",
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error._tag === "ThreadManagementThreadNotFoundError"
            ? Effect.succeed(true)
            : Effect.logError("Failed to interrupt a Magi participant.", {
                runId: input.runId,
                participantThreadId: input.member.threadId,
                error,
              }).pipe(Effect.as(false)),
        ),
      );

  const runParticipant = (input: {
    readonly owner: MagiConversationContext;
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
    readonly providerInstances: MagiGetOptionsResult["providerInstances"];
  }): Effect.Effect<MagiParticipantSettlement, never> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const participantId = input.member.participant.participantId;
      const participantThreadId = input.member.threadId;
      const failed = (
        failureClass: string,
        counts: {
          readonly retryCount?: number;
          readonly providerAttempts?: number;
          readonly contextCompressed?: boolean;
        } = {},
      ) =>
        Effect.map(Clock.currentTimeMillis, (now): MagiParticipantSettlement => ({
          participantId,
          participantThreadId,
          participantRunId: null,
          rawText: "",
          parsed: null,
          parseMode: "raw",
          state: "failed",
          durationMs: now - startedAt,
          inputTokens: null,
          outputTokens: null,
          retryCount: counts.retryCount ?? 0,
          providerAttempts: counts.providerAttempts ?? 0,
          structuralRepairCount: 0,
          reconstructed: false,
          failureClass,
          contextCompressed: counts.contextCompressed ?? false,
        }));
      const providerFiber = yield* Effect.gen(function* () {
        yield* input.onStateChange("running");
        const promptInput = {
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
        };
        const prompt = buildMagiParticipantPrompt(promptInput);
        const compressedPrompt = buildMagiParticipantPrompt({
          ...promptInput,
          priorSettlements: input.priorSettlements.map((settlement) => ({
            ...settlement,
            rawText:
              settlement.parsed === null
                ? "[Free-form peer evidence compressed by T3; inspect the durable transcript for the original.]"
                : settlement.rawText,
          })),
        });
        let providerAttempts = 0;
        const dispatchedRunIds: Array<RunId> = [];
        const dispatch = (text: string, stage: "turn" | "retry" | "repair" | "compact") =>
          Effect.gen(function* () {
            providerAttempts += 1;
            const started = yield* startParticipantTurn({
              owner: input.owner,
              runId: input.runId,
              member: input.member,
              magiTurn: input.magiTurn,
              stage,
              text,
              providerInstances: input.providerInstances,
            }).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Magi participant turn could not start.", {
                  runId: input.runId,
                  participantThreadId,
                  stage,
                  error,
                }),
              ),
              Effect.option,
            );
            if (Option.isNone(started)) return Option.none();
            dispatchedRunIds.push(started.value.runId);
            const run = yield* awaitRunTerminal(
              participantThreadId,
              started.value.runId,
              started.value.sequence,
            );
            const rawText = Option.isSome(run)
              ? yield* readRunText(participantThreadId, run.value)
              : "";
            return Option.some({ runId: started.value.runId, run, rawText });
          });

        // Participant history belongs to the participant's harness. Only when the next request
        // would not fit and the harness does not compact on its own is compaction requested.
        const usageBefore =
          input.magiTurn === 1 ? null : yield* readParticipantUsage(participantThreadId);
        const promptTokens = (value: string) => Math.ceil(value.length / 4);
        const capacity = yield* resolveMagiPromptCapacity({
          usage: usageBefore?.usage ?? null,
          fullPromptTokens: promptTokens(prompt),
          compressedPromptTokens: promptTokens(compressedPrompt),
          historyCompaction:
            usageBefore === null
              ? undefined
              : usageBefore.automatic
                ? "automatic-native"
                : "explicit-native",
          compact: dispatch("/compact", "compact").pipe(
            Effect.map(
              (result) =>
                Option.isSome(result) &&
                Option.isSome(result.value.run) &&
                result.value.run.value.status === "completed",
            ),
          ),
          readUsage: readParticipantUsage(participantThreadId).pipe(
            Effect.map((usage) => usage?.usage ?? null),
          ),
        });
        const dispatchPrompt = capacity.dispatchPrompt === "compressed" ? compressedPrompt : prompt;
        const contextCompressed = capacity.contextCompressed || dispatchPrompt !== prompt;
        if (capacity.exceeded) {
          return yield* failed("context-window-exceeded", { contextCompressed });
        }
        let attempt = yield* dispatch(dispatchPrompt, "turn");
        let retryCount = 0;
        let structuralRepairCount = 0;
        // Retry a turn that could not start or that ended unsuccessfully. A run whose outcome is
        // unknown may still be working, so it is never retried alongside itself.
        const transientFailure = Option.isNone(attempt)
          ? input.magiTurn !== 1
          : Option.isSome(attempt.value.run) && attempt.value.run.value.status !== "completed";
        if (transientFailure) {
          retryCount = 1;
          attempt = yield* dispatch(dispatchPrompt, "retry");
        }
        if (Option.isNone(attempt)) {
          return yield* failed("turn-start-failed", { retryCount, providerAttempts });
        }
        let result = attempt.value;
        let parsed = parseMagiParticipantResponse(result.rawText);
        if (
          Option.isSome(result.run) &&
          result.run.value.status === "completed" &&
          parsed.parsed === null
        ) {
          retryCount += 1;
          structuralRepairCount = 1;
          const repaired = yield* dispatch(
            `Your last Magi response could not be decoded with the required schema. Preserve its substantive assessment, justify your ballot with at least one rationale entry, and return only one JSON object matching this schema:\n${encodeUnknownJson(MAGI_PARTICIPANT_OUTPUT_SCHEMA)}\n\nYour preceding response:\n${result.rawText.slice(0, 24_000)}`,
            "repair",
          );
          if (Option.isSome(repaired)) {
            result = repaired.value;
            parsed = parseMagiParticipantResponse(result.rawText);
          }
        }
        const completed = Option.isSome(result.run) && result.run.value.status === "completed";
        const tokens = yield* readRunTokens(participantThreadId, dispatchedRunIds);
        return {
          participantId,
          participantThreadId,
          participantRunId: result.runId,
          rawText: result.rawText,
          parsed: parsed.parsed,
          parseMode: parsed.parseMode,
          state: completed ? "settled" : "failed",
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          retryCount,
          providerAttempts,
          structuralRepairCount,
          reconstructed: false,
          failureClass: completed
            ? null
            : Option.isNone(result.run)
              ? "turn-event-unavailable"
              : `provider-${result.run.value.status}`,
          contextCompressed,
        } satisfies MagiParticipantSettlement;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Magi participant failed unexpectedly", cause).pipe(
            Effect.andThen(failed("unexpected")),
          ),
        ),
        // A child of the deliberation, so it ends with the deliberation and the service.
        Effect.forkChild,
      );
      return yield* Effect.raceFirst(
        Fiber.join(providerFiber),
        Effect.gen(function* () {
          yield* Deferred.await(input.cancellation);
          yield* Fiber.interrupt(providerFiber).pipe(Effect.forkDetach);
          yield* interruptParticipantRun({
            owner: input.owner,
            runId: input.runId,
            member: input.member,
            magiTurn: input.magiTurn,
          });
          return cancelledMagiParticipantSettlement({
            participantId,
            participantThreadId,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          });
        }),
      );
    });

  const interruptParticipants = (run: PersistedMagiRun) =>
    Effect.gen(function* () {
      const owner = yield* threads
        .getThreadRecords(run.detail.summary.rootThreadId, [])
        .pipe(Effect.option);
      if (Option.isNone(owner)) return true;
      const protocol = asProtocol(run.protocol);
      const results = yield* Effect.forEach(
        protocol.members,
        (member) =>
          interruptParticipantRun({
            owner: owner.value,
            runId: run.detail.summary.runId,
            member,
            magiTurn: protocol.turns.length + 1,
          }),
        { concurrency: MAGI_PARTICIPANT_TURN_CONCURRENCY },
      );
      return results.every(Boolean);
    });

  /** Refreshes the history of every conversation in each run's audience. */
  const publishChanges = (runs: ReadonlyArray<PersistedMagiRun>) =>
    Effect.forEach(
      runs,
      (run) =>
        PubSub.publish(changes, {
          runId: run.detail.summary.runId,
          audienceThreadIds: run.audienceThreadIds,
        }),
      { discard: true },
    );

  const persist = (run: PersistedMagiRun) =>
    repository.putRun(run).pipe(
      Effect.tap(() => publishChanges([run])),
      Effect.catch((error) => {
        if (!isDeletedRootMagiPersistenceError(error)) return Effect.die(error);
        return Effect.gen(function* () {
          yield* signalRunCancellation(run.detail.summary.runId);
          if (yield* interruptParticipants(run)) {
            yield* clearRunCancellation(run.detail.summary.runId);
          }
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
      stopParticipants: interruptParticipants(run),
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

  /** The result a deliberation returns when it finds its run stopped. */
  const stoppedDeliberationResult = (
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

  /** A run's latest Magi turn, as `magi_start` and `magi_deliberate` return it. */
  const latestTurnResult = (run: PersistedMagiRun, turn: ProtocolTurn): MagiDeliberationResult => {
    const protocol = asProtocol(run.protocol);
    const threshold = calculateMagiThreshold(
      run.detail.config.participants,
      run.detail.config.consensusThresholdPercent,
    );
    return {
      runId: run.detail.summary.runId,
      magiTurn: turn.magiTurn,
      candidateFingerprint:
        turn.candidate === null ? null : magiCandidateFingerprint(turn.candidate, protocol.actions),
      participants: projectMagiParticipantEvidenceList(turn.settlements),
      totalWeight: threshold.totalWeight,
      requiredWeight: threshold.requiredWeight,
      thresholdReachable:
        settledMagiWeight(run.detail.config, turn.settlements) >= threshold.requiredWeight,
      pendingProposalIds: calculateMagiProposalOutcomes({
        magiTurn: turn.magiTurn,
        proposals: protocol.proposals,
        participants: run.detail.config.participants,
        settlements: turn.settlements,
        requiredWeight: threshold.requiredWeight,
      })
        .filter((outcome) => outcome.pending)
        .map((outcome) => outcome.proposalId),
      controlInstructions: arbitratorResultInstructions(run),
    };
  };

  /**
   * Handles the driving owner run ending while the owner still owes the next Magi call. The first
   * time, a control message continues the protocol in a new owner turn; after that, the run fails
   * as a protocol failure. Call under the run lock with the latest run.
   */
  const continueAfterOwnerRunEnded = (run: PersistedMagiRun) =>
    Effect.gen(function* () {
      const protocol = asProtocol(run.protocol);
      const { runId, rootThreadId, state } = run.detail.summary;
      if (protocol.controlContinuationRunId === null) {
        const owner = yield* readThreadRecords(rootThreadId, []).pipe(
          Effect.orElseSucceed(() => Option.none()),
        );
        const continuationRunId = Option.isNone(owner)
          ? Option.none<RunId>()
          : yield* threads
              .sendToThread({
                projectId: owner.value.thread.projectId,
                commandId: CommandId.make(`magi:${runId}:control-continuation`),
                threadId: rootThreadId,
                messageId: MessageId.make(`magi:${runId}:control-continuation`),
                text: magiControlContinuationPrompt(runId, state),
                attachments: [],
                mode: "queue",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.map((sent) => Option.some(sent.run.id)),
                Effect.catchCause((cause) =>
                  Effect.logError("Magi could not continue the owner's protocol.", cause).pipe(
                    Effect.as(Option.none<RunId>()),
                  ),
                ),
              );
        if (Option.isSome(continuationRunId)) {
          yield* persist({
            ...run,
            mainRunId: continuationRunId.value,
            updatedAt: yield* nowIso,
            protocol: {
              ...protocol,
              controlContinuationRunId: continuationRunId.value,
            } satisfies MagiProtocolState,
          });
          return;
        }
      }
      const updatedAt = yield* nowIso;
      const failed: PersistedMagiRun = {
        ...run,
        updatedAt,
        detail: {
          ...run.detail,
          summary: { ...run.detail.summary, state: "failed", completedAt: updatedAt },
          activity: { ...run.detail.activity, state: "failed" },
        },
      };
      yield* persist(failed);
      yield* increment(magiRunsTotal, {
        source: run.detail.summary.source,
        phase: "terminal",
        outcome: "failed",
        consensusTurn: null,
        limitExhausted: false,
      });
      yield* cleanupTerminalRun(failed);
    });

  /** Fans out one claimed Magi turn, then records its settlements under the run lock. */
  const executeDeliberation = (input: {
    readonly run: PersistedMagiRun;
    readonly root: MagiConversationContext;
    readonly magiTurn: number;
    readonly activities: ReadonlyArray<MagiActivityReference>;
    readonly cancellation: Deferred.Deferred<void>;
    readonly providerInstances: MagiGetOptionsResult["providerInstances"];
  }) =>
    Effect.gen(function* () {
      const { run, root, magiTurn, activities, cancellation } = input;
      const runId = run.detail.summary.runId;
      const protocol = asProtocol(run.protocol);
      const priorTurn = protocol.turns.at(-1);
      const candidate = priorTurn?.arbitration?.candidate ?? null;
      const unresolvedDisagreements = priorTurn?.arbitration?.disagreements ?? [];
      const recordedActions = protocol.actions;
      const publishMemberState = (
        participantId: MagiParticipantDraft["participantId"],
        state: MagiMemberState,
      ) =>
        withRunLock(
          runId,
          Effect.gen(function* () {
            const latest = yield* repository.getRun(runId).pipe(Effect.orDie);
            if (Option.isNone(latest) || isMagiRunTerminal(latest.value.detail.summary.state))
              return;
            const latestProtocol = asProtocol(latest.value.protocol);
            yield* persist({
              ...latest.value,
              detail: {
                ...latest.value.detail,
                participants: latest.value.detail.participants.map((participant) =>
                  participant.participantId === participantId
                    ? { ...participant, state }
                    : participant,
                ),
              },
              protocol: {
                ...latestProtocol,
                members: latestProtocol.members.map((member) =>
                  member.participant.participantId === participantId
                    ? { ...member, state }
                    : member,
                ),
              } satisfies MagiProtocolState,
              updatedAt: yield* nowIso,
            });
          }),
        );
      const currentActiveProposals = activeMagiProposals(protocol.proposals);
      const currentActiveDecisionSets = activeMagiDecisionSets(protocol.decisionSets);
      const settlements = yield* Effect.forEach(
        protocol.members,
        (member) =>
          runParticipant({
            owner: root,
            runId,
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
            providerInstances: input.providerInstances,
          }).pipe(
            Effect.withSpan("magi.participant", {
              attributes: {
                "magi.run_id": runId,
                "magi.participant_id": member.participant.participantId,
                "provider.instance_id": member.participant.modelSelection.instanceId,
              },
            }),
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
      return yield* withRunLock(
        runId,
        Effect.gen(function* () {
          const latest = yield* repository.getRun(runId).pipe(Effect.orDie);
          const cancellationRequested = Option.isSome(yield* Deferred.poll(cancellation));
          if (Option.isNone(latest) && !cancellationRequested) {
            return yield* validation("invalid-protocol-state", deletedRootMagiValidationMessage);
          }
          if (
            cancellationRequested ||
            Option.isNone(latest) ||
            isMagiRunTerminal(latest.value.detail.summary.state)
          ) {
            return {
              runId,
              magiTurn,
              candidateFingerprint,
              participants: projectMagiParticipantEvidenceList(settlements),
              totalWeight: totalWeight.totalWeight,
              requiredWeight: totalWeight.requiredWeight,
              thresholdReachable: false,
              pendingProposalIds: [],
              controlInstructions: `${MAGI_ARBITRATOR_RESULT_PROTOCOL}\n\n${
                cancellationRequested ||
                Option.isNone(latest) ||
                latest.value.detail.summary.state === "cancelled"
                  ? "The user cancelled this Magi run. Acknowledge the cancellation and finish the main turn. Do not deliberate, retry, or arbitrate it again."
                  : `This Magi run ended with state ${latest.value.detail.summary.state}. Report that terminal state and make no further Magi calls for this run.`
              }`,
            } satisfies MagiDeliberationResult;
          }
          const latestRun = latest.value;
          const latestProtocol = asProtocol(latestRun.protocol);
          const proposals = collectMagiProposals(
            runId,
            magiTurn,
            settlements,
            latestProtocol.proposals,
          );
          const proposalOutcomes = calculateMagiProposalOutcomes({
            magiTurn,
            proposals,
            participants: run.detail.config.participants,
            settlements,
            requiredWeight: totalWeight.requiredWeight,
          });
          // A pause during the fan-out holds; resuming it continues with arbitration.
          const pausedState = MAGI_PAUSE_STATES.has(latestRun.detail.summary.state)
            ? latestRun.detail.summary.state
            : null;
          const state: MagiRunState = pausedState ?? "awaiting-arbitration";
          const nextProtocol: MagiProtocolState = {
            ...latestProtocol,
            pendingContextArtifacts: [],
            members: latestProtocol.members.map((member) => ({
              ...member,
              state: latestMagiMemberState(
                member.participant.participantId,
                member.state,
                settlements,
              ),
            })),
            proposals,
            turns: [
              ...latestProtocol.turns,
              { magiTurn, candidate, settlements, arbitration: null, activities },
            ],
            stateBeforePause:
              pausedState === null ? latestProtocol.stateBeforePause : "awaiting-arbitration",
          };
          const next = {
            ...latestRun,
            detail: {
              ...latestRun.detail,
              summary: { ...latestRun.detail.summary, state, completedMagiTurns: magiTurn },
              activity: calculateMagiActivityMetrics({
                runId,
                source: run.detail.summary.source,
                state,
                completedMagiTurns: magiTurn,
                magiTurnLimit: run.detail.config.magiTurnLimit,
                totalWeight: totalWeight.totalWeight,
                requiredWeight: totalWeight.requiredWeight,
                comparableOutcomes: pendingMagiComparableOutcomes(latestRun.detail.activity),
              }),
              settlements: [...latestRun.detail.settlements, ...settlements],
              participants: latestRun.detail.participants.map((participant) => ({
                ...participant,
                state: latestMagiMemberState(
                  participant.participantId,
                  participant.state,
                  settlements,
                ),
              })),
              candidate,
              actions: recordedActions,
            },
            protocol: nextProtocol,
            updatedAt: yield* nowIso,
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
          // The owner's turn can end while participants run, for example after its tool call
          // was cancelled; nobody would arbitrate this turn without a continuation.
          if (state === "awaiting-arbitration" && next.mainRunId !== null) {
            const drivingRun = yield* readTerminalRun(
              next.detail.summary.rootThreadId,
              next.mainRunId,
            );
            if (Option.isSome(drivingRun) && drivingRun.value.status === "completed") {
              yield* continueAfterOwnerRunEnded(next).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Magi could not continue after the owner's turn ended.", cause),
                ),
              );
            }
          }
          return {
            runId,
            magiTurn,
            candidateFingerprint,
            participants: projectMagiParticipantEvidenceList(settlements),
            totalWeight: totalWeight.totalWeight,
            requiredWeight: totalWeight.requiredWeight,
            thresholdReachable:
              settledMagiWeight(run.detail.config, settlements) >= totalWeight.requiredWeight,
            pendingProposalIds: proposalOutcomes
              .filter((outcome) => outcome.pending)
              .map((outcome) => outcome.proposalId),
            controlInstructions: arbitratorResultInstructions(run),
          } satisfies MagiDeliberationResult;
        }),
      );
    });

  /**
   * Performs one Magi turn. The turn is claimed under the run lock by moving the run from
   * `expectedState` to `deliberating`; participants then run without the lock, and the outcome is
   * published for any retried call that waits on it. Turn 1 also claims a run that an owner pause
   * reached between creation and the claim, keeping the pause as a mid-turn pause is kept.
   */
  const runDeliberation = (input: {
    readonly runId: MagiRunId;
    readonly request: MagiDeliberateInput;
    readonly caller: MagiCaller;
    readonly providerInstances: MagiGetOptionsResult["providerInstances"];
    /** Turn 1 starts from the new run's `deliberating`; later turns from `awaiting-next-turn`. */
    readonly expectedState: MagiRunState;
  }) =>
    Effect.gen(function* () {
      const runId = input.runId;
      yield* Effect.annotateCurrentSpan({ "magi.run_id": runId });
      const cancellation = yield* getRunCancellation(runId);
      const claim = yield* withRunLock(
        runId,
        Effect.gen(function* () {
          const latest = yield* repository.getRun(runId).pipe(Effect.orDie);
          const cancellationRequested = Option.isSome(yield* Deferred.poll(cancellation));
          if (Option.isNone(latest)) {
            yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
            return yield* validation("invalid-protocol-state", deletedRootMagiValidationMessage);
          }
          const run = latest.value;
          if (
            !shouldPersistMagiDeliberationContext(run.detail.summary.state, cancellationRequested)
          ) {
            yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
            return {
              _tag: "stopped" as const,
              result: stoppedDeliberationResult(run, cancellationRequested),
            };
          }
          const protocol = asProtocol(run.protocol);
          const heldPause =
            input.expectedState === "deliberating" &&
            MAGI_PAUSE_STATES.has(run.detail.summary.state) &&
            protocol.stateBeforePause === "deliberating";
          if (run.detail.summary.state !== input.expectedState && !heldPause) {
            return yield* validation(
              "invalid-protocol-state",
              "Magi is not awaiting another deliberation.",
            );
          }
          const claimedState = heldPause ? run.detail.summary.state : "deliberating";
          const root = yield* resolveConversationContext(input.caller);
          const magiTurn = protocol.turns.length + 1;
          const activities =
            protocol.pendingContextArtifacts.length > 0
              ? protocol.pendingContextArtifacts
              : yield* resolveAndStoreContextArtifacts({
                  root,
                  activityIds: input.request.contextActivityIds,
                  run,
                  magiTurn,
                });
          const claimed: PersistedMagiRun = {
            ...run,
            mainRunId: root.currentRun.id,
            updatedAt: yield* nowIso,
            protocol: {
              ...protocol,
              pendingContextArtifacts: activities,
              members: protocol.members.map((member) => ({
                ...member,
                state: "pending" as const,
              })),
            } satisfies MagiProtocolState,
            detail: {
              ...run.detail,
              summary: { ...run.detail.summary, state: claimedState },
              activity: { ...run.detail.activity, state: claimedState },
              participants: run.detail.participants.map((participant) => ({
                ...participant,
                state: "pending" as const,
              })),
            },
          };
          yield* persist(claimed);
          const outcome = yield* Deferred.make<MagiDeliberationResult, MagiValidationError>();
          yield* Ref.update(liveDeliberations, (current) => new Map(current).set(runId, outcome));
          return { _tag: "claimed" as const, run: claimed, root, magiTurn, activities, outcome };
        }),
      );
      if (claim._tag === "stopped") return claim.result;
      return yield* executeDeliberation({
        run: claim.run,
        root: claim.root,
        magiTurn: claim.magiTurn,
        activities: claim.activities,
        cancellation,
        providerInstances: input.providerInstances,
      }).pipe(
        Effect.onExit((exit) =>
          Deferred.done(claim.outcome, exit).pipe(
            Effect.andThen(
              Ref.update(liveDeliberations, (current) => {
                if (current.get(runId) !== claim.outcome) return current;
                const next = new Map(current);
                next.delete(runId);
                return next;
              }),
            ),
          ),
        ),
      );
    });

  /** Creates a run and its turn-1 evidence; the caller then deliberates turn 1. */
  const createRun = (input: {
    readonly root: MagiConversationContext;
    readonly config: MagiRunConfig;
    readonly source: MagiRunSource;
    readonly objective: string;
    readonly initiatingReferenceId: string | null;
    readonly initiatingInstruction: string;
    readonly contextActivityIds: ReadonlyArray<TurnItemId>;
  }) =>
    Effect.gen(function* () {
      const rootThreadId = input.root.thread.id;
      const issues = validateMagiRoster(input.config);
      if (issues[0]) return yield* validation("invalid-config", issues[0].message, "config");
      const settings = yield* requireKnownPersonalities(input.config.participants);
      if (Option.isSome(yield* repository.findActiveRun(rootThreadId).pipe(Effect.orDie))) {
        return yield* validation("magi-run-active", "This thread already has an active Magi run.");
      }
      const providerInstances = yield* validateParticipantAvailability(input.config.participants);
      const runId = MagiRunId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const startedAt = yield* nowIso;
      // Participant thread ids derive from their creation commands, so evidence can be
      // addressed to each participant before its conversation exists.
      const members = input.config.participants.map(
        (participant) =>
          ({
            participant,
            personality:
              settings.personalities.find(
                (personality) => personality.id === participant.personalityId,
              ) ?? null,
            threadId: IdAllocator.derive.delegatedTaskThread({
              commandId: participantCommandId(runId, participant.participantId),
            }),
            state: "pending" as const,
          }) satisfies ProtocolMember,
      );
      const threshold = calculateMagiThreshold(
        input.config.participants,
        input.config.consensusThresholdPercent,
      );
      const detail: MagiRunDetail = {
        summary: {
          runId,
          rootThreadId,
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
      const created: PersistedMagiRun = {
        detail,
        initiatingReferenceId: input.initiatingReferenceId,
        initiatingInstruction: input.initiatingInstruction,
        focusedObjective: input.objective,
        arbitratorPrompt: settings.arbitratorPrompt,
        protocol: {
          members,
          turns: [],
          pendingContextArtifacts: [],
          proposals: [],
          terminalProposalDigest: [],
          decisionSets: [],
          actions: [],
          reconciliations: [],
          stateBeforePause: null,
          cleanupPending: false,
          controlContinuationRunId: null,
          pendingBatch: null,
        } satisfies MagiProtocolState,
        updatedAt: startedAt,
        mainRunId: input.root.currentRun.id,
        mainMessageId: input.root.currentRun.userMessageId,
        audienceThreadIds: yield* subagentLineage(input.root.thread),
      };
      const activities = yield* resolveAndStoreContextArtifacts({
        root: input.root,
        activityIds: input.contextActivityIds,
        run: created,
        magiTurn: 1,
      });
      const persisted: PersistedMagiRun = {
        ...created,
        protocol: {
          ...asProtocol(created.protocol),
          pendingContextArtifacts: activities,
        } satisfies MagiProtocolState,
      };
      yield* persist(persisted);
      yield* increment(magiRunsTotal, { source: input.source, phase: "started" });
      const titleUpdate = (title: MagiRunDetail["summary"]["title"]) =>
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
                      summary: { ...latest.value.detail.summary, title },
                    },
                  })
                : Effect.void,
            ),
          ),
        );
      yield* textGeneration
        .generateThreadTitle({
          cwd: input.root.cwd ?? ".",
          message: `Write only a short, specific noun phrase naming this run's subject. Base it on the initiating instruction and focused objective. Exclude Magi, models, participants, consensus mechanics, tools, and completion status.\n\nInitiating instruction:\n${input.initiatingInstruction}\n\nFocused objective:\n${input.objective}`,
          modelSelection: (yield* settingsService.getSettings.pipe(Effect.orDie))
            .textGenerationModelSelection,
        })
        .pipe(
          Effect.flatMap((generated) =>
            titleUpdate({ state: "generated", title: generated.title }),
          ),
          Effect.catch(() => titleUpdate(failedMagiRunTitle())),
          Effect.ignore,
          Effect.forkIn(serviceScope),
        );
      return { run: persisted, providerInstances };
    });

  const startFromTool = (caller: MagiCaller, input: MagiStartInput) =>
    inService(
      Effect.gen(function* () {
        const started = yield* withStartLock(
          caller.threadId,
          Effect.gen(function* () {
            yield* rejectParticipantStart(caller.threadId);
            const root = yield* resolveConversationContext(caller);
            // A retry of this call, identified by its arm or by its provider session and owner
            // run, returns the run it started, and only to the conversation that owns it.
            const runScopedReference = encodeInvocationReference([
              caller.providerSessionId,
              root.currentRun.id,
              input.armId ?? null,
            ]);
            const existing = yield* repository
              .findRunByInitiatingReferenceId({
                rootThreadId: caller.threadId,
                initiatingReferenceId: input.armId ?? runScopedReference,
              })
              .pipe(Effect.orDie);
            if (Option.isSome(existing)) {
              const run = existing.value;
              // A finished run is replayed only for the same request; a different one starts anew.
              const replayable =
                !isMagiRunTerminal(run.detail.summary.state) ||
                (run.focusedObjective === input.objective &&
                  (input.config === undefined ||
                    encodeRunConfig(normalizeMagiStartConfig(run.detail.config)) ===
                      encodeRunConfig(normalizeMagiStartConfig(input.config))));
              const latest = asProtocol(run.protocol).turns.at(-1);
              const live = (yield* Ref.get(liveDeliberations)).get(run.detail.summary.runId);
              if (replayable && latest !== undefined) {
                return {
                  _tag: "replayed" as const,
                  result: Effect.succeed(latestTurnResult(run, latest)),
                };
              }
              if (replayable && live !== undefined) {
                return { _tag: "replayed" as const, result: Deferred.await(live) };
              }
              // A run stopped before turn 1 recorded anything still answers its own retry.
              if (replayable && isMagiRunTerminal(run.detail.summary.state)) {
                return {
                  _tag: "replayed" as const,
                  result: Effect.succeed(stoppedDeliberationResult(run, false)),
                };
              }
            }
            let arm: MagiArmThreadResult | null = null;
            if (input.armId !== undefined) {
              const stored = yield* repository.getArm(caller.threadId).pipe(Effect.orDie);
              if (
                Option.isNone(stored) ||
                stored.value.arm.armId !== input.armId ||
                stored.value.attachedMessageId === null
              ) {
                return yield* validation(
                  "invalid-protocol-state",
                  "This conversation has no armed Magi run with that armId.",
                  "armId",
                );
              }
              arm = stored.value.arm;
            }
            const requestedConfig = arm?.config ?? input.config;
            if (requestedConfig === undefined) {
              return yield* validation(
                "invalid-config",
                "Supply config for a run you configure, or armId for the run the user armed.",
                "config",
              );
            }
            const startSnapshot = resolveMagiStartSnapshot({
              arm,
              requestedConfig,
              toolCallId: runScopedReference,
            });
            const created = yield* createRun({
              root,
              config: startSnapshot.config,
              source: startSnapshot.source,
              objective: input.objective,
              initiatingReferenceId: startSnapshot.initiatingReferenceId,
              initiatingInstruction: root.initiatingInstruction ?? input.objective,
              contextActivityIds: input.contextActivityIds,
            });
            if (arm !== null) {
              const consumed = arm.armId;
              yield* withArmLock(
                caller.threadId,
                repository
                  .deleteArm({ threadId: caller.threadId, armId: consumed })
                  .pipe(Effect.orDie),
              );
              // The remembered panel configuration is the last started panel-configured run's.
              yield* rememberPanelConfig(startSnapshot.config);
            }
            return { _tag: "created" as const, ...created };
          }),
        );
        if (started._tag === "replayed") return yield* started.result;
        const runId = started.run.detail.summary.runId;
        return yield* runDeliberation({
          runId,
          request: { runId, contextActivityIds: input.contextActivityIds },
          caller,
          providerInstances: started.providerInstances,
          expectedState: "deliberating",
        }).pipe(
          Effect.withSpan("magi.turn", {
            attributes: { "magi.run_id": runId, "magi.turn": 1 },
          }),
        );
      }),
    );

  const requireRun = (runId: MagiRunId, caller?: Pick<MagiCaller, "threadId">) =>
    repository.getRun(runId).pipe(
      // An unreadable snapshot is permanent; fail the call instead of defecting the
      // client's whole RPC connection on every retry.
      Effect.catch((error) =>
        error._tag === "PersistenceDecodeError"
          ? Effect.fail(
              validation(
                "invalid-protocol-state",
                "The stored Magi run state could not be read, so this run cannot continue.",
              ),
            )
          : Effect.die(error),
      ),
      Effect.flatMap((run) =>
        Option.isSome(run)
          ? Effect.succeed(run.value)
          : Effect.fail(validation("magi-run-not-active", "The Magi run does not exist.")),
      ),
      Effect.filterOrFail(
        (run) => caller === undefined || run.detail.summary.rootThreadId === caller.threadId,
        () => validation("foreign-turn", "This conversation does not own this Magi run."),
      ),
    );

  /** The caller's current run, which becomes the run driving Magi's lifecycle pauses. */
  const currentOwnerRunId = (caller: MagiCaller) =>
    threads.getThreadRecords(caller.threadId, ["runs"]).pipe(
      Effect.map(
        (records): RunId | null =>
          records.runs
            .filter(ThreadManagement.isActiveRun)
            .filter((run) => run.providerInstanceId === caller.providerInstanceId)
            .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.id ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const deliberate = (caller: MagiCaller, input: MagiDeliberateInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId, caller);
      if (run.detail.summary.state === "deliberating") {
        // A retried call, for example after its tool call was cancelled, gets the turn in flight.
        const live = (yield* Ref.get(liveDeliberations)).get(input.runId);
        if (live !== undefined) return yield* Deferred.await(live);
      }
      if (run.detail.summary.state !== "awaiting-next-turn")
        return yield* validation(
          "invalid-protocol-state",
          "Magi is not awaiting another deliberation.",
        );
      const providerInstances = yield* validateParticipantAvailability(
        run.detail.config.participants,
      );
      return yield* inService(
        runDeliberation({
          runId: input.runId,
          request: input,
          caller,
          providerInstances,
          expectedState: "awaiting-next-turn",
        }),
      );
    });

  const recordArbitration = (threadId: MagiCaller, input: MagiRecordArbitrationInput) =>
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
        // The server derives each set's id. Repeating a known set is allowed; a new set may
        // neither overlap another set nor revive a rejected, unresolved, or superseded proposal.
        const proposalDecisions = new Map(
          protocol.proposals.map((proposal) => [proposal.proposalId, proposal.decision]),
        );
        const knownDecisionSetIds = new Set(
          protocol.decisionSets.map((decisionSet) => decisionSet.decisionSetId),
        );
        const knownSetProposalIds = new Set(
          protocol.decisionSets.flatMap((decisionSet) => decisionSet.proposalIds),
        );
        const declaredDecisionSetIds: Array<MagiDecisionSetId> = [];
        const assignedExclusiveProposalIds = new Set<string>();
        for (const decision of input.record.exclusiveDecisionSets) {
          const decisionSetId = magiExclusiveDecisionSetFingerprint(
            run.detail.summary.runId,
            decision.proposalIds,
          );
          const known = knownDecisionSetIds.has(decisionSetId);
          const issue =
            decision.decisionSetId !== undefined && decision.decisionSetId !== decisionSetId
              ? `Decision set id ${decision.decisionSetId} does not match its proposals; omit decisionSetId or use ${decisionSetId}.`
              : new Set(decision.proposalIds).size !== decision.proposalIds.length ||
                  declaredDecisionSetIds.includes(decisionSetId) ||
                  decision.proposalIds.some((proposalId) =>
                    assignedExclusiveProposalIds.has(proposalId),
                  )
                ? "Each exclusive decision set must list distinct proposals, and a proposal can belong to only one declared set."
                : decision.proposalIds.some((proposalId) => !proposalIds.has(proposalId))
                  ? "Exclusive decision sets must use known proposal ids from this run."
                  : !known &&
                      decision.proposalIds.some((proposalId) => knownSetProposalIds.has(proposalId))
                    ? "A proposal already belongs to another exclusive decision set. Repeat that exact set instead of declaring an overlapping one."
                    : !known &&
                        decision.proposalIds.some((proposalId) => {
                          const decided = proposalDecisions.get(proposalId);
                          return (
                            decided !== "accepted" &&
                            decided !== "open" &&
                            decided !== "reconsidering"
                          );
                        })
                      ? "A new exclusive decision set can contain only accepted or active proposals."
                      : null;
          if (issue !== null) {
            return yield* validation(
              "invalid-protocol-state",
              issue,
              "record.exclusiveDecisionSets",
            );
          }
          declaredDecisionSetIds.push(decisionSetId);
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
        // Only sets still in play or resolved by this arbitration decide their proposals. A set
        // resolved earlier already did, and its proposals keep their later integration state.
        const resolvedThisTurnSetIds = new Set(
          decisionOutcomes
            .filter((outcome) => outcome.resolvedThisTurn)
            .map((outcome) => outcome.decisionSetId),
        );
        const currentDecisionSets = evolvedDecisionSets.filter(
          (decisionSet) =>
            decisionSet.decision === "open" ||
            decisionSet.decision === "reconsidering" ||
            resolvedThisTurnSetIds.has(decisionSet.decisionSetId),
        );
        const evolvedProposals = applyMagiProposalOutcomes(
          protocol.proposals,
          proposalOutcomes,
          input.magiTurn,
        ).map((proposal) => {
          const relatedDecisionSet = currentDecisionSets.find((decisionSet) =>
            decisionSet.proposalIds.includes(proposal.proposalId),
          );
          if (!relatedDecisionSet) return proposal;
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
        // The record keeps the stances the server counted and the derived decision set ids.
        const persistedArbitrationRecord = {
          ...arbitrationRecord,
          assessments,
          exclusiveDecisionSets: arbitrationRecord.exclusiveDecisionSets.map((decision) => ({
            ...decision,
            decisionSetId: magiExclusiveDecisionSetFingerprint(
              run.detail.summary.runId,
              decision.proposalIds,
            ),
          })),
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
        const drivingRunId = yield* currentOwnerRunId(threadId);
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
          mainRunId: drivingRunId ?? run.mainRunId,
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
          exclusiveDecisionSetIds: declaredDecisionSetIds,
          assessedCandidateFingerprint:
            turn.candidate === null
              ? null
              : magiCandidateFingerprint(turn.candidate, protocol.actions),
          candidateChanged,
          transition,
        } satisfies MagiRecordArbitrationResult;
      }),
    );

  const recordActions = (threadId: MagiCaller, input: MagiRecordActionsInput) =>
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
                  // The ledger position keeps identical repeated outcomes distinct.
                  reconciliationId: `${batch.batchId}:${protocol.reconciliations.length + 1}:${input.record.actions.map((action) => `${action.actionId}:${action.status}`).join("|")}`,
                  batchId: batch.batchId,
                  actions: recordedActions,
                  recordedAt: updatedAt,
                },
              ]
            : [];
        const next: PersistedMagiRun = {
          ...run,
          mainRunId: (yield* currentOwnerRunId(threadId)) ?? run.mainRunId,
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
  const controlRun = Effect.fn("MagiService.controlRun")(function* (
    threadId: MagiCaller,
    input: MagiControlRunInput,
  ) {
    // Check ownership before cancellation can wake another run's deliberation.
    yield* requireRun(input.runId, threadId);
    if (input.action === "stop") {
      yield* cancelRun(input.runId);
    } else {
      yield* withRunLock(
        input.runId,
        Effect.gen(function* () {
          const run = yield* requireRun(input.runId, threadId);
          const currentState = run.detail.summary.state;
          if (isMagiRunTerminal(currentState)) {
            return yield* validation(
              "invalid-protocol-state",
              "A terminal Magi run cannot be paused or resumed.",
            );
          }
          const protocol = asProtocol(run.protocol);
          if (input.action === "pause" && currentState === "paused") return;
          if (input.action === "resume" && currentState !== "paused") return;
          // A deliberation paused in flight resumes as deliberating; one lost to a restart is
          // repeated from awaiting-next-turn.
          const deliberationLive = (yield* Ref.get(liveDeliberations)).has(input.runId);
          const state: MagiRunState =
            input.action === "pause"
              ? "paused"
              : protocol.stateBeforePause === "deliberating"
                ? deliberationLive
                  ? "deliberating"
                  : "awaiting-next-turn"
                : (protocol.stateBeforePause ?? "awaiting-next-turn");
          yield* persist({
            ...run,
            mainRunId: (yield* currentOwnerRunId(threadId)) ?? run.mainRunId,
            updatedAt: yield* nowIso,
            protocol: {
              ...protocol,
              stateBeforePause:
                input.action === "pause" ? (protocol.stateBeforePause ?? currentState) : null,
            },
            detail: {
              ...run.detail,
              summary: { ...run.detail.summary, state },
              activity: { ...run.detail.activity, state },
            },
          });
        }),
      );
    }
    return yield* recoverRunContext(threadId, { runId: input.runId });
  });

  const listRuns = (input: MagiListRunsInput) => repository.listRuns(input).pipe(Effect.orDie);
  const getTerminalProposals = (threadId: MagiCaller, input: MagiGetTerminalProposalsInput) =>
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
  const recoverTurnResult = (threadId: MagiCaller, input: MagiRecoverTurnResultInput) =>
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
  const recoverRunContext = (threadId: MagiCaller, input: MagiRecoverRunContextInput) =>
    Effect.gen(function* () {
      const run = yield* requireRun(input.runId, threadId);
      const protocol = asProtocol(run.protocol);
      const turn = protocol.turns.at(-1);
      const candidate = turn?.arbitration?.candidate ?? turn?.candidate ?? run.detail.candidate;
      const threshold = calculateMagiThreshold(
        run.detail.config.participants,
        run.detail.config.consensusThresholdPercent,
      );
      const settledWeight = settledMagiWeight(run.detail.config, turn?.settlements ?? []);
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
      const listed = yield* listRuns({
        rootThreadId: input.rootThreadId,
        limit: input.limit,
      });
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
              participantRunId: settlement.participantRunId,
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

  /** Emits on subscription and again whenever a matching run changes. */
  const changesFor = (matches: (change: MagiRunChange) => boolean) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the initial read so a change published during it is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.succeed(undefined),
          Stream.fromSubscription(subscription).pipe(Stream.filter(matches)),
        );
      }),
    ).pipe(Stream.scoped);

  const subscribeThreadRuns: MagiServiceShape["subscribeThreadRuns"] = (input) =>
    changesFor((change) => change.audienceThreadIds.includes(input.rootThreadId)).pipe(
      Stream.mapEffect(() => listRuns({ rootThreadId: input.rootThreadId, limit: input.limit })),
    );

  const subscribeRunDetail: MagiServiceShape["subscribeRunDetail"] = (input) =>
    changesFor((change) => change.runId === input.runId).pipe(
      Stream.mapEffect(() => getRunDetail(input)),
    );

  const service: MagiServiceShape = {
    getOptions,
    getSettings: readSettings,
    updateSettings,
    resetSettings,
    armThread,
    getArm,
    disarmThread,
    sendArmedMessage,
    startFromTool,
    deliberate,
    recordArbitration,
    getTerminalProposals,
    recoverTurnResult,
    recoverRunContext,
    recordActions,
    cancelRun,
    controlRun,
    listRuns,
    getRunDetail,
    subscribeThreadRuns,
    subscribeRunDetail,
    listContextActivities,
    readContextArtifacts,
    exportDiagnostics,
  };

  /** The owning conversation's approvals, input requests, and failed runs pause or resume Magi. */
  const applyOwnerLifecycle = (
    rootThreadId: ThreadId,
    runId: RunId | null,
    eventType: Parameters<typeof resolveMagiProviderEventTransition>[0]["eventType"],
  ) =>
    repository.findActiveRun(rootThreadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.flatMap((active) => {
        if (Option.isNone(active) || active.value.mainRunId !== runId) return Effect.void;
        return withRunLock(
          active.value.detail.summary.runId,
          Effect.gen(function* () {
            const latest = yield* requireRun(active.value.detail.summary.runId);
            // The run may have ended or changed driving run while this waited for the lock.
            if (isMagiRunTerminal(latest.detail.summary.state) || latest.mainRunId !== runId) {
              return;
            }
            const protocol = asProtocol(latest.protocol);
            const { state, stateBeforePause } = resolveMagiProviderEventTransition({
              currentState: latest.detail.summary.state,
              stateBeforePause: protocol.stateBeforePause,
              eventType,
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
    );

  /** The driving owner run completed; continue or fail a protocol it left unfinished. */
  const applyOwnerRunCompleted = (rootThreadId: ThreadId, runId: RunId) =>
    repository.findActiveRun(rootThreadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.flatMap((active) => {
        if (Option.isNone(active) || active.value.mainRunId !== runId) return Effect.void;
        return withRunLock(
          active.value.detail.summary.runId,
          Effect.gen(function* () {
            const latest = yield* requireRun(active.value.detail.summary.runId);
            if (
              latest.mainRunId !== runId ||
              !OWNER_PROTOCOL_WORK_STATES.has(latest.detail.summary.state)
            ) {
              return;
            }
            yield* continueAfterOwnerRunEnded(latest);
          }),
        );
      }),
    );

  /** Settles a run that a stopped server left in a state nothing would continue. */
  const recoverRun = (runId: MagiRunId) =>
    withRunLock(
      runId,
      Effect.gen(function* () {
        const stored = yield* repository.getRun(runId).pipe(Effect.orDie);
        if (Option.isNone(stored)) return;
        const run = stored.value;
        const protocol = asProtocol(run.protocol);
        const interruptedState = run.detail.summary.state;
        if (protocol.cleanupPending) {
          yield* cleanupTerminalRun(run);
          return;
        }
        if (isMagiRunTerminal(interruptedState)) return;
        const recovery = recoverInterruptedMagiState(interruptedState, protocol.stateBeforePause);
        const state = recovery.state;
        if (state === interruptedState) return;
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
              ? repository
                  .deleteByOwnerThreadId(run.detail.summary.rootThreadId)
                  .pipe(Effect.orDie, Effect.andThen(publishChanges([run])))
              : Effect.fail(error),
          ),
        );
        if (isMagiRunTerminal(state)) yield* cleanupTerminalRun(recovered);
      }),
    );

  /**
   * Applies the end of a driving owner run that finished while the server was down, whose
   * `run.updated` event no live handler saw, exactly as the live handler would have.
   */
  const recoverOwnerRunEnded = (run: PersistedMagiRun) =>
    Effect.gen(function* () {
      const { rootThreadId } = run.detail.summary;
      if (run.mainRunId === null) return;
      const drivingRun = yield* readTerminalRun(rootThreadId, run.mainRunId);
      if (Option.isNone(drivingRun)) return;
      const { status } = drivingRun.value;
      if (status === "completed") {
        yield* applyOwnerRunCompleted(rootThreadId, run.mainRunId);
      } else if (status === "failed" || status === "interrupted" || status === "cancelled") {
        yield* applyOwnerLifecycle(rootThreadId, run.mainRunId, "turn.aborted");
      }
    });

  /** Participant conversations share their owner's archive and deletion lifecycle. */
  const cascadeOwnerLifecycle = (
    ownerThreadId: ThreadId,
    type: "thread.archived" | "thread.unarchived" | "thread.deleted",
    eventId: string,
  ) =>
    Effect.gen(function* () {
      const runs = yield* repository.listRunsByOwner(ownerThreadId).pipe(Effect.orDie);
      if (runs.length === 0) {
        // An owner deleted before its first run can still hold an arm.
        if (type === "thread.deleted") {
          yield* repository.deleteByOwnerThreadId(ownerThreadId).pipe(Effect.orDie);
        }
        return;
      }
      if (type === "thread.deleted") {
        yield* Effect.forEach(
          runs.filter((run) => !isMagiRunTerminal(run.detail.summary.state)),
          (run) => cancelRun(run.detail.summary.runId).pipe(Effect.ignore),
          { discard: true },
        );
      }
      const command =
        type === "thread.deleted"
          ? "thread.delete"
          : type === "thread.archived"
            ? "thread.archive"
            : "thread.unarchive";
      yield* Effect.forEach(
        runs.flatMap((run) => asProtocol(run.protocol).members),
        (member) =>
          threads
            .dispatch({
              type: command,
              commandId: CommandId.make(`magi:${command}:${member.threadId}:${eventId}`),
              threadId: member.threadId,
            })
            .pipe(Effect.ignore),
        { discard: true },
      );
      if (type === "thread.deleted") {
        yield* repository.deleteByOwnerThreadId(ownerThreadId).pipe(Effect.orDie);
        yield* publishChanges(runs);
      }
    });

  const handleLifecycleEvent = (event: Stream.Success<typeof threads.streamDomainEvents>) => {
    if (event.type === "runtime-request.updated") {
      const request = event.payload;
      const eventType =
        request.status === "pending"
          ? request.kind === "user_input"
            ? "user-input.requested"
            : "request.opened"
          : request.kind === "user_input"
            ? "user-input.resolved"
            : "request.resolved";
      return applyOwnerLifecycle(event.threadId, event.runId ?? null, eventType);
    }
    if (
      event.type === "run.updated" &&
      (event.payload.status === "failed" ||
        event.payload.status === "interrupted" ||
        event.payload.status === "cancelled")
    ) {
      return applyOwnerLifecycle(event.threadId, event.payload.id, "turn.aborted");
    }
    if (event.type === "run.updated" && event.payload.status === "completed") {
      return applyOwnerRunCompleted(event.threadId, event.payload.id);
    }
    if (
      event.type === "thread.archived" ||
      event.type === "thread.unarchived" ||
      event.type === "thread.deleted"
    ) {
      return cascadeOwnerLifecycle(event.threadId, event.type, event.id);
    }
    return Effect.void;
  };
  // Observation starts before recovery reads any run. Started immediately, the subscription fixes
  // its starting sequence before this fiber continues, so an owner event is either delivered live
  // or already visible to recovery.
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      handleLifecycleEvent(event).pipe(
        Effect.catchCause((cause) => Effect.logError("Magi lifecycle event failed.", cause)),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError("Magi lifecycle stream stopped.", cause)),
    Effect.forkScoped({ startImmediately: true }),
  );
  const recoverable = yield* repository.listRecoverableRuns().pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    recoverable,
    (run) =>
      recoverRun(run.detail.summary.runId).pipe(
        Effect.andThen(recoverOwnerRunEnded(run)),
        Effect.catchCause((cause) => Effect.logError("Magi run recovery failed.", cause)),
      ),
    { discard: true },
  );
  return service;
});

export class MagiService extends Context.Service<MagiService, MagiServiceShape>()(
  "t3/magi/MagiService",
) {}

export const layer = Layer.effect(MagiService, makeMagiService).pipe(
  Layer.provide([ProjectionMagiRepositoryLive, MagiParticipantPolicy.layer]),
);

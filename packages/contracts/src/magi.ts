import { sha256 } from "@noble/hashes/sha2.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ContextArtifactId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const boundedString = (maximum: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(maximum));

export const MAGI_MIN_PARTICIPANTS = 2;
export const MAGI_MAX_PARTICIPANTS = 9;
export const MAGI_MIN_WEIGHT = 1;
export const MAGI_MAX_WEIGHT = 100;
export const MAGI_MIN_THRESHOLD_PERCENT = 1;
export const MAGI_MAX_THRESHOLD_PERCENT = 100;
export const MAGI_DEFAULT_THRESHOLD_PERCENT = 100;
export const MAGI_DEFAULT_TURN_LIMIT = 1;
export const MAGI_MAX_CONTEXT_ACTIVITY_IDS = 32;
export const MAGI_MAX_CONTEXT_ACTIVITY_BYTES = 120_000;
export const MAGI_MAX_OBJECTIVE_CHARS = 8_000;
export const MAGI_MAX_CANDIDATE_FIELD_CHARS = 16_000;
export const MAGI_TERMINAL_PROPOSAL_PAGE_MAX = 20;

export const MagiRunId = TrimmedNonEmptyString.pipe(Schema.brand("MagiRunId"));
export type MagiRunId = typeof MagiRunId.Type;
export const MagiArmId = TrimmedNonEmptyString.pipe(Schema.brand("MagiArmId"));
export type MagiArmId = typeof MagiArmId.Type;
export const MagiParticipantId = TrimmedNonEmptyString.pipe(Schema.brand("MagiParticipantId"));
export type MagiParticipantId = typeof MagiParticipantId.Type;
export const MagiPersonalityId = TrimmedNonEmptyString.pipe(Schema.brand("MagiPersonalityId"));
export type MagiPersonalityId = typeof MagiPersonalityId.Type;
export const MagiProposalId = TrimmedNonEmptyString.pipe(Schema.brand("MagiProposalId"));
export type MagiProposalId = typeof MagiProposalId.Type;
export const MagiDecisionSetId = TrimmedNonEmptyString.pipe(Schema.brand("MagiDecisionSetId"));
export type MagiDecisionSetId = typeof MagiDecisionSetId.Type;
export const MagiActionBatchId = TrimmedNonEmptyString.pipe(Schema.brand("MagiActionBatchId"));
export type MagiActionBatchId = typeof MagiActionBatchId.Type;
export const MagiActionRecordId = TrimmedNonEmptyString.pipe(Schema.brand("MagiActionRecordId"));
export type MagiActionRecordId = typeof MagiActionRecordId.Type;
export const MagiCandidateFingerprint = TrimmedNonEmptyString.pipe(
  Schema.brand("MagiCandidateFingerprint"),
);
export type MagiCandidateFingerprint = typeof MagiCandidateFingerprint.Type;

export const MagiRunSource = Schema.Literals(["user-arm", "agent-tool"]);
export type MagiRunSource = typeof MagiRunSource.Type;

export const MagiReadOnlySupport = Schema.Literals(["native-policy", "prompt-only"]);
export type MagiReadOnlySupport = typeof MagiReadOnlySupport.Type;
export const MagiStructuredOutputSupport = Schema.Literals(["native", "prompt-only"]);
export type MagiStructuredOutputSupport = typeof MagiStructuredOutputSupport.Type;
export const MagiInstructionSupport = Schema.Literals(["native", "prompt-envelope"]);
export type MagiInstructionSupport = typeof MagiInstructionSupport.Type;
export const MagiControlToolSupport = Schema.Literals(["native-tools", "mcp-tools", "unsupported"]);
export type MagiControlToolSupport = typeof MagiControlToolSupport.Type;
export const MagiWebSearchSupport = Schema.Literals(["native", "unsupported"]);
export type MagiWebSearchSupport = typeof MagiWebSearchSupport.Type;
export const MagiHistoryCompactionSupport = Schema.Literals([
  "explicit-native",
  "automatic-native",
  "unsupported",
]);
export type MagiHistoryCompactionSupport = typeof MagiHistoryCompactionSupport.Type;

export const ProviderMagiCapabilities = Schema.Struct({
  instructions: MagiInstructionSupport,
  structuredOutput: MagiStructuredOutputSupport,
  readOnly: MagiReadOnlySupport,
  controlTools: MagiControlToolSupport,
  webSearch: MagiWebSearchSupport,
  historyCompaction: MagiHistoryCompactionSupport,
});
export type ProviderMagiCapabilities = typeof ProviderMagiCapabilities.Type;

export const ProviderExecutionProfile = Schema.Literals(["interactive", "magi-read-only"]);
export type ProviderExecutionProfile = typeof ProviderExecutionProfile.Type;

export const ProviderControlInput = Schema.Struct({
  executionProfile: Schema.optional(ProviderExecutionProfile),
  instructions: Schema.optional(Schema.String),
  outputSchema: Schema.optional(Schema.Unknown),
  contextPreamble: Schema.optional(Schema.String),
  magiControlEnabled: Schema.optional(Schema.Boolean),
  idempotencyKey: Schema.optional(boundedString(500)),
});
export type ProviderControlInput = typeof ProviderControlInput.Type;

export const ProviderContextUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  limitTokens: Schema.NullOr(NonNegativeInt),
  measuredAt: IsoDateTime,
});
export type ProviderContextUsage = typeof ProviderContextUsage.Type;

export const MagiPersonality = Schema.Struct({
  id: MagiPersonalityId,
  name: boundedString(80),
  prompt: boundedString(12_000),
  included: Schema.Boolean,
});
export type MagiPersonality = typeof MagiPersonality.Type;

export const MagiParticipantDraft = Schema.Struct({
  participantId: MagiParticipantId,
  modelSelection: ModelSelection,
  personalityId: Schema.NullOr(MagiPersonalityId),
  weight: Schema.Int.check(
    Schema.isBetween({ minimum: MAGI_MIN_WEIGHT, maximum: MAGI_MAX_WEIGHT }),
  ),
});
export type MagiParticipantDraft = typeof MagiParticipantDraft.Type;

export const MagiRunConfig = Schema.Struct({
  participants: Schema.Array(MagiParticipantDraft).check(
    Schema.isMinLength(MAGI_MIN_PARTICIPANTS),
    Schema.isMaxLength(MAGI_MAX_PARTICIPANTS),
  ),
  consensusThresholdPercent: Schema.Int.check(
    Schema.isBetween({
      minimum: MAGI_MIN_THRESHOLD_PERCENT,
      maximum: MAGI_MAX_THRESHOLD_PERCENT,
    }),
  ),
  magiTurnLimit: Schema.NullOr(NonNegativeInt),
});
export type MagiRunConfig = typeof MagiRunConfig.Type;

export const MagiRunState = Schema.Literals([
  "initializing",
  "awaiting-main-tool",
  "deliberating",
  "awaiting-arbitration",
  "awaiting-actions",
  "awaiting-next-turn",
  "awaiting-main-approval",
  "awaiting-main-input",
  "awaiting-action-reconciliation",
  "paused",
  "cancelling",
  "succeeded",
  "turn-limit-reached",
  "cancelled",
  "failed",
]);
export type MagiRunState = typeof MagiRunState.Type;

export const NONTERMINAL_MAGI_RUN_STATES: ReadonlySet<MagiRunState> = new Set([
  "initializing",
  "awaiting-main-tool",
  "deliberating",
  "awaiting-arbitration",
  "awaiting-actions",
  "awaiting-next-turn",
  "awaiting-main-approval",
  "awaiting-main-input",
  "awaiting-action-reconciliation",
  "paused",
  "cancelling",
]);

export const isMagiRunTerminal = (state: MagiRunState): boolean =>
  !NONTERMINAL_MAGI_RUN_STATES.has(state);

export const MagiTurnState = Schema.Literals([
  "queued",
  "deliberating",
  "awaiting-arbitration",
  "awaiting-actions",
  "completed",
  "failed",
]);
export type MagiTurnState = typeof MagiTurnState.Type;

export const MagiMemberState = Schema.Literals([
  "pending",
  "running",
  "settled",
  "failed",
  "timed-out",
  "cancelled",
]);
export type MagiMemberState = typeof MagiMemberState.Type;

export const MagiParseMode = Schema.Literals(["structured", "repaired", "raw"]);
export type MagiParseMode = typeof MagiParseMode.Type;
export const MagiBallot = Schema.Literals(["approve", "reject", "abstain", "not-applicable"]);
export type MagiBallot = typeof MagiBallot.Type;
export const MagiEvaluationBallot = Schema.Literals(["approve", "reject", "abstain"]);
export type MagiEvaluationBallot = typeof MagiEvaluationBallot.Type;
export const MagiArbitrationStance = Schema.Literals(["supports", "opposes", "unclear"]);
export type MagiArbitrationStance = typeof MagiArbitrationStance.Type;
export const MagiProposalKind = Schema.Literals(["vote-changing", "optional"]);
export type MagiProposalKind = typeof MagiProposalKind.Type;
export const MagiActionObligation = Schema.Literals(["required", "optional"]);
export type MagiActionObligation = typeof MagiActionObligation.Type;
export const MagiActionStatus = Schema.Literals(["completed", "not-completed", "unknown"]);
export type MagiActionStatus = typeof MagiActionStatus.Type;

const textArray = Schema.Array(boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS));

export const MagiProposalInput = Schema.Struct({
  kind: MagiProposalKind,
  change: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  expectedVoteEffect: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  atomicSetKey: Schema.NullOr(boundedString(200)),
  supersedesProposalId: Schema.optionalKey(Schema.NullOr(MagiProposalId)),
});
export type MagiProposalInput = typeof MagiProposalInput.Type;

export const MagiProposalEvaluation = Schema.Struct({
  proposalId: MagiProposalId,
  ballot: MagiEvaluationBallot,
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
});
export type MagiProposalEvaluation = typeof MagiProposalEvaluation.Type;

export const MagiExclusiveSetEvaluation = Schema.Struct({
  decisionSetId: MagiDecisionSetId,
  selectedProposalId: Schema.NullOr(MagiProposalId),
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
});
export type MagiExclusiveSetEvaluation = typeof MagiExclusiveSetEvaluation.Type;

export const MagiParticipantResponse = Schema.Struct({
  recommendation: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  rationale: textArray,
  assumptions: textArray,
  risks: textArray,
  confidence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  candidateFingerprint: Schema.NullOr(MagiCandidateFingerprint),
  ballot: MagiBallot,
  proposals: Schema.Array(MagiProposalInput),
  proposalEvaluations: Schema.Array(MagiProposalEvaluation),
  exclusiveSetEvaluations: Schema.Array(MagiExclusiveSetEvaluation),
});
export type MagiParticipantResponse = typeof MagiParticipantResponse.Type;

export const MagiParticipantSettlement = Schema.Struct({
  participantId: MagiParticipantId,
  participantThreadId: ThreadId,
  participantTurnId: TurnId,
  rawText: Schema.String,
  parsed: Schema.NullOr(MagiParticipantResponse),
  parseMode: MagiParseMode,
  state: MagiMemberState,
  durationMs: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  retryCount: NonNegativeInt,
  providerAttempts: NonNegativeInt,
  structuralRepairCount: NonNegativeInt,
  reconstructed: Schema.Boolean,
  failureClass: Schema.NullOr(boundedString(200)),
  contextCompressed: Schema.Boolean,
});
export type MagiParticipantSettlement = typeof MagiParticipantSettlement.Type;

const MagiParticipantEvidenceFields = {
  participantId: MagiParticipantId,
  participantThreadId: ThreadId,
  participantTurnId: TurnId,
  parseMode: MagiParseMode,
  state: MagiMemberState,
  durationMs: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  retryCount: NonNegativeInt,
  providerAttempts: NonNegativeInt,
  structuralRepairCount: NonNegativeInt,
  reconstructed: Schema.Boolean,
  failureClass: Schema.NullOr(boundedString(200)),
  contextCompressed: Schema.Boolean,
} as const;

export const MagiParticipantEvidence = Schema.Struct({
  ...MagiParticipantEvidenceFields,
  response: Schema.Union([
    Schema.Struct({
      format: Schema.Literal("structured"),
      value: MagiParticipantResponse,
    }),
    Schema.Struct({
      format: Schema.Literal("raw"),
      value: Schema.String,
    }),
  ]),
  rawTextAvailable: Schema.Boolean,
});
export type MagiParticipantEvidence = typeof MagiParticipantEvidence.Type;

export const MagiCandidate = Schema.Struct({
  conclusion: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  rationale: textArray,
  recommendedActions: textArray,
  caveats: textArray,
});
export type MagiCandidate = typeof MagiCandidate.Type;

export const MagiParticipantAssessment = Schema.Struct({
  participantId: MagiParticipantId,
  stance: MagiArbitrationStance,
  evidence: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  clarificationNeeded: Schema.Boolean,
  clarificationQuestion: Schema.NullOr(boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS)),
});
export type MagiParticipantAssessment = typeof MagiParticipantAssessment.Type;

export const MagiProposalDisposition = Schema.Struct({
  proposalId: MagiProposalId,
  disposition: Schema.Literals(["apply", "do-not-apply", "needs-reassessment"]),
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
});
export type MagiProposalDisposition = typeof MagiProposalDisposition.Type;

export const MagiTerminalProposalDigestEntry = Schema.Struct({
  proposalId: MagiProposalId,
  summary: TrimmedNonEmptyString,
});
export type MagiTerminalProposalDigestEntry = typeof MagiTerminalProposalDigestEntry.Type;

export const MagiExclusiveDecisionSetInput = Schema.Struct({
  decisionSetId: MagiDecisionSetId,
  proposalIds: Schema.Array(MagiProposalId).check(Schema.isMinLength(2)),
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
});
export type MagiExclusiveDecisionSetInput = typeof MagiExclusiveDecisionSetInput.Type;

export const MagiAuthorizedExecutionAction = Schema.Struct({
  summary: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  relatedProposalIds: Schema.Array(MagiProposalId),
  obligation: MagiActionObligation,
});
export type MagiAuthorizedExecutionAction = typeof MagiAuthorizedExecutionAction.Type;

export const MagiArbitrationRecord = Schema.Struct({
  candidate: MagiCandidate,
  assessments: Schema.Array(MagiParticipantAssessment),
  disagreements: textArray,
  proposalDispositions: Schema.Array(MagiProposalDisposition),
  exclusiveDecisionSets: Schema.Array(MagiExclusiveDecisionSetInput),
  nextTurnBrief: Schema.NullOr(boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS)),
  authorizedExecutionActions: Schema.Array(MagiAuthorizedExecutionAction),
  requestedOutcome: Schema.Literals(["consensus", "continue"]),
  // Historical arbitration records predate the digest. MagiService requires
  // this field on every newly recorded arbitration and persists it as an array.
  terminalProposalDigest: Schema.optionalKey(Schema.Array(MagiTerminalProposalDigestEntry)),
});
export type MagiArbitrationRecord = typeof MagiArbitrationRecord.Type;

export const MagiRecordedAction = Schema.Struct({
  actionId: MagiActionRecordId,
  summary: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  status: MagiActionStatus,
  relatedProposalIds: Schema.Array(MagiProposalId),
  obligation: MagiActionObligation,
  details: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  unforeseenConsequence: Schema.NullOr(boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS)),
});
export type MagiRecordedAction = typeof MagiRecordedAction.Type;

export const MagiActionRecord = Schema.Struct({
  batchId: MagiActionBatchId,
  actions: Schema.Array(MagiRecordedAction).check(Schema.isMinLength(1)),
});
export type MagiActionRecord = typeof MagiActionRecord.Type;

export const MagiIssuedAction = Schema.Struct({
  actionId: MagiActionRecordId,
  summary: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  relatedProposalIds: Schema.Array(MagiProposalId),
  obligation: MagiActionObligation,
});
export type MagiIssuedAction = typeof MagiIssuedAction.Type;
export const MagiIssuedActionBatch = Schema.Struct({
  batchId: MagiActionBatchId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  actions: Schema.Array(MagiIssuedAction).check(Schema.isMinLength(1)),
});
export type MagiIssuedActionBatch = typeof MagiIssuedActionBatch.Type;

export const MagiPostActionTransition = Schema.Literals(["continue", "turn-limit-reached"]);
export type MagiPostActionTransition = typeof MagiPostActionTransition.Type;
export const MagiDirectTransition = Schema.Literals([
  "consensus-reached",
  "continue",
  "turn-limit-reached",
]);
export type MagiDirectTransition = typeof MagiDirectTransition.Type;
export const MagiArbitrationTransition = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("actions-required"),
    batchId: MagiActionBatchId,
    actions: Schema.Array(MagiAuthorizedExecutionAction).check(Schema.isMinLength(1)),
    afterActions: MagiPostActionTransition,
  }),
  Schema.Struct({ state: MagiDirectTransition }),
]);
export type MagiArbitrationTransition = typeof MagiArbitrationTransition.Type;

export const MagiActivityReference = Schema.Struct({
  // Optional only for persisted runs created before context artifacts existed.
  // Newly resolved references always include both fields.
  artifactId: Schema.optionalKey(ContextArtifactId),
  activityId: EventId,
  turnId: TurnId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: Schema.optionalKey(NonNegativeInt),
  // Internal persisted runs may carry the opaque payload for context_read.
  // Public run-detail responses omit it and expose only the manifest fields.
  result: Schema.optionalKey(Schema.Unknown),
});
export type MagiActivityReference = typeof MagiActivityReference.Type;

export const ContextArtifactManifest = Schema.Struct({
  artifactId: ContextArtifactId,
  sourceActivityId: EventId,
  sourceTurnId: TurnId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: NonNegativeInt,
});
export type ContextArtifactManifest = typeof ContextArtifactManifest.Type;

export const MagiContextActivityOption = Schema.Struct({
  activityId: EventId,
  turnId: TurnId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: NonNegativeInt,
});
export type MagiContextActivityOption = typeof MagiContextActivityOption.Type;

export const MagiActivitySummary = Schema.Struct({
  runId: MagiRunId,
  source: MagiRunSource,
  state: MagiRunState,
  completedMagiTurns: NonNegativeInt,
  magiTurnLimit: Schema.NullOr(NonNegativeInt),
  totalWeight: NonNegativeInt,
  leadingAgreementWeight: Schema.NullOr(NonNegativeInt),
  leadingAgreementLabel: Schema.NullOr(boundedString(500)),
  requiredWeight: NonNegativeInt,
});
export type MagiActivitySummary = typeof MagiActivitySummary.Type;

export const ActiveMagiRunSummary = Schema.Struct({
  runId: MagiRunId,
  source: MagiRunSource,
  state: MagiRunState,
  completedMagiTurns: NonNegativeInt,
});
export type ActiveMagiRunSummary = typeof ActiveMagiRunSummary.Type;

export const MagiRunTitleState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending"), title: Schema.Literal("Magi run") }),
  Schema.Struct({ state: Schema.Literal("generated"), title: boundedString(120) }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    title: Schema.Literal("Magi run"),
    diagnostic: boundedString(500),
  }),
]);
export type MagiRunTitleState = typeof MagiRunTitleState.Type;

export const MagiRunSummary = Schema.Struct({
  runId: MagiRunId,
  rootThreadId: ThreadId,
  source: MagiRunSource,
  title: MagiRunTitleState,
  state: MagiRunState,
  objective: Schema.NullOr(boundedString(MAGI_MAX_OBJECTIVE_CHARS)),
  completedMagiTurns: NonNegativeInt,
  participantCount: Schema.optional(NonNegativeInt),
  magiTurnLimit: Schema.optional(Schema.NullOr(NonNegativeInt)),
  agreedVoteCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
  totalVoteCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
  tokenCount: Schema.optional(NonNegativeInt),
  startedAt: IsoDateTime,
  updatedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type MagiRunSummary = typeof MagiRunSummary.Type;

export const MagiRunTurnDetail = Schema.Struct({
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  candidate: Schema.NullOr(MagiCandidate),
  settlements: Schema.Array(MagiParticipantSettlement),
  arbitration: Schema.NullOr(MagiArbitrationRecord),
  activities: Schema.Array(MagiActivityReference),
});
export type MagiRunTurnDetail = typeof MagiRunTurnDetail.Type;

export const MagiProposal = Schema.Struct({
  proposalId: MagiProposalId,
  proposal: MagiProposalInput,
  originParticipantIds: Schema.Array(MagiParticipantId),
  firstMagiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  decision: Schema.Literals([
    "open",
    "reconsidering",
    "accepted",
    "rejected",
    "unresolved",
    "superseded",
  ]),
  decisionBasis: Schema.Literals([
    "pending",
    "panel-threshold",
    "panel-deadlock",
    "recorded-action",
    "superseded",
  ]),
  evaluationRounds: NonNegativeInt,
  decisionMagiTurn: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  approvalWeight: NonNegativeInt,
  rejectionWeight: NonNegativeInt,
  integration: Schema.Literals([
    "not-applicable",
    "awaiting-arbitration",
    "incorporated",
    "omitted",
    "action-pending",
    "action-completed",
    "action-impeded",
  ]),
});
export type MagiProposal = typeof MagiProposal.Type;

export const MagiKnownDecisionSet = Schema.Struct({
  decisionSetId: MagiDecisionSetId,
  proposalIds: Schema.Array(MagiProposalId),
  rationale: boundedString(MAGI_MAX_CANDIDATE_FIELD_CHARS),
  firstMagiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  decision: Schema.Literals(["open", "reconsidering", "resolved", "unresolved"]),
  evaluationRounds: NonNegativeInt,
  winningProposalId: Schema.NullOr(MagiProposalId),
  decisionMagiTurn: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type MagiKnownDecisionSet = typeof MagiKnownDecisionSet.Type;

export const MagiActionReconciliation = Schema.Struct({
  reconciliationId: boundedString(2_000),
  batchId: MagiActionBatchId,
  actions: Schema.Array(MagiRecordedAction),
  recordedAt: IsoDateTime,
});
export type MagiActionReconciliation = typeof MagiActionReconciliation.Type;

export const MagiRunDetail = Schema.Struct({
  summary: MagiRunSummary,
  config: MagiRunConfig,
  totalWeight: NonNegativeInt,
  requiredWeight: NonNegativeInt,
  activity: MagiActivitySummary,
  participants: Schema.Array(
    Schema.Struct({
      participantId: MagiParticipantId,
      modelSelection: ModelSelection,
      personality: Schema.NullOr(MagiPersonality),
      weight: NonNegativeInt,
      state: MagiMemberState,
      childThreadId: Schema.NullOr(ThreadId),
    }),
  ),
  settlements: Schema.Array(MagiParticipantSettlement),
  candidate: Schema.NullOr(MagiCandidate),
  actions: Schema.Array(MagiRecordedAction),
  issuedActionBatch: Schema.NullOr(MagiIssuedActionBatch),
  finalParticipantVotes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        participantId: MagiParticipantId,
        stance: Schema.NullOr(MagiArbitrationStance),
        ballot: Schema.NullOr(MagiBallot),
      }),
    ),
  ),
  initialPrompt: Schema.optionalKey(Schema.String),
  // Added after the initial Magi projection shipped. Optional decoding keeps
  // pre-field snapshots readable; the detail query always hydrates them from
  // the durable protocol projection.
  magiTurns: Schema.optionalKey(Schema.Array(MagiRunTurnDetail)),
  proposals: Schema.optionalKey(Schema.Array(MagiProposal)),
  exclusiveDecisionSets: Schema.optionalKey(Schema.Array(MagiKnownDecisionSet)),
  actionReconciliations: Schema.optionalKey(Schema.Array(MagiActionReconciliation)),
});
export type MagiRunDetail = typeof MagiRunDetail.Type;

export const MagiDiagnosticsInput = Schema.Struct({
  rootThreadId: ThreadId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export type MagiDiagnosticsInput = typeof MagiDiagnosticsInput.Type;
export const MagiDiagnosticsResult = Schema.Struct({
  generatedAt: IsoDateTime,
  redacted: Schema.Literal(true),
  runs: Schema.Array(
    Schema.Struct({
      summary: MagiRunSummary,
      totalWeight: NonNegativeInt,
      requiredWeight: NonNegativeInt,
      participants: Schema.Array(
        Schema.Struct({
          participantId: MagiParticipantId,
          childThreadId: Schema.NullOr(ThreadId),
          providerInstanceId: ProviderInstanceId,
          model: Schema.String,
          state: MagiMemberState,
          weight: NonNegativeInt,
        }),
      ),
      settlements: Schema.Array(
        Schema.Struct({
          participantId: MagiParticipantId,
          participantThreadId: ThreadId,
          participantTurnId: TurnId,
          state: MagiMemberState,
          parseMode: MagiParseMode,
          durationMs: NonNegativeInt,
          inputTokens: Schema.NullOr(NonNegativeInt),
          outputTokens: Schema.NullOr(NonNegativeInt),
          retryCount: NonNegativeInt,
          providerAttempts: NonNegativeInt,
          structuralRepairCount: NonNegativeInt,
          reconstructed: Schema.Boolean,
          failureClass: Schema.NullOr(Schema.String),
          contextCompressed: Schema.Boolean,
        }),
      ),
      actions: Schema.Array(
        Schema.Struct({
          actionId: MagiActionRecordId,
          status: MagiActionStatus,
          obligation: MagiActionObligation,
          relatedProposalIds: Schema.Array(MagiProposalId),
        }),
      ),
    }),
  ),
});
export type MagiDiagnosticsResult = typeof MagiDiagnosticsResult.Type;

export const MagiArmThreadInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: NonNegativeInt,
  config: MagiRunConfig,
});
export type MagiArmThreadInput = typeof MagiArmThreadInput.Type;
export const MagiArmThreadResult = Schema.Struct({
  armId: MagiArmId,
  threadId: ThreadId,
  revision: NonNegativeInt,
  config: MagiRunConfig,
  armedAt: IsoDateTime,
});
export type MagiArmThreadResult = typeof MagiArmThreadResult.Type;
export const MagiGetArmInput = Schema.Struct({ threadId: ThreadId });
export type MagiGetArmInput = typeof MagiGetArmInput.Type;
export const MagiGetArmResult = Schema.NullOr(MagiArmThreadResult);
export type MagiGetArmResult = typeof MagiGetArmResult.Type;

export const MagiDisarmThreadInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: NonNegativeInt,
});
export type MagiDisarmThreadInput = typeof MagiDisarmThreadInput.Type;

export const MagiRunCommandInput = Schema.Struct({ runId: MagiRunId });
export type MagiRunCommandInput = typeof MagiRunCommandInput.Type;

export const MagiReconcileActionsInput = Schema.Struct({
  runId: MagiRunId,
  batchId: MagiActionBatchId,
  actions: Schema.Array(MagiRecordedAction).check(Schema.isMinLength(1)),
});
export type MagiReconcileActionsInput = typeof MagiReconcileActionsInput.Type;

export const MagiListRunsInput = Schema.Struct({
  rootThreadId: ThreadId,
  cursor: Schema.optional(boundedString(500)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export type MagiListRunsInput = typeof MagiListRunsInput.Type;
export const MagiListRunsResult = Schema.Struct({
  runs: Schema.Array(MagiRunSummary),
  nextCursor: Schema.NullOr(boundedString(500)),
});
export type MagiListRunsResult = typeof MagiListRunsResult.Type;
export const MagiGetRunDetailInput = Schema.Struct({
  runId: MagiRunId,
  includeDiagnostics: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type MagiGetRunDetailInput = typeof MagiGetRunDetailInput.Type;

export const MagiSettings = Schema.Struct({
  personalities: Schema.Array(MagiPersonality),
  arbitratorPrompt: boundedString(24_000),
  showRunDetailsAndDiagnostics: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  lastPanelRoster: Schema.Array(MagiParticipantDraft).check(
    Schema.isMaxLength(MAGI_MAX_PARTICIPANTS),
  ),
  lastPanelConsensusThresholdPercent: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 100 }),
  ),
  lastPanelMagiTurnLimit: Schema.NullOr(NonNegativeInt),
});
export type MagiSettings = typeof MagiSettings.Type;

export const MagiSettingsPatch = Schema.Struct({
  personalities: Schema.optionalKey(Schema.Array(MagiPersonality)),
  arbitratorPrompt: Schema.optionalKey(boundedString(24_000)),
  showRunDetailsAndDiagnostics: Schema.optionalKey(Schema.Boolean),
  lastPanelRoster: Schema.optionalKey(
    Schema.Array(MagiParticipantDraft).check(Schema.isMaxLength(MAGI_MAX_PARTICIPANTS)),
  ),
  lastPanelConsensusThresholdPercent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  lastPanelMagiTurnLimit: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type MagiSettingsPatch = typeof MagiSettingsPatch.Type;
export const MagiResetSettingsInput = Schema.Struct({
  target: Schema.Literals(["arbitrator-prompt", "included-personalities"]),
});
export type MagiResetSettingsInput = typeof MagiResetSettingsInput.Type;

export const DEFAULT_MAGI_ARBITRATOR_PROMPT = `You are the impartial arbitrator for this Magi run. Treat participant results and the server-calculated weighted consensus state returned by the Magi tools as authoritative. Participants choose outcomes; you arbitrate them. When there is no consensus, give every current outcome unbiased framing in the next turn. Interpret each participant's complete response. Silence and superficial similarity are not agreement. Malformed structure does not erase useful explicit evidence in the raw response.

Magi supplies no authority to act. Treat only proposals that the server marks threshold-approved as adopted. Pending, rejected, abstained, unclear, and below-threshold proposals remain evidence. Do not fold an unapproved idea into an accepted edit because it appears compatible or editorially convenient.

For advice or information, report only. When the initiating request specifically authorizes execution, carry out only threshold-approved actions within that request. Start another Magi turn whenever the tool says deliberation must continue.

In your final report, indicate if there was an agreed outcome and its main justifications. Otherwise report the final participant outcomes without choosing a leader. Keep discarded alternatives and their reasons brief. Preserve remaining dissent and its reasons, even after consensus. Attribute every outcome, justification, alternative, and dissent with the exact Model and Personality label supplied by the Magi tool. Participant ids are internal bookkeeping and never belong in user-facing text. Never make claims beyond the Magi output. Report only actions performed outside the Magi workflow. Starting the run, dispatching participants, collecting responses, calling tools, and arbitrating are workflow steps, not user-facing actions.`;

export const INCLUDED_MAGI_PERSONALITIES: ReadonlyArray<MagiPersonality> = [
  {
    id: MagiPersonalityId.make("security-specialist"),
    name: "Security specialist",
    included: true,
    prompt:
      "Review the question as a security engineer. Map trust boundaries, assets, likely threat actors, abuse cases, privilege changes, data exposure, supply-chain risks, and insecure defaults. Rank findings by realistic likelihood and impact. Prefer the smallest effective controls and state how to verify them.",
  },
  {
    id: MagiPersonalityId.make("financials-advisor"),
    name: "Financials Advisor",
    included: true,
    prompt:
      "Evaluate sustainability, unit economics, direct and opportunity costs, monetization, operating overhead, and downside exposure. State assumptions. Distinguish cash cost, engineering time, and strategic option value. This perspective is not individualized financial advice.",
  },
  {
    id: MagiPersonalityId.make("tech-evangelist"),
    name: "Tech. Evangelist",
    included: true,
    prompt:
      "Make the strongest credible case for the proposal. Identify concrete user value, product advantages, better developer workflows, and useful extensions. Name prerequisites, adoption barriers, costs, and claims that still need proof.",
  },
  {
    id: MagiPersonalityId.make("product-ux-advocate"),
    name: "Product and UX Advocate",
    included: true,
    prompt:
      "Start with the user's path. Examine discoverability, mental model, setup effort, feedback, recovery, accessibility, multi-device behavior, interruptions, and empty, loading, error, and destructive states. Prefer a small coherent experience. Name measurable success signals.",
  },
  {
    id: MagiPersonalityId.make("reliability-operations-engineer"),
    name: "Reliability and Operations Engineer",
    included: true,
    prompt:
      "Review the design as a production system subject to interruption, restart, rate limits, partial failure, and concurrent clients. Examine idempotency, retries, backpressure, timeouts, cancellation, crash recovery, persistence, monitoring, and cleanup. Require explicit ownership and recovery paths that cannot duplicate external actions.",
  },
  {
    id: MagiPersonalityId.make("maintainability-steward"),
    name: "Maintainability Steward",
    included: true,
    prompt:
      "Check whether the design makes correct behavior obvious to future maintainers. Find duplicated truth, provider assumptions, migration hazards, hidden coupling, and difficult removal paths. Prefer the smallest stable domain model with clear ownership and tests at contract boundaries.",
  },
  {
    id: MagiPersonalityId.make("skeptical-reviewer"),
    name: "Skeptical Reviewer",
    included: true,
    prompt:
      "Test the proposal's premises. Search for counterexamples and falsifying evidence. Consider simpler alternatives, including doing nothing. Watch for correlated assumptions. Acknowledge strong evidence and propose concrete changes that would resolve material objections.",
  },
  {
    id: MagiPersonalityId.make("accessibility-inclusion-advocate"),
    name: "Accessibility and Inclusion Advocate",
    included: true,
    prompt:
      "Assess keyboard, screen-reader, reduced-motion, low-vision, cognitive-load, language, and constrained-device needs. Find color-only meaning, inaccessible status, focus loss, dense configuration, ambiguous labels, and time-sensitive interactions. Recommend semantic controls and focused verification.",
  },
];

export const DEFAULT_MAGI_SETTINGS: MagiSettings = {
  personalities: INCLUDED_MAGI_PERSONALITIES,
  arbitratorPrompt: DEFAULT_MAGI_ARBITRATOR_PROMPT,
  showRunDetailsAndDiagnostics: false,
  lastPanelRoster: [],
  lastPanelConsensusThresholdPercent: MAGI_DEFAULT_THRESHOLD_PERCENT,
  lastPanelMagiTurnLimit: MAGI_DEFAULT_TURN_LIMIT,
};

export const MagiOptionCatalogue = Schema.Struct({
  providerInstances: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      displayName: boundedString(120),
      models: Schema.Array(boundedString(200)),
      modelOptions: Schema.optional(
        Schema.Array(
          Schema.Struct({
            model: boundedString(200),
            optionDescriptors: Schema.Array(ProviderOptionDescriptor),
          }),
        ),
      ),
      magi: ProviderMagiCapabilities,
      available: Schema.Boolean,
      unavailableReason: Schema.NullOr(boundedString(500)),
    }),
  ),
  personalities: Schema.Array(MagiPersonality),
  bounds: Schema.Struct({
    minimumParticipants: Schema.Literal(MAGI_MIN_PARTICIPANTS),
    maximumParticipants: Schema.Literal(MAGI_MAX_PARTICIPANTS),
    minimumWeight: Schema.Literal(MAGI_MIN_WEIGHT),
    maximumWeight: Schema.Literal(MAGI_MAX_WEIGHT),
    maximumContextActivityIds: Schema.Literal(MAGI_MAX_CONTEXT_ACTIVITY_IDS),
  }),
});
export type MagiOptionCatalogue = typeof MagiOptionCatalogue.Type;

const ContextActivityIds = Schema.Array(EventId).check(
  Schema.isMaxLength(MAGI_MAX_CONTEXT_ACTIVITY_IDS),
);

export const MagiGetOptionsInput = Schema.Struct({});
export type MagiGetOptionsInput = typeof MagiGetOptionsInput.Type;
export const MagiGetOptionsResult = MagiOptionCatalogue;
export type MagiGetOptionsResult = typeof MagiGetOptionsResult.Type;

export const MagiListContextActivitiesInput = Schema.Struct({});
export type MagiListContextActivitiesInput = typeof MagiListContextActivitiesInput.Type;
export const MagiListContextActivitiesResult = Schema.Struct({
  activities: Schema.Array(MagiContextActivityOption),
});
export type MagiListContextActivitiesResult = typeof MagiListContextActivitiesResult.Type;

export const ContextReadInput = Schema.Struct({
  artifactIds: Schema.Array(ContextArtifactId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAGI_MAX_CONTEXT_ACTIVITY_IDS),
  ),
});
export type ContextReadInput = typeof ContextReadInput.Type;
export const ContextReadResult = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      artifact: ContextArtifactManifest,
      result: Schema.Unknown,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAGI_MAX_CONTEXT_ACTIVITY_IDS)),
});
export type ContextReadResult = typeof ContextReadResult.Type;

export const MagiStartInput = Schema.Struct({
  config: MagiRunConfig,
  objective: boundedString(MAGI_MAX_OBJECTIVE_CHARS),
  contextActivityIds: ContextActivityIds,
});
export type MagiStartInput = typeof MagiStartInput.Type;

export const MagiDeliberateInput = Schema.Struct({
  runId: MagiRunId,
  contextActivityIds: ContextActivityIds,
});
export type MagiDeliberateInput = typeof MagiDeliberateInput.Type;

export const MagiDeliberationResult = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  candidateFingerprint: Schema.NullOr(MagiCandidateFingerprint),
  participants: Schema.Array(MagiParticipantEvidence),
  totalWeight: NonNegativeInt,
  requiredWeight: NonNegativeInt,
  thresholdReachable: Schema.Boolean,
  pendingProposalIds: Schema.Array(MagiProposalId),
  controlInstructions: Schema.optional(Schema.String),
});
export type MagiDeliberationResult = typeof MagiDeliberationResult.Type;
export const MagiStartResult = MagiDeliberationResult;
export type MagiStartResult = typeof MagiStartResult.Type;

const { terminalProposalDigest: _terminalProposalDigest, ...MagiArbitrationInputFields } =
  MagiArbitrationRecord.fields;

export const MagiRecordArbitrationInput = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  record: Schema.Struct({
    ...MagiArbitrationInputFields,
    terminalProposalDigestUpdates: Schema.Array(MagiTerminalProposalDigestEntry),
  }),
});
export type MagiRecordArbitrationInput = typeof MagiRecordArbitrationInput.Type;
export const MagiRecordArbitrationResult = Schema.Struct({
  runId: MagiRunId,
  supportWeight: NonNegativeInt,
  opposingWeight: NonNegativeInt,
  unclearWeight: NonNegativeInt,
  acceptedProposalIds: Schema.Array(MagiProposalId),
  rejectedProposalIds: Schema.Array(MagiProposalId),
  unresolvedProposalIds: Schema.Array(MagiProposalId),
  pendingProposalIds: Schema.Array(MagiProposalId),
  transition: MagiArbitrationTransition,
});
export type MagiRecordArbitrationResult = typeof MagiRecordArbitrationResult.Type;

export const MagiGetTerminalProposalsInput = Schema.Struct({
  runId: MagiRunId,
  scope: Schema.Literals(["missing-digest", "all-terminal"]),
  offset: NonNegativeInt,
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAGI_TERMINAL_PROPOSAL_PAGE_MAX }),
  ),
  includePersistedDigest: Schema.Boolean,
});
export type MagiGetTerminalProposalsInput = typeof MagiGetTerminalProposalsInput.Type;
export const MagiGetTerminalProposalsResult = Schema.Struct({
  runId: MagiRunId,
  terminalProposalCount: NonNegativeInt,
  missingDigestCount: NonNegativeInt,
  persistedDigestEntryCount: NonNegativeInt,
  proposals: Schema.Array(MagiProposal),
  nextOffset: Schema.NullOr(NonNegativeInt),
  persistedDigest: Schema.NullOr(Schema.Array(MagiTerminalProposalDigestEntry)),
});
export type MagiGetTerminalProposalsResult = typeof MagiGetTerminalProposalsResult.Type;

export const MagiRecoverTurnResultInput = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  participantIndex: NonNegativeInt,
  representation: Schema.Literals(["best-available", "raw"]),
});
export type MagiRecoverTurnResultInput = typeof MagiRecoverTurnResultInput.Type;
export const MagiRecoverTurnResult = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  participantCount: NonNegativeInt,
  participantIndex: NonNegativeInt,
  participant: MagiParticipantEvidence,
  nextParticipantIndex: Schema.NullOr(NonNegativeInt),
});
export type MagiRecoverTurnResult = typeof MagiRecoverTurnResult.Type;

export const MagiRecoverRunContextInput = Schema.Struct({
  runId: MagiRunId,
});
export type MagiRecoverRunContextInput = typeof MagiRecoverRunContextInput.Type;
export const MagiRecoverRunContextResult = Schema.Struct({
  runId: MagiRunId,
  state: MagiRunState,
  completedMagiTurns: NonNegativeInt,
  latestMagiTurn: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  participantIds: Schema.Array(MagiParticipantId),
  totalWeight: NonNegativeInt,
  requiredWeight: NonNegativeInt,
  thresholdReachable: Schema.Boolean,
  candidate: Schema.NullOr(MagiCandidate),
  candidateFingerprint: Schema.NullOr(MagiCandidateFingerprint),
  recordedActions: Schema.Array(MagiRecordedAction),
  issuedActionBatch: Schema.NullOr(MagiIssuedActionBatch),
  unresolvedDisagreements: textArray,
  pendingProposalIds: Schema.Array(MagiProposalId),
  pendingProposals: Schema.Array(MagiProposal),
  activeDecisionSets: Schema.Array(MagiKnownDecisionSet),
  nextRequiredTool: Schema.Literals([
    "magi_deliberate",
    "magi_recover_turn_result",
    "magi_record_actions",
    "none",
  ]),
  controlInstructions: Schema.String,
});
export type MagiRecoverRunContextResult = typeof MagiRecoverRunContextResult.Type;

export const MagiRecordActionsInput = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  record: MagiActionRecord,
});
export type MagiRecordActionsInput = typeof MagiRecordActionsInput.Type;
export const MagiRecordActionsResult = Schema.Struct({
  runId: MagiRunId,
  transition: Schema.Literals(["continue", "awaiting-action-reconciliation", "turn-limit-reached"]),
  mandatoryReassessmentActionIds: Schema.Array(MagiActionRecordId),
});
export type MagiRecordActionsResult = typeof MagiRecordActionsResult.Type;

export const MagiValidationErrorReason = Schema.Literals([
  "invalid-config",
  "duplicate-participant-id",
  "unknown-personality",
  "unavailable-model",
  "draw-capable-threshold",
  "magi-run-active",
  "magi-run-not-active",
  "recursive-start",
  "foreign-turn",
  "unknown-activity",
  "foreign-activity",
  "unfinished-activity",
  "duplicate-activity",
  "oversized-activity",
  "invalid-protocol-state",
  "turn-limit-reached",
]);
export type MagiValidationErrorReason = typeof MagiValidationErrorReason.Type;

export class MagiValidationError extends Schema.TaggedErrorClass<MagiValidationError>()(
  "MagiValidationError",
  {
    reason: MagiValidationErrorReason,
    message: boundedString(2_000),
    field: Schema.NullOr(boundedString(200)),
  },
) {}

export class MagiControlUnavailableError extends Schema.TaggedErrorClass<MagiControlUnavailableError>()(
  "MagiControlUnavailableError",
  {
    capability: Schema.Literal("magi-control"),
    environmentId: TrimmedNonEmptyString,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return "MCP credential does not grant the magi-control capability.";
  }
}

export class MagiContextUnavailableError extends Schema.TaggedErrorClass<MagiContextUnavailableError>()(
  "MagiContextUnavailableError",
  {
    capability: Schema.Literal("magi-context"),
    environmentId: TrimmedNonEmptyString,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return "MCP credential does not grant the magi-context capability.";
  }
}

export interface MagiThreshold {
  readonly totalWeight: number;
  readonly requiredWeight: number;
  readonly thresholdPercent: number;
  readonly valid: boolean;
}

export const totalMagiWeight = (
  participants: ReadonlyArray<Pick<MagiParticipantDraft, "weight">>,
): number => participants.reduce((total, participant) => total + participant.weight, 0);

export const requiredMagiWeight = (totalWeight: number, thresholdPercent: number): number =>
  Math.ceil((totalWeight * thresholdPercent) / 100);

export interface MagiParticipantVoteWeights {
  readonly agreedWeight: number;
  readonly opposedWeight: number;
}

export const magiParticipantVoteWeights = (
  participants: ReadonlyArray<Pick<MagiParticipantDraft, "participantId" | "weight">>,
  votes:
    | ReadonlyArray<{
        readonly participantId: MagiParticipantId;
        readonly stance: MagiArbitrationStance | null;
      }>
    | null
    | undefined,
): MagiParticipantVoteWeights => {
  const stanceByParticipant = new Map(
    (votes ?? []).map((vote) => [vote.participantId, vote.stance] as const),
  );
  let agreedWeight = 0;
  let opposedWeight = 0;
  for (const participant of participants) {
    const stance = stanceByParticipant.get(participant.participantId);
    if (stance === "supports") agreedWeight += participant.weight;
    if (stance === "opposes") opposedWeight += participant.weight;
  }
  return { agreedWeight, opposedWeight };
};

export const minimumValidMagiThresholdPercent = (totalWeight: number): number => {
  if (!Number.isInteger(totalWeight) || totalWeight <= 0) return 101;
  for (let percentage = 1; percentage <= 100; percentage += 1) {
    if (requiredMagiWeight(totalWeight, percentage) > totalWeight / 2) return percentage;
  }
  return 101;
};

export const calculateMagiThreshold = (
  participants: ReadonlyArray<Pick<MagiParticipantDraft, "weight">>,
  thresholdPercent: number,
): MagiThreshold => {
  const totalWeight = totalMagiWeight(participants);
  const requiredWeight = requiredMagiWeight(totalWeight, thresholdPercent);
  return {
    totalWeight,
    requiredWeight,
    thresholdPercent,
    valid: totalWeight > 0 && requiredWeight > totalWeight / 2,
  };
};

export const isMagiThresholdReachable = (
  requiredWeight: number,
  settledSupportWeight: number,
  unsettledWeight: number,
): boolean => settledSupportWeight + unsettledWeight >= requiredWeight;

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, " ");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return typeof value === "string" ? normalizeWhitespace(value) : value;
};

const stableSerialize = (value: unknown): string => JSON.stringify(stableValue(value));

const deterministicHash = (value: unknown): string =>
  Array.from(sha256(new TextEncoder().encode(stableSerialize(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const magiContextArtifactId = (
  runId: MagiRunId,
  magiTurn: number,
  activityId: EventId,
): ContextArtifactId => ContextArtifactId.make(`context_${runId}_${magiTurn}_${activityId}`);

/** Stable retry identity for a provider's magi_start call. The provider
 * session id is added by the server, keeping independent conversations apart. */
export const magiStartIdempotencyKey = (input: MagiStartInput): string =>
  `start_${deterministicHash(input)}`;

export const magiActionLogDigest = (actions: ReadonlyArray<MagiRecordedAction>): string =>
  deterministicHash(
    actions.map((action) => ({
      actionId: action.actionId,
      status: action.status,
      relatedProposalIds: [...action.relatedProposalIds].sort(),
      summary: action.summary,
      details: action.details,
      unforeseenConsequence: action.unforeseenConsequence,
    })),
  );

export const magiCandidateFingerprint = (
  candidate: MagiCandidate,
  actions: ReadonlyArray<MagiRecordedAction>,
): MagiCandidateFingerprint =>
  MagiCandidateFingerprint.make(
    `candidate_${deterministicHash({ candidate, actionDigest: magiActionLogDigest(actions) })}`,
  );

export const deterministicMagiActionRecordId = (
  runId: MagiRunId,
  magiTurn: number,
  actionIndex: number,
  idempotencyKey: string,
): MagiActionRecordId =>
  MagiActionRecordId.make(
    `action_${deterministicHash({ runId, magiTurn, actionIndex, idempotencyKey })}`,
  );

export const deriveMagiActionObligation = (
  relatedProposalIds: ReadonlyArray<MagiProposalId>,
  proposalKinds: ReadonlyMap<string, MagiProposalKind>,
): MagiActionObligation => {
  if (relatedProposalIds.length === 0) return "required";
  return relatedProposalIds.every((id) => proposalKinds.get(id) === "optional")
    ? "optional"
    : "required";
};

export const isMaterialMagiCandidateChange = (
  previous: MagiCandidate,
  next: MagiCandidate,
): boolean => stableSerialize(previous) !== stableSerialize(next);

export const normalizeMagiProposal = (proposal: MagiProposalInput): string =>
  stableSerialize({
    kind: proposal.kind,
    change: normalizeWhitespace(proposal.change),
    rationale: normalizeWhitespace(proposal.rationale),
    expectedVoteEffect: normalizeWhitespace(proposal.expectedVoteEffect),
    atomicSetKey:
      proposal.atomicSetKey === null ? null : normalizeWhitespace(proposal.atomicSetKey),
  });

export const magiProposalIdentity = (
  runId: MagiRunId,
  proposal: MagiProposalInput,
): MagiProposalId =>
  MagiProposalId.make(
    `proposal_${deterministicHash({ runId, normalized: normalizeMagiProposal(proposal) })}`,
  );

export const magiExclusiveDecisionSetFingerprint = (
  runId: MagiRunId,
  proposalIds: ReadonlyArray<MagiProposalId>,
): MagiDecisionSetId =>
  MagiDecisionSetId.make(
    `decision_${deterministicHash({ runId, proposalIds: [...proposalIds].sort() })}`,
  );

export interface MagiCurrentTurnVoteTotals {
  supportWeight: number;
  opposingWeight: number;
  unclearWeight: number;
}

export const currentMagiTurnVoteTotals = (
  assessments: ReadonlyArray<MagiParticipantAssessment>,
  weights: ReadonlyMap<string, number>,
): MagiCurrentTurnVoteTotals =>
  assessments.reduce<MagiCurrentTurnVoteTotals>(
    (totals, assessment) => {
      const weight = weights.get(assessment.participantId) ?? 0;
      if (assessment.stance === "supports") {
        totals.supportWeight += weight;
        return totals;
      }
      if (assessment.stance === "opposes") {
        totals.opposingWeight += weight;
        return totals;
      }
      totals.unclearWeight += weight;
      return totals;
    },
    { supportWeight: 0, opposingWeight: 0, unclearWeight: 0 },
  );

export const hasExplicitOriginatorEvaluation = (
  proposalId: MagiProposalId,
  originatorId: MagiParticipantId,
  evaluations: ReadonlyArray<{
    readonly participantId: MagiParticipantId;
    readonly evaluation: MagiProposalEvaluation;
  }>,
): boolean =>
  evaluations.some(
    ({ participantId, evaluation }) =>
      participantId === originatorId && evaluation.proposalId === proposalId,
  );

export const pendingMagiEvaluationParticipantIds = (
  participantIds: ReadonlyArray<MagiParticipantId>,
  evaluatedParticipantIds: ReadonlySet<string>,
): ReadonlyArray<MagiParticipantId> =>
  participantIds.filter((participantId) => !evaluatedParticipantIds.has(participantId));

export const magiContextualClarifications = (
  assessments: ReadonlyArray<MagiParticipantAssessment>,
): ReadonlyArray<MagiParticipantAssessment> =>
  assessments.filter(
    (assessment) =>
      assessment.stance === "unclear" &&
      assessment.clarificationNeeded &&
      assessment.clarificationQuestion !== null,
  );

export const magiActionsRequiringReassessment = (
  actions: ReadonlyArray<MagiRecordedAction>,
): ReadonlyArray<MagiRecordedAction> =>
  actions.filter(
    (action) =>
      action.status === "unknown" ||
      action.unforeseenConsequence !== null ||
      (action.obligation === "required" && action.status === "not-completed"),
  );

export const magiActionReconciliationState = (
  actions: ReadonlyArray<MagiRecordedAction>,
): "reconciled" | "awaiting-action-reconciliation" =>
  actions.some((action) => action.status === "unknown")
    ? "awaiting-action-reconciliation"
    : "reconciled";

export const normalizeMagiTurnLimit = (value: number | null | ""): number | null =>
  value === "" || value === null || value === 0 ? null : value;

export const hasMagiTurnRemaining = (
  completedMagiTurns: number,
  magiTurnLimit: number | null,
): boolean => magiTurnLimit === null || completedMagiTurns < magiTurnLimit;

export const calculateMagiDirectTransition = (input: {
  readonly consensusReached: boolean;
  readonly pendingEvaluations: boolean;
  readonly completedMagiTurns: number;
  readonly magiTurnLimit: number | null;
}): MagiDirectTransition => {
  if (input.consensusReached && !input.pendingEvaluations) return "consensus-reached";
  return hasMagiTurnRemaining(input.completedMagiTurns, input.magiTurnLimit)
    ? "continue"
    : "turn-limit-reached";
};

export const calculateMagiPostActionTransition = (
  completedMagiTurns: number,
  magiTurnLimit: number | null,
): MagiPostActionTransition =>
  hasMagiTurnRemaining(completedMagiTurns, magiTurnLimit) ? "continue" : "turn-limit-reached";

export const calculateMagiActivityMetrics = (input: {
  readonly runId: MagiRunId;
  readonly source: MagiRunSource;
  readonly state: MagiRunState;
  readonly completedMagiTurns: number;
  readonly magiTurnLimit: number | null;
  readonly totalWeight: number;
  readonly requiredWeight: number;
  readonly comparableOutcomes: ReadonlyArray<{ readonly label: string; readonly weight: number }>;
}): MagiActivitySummary => {
  const leading = [...input.comparableOutcomes].sort(
    (left, right) => right.weight - left.weight || left.label.localeCompare(right.label),
  )[0];
  return {
    runId: input.runId,
    source: input.source,
    state: input.state,
    completedMagiTurns: input.completedMagiTurns,
    magiTurnLimit: input.magiTurnLimit,
    totalWeight: input.totalWeight,
    leadingAgreementWeight: leading?.weight ?? null,
    leadingAgreementLabel: leading?.label ?? null,
    requiredWeight: input.requiredWeight,
  };
};

export const pendingMagiRunTitle = (): MagiRunTitleState => ({
  state: "pending",
  title: "Magi run",
});

export const failedMagiRunTitle = (): MagiRunTitleState => ({
  state: "failed",
  title: "Magi run",
  diagnostic: "Title generation failed",
});

export interface MagiRosterValidationIssue {
  readonly reason:
    | "participant-count"
    | "duplicate-participant-id"
    | "invalid-weight"
    | "draw-capable-threshold";
  readonly participantId: MagiParticipantId | null;
  readonly message: string;
}

export const validateMagiRoster = (
  config: MagiRunConfig,
): ReadonlyArray<MagiRosterValidationIssue> => {
  const issues: Array<MagiRosterValidationIssue> = [];
  if (
    config.participants.length < MAGI_MIN_PARTICIPANTS ||
    config.participants.length > MAGI_MAX_PARTICIPANTS
  ) {
    issues.push({
      reason: "participant-count",
      participantId: null,
      message: `Magi requires ${MAGI_MIN_PARTICIPANTS} to ${MAGI_MAX_PARTICIPANTS} participants.`,
    });
  }

  const seen = new Set<string>();
  for (const participant of config.participants) {
    if (seen.has(participant.participantId)) {
      issues.push({
        reason: "duplicate-participant-id",
        participantId: participant.participantId,
        message: `Participant id ${participant.participantId} appears more than once.`,
      });
    }
    seen.add(participant.participantId);
    if (
      !Number.isInteger(participant.weight) ||
      participant.weight < MAGI_MIN_WEIGHT ||
      participant.weight > MAGI_MAX_WEIGHT
    ) {
      issues.push({
        reason: "invalid-weight",
        participantId: participant.participantId,
        message: `Participant weight must be between ${MAGI_MIN_WEIGHT} and ${MAGI_MAX_WEIGHT}.`,
      });
    }
  }

  if (!calculateMagiThreshold(config.participants, config.consensusThresholdPercent).valid) {
    issues.push({
      reason: "draw-capable-threshold",
      participantId: null,
      message: "Consensus threshold must be greater than 50% of the configured participant weight.",
    });
  }
  return issues;
};

export const exactDuplicateMagiParticipantGroups = (
  participants: ReadonlyArray<MagiParticipantDraft>,
): ReadonlyArray<ReadonlyArray<MagiParticipantId>> => {
  const groups = new Map<string, Array<MagiParticipantId>>();
  for (const participant of participants) {
    const key = stableSerialize({
      modelSelection: participant.modelSelection,
      personalityId: participant.personalityId,
    });
    const group = groups.get(key) ?? [];
    group.push(participant.participantId);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
};

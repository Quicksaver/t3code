import { sha256 } from "@noble/hashes/sha2.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ContextArtifactId,
  IsoDateTime,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const boundedString = (maximum: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(maximum));

export const MAGI_MIN_PARTICIPANTS = 2;
export const MAGI_MIN_WEIGHT = 1;
export const MAGI_MAX_WEIGHT = 100;
export const MAGI_MIN_THRESHOLD_PERCENT = 1;
export const MAGI_MAX_THRESHOLD_PERCENT = 100;
export const MAGI_MAX_CONTEXT_ACTIVITY_IDS = 32;
export const MAGI_MAX_CONTEXT_ACTIVITY_BYTES = 120_000;
export const MAGI_MAX_OBJECTIVE_CHARS = 8_000;
export const MAGI_MAX_CANDIDATE_FIELD_CHARS = 16_000;
export const MAGI_TERMINAL_PROPOSAL_PAGE_MAX = 20;

export const MagiRunId = TrimmedNonEmptyString.pipe(Schema.brand("MagiRunId"));
export type MagiRunId = typeof MagiRunId.Type;
export const MagiParticipantId = TrimmedNonEmptyString.pipe(Schema.brand("MagiParticipantId"));
export type MagiParticipantId = typeof MagiParticipantId.Type;
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

// Existing runs retain their initiation provenance after arming is removed.
export const MagiRunSource = Schema.Literals(["user-arm", "agent-tool"]);
export type MagiRunSource = typeof MagiRunSource.Type;

export const ProviderContextUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  limitTokens: Schema.NullOr(NonNegativeInt),
  measuredAt: IsoDateTime,
});
export type ProviderContextUsage = typeof ProviderContextUsage.Type;

export const MagiParticipantDraft = Schema.Struct({
  participantId: MagiParticipantId,
  modelSelection: ModelSelection,
  weight: Schema.Int.check(
    Schema.isBetween({ minimum: MAGI_MIN_WEIGHT, maximum: MAGI_MAX_WEIGHT }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(1))),
});
export type MagiParticipantDraft = typeof MagiParticipantDraft.Type;

export const MagiRunConfig = Schema.Struct({
  participants: Schema.Array(MagiParticipantDraft).check(Schema.isMinLength(MAGI_MIN_PARTICIPANTS)),
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
  participantRunId: Schema.NullOr(RunId),
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
  participantRunId: Schema.NullOr(RunId),
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
  /** The server derives the id from the run and proposal ids; a supplied id must match it. */
  decisionSetId: Schema.optionalKey(MagiDecisionSetId),
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

/** A selected tool result. Its complete payload lives in the per-participant artifact store. */
export const MagiActivityReference = Schema.Struct({
  artifactId: ContextArtifactId,
  activityId: TurnItemId,
  runId: RunId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: NonNegativeInt,
});
export type MagiActivityReference = typeof MagiActivityReference.Type;

export const ContextArtifactManifest = Schema.Struct({
  artifactId: ContextArtifactId,
  sourceActivityId: TurnItemId,
  sourceRunId: RunId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: NonNegativeInt,
});
export type ContextArtifactManifest = typeof ContextArtifactManifest.Type;

export const MagiContextActivityOption = Schema.Struct({
  activityId: TurnItemId,
  runId: RunId,
  kind: boundedString(200),
  summary: boundedString(2_000),
  byteLength: NonNegativeInt,
});
export type MagiContextActivityOption = typeof MagiContextActivityOption.Type;

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

export const MagiRunSummary = Schema.Struct({
  runId: MagiRunId,
  rootThreadId: ThreadId,
  source: MagiRunSource,
  state: MagiRunState,
  completedMagiTurns: NonNegativeInt,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type MagiRunSummary = typeof MagiRunSummary.Type;

export const MagiRunDetail = Schema.Struct({
  summary: MagiRunSummary,
  config: MagiRunConfig,
  totalWeight: NonNegativeInt,
  requiredWeight: NonNegativeInt,
  participants: Schema.Array(
    Schema.Struct({
      participantId: MagiParticipantId,
      modelSelection: ModelSelection,
      weight: Schema.Int,
      state: MagiMemberState,
      childThreadId: Schema.NullOr(ThreadId),
    }),
  ),
  settlements: Schema.Array(MagiParticipantSettlement),
  candidate: Schema.NullOr(MagiCandidate),
  actions: Schema.Array(MagiRecordedAction),
  issuedActionBatch: Schema.NullOr(MagiIssuedActionBatch),
});
export type MagiRunDetail = typeof MagiRunDetail.Type;

export const MagiControlRunInput = Schema.Struct({
  runId: MagiRunId,
  action: Schema.Literals(["pause", "resume", "stop"]),
});
export type MagiControlRunInput = typeof MagiControlRunInput.Type;

export const MagiSettingsPatch = Schema.Struct({
  arbitratorPrompt: Schema.optionalKey(boundedString(24_000)),
});
export type MagiSettingsPatch = typeof MagiSettingsPatch.Type;

export const DEFAULT_MAGI_ARBITRATOR_PROMPT = `Start only after the user explicitly requests Magi and supplies the roster, consensus threshold, and turn limit. Ask the user to clarify any missing or ambiguous value before starting. Never invent participants or default the threshold or turn limit. A turn limit of null or 0 means unlimited only when the user explicitly requests it. Voting weight defaults to 1 unless explicitly overridden.

You are the impartial arbitrator for this Magi run. Treat participant results and the server-calculated weighted consensus state returned by the Magi tools as authoritative. Participants choose outcomes; you arbitrate them. When there is no consensus, give every current outcome unbiased framing in the next turn. Interpret each participant's complete response. Silence and superficial similarity are not agreement. Malformed structure does not erase useful explicit evidence in the raw response.

Magi supplies no authority to act. Treat only proposals that the server marks threshold-approved as adopted. Pending, rejected, abstained, unclear, and below-threshold proposals remain evidence. Do not fold an unapproved idea into an accepted edit because it appears compatible or editorially convenient.

For advice or information, report only. When the initiating request specifically authorizes execution, carry out only threshold-approved actions within that request. Start another Magi turn whenever the tool says deliberation must continue.

In your final report, indicate if there was an agreed outcome and its main justifications. Otherwise report the final participant outcomes without choosing a leader. Keep discarded alternatives and their reasons brief. Preserve remaining dissent and its reasons, even after consensus. Attribute every outcome, justification, alternative, and dissent with the exact Model label supplied by the Magi tool. Participant ids are internal bookkeeping and never belong in user-facing text. Never make claims beyond the Magi output. Report only actions performed outside the Magi workflow. Starting the run, dispatching participants, collecting responses, calling tools, and arbitrating are workflow steps, not user-facing actions.`;

/**
 * Every field decodes to its bundled default when absent, so settings.json stores only the
 * fields a user changed and unchanged defaults keep tracking the bundled values.
 */
export const MagiSettings = Schema.Struct({
  arbitratorPrompt: boundedString(24_000).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAGI_ARBITRATOR_PROMPT)),
  ),
});
export type MagiSettings = typeof MagiSettings.Type;

export const DEFAULT_MAGI_SETTINGS: MagiSettings = {
  arbitratorPrompt: DEFAULT_MAGI_ARBITRATOR_PROMPT,
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
      available: Schema.Boolean,
      unavailableReason: Schema.NullOr(boundedString(500)),
    }),
  ),
  bounds: Schema.Struct({
    minimumParticipants: Schema.Literal(MAGI_MIN_PARTICIPANTS),
    minimumWeight: Schema.Literal(MAGI_MIN_WEIGHT),
    maximumWeight: Schema.Literal(MAGI_MAX_WEIGHT),
    maximumContextActivityIds: Schema.Literal(MAGI_MAX_CONTEXT_ACTIVITY_IDS),
  }),
});
export type MagiOptionCatalogue = typeof MagiOptionCatalogue.Type;

const ContextActivityIds = Schema.Array(TurnItemId).check(
  Schema.isMaxLength(MAGI_MAX_CONTEXT_ACTIVITY_IDS),
);

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

/** Roster, threshold, and turn limit must reflect the user's explicit instructions. */
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
/** Deliberation is accepted immediately; completion wakes the owning conversation. */
export const MagiStartResult = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: MagiRunState,
  controlInstructions: Schema.String,
});
export type MagiStartResult = typeof MagiStartResult.Type;

export const MagiGetTurnResultInput = Schema.Struct({
  runId: MagiRunId,
  magiTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type MagiGetTurnResultInput = typeof MagiGetTurnResultInput.Type;

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
  /** The server-derived id of each declared exclusive decision set, in request order. */
  exclusiveDecisionSetIds: Schema.Array(MagiDecisionSetId),
  /**
   * The candidate fingerprint participants assessed this turn. Any change to that candidate's
   * content sets `candidateChanged`, and then every stance counts as unclear until a fresh ballot.
   */
  assessedCandidateFingerprint: Schema.NullOr(MagiCandidateFingerprint),
  candidateChanged: Schema.Boolean,
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
    "magi_get_turn_result",
    "magi_recover_turn_result",
    "magi_record_actions",
    "magi_control_run",
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

export class MagiValidationError extends Schema.TaggedError<MagiValidationError>()(
  "MagiValidationError",
  {
    reason: MagiValidationErrorReason,
    message: boundedString(2_000),
    field: Schema.NullOr(boundedString(200)),
  },
) {}

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
  activityId: TurnItemId,
): ContextArtifactId => ContextArtifactId.make(`context_${runId}_${magiTurn}_${activityId}`);

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

export const normalizeMagiTurnLimit = (value: number | null): number | null =>
  value === null || value === 0 ? null : value;

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

export interface MagiRosterValidationIssue {
  readonly reason:
    | "participant-count"
    | "duplicate-participant-id"
    | "invalid-weight"
    | "invalid-threshold"
    | "draw-capable-threshold";
  readonly participantId: MagiParticipantId | null;
  readonly message: string;
}

export const validateMagiRoster = (
  config: MagiRunConfig,
): ReadonlyArray<MagiRosterValidationIssue> => {
  const issues: Array<MagiRosterValidationIssue> = [];
  if (config.participants.length < MAGI_MIN_PARTICIPANTS) {
    issues.push({
      reason: "participant-count",
      participantId: null,
      message: `Magi requires at least ${MAGI_MIN_PARTICIPANTS} participants.`,
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

  if (
    !Number.isInteger(config.consensusThresholdPercent) ||
    config.consensusThresholdPercent < MAGI_MIN_THRESHOLD_PERCENT ||
    config.consensusThresholdPercent > MAGI_MAX_THRESHOLD_PERCENT
  ) {
    issues.push({
      reason: "invalid-threshold",
      participantId: null,
      message: `Consensus threshold must be a whole percentage from ${MAGI_MIN_THRESHOLD_PERCENT} to ${MAGI_MAX_THRESHOLD_PERCENT}.`,
    });
  } else if (!calculateMagiThreshold(config.participants, config.consensusThresholdPercent).valid) {
    issues.push({
      reason: "draw-capable-threshold",
      participantId: null,
      message: "Consensus threshold must be greater than 50% of the configured participant weight.",
    });
  }
  return issues;
};

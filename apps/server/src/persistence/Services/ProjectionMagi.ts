import {
  IsoDateTime,
  MagiArmThreadResult,
  MagiListRunsInput,
  MagiListRunsResult,
  MagiRunDetail,
  MagiRunId,
  MagiRunState,
  MessageId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PersistedMagiRun = Schema.Struct({
  detail: MagiRunDetail,
  initiatingReferenceId: Schema.NullOr(Schema.String),
  initiatingInstruction: Schema.String,
  focusedObjective: Schema.NullOr(Schema.String),
  arbitratorPrompt: Schema.String,
  // Legacy snapshots may carry the removed participant timeout. New runs omit it.
  participantTimeoutMinutes: Schema.optionalKey(Schema.Int),
  protocol: Schema.Unknown,
  updatedAt: IsoDateTime,
  mainTurnId: Schema.NullOr(TurnId),
  mainMessageId: Schema.NullOr(MessageId),
});
export type PersistedMagiRun = typeof PersistedMagiRun.Type;

export interface ProjectionMagiRepositoryShape {
  readonly putArm: (arm: MagiArmThreadResult) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getArm: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<MagiArmThreadResult>, ProjectionRepositoryError>;
  readonly deleteArm: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly putRun: (run: PersistedMagiRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getRun: (
    runId: MagiRunId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly findActiveRun: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly findRunByInitiatingReferenceId: (
    initiatingReferenceId: string,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly findRunByParticipantThreadId: (
    participantThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly listRecoverableRuns: () => Effect.Effect<
    ReadonlyArray<PersistedMagiRun>,
    ProjectionRepositoryError
  >;
  readonly listRuns: (
    input: MagiListRunsInput,
  ) => Effect.Effect<MagiListRunsResult, ProjectionRepositoryError>;
  readonly setActiveSummary: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByOwnerThreadId: (
    ownerThreadId: ThreadId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export const RECOVERABLE_MAGI_STATES: ReadonlyArray<MagiRunState> = [
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
];

export class ProjectionMagiRepository extends Context.Service<
  ProjectionMagiRepository,
  ProjectionMagiRepositoryShape
>()("t3/persistence/Services/ProjectionMagi/ProjectionMagiRepository") {}

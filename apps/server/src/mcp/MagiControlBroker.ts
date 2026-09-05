import {
  DEFAULT_MAGI_SETTINGS,
  MagiDeliberateInput,
  MagiDeliberationResult,
  MagiGetOptionsInput,
  MagiGetOptionsResult,
  MagiGetTerminalProposalsInput,
  MagiGetTerminalProposalsResult,
  MagiRecoverRunContextInput,
  MagiRecoverRunContextResult,
  MagiRecoverTurnResultInput,
  MagiRecoverTurnResult,
  MagiRecordActionsInput,
  MagiRecordActionsResult,
  MagiRecordArbitrationInput,
  MagiRecordArbitrationResult,
  MagiStartInput,
  MagiStartResult,
  magiStartIdempotencyKey,
  MagiValidationError,
  type MagiArmThreadInput,
  type MagiArmThreadResult,
  type MagiGetArmResult,
  type MagiGetRunDetailInput,
  type MagiDiagnosticsInput,
  type MagiDiagnosticsResult,
  type MagiListContextActivitiesInput,
  type MagiListContextActivitiesResult,
  type MagiListRunsInput,
  type MagiListRunsResult,
  type MagiReconcileActionsInput,
  type MagiRunDetail,
  type MagiRunId,
  type MagiSettings,
  type MagiSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface MagiControlHandlers {
  readonly getArmedTurnInstructions: (
    threadId: ThreadId,
    initiatingInstruction: string,
  ) => Effect.Effect<string | null, MagiValidationError>;
  readonly getPanelOptions: () => Effect.Effect<MagiGetOptionsResult, MagiValidationError>;
  readonly getSettings: () => Effect.Effect<MagiSettings>;
  readonly updateSettings: (
    input: MagiSettingsPatch,
  ) => Effect.Effect<MagiSettings, MagiValidationError>;
  readonly resetSettings: (
    target: "arbitrator-prompt" | "included-personalities",
  ) => Effect.Effect<MagiSettings, MagiValidationError>;
  readonly armThread: (
    input: MagiArmThreadInput,
  ) => Effect.Effect<MagiArmThreadResult, MagiValidationError>;
  readonly getArm: (threadId: ThreadId) => Effect.Effect<MagiGetArmResult, MagiValidationError>;
  readonly disarmThread: (
    threadId: ThreadId,
    expectedRevision: number,
  ) => Effect.Effect<void, MagiValidationError>;
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
  readonly exportDiagnostics: (
    input: MagiDiagnosticsInput,
  ) => Effect.Effect<MagiDiagnosticsResult, MagiValidationError>;
  readonly getOptions: (
    scope: McpInvocationScope,
    input: MagiGetOptionsInput,
  ) => Effect.Effect<MagiGetOptionsResult, MagiValidationError>;
  readonly listContextActivities: (
    scope: McpInvocationScope,
    input: MagiListContextActivitiesInput,
  ) => Effect.Effect<MagiListContextActivitiesResult, MagiValidationError>;
  readonly start: (
    scope: McpInvocationScope,
    input: MagiStartInput,
  ) => Effect.Effect<MagiStartResult, MagiValidationError>;
  readonly deliberate: (
    scope: McpInvocationScope,
    input: MagiDeliberateInput,
  ) => Effect.Effect<MagiDeliberationResult, MagiValidationError>;
  readonly recordArbitration: (
    scope: McpInvocationScope,
    input: MagiRecordArbitrationInput,
  ) => Effect.Effect<MagiRecordArbitrationResult, MagiValidationError>;
  readonly getTerminalProposals: (
    scope: McpInvocationScope,
    input: MagiGetTerminalProposalsInput,
  ) => Effect.Effect<MagiGetTerminalProposalsResult, MagiValidationError>;
  readonly recoverTurnResult: (
    scope: McpInvocationScope,
    input: MagiRecoverTurnResultInput,
  ) => Effect.Effect<MagiRecoverTurnResult, MagiValidationError>;
  readonly recoverRunContext: (
    scope: McpInvocationScope,
    input: MagiRecoverRunContextInput,
  ) => Effect.Effect<MagiRecoverRunContextResult, MagiValidationError>;
  readonly recordActions: (
    scope: McpInvocationScope,
    input: MagiRecordActionsInput,
  ) => Effect.Effect<MagiRecordActionsResult, MagiValidationError>;
}

export class MagiControlBroker extends Context.Service<MagiControlBroker, MagiControlHandlers>()(
  "t3/mcp/MagiControlBroker",
) {}

let activeHandlers: MagiControlHandlers | undefined;

const unavailable = () =>
  Effect.fail(
    new MagiValidationError({
      reason: "invalid-protocol-state",
      message: "Magi control is not available while the server is starting or stopping.",
      field: null,
    }),
  );

export const proxy: MagiControlHandlers = {
  getArmedTurnInstructions: (threadId, initiatingInstruction) =>
    activeHandlers?.getArmedTurnInstructions(threadId, initiatingInstruction) ??
    Effect.succeed(null),
  getPanelOptions: () => activeHandlers?.getPanelOptions() ?? unavailable(),
  getSettings: () => activeHandlers?.getSettings() ?? Effect.succeed(DEFAULT_MAGI_SETTINGS),
  updateSettings: (input) => activeHandlers?.updateSettings(input) ?? unavailable(),
  resetSettings: (target) => activeHandlers?.resetSettings(target) ?? unavailable(),
  armThread: (input) => activeHandlers?.armThread(input) ?? unavailable(),
  getArm: (threadId) => activeHandlers?.getArm(threadId) ?? unavailable(),
  disarmThread: (threadId, expectedRevision) =>
    activeHandlers?.disarmThread(threadId, expectedRevision) ?? unavailable(),
  cancelRun: (runId) => activeHandlers?.cancelRun(runId) ?? unavailable(),
  continueRun: (runId) => activeHandlers?.continueRun(runId) ?? unavailable(),
  reconcileActions: (input) => activeHandlers?.reconcileActions(input) ?? unavailable(),
  listRuns: (input) =>
    activeHandlers?.listRuns(input) ?? Effect.succeed({ runs: [], nextCursor: null }),
  getRunDetail: (input) => activeHandlers?.getRunDetail(input) ?? unavailable(),
  exportDiagnostics: (input) => activeHandlers?.exportDiagnostics(input) ?? unavailable(),
  getOptions: (scope, input) => activeHandlers?.getOptions(scope, input) ?? unavailable(),
  listContextActivities: (scope, input) =>
    activeHandlers?.listContextActivities(scope, input) ?? unavailable(),
  start: (scope, input) =>
    activeHandlers?.start(
      {
        ...scope,
        providerSessionId: `${scope.providerSessionId}:${magiStartIdempotencyKey(input)}`,
      },
      input,
    ) ?? unavailable(),
  deliberate: (scope, input) => activeHandlers?.deliberate(scope, input) ?? unavailable(),
  recordArbitration: (scope, input) =>
    activeHandlers?.recordArbitration(scope, input) ?? unavailable(),
  getTerminalProposals: (scope, input) =>
    activeHandlers?.getTerminalProposals(scope, input) ?? unavailable(),
  recoverTurnResult: (scope, input) =>
    activeHandlers?.recoverTurnResult(scope, input) ?? unavailable(),
  recoverRunContext: (scope, input) =>
    activeHandlers?.recoverRunContext(scope, input) ?? unavailable(),
  recordActions: (scope, input) => activeHandlers?.recordActions(scope, input) ?? unavailable(),
};

export const layer = Layer.succeed(MagiControlBroker, proxy);

export const installActiveHandlers = (handlers: MagiControlHandlers) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      activeHandlers = handlers;
    }),
    () =>
      Effect.sync(() => {
        if (activeHandlers === handlers) activeHandlers = undefined;
      }),
  );

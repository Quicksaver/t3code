import {
  MagiControlUnavailableError,
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
  MagiListContextActivitiesInput,
  MagiListContextActivitiesResult,
  MagiRecordActionsInput,
  MagiRecordActionsResult,
  MagiRecordArbitrationInput,
  MagiRecordArbitrationResult,
  MagiStartInput,
  MagiStartResult,
  MagiValidationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as MagiControlBroker from "../../MagiControlBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MAGI_ARBITRATOR_PRE_TURN_PROTOCOL } from "../../../magi/MagiPrompts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MagiControlBroker.MagiControlBroker,
];
const failure = Schema.Union([MagiValidationError, MagiControlUnavailableError]);

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const MagiGetOptionsTool = readonlyTool(
  Tool.make("magi_get_options", {
    description:
      "List the provider instances, models, personalities, and validation bounds currently available to Magi. Use this to validate available Magi participant roster options. This tool does not start a run.",
    parameters: MagiGetOptionsInput,
    success: MagiGetOptionsResult,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get Magi options"),
);

export const MagiListContextActivitiesTool = readonlyTool(
  Tool.make("magi_list_context_activities", {
    description:
      "List completed tool activities from this conversation's current turn that can be supplied to Magi. Returns T3 activity ids and metadata only, never provider-native tool-call ids or result bodies. Use selected activity ids in magi_start or magi_deliberate.",
    parameters: MagiListContextActivitiesInput,
    success: MagiListContextActivitiesResult,
    failure,
    dependencies,
  }).annotate(Tool.Title, "List Magi context activities"),
);

export const MagiStartTool = Tool.make("magi_start", {
  description: `Start a Magi run after the user explicitly requests one in this conversation, including through a named skill or instruction file. Snapshot the resolved roster, start its first read-only deliberation, and return participant evidence to the current turn. Before any user-facing response, arbitrate that evidence with magi_record_arbitration and follow its authoritative transition. Tool availability alone is not a request to start Magi.

${MAGI_ARBITRATOR_PRE_TURN_PROTOCOL}`,
  parameters: MagiStartInput,
  success: MagiStartResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Start Magi")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MagiDeliberateTool = Tool.make("magi_deliberate", {
  description: `Run the next full-panel turn for this conversation's active Magi run. The server carries forward the arbitrated candidate, disagreements, proposal state, and recorded actions; supply only newly completed current-turn activities used as evidence. Before any user-facing response, arbitrate the returned evidence with magi_record_arbitration and follow its authoritative transition.

${MAGI_ARBITRATOR_PRE_TURN_PROTOCOL}`,
  parameters: MagiDeliberateInput,
  success: MagiDeliberationResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Continue Magi deliberation")
  .annotate(Tool.Destructive, false);

export const MagiRecordArbitrationTool = Tool.make("magi_record_arbitration", {
  description:
    "Required after every magi_start or magi_deliberate result that contains participant evidence. Record the main model's arbitration of the active Magi turn before any user-facing response. Supply terminalProposalDigestUpdates only for newly terminal proposals or intentional revisions; the server merges them with the persisted arbitrator-authored digest and rejects incomplete or aggregate-oversized results without truncating them. Participants choose outcomes; the main model classifies their evidence. The server validates those assessments, computes weighted support, resolves proposal and action state, and returns the authoritative next transition.",
  parameters: MagiRecordArbitrationInput,
  success: MagiRecordArbitrationResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Record Magi arbitration")
  .annotate(Tool.Destructive, false);

export const MagiGetTerminalProposalsTool = readonlyTool(
  Tool.make("magi_get_terminal_proposals", {
    description:
      "Read terminal proposal records on demand during or after this conversation's Magi run. Use scope missing-digest to bootstrap or recover arbitrator-authored summaries without returning history in every Magi result. Page with nextOffset; the server limits aggregate page size without truncating any proposal. Set includePersistedDigest only when the accepted digest itself is needed for recovery, revision, or a complete final report.",
    parameters: MagiGetTerminalProposalsInput,
    success: MagiGetTerminalProposalsResult,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Read Magi terminal proposals"),
);

export const MagiRecoverTurnResultTool = readonlyTool(
  Tool.make("magi_recover_turn_result", {
    description:
      "Recovery only: read one participant from any completed turn during or after this Magi run when the original magi_start or magi_deliberate result was explicitly truncated, incomplete, or lost after context compaction or session recovery. Page by participantIndex. Use best-available normally; request raw only when the structured response is insufficient. Never use this during an intact normal flow or for convenience.",
    parameters: MagiRecoverTurnResultInput,
    success: MagiRecoverTurnResult,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Recover Magi turn result"),
);

export const MagiRecoverRunContextTool = readonlyTool(
  Tool.make("magi_recover_run_context", {
    description:
      "Recovery only: restore the active run's authoritative continuation context when a Magi result or the owning conversation context was explicitly truncated, incomplete, or lost after compaction or session recovery. Never use this during an intact normal flow or for convenience; normal deliberation carries server-owned state forward automatically.",
    parameters: MagiRecoverRunContextInput,
    success: MagiRecoverRunContextResult,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Recover Magi run context"),
);

export const MagiRecordActionsTool = Tool.make("magi_record_actions", {
  description:
    "Record what happened to the exact action batch issued by the active Magi run. Classify each action as completed, not completed, or unknown before the required reassessment. This tool records outcomes and never executes or replays actions.",
  parameters: MagiRecordActionsInput,
  success: MagiRecordActionsResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Record Magi action outcomes")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MagiToolkit = Toolkit.make(
  MagiGetOptionsTool,
  MagiListContextActivitiesTool,
  MagiStartTool,
  MagiDeliberateTool,
  MagiGetTerminalProposalsTool,
  MagiRecoverTurnResultTool,
  MagiRecoverRunContextTool,
  MagiRecordArbitrationTool,
  MagiRecordActionsTool,
);

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Effect from "effect/Effect";

import { MagiService, type MagiServiceShape } from "../../../magi/MagiService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { requireMagiCaller } from "./caller.ts";
import { MagiToolkit } from "./tools.ts";

/** Every Magi tool acts for the calling conversation, identified by its MCP credential. */
const withCaller = <A, E>(
  tool: string,
  effect: (
    magi: MagiServiceShape,
    caller: McpInvocationContext.McpThreadCaller,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const caller = yield* requireMagiCaller(tool);
    const magi = yield* MagiService;
    return yield* effect(magi, caller);
  }).pipe(Effect.withSpan("magi.tool-call", { attributes: { "magi.tool": tool } }));

export const MagiToolkitHandlersLive = McpToolAccess.toLayer(MagiToolkit, {
  magi_control_run: McpToolAccess.actsAsCaller((input) =>
    withCaller("magi_control_run", (magi, scope) => magi.controlRun(scope, input)),
  ),
  magi_get_options: McpToolAccess.reads(() =>
    withCaller("magi_get_options", (magi) => magi.getOptions),
  ),
  magi_list_context_activities: McpToolAccess.reads(() =>
    withCaller("magi_list_context_activities", (magi, scope) => magi.listContextActivities(scope)),
  ),
  magi_start: McpToolAccess.actsAsCaller((input) =>
    withCaller("magi_start", (magi, scope) => magi.startFromTool(scope, input)),
  ),
  magi_deliberate: McpToolAccess.actsAsCaller((input) =>
    withCaller("magi_deliberate", (magi, scope) => magi.deliberate(scope, input)),
  ),
  magi_record_arbitration: McpToolAccess.actsAsCaller((input) =>
    withCaller("magi_record_arbitration", (magi, scope) => magi.recordArbitration(scope, input)),
  ),
  magi_get_terminal_proposals: McpToolAccess.reads((input) =>
    withCaller("magi_get_terminal_proposals", (magi, scope) =>
      magi.getTerminalProposals(scope, input),
    ),
  ),
  magi_recover_turn_result: McpToolAccess.reads((input) =>
    withCaller("magi_recover_turn_result", (magi, scope) => magi.recoverTurnResult(scope, input)),
  ),
  magi_recover_run_context: McpToolAccess.reads((input) =>
    withCaller("magi_recover_run_context", (magi, scope) => magi.recoverRunContext(scope, input)),
  ),
  magi_record_actions: McpToolAccess.actsAsCaller((input) =>
    withCaller("magi_record_actions", (magi, scope) => magi.recordActions(scope, input)),
  ),
});

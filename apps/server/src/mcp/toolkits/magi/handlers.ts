import * as Effect from "effect/Effect";

import * as MagiControlBroker from "../../MagiControlBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MagiToolkit } from "./tools.ts";

const withControl = <A, E>(
  tool: string,
  effect: (
    broker: MagiControlBroker.MagiControlHandlers,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("magi-control");
    const broker = yield* MagiControlBroker.MagiControlBroker;
    return yield* effect(broker, scope);
  }).pipe(Effect.withSpan("magi.root-tool-call", { attributes: { "magi.tool": tool } }));

export const MagiToolkitHandlersLive = MagiToolkit.toLayer({
  magi_get_options: (input) =>
    withControl("magi_get_options", (broker, scope) => broker.getOptions(scope, input)),
  magi_list_context_activities: (input) =>
    withControl("magi_list_context_activities", (broker, scope) =>
      broker.listContextActivities(scope, input),
    ),
  magi_start: (input) => withControl("magi_start", (broker, scope) => broker.start(scope, input)),
  magi_deliberate: (input) =>
    withControl("magi_deliberate", (broker, scope) => broker.deliberate(scope, input)),
  magi_record_arbitration: (input) =>
    withControl("magi_record_arbitration", (broker, scope) =>
      broker.recordArbitration(scope, input),
    ),
  magi_get_terminal_proposals: (input) =>
    withControl("magi_get_terminal_proposals", (broker, scope) =>
      broker.getTerminalProposals(scope, input),
    ),
  magi_recover_turn_result: (input) =>
    withControl("magi_recover_turn_result", (broker, scope) =>
      broker.recoverTurnResult(scope, input),
    ),
  magi_recover_run_context: (input) =>
    withControl("magi_recover_run_context", (broker, scope) =>
      broker.recoverRunContext(scope, input),
    ),
  magi_record_actions: (input) =>
    withControl("magi_record_actions", (broker, scope) => broker.recordActions(scope, input)),
});

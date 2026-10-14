import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Effect from "effect/Effect";

import { MagiService } from "../../../magi/MagiService.ts";
import { requireMagiCaller } from "../magi/caller.ts";
import { ContextArtifactToolkit } from "./tools.ts";

export const ContextArtifactToolkitHandlersLive = McpToolAccess.toLayer(ContextArtifactToolkit, {
  context_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* requireMagiCaller("context_read");
      const magi = yield* MagiService;
      return yield* magi.readContextArtifacts(caller, input);
    }).pipe(Effect.withSpan("magi.context-read")),
  ),
});

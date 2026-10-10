import { MagiValidationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Resolves the thread credential used by Magi tools and context artifacts. */
export const requireMagiCaller = Effect.fn("magi.requireCaller")(function* (tool: string) {
  const scope = yield* McpInvocationContext.requireMcpCapability("orchestration").pipe(
    Effect.mapError(
      () =>
        new MagiValidationError({
          reason: "invalid-protocol-state",
          message: "This MCP credential cannot use T3 orchestration tools.",
          field: null,
        }),
    ),
  );
  const callerScope = yield* Effect.mapError(
    McpInvocationContext.requireThreadScope(scope, tool),
    (error) =>
      new MagiValidationError({
        reason: "invalid-protocol-state",
        message: error.message,
        field: null,
      }),
  );
  return callerScope.thread;
});

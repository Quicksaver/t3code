import {
  type ContextReadInput,
  type ContextReadResult,
  MagiValidationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface ContextArtifactHandlers {
  readonly read: (
    scope: McpInvocationScope,
    input: ContextReadInput,
  ) => Effect.Effect<ContextReadResult, MagiValidationError>;
}

export class ContextArtifactBroker extends Context.Service<
  ContextArtifactBroker,
  ContextArtifactHandlers
>()("t3/mcp/ContextArtifactBroker") {}

let activeHandlers: ContextArtifactHandlers | undefined;

const unavailable = () =>
  Effect.fail(
    new MagiValidationError({
      reason: "invalid-protocol-state",
      message: "Context artifacts are not available while the server is starting or stopping.",
      field: null,
    }),
  );

export const proxy: ContextArtifactHandlers = {
  read: (scope, input) => activeHandlers?.read(scope, input) ?? unavailable(),
};

export const layer = Layer.succeed(ContextArtifactBroker, proxy);

export const installActiveHandlers = (handlers: ContextArtifactHandlers) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      activeHandlers = handlers;
    }),
    () =>
      Effect.sync(() => {
        if (activeHandlers === handlers) activeHandlers = undefined;
      }),
  );

import * as Effect from "effect/Effect";

import * as ContextArtifactBroker from "../../ContextArtifactBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ContextArtifactToolkit } from "./tools.ts";

export const ContextArtifactToolkitHandlersLive = ContextArtifactToolkit.toLayer({
  context_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("magi-context");
      const broker = yield* ContextArtifactBroker.ContextArtifactBroker;
      return yield* broker.read(scope, input);
    }).pipe(Effect.withSpan("context-artifact.read")),
});

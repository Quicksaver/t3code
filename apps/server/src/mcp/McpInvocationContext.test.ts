import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MagiContextUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});
it.effect("keeps participant context reads separate from root Magi control", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("participant-thread"),
    providerSessionId: "provider-session-2",
    providerInstanceId: ProviderInstanceId.make("claude"),
    capabilities: new Set(["magi-context"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    expect(
      yield* McpInvocationContext.requireMcpCapability("magi-context").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      ),
    ).toBe(invocation);
    const error = yield* McpInvocationContext.requireMcpCapability("magi-control").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).not.toBeInstanceOf(MagiContextUnavailableError);
    expect(error.message).toBe("MCP credential does not grant the magi-control capability.");
  });
});

import {
  type EnvironmentId,
  MagiControlUnavailableError,
  MagiContextUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "magi-control" | "magi-context";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "magi-control",
): Effect.Effect<McpInvocationScope, MagiControlUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "magi-context",
): Effect.Effect<McpInvocationScope, MagiContextUnavailableError, McpInvocationContext>;
export function requireMcpCapability(capability: McpCapability) {
  return Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      const context = {
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      };
      if (capability === "preview") {
        return yield* new PreviewAutomationUnavailableError({ ...context, capability });
      }
      return yield* capability === "magi-control"
        ? new MagiControlUnavailableError({ ...context, capability })
        : new MagiContextUnavailableError({ ...context, capability });
    }
    return invocation;
  }).pipe(Effect.withSpan("mcp.requireCapability"));
}

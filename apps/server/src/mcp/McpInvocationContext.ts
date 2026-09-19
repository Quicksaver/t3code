import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  MagiControlUnavailableError,
  MagiContextUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability =
  | "preview"
  | "device"
  | "pull-requests"
  | "magi-control"
  | "magi-context";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  /** Native caller identity from request metadata, still bounded by the bearer owner. */
  readonly nativeThreadId?: unknown;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : C extends "magi-control"
    ? MagiControlUnavailableError
    : C extends "magi-context"
      ? MagiContextUnavailableError
      : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
):
  | PreviewAutomationUnavailableError
  | MagiControlUnavailableError
  | MagiContextUnavailableError
  | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : capability === "magi-control"
      ? new MagiControlUnavailableError({ capability, ...fields })
      : capability === "magi-context"
        ? new MagiContextUnavailableError({ capability, ...fields })
        : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability)
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

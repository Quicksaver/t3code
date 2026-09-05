import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ContextArtifactBroker from "./ContextArtifactBroker.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { MagiToolkitHandlersLive } from "./toolkits/magi/handlers.ts";
import { MagiToolkit } from "./toolkits/magi/tools.ts";
import { ContextArtifactToolkitHandlersLive } from "./toolkits/context/handlers.ts";
import { ContextArtifactToolkit } from "./toolkits/context/tools.ts";
import * as MagiControlBroker from "./MagiControlBroker.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: null | {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot:
                  screenshot === null
                    ? null
                    : {
                        mimeType: screenshot.mimeType,
                        width: screenshot.width,
                        height: screenshot.height,
                      },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    ...(screenshot === null
                      ? []
                      : [
                          {
                            type: "image" as const,
                            data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                            mimeType: screenshot.mimeType,
                          },
                        ]),
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

const mcpToolErrorResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

export const getMcpToolInputSchema = (tool: Tool.Any) => {
  const inputSchema = Tool.getJsonSchema(tool);
  if (
    "anyOf" in inputSchema &&
    Array.isArray(inputSchema.anyOf) &&
    inputSchema.anyOf.length === 2 &&
    inputSchema.anyOf.every(
      (branch) => typeof branch === "object" && branch !== null && Object.keys(branch).length === 1,
    ) &&
    inputSchema.anyOf.some(
      (branch) => typeof branch === "object" && branch !== null && branch.type === "object",
    ) &&
    inputSchema.anyOf.some(
      (branch) => typeof branch === "object" && branch !== null && branch.type === "array",
    )
  ) {
    return { type: "object" as const, properties: {}, additionalProperties: false };
  }
  return inputSchema;
};

const registerMagiToolkit = Effect.fn("McpHttpServer.registerMagiToolkit")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* MagiControlBroker.MagiControlBroker;
  const built = yield* MagiToolkit;
  for (const tool of Object.values(built.tools)) {
    const outputSchema = Tool.getJsonSchemaFromSchema(tool.successSchema);
    const isDeclaredFailure = Schema.is(tool.failureSchema);
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: getMcpToolInputSchema(tool),
        ...(outputSchema.type === "object" ? { outputSchema } : {}),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return built.handle(tool.name, payload).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(MagiControlBroker.MagiControlBroker, broker),
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.map(
              ({ encodedResult }) =>
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: typeof encodedResult === "object" ? encodedResult : undefined,
                  content: [{ type: "text", text: JSON.stringify(encodedResult) }],
                }),
            ),
            Effect.tapCause(Effect.logError),
            Effect.catch((error) => {
              if (AiError.isAiError(error)) {
                const reason = error.reason;
                return reason._tag === "ToolParameterValidationError"
                  ? Effect.fail(new McpSchema.InvalidParams({ message: reason.message }))
                  : Effect.succeed(
                      mcpToolErrorResult("Tool execution failed due to an internal server error."),
                    );
              }
              if (isDeclaredFailure(error)) {
                return Effect.succeed(
                  mcpToolErrorResult(
                    error instanceof Error
                      ? error.message
                      : "Tool execution failed due to an internal server error.",
                  ),
                );
              }
              return Effect.succeed(
                mcpToolErrorResult("Tool execution failed due to an internal server error."),
              );
            }),
            Effect.catchDefect(() =>
              Effect.succeed(
                mcpToolErrorResult("Tool execution failed due to an internal server error."),
              ),
            ),
          );
        }),
    });
  }
});

export const MagiToolkitRegistrationLive = Layer.effectDiscard(registerMagiToolkit()).pipe(
  Layer.provide(MagiToolkitHandlersLive),
);

const registerContextArtifactToolkit = Effect.fn("McpHttpServer.registerContextArtifactToolkit")(
  function* () {
    const server = yield* McpServer.McpServer;
    const broker = yield* ContextArtifactBroker.ContextArtifactBroker;
    const built = yield* ContextArtifactToolkit;
    for (const tool of Object.values(built.tools)) {
      const outputSchema = Tool.getJsonSchemaFromSchema(tool.successSchema);
      const isDeclaredFailure = Schema.is(tool.failureSchema);
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: getMcpToolInputSchema(tool),
          ...(outputSchema.type === "object" ? { outputSchema } : {}),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            return built.handle(tool.name, payload).pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(ContextArtifactBroker.ContextArtifactBroker, broker),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.map(
                ({ encodedResult }) =>
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent:
                      typeof encodedResult === "object" ? encodedResult : undefined,
                    content: [{ type: "text", text: JSON.stringify(encodedResult) }],
                  }),
              ),
              Effect.tapCause(Effect.logError),
              Effect.catch((error) => {
                if (AiError.isAiError(error)) {
                  const reason = error.reason;
                  return reason._tag === "ToolParameterValidationError"
                    ? Effect.fail(new McpSchema.InvalidParams({ message: reason.message }))
                    : Effect.succeed(
                        mcpToolErrorResult(
                          "Tool execution failed due to an internal server error.",
                        ),
                      );
                }
                if (isDeclaredFailure(error)) {
                  return Effect.succeed(
                    mcpToolErrorResult(
                      error instanceof Error
                        ? error.message
                        : "Tool execution failed due to an internal server error.",
                    ),
                  );
                }
                return Effect.succeed(
                  mcpToolErrorResult("Tool execution failed due to an internal server error."),
                );
              }),
              Effect.catchDefect(() =>
                Effect.succeed(
                  mcpToolErrorResult("Tool execution failed due to an internal server error."),
                ),
              ),
            );
          }),
      });
    }
  },
);

export const ContextArtifactToolkitRegistrationLive = Layer.effectDiscard(
  registerContextArtifactToolkit(),
).pipe(Layer.provide(ContextArtifactToolkitHandlersLive));

const makeMcpTransportLive = (path: "/mcp" | "/mcp/magi" | "/mcp/context" | "/mcp/all") =>
  McpServer.layerHttp({
    name: "T3 Code",
    version: packageJson.version,
    path,
    protocols: [McpProtocol.v2025_06_18],
  }).pipe(Layer.provide(McpAuthMiddlewareLive));

export const isolateMcpServerLayer = <ROut, E, RIn>(server: Layer.Layer<ROut, E, RIn>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      yield* Layer.buildWithScope(Layer.fresh(server), scope);
    }),
  );

const CombinedToolkitServerLive = isolateMcpServerLayer(
  Layer.mergeAll(PreviewToolkitRegistrationLive, MagiToolkitRegistrationLive).pipe(
    Layer.provideMerge(makeMcpTransportLive("/mcp/all")),
  ),
);

const PreviewOnlyServerLive = isolateMcpServerLayer(
  PreviewToolkitRegistrationLive.pipe(Layer.provideMerge(makeMcpTransportLive("/mcp"))),
);

const MagiOnlyServerLive = isolateMcpServerLayer(
  MagiToolkitRegistrationLive.pipe(Layer.provideMerge(makeMcpTransportLive("/mcp/magi"))),
);

const ContextOnlyServerLive = isolateMcpServerLayer(
  ContextArtifactToolkitRegistrationLive.pipe(
    Layer.provideMerge(makeMcpTransportLive("/mcp/context")),
  ),
);

export const layer = Layer.mergeAll(
  PreviewOnlyServerLive,
  MagiOnlyServerLive,
  ContextOnlyServerLive,
  CombinedToolkitServerLive,
).pipe(Layer.provide(MagiControlBroker.layer), Layer.provide(ContextArtifactBroker.layer));

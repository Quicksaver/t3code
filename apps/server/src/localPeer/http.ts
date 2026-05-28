import {
  ClientOrchestrationCommand,
  DispatchableClientOrchestrationCommand,
  type OrchestrationCommand,
  type LocalBackendPeerDescriptor,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  OrchestrationReplayEventsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth, AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const MAX_PEER_EVENTS = 500;
const LocalPeerDispatchCommand = Schema.Union([
  ClientOrchestrationCommand,
  DispatchableClientOrchestrationCommand,
]);
type LocalPeerDispatchCommand = typeof LocalPeerDispatchCommand.Type;

const respondToPeerError = (
  error:
    | AuthError
    | OrchestrationDispatchCommandError
    | OrchestrationGetSnapshotError
    | OrchestrationReplayEventsError,
) =>
  Effect.gen(function* () {
    if (error._tag === "AuthError") {
      return HttpServerResponse.jsonUnsafe(
        { error: error.message },
        { status: error.status ?? 500 },
      );
    }
    if (
      error._tag === "OrchestrationGetSnapshotError" ||
      error._tag === "OrchestrationReplayEventsError"
    ) {
      yield* Effect.logError("local peer route failed", {
        message: error.message,
        cause: error.cause,
      });
      return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });
  });

const authenticateLocalOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isLoopbackRequest(request)) {
    return yield* new AuthError({
      message: "Local peer API is available only over loopback.",
      status: 403,
    });
  }

  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can use the local peer API.",
      status: 403,
    });
  }
  const config = yield* ServerConfig;
  if (config.hostIntegration !== "vscode") {
    return yield* new AuthError({
      message: "Local peer API is available only from VS Code-hosted backends.",
      status: 403,
    });
  }
  return session;
});

export const localPeerDescriptorRouteLayer = HttpRouter.add(
  "GET",
  "/api/local-peer/descriptor",
  Effect.gen(function* () {
    yield* authenticateLocalOwnerSession;
    const config = yield* ServerConfig;
    const serverEnvironment = yield* ServerEnvironment;
    const descriptor: LocalBackendPeerDescriptor = {
      version: 1,
      hostKind: "vscode",
      environment: yield* serverEnvironment.getDescriptor,
      workspaceFolders: [...config.autoBootstrapWorkspaceFolders],
      ...(config.activeBootstrapWorkspaceFolderKey
        ? { activeWorkspaceFolderKey: config.activeBootstrapWorkspaceFolderKey }
        : {}),
      capabilities: {
        descriptor: true,
        health: true,
        shellSnapshot: true,
        orchestrationEvents: true,
        commandRouting: true,
      },
    };
    return HttpServerResponse.jsonUnsafe(descriptor, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToPeerError)),
);

export const localPeerHealthRouteLayer = HttpRouter.add(
  "GET",
  "/api/local-peer/health",
  Effect.gen(function* () {
    yield* authenticateLocalOwnerSession;
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToPeerError)),
);

export const localPeerShellSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/local-peer/orchestration/shell-snapshot",
  Effect.gen(function* () {
    yield* authenticateLocalOwnerSession;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load local peer shell snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToPeerError),
    Effect.catchTag("OrchestrationGetSnapshotError", respondToPeerError),
  ),
);

export const localPeerEventsRouteLayer = HttpRouter.add(
  "GET",
  "/api/local-peer/orchestration/events",
  Effect.gen(function* () {
    yield* authenticateLocalOwnerSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const fromSequenceExclusive = Option.isSome(requestUrl)
      ? Number.parseInt(requestUrl.value.searchParams.get("fromSequenceExclusive") ?? "0", 10)
      : 0;
    const cursor = Number.isFinite(fromSequenceExclusive)
      ? Math.max(0, Math.floor(fromSequenceExclusive))
      : 0;

    const orchestrationEngine = yield* OrchestrationEngineService;
    const events = yield* Stream.runCollect(
      orchestrationEngine.readEvents(cursor).pipe(Stream.take(MAX_PEER_EVENTS)),
    ).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.mapError(
        (cause) =>
          new OrchestrationReplayEventsError({
            message: "Failed to replay local peer orchestration events.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe({ events }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToPeerError),
    Effect.catchTag("OrchestrationReplayEventsError", respondToPeerError),
  ),
);

export const localPeerDispatchRouteLayer = HttpRouter.add(
  "POST",
  "/api/local-peer/orchestration/dispatch",
  Effect.gen(function* () {
    yield* authenticateLocalOwnerSession;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const command = yield* HttpServerRequest.schemaBodyJson(LocalPeerDispatchCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Invalid local peer orchestration command payload.",
            cause,
          }),
      ),
    );
    const normalizedCommand = yield* normalizeLocalPeerDispatchCommand(command);
    const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to dispatch local peer orchestration command.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToPeerError),
    Effect.catchTag("OrchestrationDispatchCommandError", respondToPeerError),
  ),
);

function normalizeLocalPeerDispatchCommand(command: LocalPeerDispatchCommand) {
  if (
    command.type === "thread.turn.start" &&
    command.message.attachments.some((attachment) => "id" in attachment)
  ) {
    return Effect.succeed(command as OrchestrationCommand);
  }
  return normalizeDispatchCommand(command as ClientOrchestrationCommand);
}

function isLoopbackRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  const source = request.source;
  if (!source || typeof source !== "object") {
    return false;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };
  return isLoopbackRemoteAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

export function isLoopbackRemoteAddress(value: string | null | undefined): boolean {
  const address = normalizeIpAddress(value);
  return address === "127.0.0.1" || address === "::1" || address?.startsWith("127.") === true;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

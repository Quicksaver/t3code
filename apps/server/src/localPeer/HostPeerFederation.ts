import * as net from "node:net";
import {
  DispatchResult as DispatchResultSchema,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  type DispatchResult,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type ThreadId,
} from "@t3tools/contracts";
import {
  cleanupLocalBackendAdvertisements,
  readLocalBackendAdvertisements,
} from "@t3tools/shared/localBackendAdvertisement";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ServerConfigShape } from "../config.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const PEER_POLL_INTERVAL_MS = 500;
const PEER_REQUEST_TIMEOUT_MS = 1_500;

class LocalPeerRequestError extends Data.TaggedError("LocalPeerRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PeerEventsResponse = Schema.Struct({
  events: Schema.Array(OrchestrationEvent),
});

export interface HostPeerFederationShape {
  readonly dispatchCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<Option.Option<DispatchResult>, OrchestrationDispatchCommandError>;
  readonly streamEvents: (input: {
    readonly fromSequenceExclusive: number;
  }) => Stream.Stream<OrchestrationEvent>;
}

const decodePeerEventsResponse = Schema.decodeUnknownSync(PeerEventsResponse);
const decodeDispatchResult = Schema.decodeUnknownSync(DispatchResultSchema);

export function makeHostPeerFederation(
  config: ServerConfigShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
): HostPeerFederationShape {
  const isFederationEnabled = config.mode === "desktop" && config.hostIntegration === undefined;

  const discoverPeers = (workspaceRoot?: string) =>
    Effect.try({
      try: () => {
        if (!isFederationEnabled) {
          return [];
        }
        cleanupLocalBackendAdvertisements({ t3Home: config.baseDir });
        return readLocalBackendAdvertisements({
          t3Home: config.baseDir,
          ...(workspaceRoot ? { workspaceRoot } : {}),
        }).advertisements;
      },
      catch: (cause) =>
        new LocalPeerRequestError({
          message: "Failed to discover local backend peers.",
          cause,
        }),
    }).pipe(Effect.catch(() => Effect.succeed([])));

  const resolveThreadProjectWorkspaceRoot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(thread)) {
        return null;
      }
      const project = yield* projectionSnapshotQuery.getProjectShellById(thread.value.projectId);
      if (Option.isNone(project)) {
        return null;
      }
      return {
        projectId: project.value.id,
        workspaceRoot: project.value.workspaceRoot,
        sessionStatus: thread.value.session?.status ?? null,
      };
    }).pipe(Effect.catch(() => Effect.succeed(null)));

  const dispatchCommand: HostPeerFederationShape["dispatchCommand"] = (command) =>
    Effect.gen(function* () {
      if (!isFederationEnabled) {
        return Option.none();
      }
      const routing = resolveCommandRouting(command);
      if (!routing) {
        return Option.none();
      }
      const threadContext = yield* resolveThreadProjectWorkspaceRoot(routing.threadId);
      if (!threadContext || !shouldRouteCommandToPeer(command, threadContext.sessionStatus)) {
        return Option.none();
      }

      const peers = yield* discoverPeers(threadContext.workspaceRoot);
      if (peers.length === 0) {
        return Option.none();
      }
      const results = yield* Effect.forEach(
        peers,
        (peer) =>
          requestPeerJson({
            peer,
            pathname: "/api/local-peer/orchestration/dispatch",
            method: "POST",
            body: command,
            decode: decodeDispatchResult,
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logDebug("local peer command route failed", {
                backendId: peer.backendId,
                projectId: threadContext.projectId,
                threadId: routing.threadId,
                commandType: command.type,
                cause,
              }).pipe(Effect.as(Option.none<DispatchResult>())),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const result = results.find(Option.isSome);
      if (result) {
        return result;
      }

      return yield* new OrchestrationDispatchCommandError({
        message: `No reachable local owner backend is available for thread ${routing.threadId}.`,
      });
    });

  const streamEvents: HostPeerFederationShape["streamEvents"] = (input) => {
    if (!isFederationEnabled) {
      return Stream.empty;
    }

    let cursor = Math.max(0, Math.floor(input.fromSequenceExclusive));

    const poll = Effect.gen(function* () {
      const peers = yield* discoverPeers();
      const peerResponses = yield* Effect.forEach(
        peers,
        (peer) =>
          requestPeerJson({
            peer,
            pathname: "/api/local-peer/orchestration/events",
            searchParams: { fromSequenceExclusive: String(cursor) },
            decode: decodePeerEventsResponse,
          }).pipe(
            Effect.catch((cause) =>
              Effect.logDebug("local peer event poll failed", {
                backendId: peer.backendId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const events: OrchestrationEvent[] = [];
      const seenEventIds = new Set<string>();
      for (const response of peerResponses) {
        if (!response) {
          continue;
        }
        for (const event of response.events) {
          if (seenEventIds.has(event.eventId)) {
            continue;
          }
          seenEventIds.add(event.eventId);
          events.push(event);
        }
      }
      if (events.length > 0) {
        cursor = Math.max(cursor, ...events.map((event) => event.sequence));
      }
      return events.toSorted((left, right) => left.sequence - right.sequence);
    });

    return Stream.fromEffect(poll).pipe(
      Stream.repeat(Schedule.spaced(Duration.millis(PEER_POLL_INTERVAL_MS))),
      Stream.flatMap((events) => Stream.fromIterable(events)),
    );
  };

  return {
    dispatchCommand,
    streamEvents,
  };
}

function resolveCommandRouting(
  command: OrchestrationCommand,
): { readonly threadId: ThreadId } | null {
  if (!("threadId" in command)) {
    return null;
  }
  switch (command.type) {
    case "thread.turn.start":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.session.stop":
      return { threadId: command.threadId };
    default:
      return null;
  }
}

function shouldRouteCommandToPeer(
  command: OrchestrationCommand,
  sessionStatus: OrchestrationSessionStatus | null,
): boolean {
  if (sessionStatus === null || sessionStatus === "stopped") {
    return false;
  }
  if (command.type === "thread.turn.start") {
    return sessionStatus === "starting" || sessionStatus === "running" || sessionStatus === "ready";
  }
  return true;
}

function requestPeerJson<A>(input: {
  readonly peer: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  };
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly decode: (value: unknown) => A;
}): Effect.Effect<A, LocalPeerRequestError> {
  return Effect.tryPromise({
    try: async () => {
      if (!isLoopbackPeerBaseUrl(input.peer.httpBaseUrl)) {
        throw new Error("Local peer base URL must be loopback HTTP without credentials.");
      }
      const url = new URL(input.pathname, input.peer.httpBaseUrl);
      for (const [key, value] of Object.entries(input.searchParams ?? {})) {
        url.searchParams.set(key, value);
      }
      const response = await fetch(url, {
        method: input.method ?? "GET",
        headers: {
          authorization: `Bearer ${input.peer.bearerToken}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Local peer request failed (${response.status}).`);
      }
      const payload = await response.json();
      try {
        return input.decode(payload);
      } catch (cause) {
        throw new Error("Unexpected local peer response shape.", { cause });
      }
    },
    catch: (cause) =>
      new LocalPeerRequestError({
        message: cause instanceof Error ? cause.message : "Local peer request failed.",
        cause,
      }),
  });
}

function isLoopbackPeerBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  return net.isIP(hostname) === 4 && hostname.startsWith("127.");
}

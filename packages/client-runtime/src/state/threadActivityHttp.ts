import type { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const DEFAULT_THREAD_ACTIVITY_TIMEOUT_MS = 6_000;

export interface ThreadActivityDetailInput {
  readonly threadId: ThreadId;
  readonly activityId: EventId;
}

export interface ThreadActivityDetailsInput {
  readonly threadId: ThreadId;
  readonly activityIds: ReadonlyArray<EventId>;
}

export class ThreadActivityConnectionUnavailableError extends Schema.TaggedErrorClass<ThreadActivityConnectionUnavailableError>()(
  "ThreadActivityConnectionUnavailableError",
  {},
) {
  override get message(): string {
    return "The environment connection is not ready.";
  }
}

export const fetchEnvironmentThreadActivity = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadActivity",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly activityId: EventId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const path = `/api/orchestration/threads/${input.threadId}/activities/${input.activityId}`;
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, path);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_ACTIVITY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadActivity({
        params: { threadId: input.threadId, activityId: input.activityId },
        headers,
      }),
    ),
  );
});

const fetchCurrentEnvironmentThreadActivity = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentThreadActivity",
)(function* (input: ThreadActivityDetailInput) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new ThreadActivityConnectionUnavailableError();
  }
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  return yield* fetchEnvironmentThreadActivity({
    prepared: prepared.value,
    threadId: input.threadId,
    activityId: input.activityId,
    signer,
  });
});

export const fetchEnvironmentThreadActivities = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadActivities",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly activityIds: ReadonlyArray<EventId>;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const [failures, activities] = yield* Effect.partition(
    input.activityIds,
    (activityId) =>
      fetchEnvironmentThreadActivity({
        prepared: input.prepared,
        threadId: input.threadId,
        activityId,
        signer: input.signer,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      }).pipe(Effect.mapError((error) => ({ activityId, error }))),
    { concurrency: 4 },
  );
  if (activities.length === 0 && failures.length > 0) {
    return yield* failures[0]!.error;
  }
  return {
    activities,
    failedActivityIds: failures.map(({ activityId }) => activityId),
  };
});

const fetchCurrentEnvironmentThreadActivities = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentThreadActivities",
)(function* (input: ThreadActivityDetailsInput) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new ThreadActivityConnectionUnavailableError();
  }
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  return yield* fetchEnvironmentThreadActivities({
    prepared: prepared.value,
    threadId: input.threadId,
    activityIds: input.activityIds,
    signer,
  });
});

export function createThreadActivityEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    detail: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:thread-activity-detail",
      execute: fetchCurrentEnvironmentThreadActivity,
      staleTimeMs: 5 * 60_000,
      idleTtlMs: 5 * 60_000,
    }),
    details: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:thread-activity-details",
      execute: fetchCurrentEnvironmentThreadActivities,
      staleTimeMs: 5 * 60_000,
      idleTtlMs: 5 * 60_000,
    }),
  };
}

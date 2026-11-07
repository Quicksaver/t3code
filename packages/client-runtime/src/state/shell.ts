import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { request, subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvents,
  type ShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
  sameThreadPullRequests,
} from "./shellReducer.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import {
  evictCachedThread,
  cachedThreadGeneration,
  cachedThreadActiveSequence,
  isCachedThreadEvicted,
  isCachedThreadLive,
  observeActiveCachedThreads,
  restoreCachedThread,
  reviveCachedThread,
  reviveSequencedEviction,
  retainCachedThreadUnsafe,
} from "./threadCache.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
  /**
   * Changes with each authoritative snapshot (not enrichment refreshes); 0 until the first one.
   * Thread families read for an older generation may miss changes from before the latest snapshot,
   * so they are read again.
   */
  readonly generation: number;
  /** Sequences of the thread removals applied since the latest authoritative snapshot. */
  readonly removedAt: ReadonlyMap<ThreadId, number>;
  /** Omitted active threads cannot be classified as archived by their absence. */
  readonly omitsThreads?: boolean;
}

const EMPTY_REMOVALS: ReadonlyMap<ThreadId, number> = new Map();
// Shared by every shell state, so a rebuilt one never reuses a generation another already used.
let lastShellGeneration = 0;

export const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
  generation: 0,
  removedAt: EMPTY_REMOVALS,
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

function withoutDeferredPullRequests(value: DeferredShellSnapshot): OrchestrationV2ShellSnapshot {
  if (value.loadPullRequests === undefined) return value;
  const { loadPullRequests: _deferred, ...snapshot } = value;
  return snapshot;
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

/**
 * Replay does not refresh the older-settled cut, rows that left the newest window, or
 * projections the server rebuilt, so drift grows with the age of the last server snapshot.
 */
const CACHE_RESUME_MAX_AGE_MILLIS = 12 * 60 * 60 * 1000;

// How long a ready socket waits for the early HTTP answer before it resumes held rows itself.
// The supervisor's quick probe allows a live host the same time. A proxy that drops `/api`
// without an answer would otherwise hold each connect for the full HTTP timeout.
const EARLY_LOAD_GRACE = "3 seconds";

type ShellOriginIdentity = Omit<Persistence.ShellCacheOrigin, "snapshotAt">;

interface ShellSubscription {
  readonly session: RpcSession;
  /** What a snapshot from this subscription descends from; null when the server did not say. */
  readonly identity: ShellOriginIdentity | null;
}

function shellIdentity(
  environment: Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "databaseMigration">,
  flags: {
    readonly shellThreadFamilies?: boolean;
    readonly shellOlderSettled?: boolean;
    readonly shellThreadMembership?: boolean;
  },
): ShellOriginIdentity {
  const omitIdleSubagents = flags.shellThreadFamilies === true;
  return {
    serverVersion: environment.serverVersion,
    // Migrations rewrite projections without events, so a migrated server reloads.
    databaseMigration: environment.databaseMigration ?? null,
    shellThreadMembership: flags.shellThreadMembership === true,
    omitIdleSubagents,
    omitOlderSettled: flags.shellOlderSettled === true && omitIdleSubagents,
  };
}

function sameConnection(left: PreparedConnection, right: PreparedConnection): boolean {
  const keys = Object.keys({ ...left, ...right }) as Array<keyof PreparedConnection>;
  return keys.every((key) => key === "httpAuthorization" || left[key] === right[key]);
}

/** Null for a server whose descriptor does not name its shell flags; only its config does. */
function descriptorShellIdentity(
  descriptor: ExecutionEnvironmentDescriptor | undefined,
): ShellOriginIdentity | null {
  if (descriptor?.capabilities.shellThreadFamilies === undefined) return null;
  return shellIdentity(descriptor, descriptor.capabilities);
}

function sameShellIdentity(left: ShellOriginIdentity, right: ShellOriginIdentity): boolean {
  return (
    left.serverVersion === right.serverVersion &&
    left.databaseMigration === right.databaseMigration &&
    left.omitIdleSubagents === right.omitIdleSubagents &&
    left.omitOlderSettled === right.omitOlderSettled &&
    (left.shellThreadMembership === true) === (right.shellThreadMembership === true)
  );
}

function canResumeFrom(
  origin: Persistence.ShellCacheOrigin | undefined,
  identity: ShellOriginIdentity | null,
  now: number,
): boolean {
  if (origin === undefined || identity === null) return false;
  const age = now - origin.snapshotAt;
  return sameShellIdentity(origin, identity) && age >= 0 && age < CACHE_RESUME_MAX_AGE_MILLIS;
}

type HttpShellOutcome =
  | { readonly kind: "snapshot"; readonly projectIdentities: string | undefined }
  /** The server can replay from the rows the client holds. */
  | { readonly kind: "resumable" }
  | { readonly kind: "failed" };

interface EarlyShellLoad {
  readonly prepared: PreparedConnection;
  readonly identity: ShellOriginIdentity;
  readonly fiber: Fiber.Fiber<HttpShellOutcome>;
  // One subscription uses a load; a later one on the same connection decides again.
  readonly claimed: boolean;
}

interface LiveShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  // Read together with the rows, so a save never pairs them with another snapshot's origin.
  readonly origin: Persistence.ShellCacheOrigin | undefined;
}

// Shell deltas update threads in place, so a positional comparison detects an
// unchanged membership without allocating on every batch.
function sameThreadIds(
  left: OrchestrationV2ShellSnapshot["threads"],
  right: OrchestrationV2ShellSnapshot["threads"],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]!.id !== right[index]!.id) return false;
  }
  return true;
}

// Records the active threads an applied item removed. A thread that is active
// again by the end of the batch was archived and restored within it, which the
// net membership comparison cannot see. Ordinary updates skip this work.
function collectRemovedThreadIds(
  item: OrchestrationV2ShellStreamItem,
  previous: OrchestrationV2ShellSnapshot,
  next: OrchestrationV2ShellSnapshot,
  removed: Set<ThreadId>,
): void {
  if (previous.threads === next.threads) return;
  switch (item.kind) {
    case "thread.removed":
      if (next.threads.length < previous.threads.length) removed.add(item.threadId);
      return;
    case "thread.updated":
      if (item.location === "archive" && next.threads.length < previous.threads.length) {
        removed.add(item.thread.id);
      }
      return;
    case "snapshot": {
      const nextThreadIds = new Set(next.threads.map((thread) => thread.id));
      for (const thread of previous.threads) {
        if (!nextThreadIds.has(thread.id)) removed.add(thread.id);
      }
      return;
    }
    default:
      return;
  }
}

// Coalesced archive/unarchive updates can keep membership unchanged. Record the
// authoritative active sequence so a late archive acknowledgement cannot evict it.
// Ignore enrichment and stale deltas; a lower snapshot resets the sequence space.
function activeObservation(
  item: OrchestrationV2ShellStreamItem,
  previous: OrchestrationV2ShellSnapshot | undefined,
):
  | {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly sequence: number;
      readonly reset: boolean;
    }
  | undefined {
  if (item.kind === "snapshot") {
    return item.resolvedRepositoryIdentityRoots === undefined
      ? {
          threadIds: item.snapshot.threads.map((thread) => thread.id),
          sequence: item.snapshot.snapshotSequence,
          reset:
            previous !== undefined && item.snapshot.snapshotSequence < previous.snapshotSequence,
        }
      : undefined;
  }
  if (
    item.kind === "thread.updated" &&
    item.location === "active" &&
    previous !== undefined &&
    item.sequence > previous.snapshotSequence
  ) {
    return { threadIds: [item.thread.id], sequence: item.sequence, reset: false };
  }
  return undefined;
}

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<Persistence.CachedShellSnapshot>()),
      ),
    ),
  );
  const cachedOrigin = Option.isSome(cached) ? cached.value.origin : undefined;
  const cachedSnapshot = Option.map(cached, ({ origin: _origin, ...rows }) =>
    withoutDeferredPullRequests(rows),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  const activeSubscription = yield* Ref.make<ShellSubscription | null>(null);
  // The server snapshot the in-memory rows descend from, directly or through the cache.
  // Only a server snapshot renews it; `snapshot-required` drops it.
  const origin = yield* Ref.make(cachedOrigin);
  const reloadRequests = yield* Queue.unbounded<void>();
  const latestLive = yield* Ref.make<Option.Option<LiveShell>>(Option.none());
  const pendingThreadEvictions = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const omittedThreadIds = new Set<ThreadId>();
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);
  const listPersistedThreadIds = cache
    .listThreadIds(environmentId)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not list cached thread details.").pipe(
          Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
          Effect.as<ReadonlyArray<ThreadId>>([]),
        ),
      ),
    );

  const persistenceLock = yield* Semaphore.make(1);
  let lastPersisted: LiveShell | undefined;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLive);
      if (Option.isNone(latest) || latest.value === lastPersisted) return;
      const { snapshot, origin } = latest.value;
      if (snapshot.threads.some((thread) => pendingLinkRows.has(thread))) return;
      if (
        lastPersisted !== undefined &&
        origin === lastPersisted.origin &&
        snapshot.snapshotSequence >= lastPersisted.snapshot.snapshotSequence &&
        snapshot.schemaVersion === lastPersisted.snapshot.schemaVersion &&
        snapshot.projects === lastPersisted.snapshot.projects &&
        snapshot.threads === lastPersisted.snapshot.threads &&
        snapshot.archivedThreads === lastPersisted.snapshot.archivedThreads
      ) {
        // Keep the live cursor without rewriting the rows. Remember it here too so a
        // later authoritative reset to a lower sequence still reaches the cache.
        lastPersisted = latest.value;
        return;
      }
      const saved = yield* cache.saveShell(environmentId, snapshot, origin).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = latest.value;
      if (!flush) return;
    }
  }, persistenceLock.withPermit);
  const persist = () => persistLatest(false);
  const flushLiveShellSnapshot = persistLatest(true);

  // Register before scoped worker fibers so reverse finalizer order interrupts
  // those fibers first and this flush sees a stable latestLiveSnapshot.
  yield* Effect.addFinalizer(() => flushLiveShellSnapshot);

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
    Effect.andThen(flushLiveShellSnapshot.pipe(Effect.forkScoped)),
    Effect.asVoid,
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Server items and deferred link fills both read the snapshot and write it back; one at a
  // time, so neither can overwrite what the other wrote in between.
  const snapshotWriteLock = yield* Semaphore.make(1);
  let pendingHttpReconciliation = false;

  // HTTP and socket application share the snapshot lock and cache lifecycle boundary.
  const applyLocked = Effect.fnUntraced(function* (
    items: ReadonlyArray<OrchestrationV2ShellStreamItem>,
    identity: ShellOriginIdentity | null,
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const omitsThreads =
      identity?.omitIdleSubagents === true || identity?.omitOlderSettled === true;
    const session = (yield* Ref.get(activeSubscription))?.session;
    const initial = yield* SubscriptionRef.get(state);
    const fromHttp = pendingLinkIds !== undefined;
    const supportsMembership = identity?.shellThreadMembership === true && session !== undefined;
    if (fromHttp) {
      pendingHttpReconciliation =
        omitsThreads && identity?.shellThreadMembership === true && !supportsMembership;
    }
    const disconnected = initial.status === "empty" || initial.status === "cached";
    let waiting = yield* Ref.get(awaitingCompletion);
    let next =
      (initial.omitsThreads === true) === omitsThreads ? initial : { ...initial, omitsThreads };
    let receivedSnapshot = false;
    let snapshotRequired = false;
    let receivedAuthoritativeSnapshot = false;
    let completedCachedResume = false;
    const removedThreadIds = new Set<ThreadId>();
    const sequencedEvictions = new Set<ThreadId>();
    let deltas: Array<ShellStreamEvent> = [];
    const flushDeltas = () => {
      if (deltas.length > 0 && Option.isSome(next.snapshot)) {
        let sequence = next.snapshot.value.snapshotSequence;
        const activeIds = deltas.some(
          (delta) =>
            delta.kind === "thread.removed" ||
            (delta.kind === "thread.updated" && delta.location !== "active"),
        )
          ? new Set(next.snapshot.value.threads.map((thread) => thread.id))
          : undefined;
        let removedAt: Map<ThreadId, number> | undefined;
        for (const delta of deltas) {
          if (delta.sequence <= sequence) continue;
          switch (delta.kind) {
            case "thread.removed":
              activeIds?.delete(delta.threadId);
              removedThreadIds.add(delta.threadId);
              removedAt ??= new Map(next.removedAt);
              removedAt.set(delta.threadId, delta.sequence);
              break;
            case "thread.updated":
              if (delta.location === "active") {
                activeIds?.add(delta.thread.id);
                const revivals = observeActiveCachedThreads(
                  cache,
                  environmentId,
                  [delta.thread.id],
                  delta.sequence,
                  false,
                );
                for (const threadId of revivals) sequencedEvictions.add(threadId);
              } else if (activeIds?.delete(delta.thread.id)) {
                removedThreadIds.add(delta.thread.id);
              }
              break;
            case "project.updated":
            case "project.removed":
              break;
            default:
              continue;
          }
          sequence = delta.sequence;
        }
        next = {
          ...next,
          removedAt: removedAt ?? next.removedAt,
          snapshot: Option.some(applyShellStreamEvents(next.snapshot.value, deltas)),
          status:
            fromHttp && disconnected ? "cached" : waiting || fromHttp ? "synchronizing" : "live",
          error: Option.none(),
        };
      }
      deltas = [];
    };
    for (const item of items) {
      if (item.kind === "snapshot-required") {
        snapshotRequired = true;
        continue;
      }
      if (item.kind !== "snapshot" && item.kind !== "synchronized") {
        deltas.push(item);
        continue;
      }
      // Snapshots can reset the cursor; completion markers change the sync status.
      flushDeltas();
      if (item.kind === "synchronized") {
        completedCachedResume ||=
          (pendingHttpReconciliation || (waiting && next.generation === 0)) &&
          Option.isSome(next.snapshot);
        pendingHttpReconciliation = false;
        waiting = false;
        if (Option.isSome(next.snapshot)) {
          next = {
            ...next,
            status: "live",
            error: Option.none(),
            generation: next.generation === 0 ? ++lastShellGeneration : next.generation,
          };
        }
        continue;
      }
      const authoritative = item.resolvedRepositoryIdentityRoots === undefined;
      const nextSnapshot = mergeShellSnapshotProjects(
        Option.getOrNull(next.snapshot),
        item.snapshot,
        item.resolvedRepositoryIdentityRoots === undefined
          ? undefined
          : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
      );
      if (Option.isSome(next.snapshot) && next.omitsThreads !== true) {
        collectRemovedThreadIds(item, next.snapshot.value, nextSnapshot, removedThreadIds);
      }
      const observed = activeObservation(item, Option.getOrUndefined(next.snapshot));
      if (observed !== undefined) {
        const revivals = observeActiveCachedThreads(
          cache,
          environmentId,
          observed.threadIds,
          observed.sequence,
          observed.reset,
        );
        for (const threadId of revivals) sequencedEvictions.add(threadId);
      }
      receivedSnapshot = true;
      receivedAuthoritativeSnapshot ||= authoritative;
      next = {
        omitsThreads: next.omitsThreads === true,
        snapshot: Option.some(nextSnapshot),
        status:
          fromHttp && disconnected ? "cached" : waiting || fromHttp ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        removedAt: authoritative ? EMPTY_REMOVALS : next.removedAt,
      };
    }
    flushDeltas();
    yield* Ref.set(awaitingCompletion, waiting);
    let nextOrigin = yield* Ref.get(origin);
    if (snapshotRequired) {
      // The rows stay on screen but reload before the next resume; the cache keeps the old
      // origin until that reload saves, which costs at most one more refusal.
      nextOrigin = undefined;
      yield* Ref.set(origin, nextOrigin);
      yield* Queue.offer(reloadRequests, undefined);
    } else if (receivedAuthoritativeSnapshot) {
      nextOrigin =
        identity === null ? undefined : { ...identity, snapshotAt: yield* Clock.currentTimeMillis };
      yield* Ref.set(origin, nextOrigin);
    }

    if (next === initial || Option.isNone(next.snapshot)) return;
    if (pendingLinkIds !== undefined) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    yield* Ref.set(latestLive, Option.some({ snapshot: next.snapshot.value, origin: nextOrigin }));
    const nextSnapshot = next.snapshot.value;
    const previousThreads = Option.match(initial.snapshot, {
      onNone: () => undefined,
      onSome: (snapshot) => snapshot.threads,
    });
    const membershipChanged =
      previousThreads !== undefined &&
      (previousThreads.length !== nextSnapshot.threads.length ||
        ((receivedSnapshot || removedThreadIds.size > 0) &&
          !sameThreadIds(previousThreads, nextSnapshot.threads)));
    const pendingEvictions = yield* Ref.get(pendingThreadEvictions);
    // A saved shell can finish replay without a new snapshot, so reconcile its saved details then.
    const reconcileThreads = receivedAuthoritativeSnapshot || completedCachedResume;
    // Partial shells validate only known omissions, without fetching their shells
    // or bodies. Open details own disk eviction and may postdate this snapshot.
    const persistedThreadIds =
      reconcileThreads && (next.omitsThreads !== true || supportsMembership)
        ? yield* listPersistedThreadIds
        : [];
    const membershipEvictions = new Map<ThreadId, { generation: number; sequence: number }>();
    if (reconcileThreads && next.omitsThreads === true) {
      const listedIds = new Set(nextSnapshot.threads.map((thread) => thread.id));
      for (const thread of previousThreads ?? []) omittedThreadIds.add(thread.id);
      for (const id of persistedThreadIds) {
        if (!isCachedThreadLive(cache, environmentId, id)) omittedThreadIds.add(id);
      }
      for (const id of listedIds) omittedThreadIds.delete(id);
      const candidates = supportsMembership ? [...omittedThreadIds] : [];
      for (let offset = 0; offset < candidates.length; offset += 200) {
        const threadIds = candidates.slice(offset, offset + 200);
        // An unretained generation can be collected while the membership RPC is in flight.
        for (const id of threadIds) {
          yield* Effect.acquireRelease(
            Effect.sync(() => retainCachedThreadUnsafe(cache, environmentId, id)),
            (release) => Effect.sync(release),
          );
        }
        const generations = new Map(
          threadIds.map((id) => [id, cachedThreadGeneration(cache, environmentId, id)]),
        );
        const membership = yield* request(ORCHESTRATION_V2_WS_METHODS.getActiveThreadIds, {
          threadIds,
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.asSome,
          Effect.catch((error) =>
            Effect.logWarning("Could not validate active thread membership.").pipe(
              Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
              Effect.as(Option.none()),
            ),
          ),
        );
        if (Option.isNone(membership)) continue;
        const sessionChanged =
          Option.getOrNull(yield* SubscriptionRef.get(supervisor.session)) !== session;
        if (membership.value.snapshotSequence < nextSnapshot.snapshotSequence || sessionChanged) {
          yield* Effect.logDebug("Discarded active thread membership response.").pipe(
            Effect.annotateLogs({
              environmentId,
              sessionChanged,
              membershipSequence: membership.value.snapshotSequence,
              shellSequence: nextSnapshot.snapshotSequence,
            }),
          );
          continue;
        }
        const { snapshotSequence, threadIds: activeIds } = membership.value;
        const active = new Set(activeIds);
        observeActiveCachedThreads(cache, environmentId, activeIds, snapshotSequence, false);
        for (const id of threadIds) {
          const unchanged =
            cachedThreadGeneration(cache, environmentId, id) === generations.get(id);
          if (active.has(id)) {
            if (unchanged)
              yield* reviveCachedThread(
                cache,
                environmentId,
                id,
                () => cachedThreadGeneration(cache, environmentId, id) === generations.get(id),
              );
          } else if (unchanged || isCachedThreadEvicted(cache, environmentId, id)) {
            membershipEvictions.set(id, {
              generation: generations.get(id)!,
              sequence: snapshotSequence,
            });
          }
        }
      }
    }

    if (
      membershipChanged ||
      removedThreadIds.size > 0 ||
      pendingEvictions.size > 0 ||
      membershipEvictions.size > 0 ||
      persistedThreadIds.length > 0
    ) {
      const nextThreadIds = new Set(nextSnapshot.threads.map((thread) => thread.id));
      const evictionCandidates = new Set<ThreadId>();
      for (const threadId of removedThreadIds) evictionCandidates.add(threadId);
      for (const threadId of membershipEvictions.keys()) evictionCandidates.add(threadId);
      if (membershipChanged && next.omitsThreads !== true) {
        for (const thread of previousThreads) evictionCandidates.add(thread.id);
      }
      for (const threadId of next.omitsThreads === true ? [] : persistedThreadIds) {
        if (!isCachedThreadLive(cache, environmentId, threadId)) evictionCandidates.add(threadId);
      }
      const freshEvictions = new Set(evictionCandidates);
      for (const threadId of pendingEvictions) evictionCandidates.add(threadId);
      for (const threadId of nextThreadIds) {
        evictionCandidates.delete(threadId);
      }
      // Advance cache tombstones before publishing the new shell so detail
      // observers cannot enqueue an obsolete write in the transition window.
      // Keep failed disk removals pending while the shell still omits the thread;
      // a later snapshot or event can then retry instead of stranding stale data.
      const evictionResults = yield* Effect.forEach(evictionCandidates, (threadId) => {
        const validated = membershipEvictions.get(threadId);
        return evictCachedThread(
          cache,
          environmentId,
          threadId,
          () =>
            validated === undefined
              ? freshEvictions.has(threadId) ||
                isCachedThreadEvicted(cache, environmentId, threadId)
              : cachedThreadGeneration(cache, environmentId, threadId) === validated.generation &&
                !isCachedThreadLive(cache, environmentId, threadId),
          validated?.sequence,
        ).pipe(Effect.map((removed) => [threadId, removed] as const));
      });
      yield* Ref.set(
        pendingThreadEvictions,
        new Set(
          evictionResults
            .filter(
              ([threadId, removed]) =>
                !removed && isCachedThreadEvicted(cache, environmentId, threadId),
            )
            .map(([threadId]) => threadId),
        ),
      );
      if (membershipChanged) {
        const previousThreadIds = new Set(previousThreads.map((thread) => thread.id));
        yield* Effect.forEach(
          nextThreadIds,
          (threadId) =>
            previousThreadIds.has(threadId)
              ? Effect.void
              : reviveCachedThread(cache, environmentId, threadId),
          { discard: true },
        );
      }
      yield* Effect.forEach(
        removedThreadIds,
        (threadId) =>
          nextThreadIds.has(threadId)
            ? restoreCachedThread(cache, environmentId, threadId)
            : Effect.void,
        { discard: true },
      );
    }
    if (sequencedEvictions.size > 0) {
      const activeThreadIds = new Set(nextSnapshot.threads.map((thread) => thread.id));
      yield* Effect.forEach(
        sequencedEvictions,
        (threadId) =>
          activeThreadIds.has(threadId)
            ? reviveSequencedEviction(cache, environmentId, threadId)
            : Effect.void,
        { discard: true },
      );
    }

    // Open details own disk eviction, but known UI rows still need archive cleanup.
    if (membershipEvictions.size > 0) {
      const removedAt = new Map(next.removedAt);
      for (const [threadId, validated] of membershipEvictions) {
        if (
          cachedThreadActiveSequence(cache, environmentId, threadId) <= validated.sequence &&
          (isCachedThreadEvicted(cache, environmentId, threadId) ||
            (isCachedThreadLive(cache, environmentId, threadId) &&
              cachedThreadGeneration(cache, environmentId, threadId) === validated.generation))
        ) {
          omittedThreadIds.delete(threadId);
          removedAt.set(threadId, validated.sequence);
        }
      }
      next = { ...next, removedAt };
    }
    yield* SubscriptionRef.set(state, next);
    if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  }, Effect.scoped);

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    entries: ReadonlyArray<readonly [RpcSession, OrchestrationV2ShellStreamItem]>,
  ) {
    // Buffered items belong only to the session that admitted them.
    const subscription = yield* Ref.get(activeSubscription);
    yield* applyLocked(
      entries.flatMap(([session, item]) => (session === subscription?.session ? [item] : [])),
      subscription?.identity ?? null,
    );
  }, snapshotWriteLock.withPermit);

  const stateScope = yield* Effect.scope;
  // Each full snapshot supersedes the previous one's fill; links from an older snapshot must
  // not land on rows a newer snapshot reused.

  let activeFill: Fiber.Fiber<void> | undefined;
  const cancelActiveFill = Effect.suspend(() => {
    const fill = activeFill;
    activeFill = undefined;
    return fill === undefined ? Effect.void : Fiber.interrupt(fill);
  });
  const fillDeferredPullRequests = Effect.fnUntraced(function* (
    source: DeferredShellSnapshot,
    applied: OrchestrationV2ShellSnapshot,
  ) {
    yield* cancelActiveFill;
    if (source.loadPullRequests === undefined) return;
    const arrivedRows = new Set(applied.threads);
    const arrivedIds = new Set(source.threads.map((thread) => thread.id));
    pendingLinkRows = new Set(applied.threads.filter((thread) => arrivedIds.has(thread.id)));
    activeFill = yield* source.loadPullRequests.pipe(
      Effect.flatMap((linksByThreadId) =>
        writeFilledLinks(linksByThreadId, arrivedRows, arrivedIds),
      ),
      Effect.forkIn(stateScope),
    );
  });
  const writeFilledLinks = Effect.fnUntraced(
    function* (
      linksByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>,
      arrivedRows: ReadonlySet<OrchestrationV2ThreadShell>,
      arrivedIds: ReadonlySet<ThreadId>,
    ) {
      const filled = yield* SubscriptionRef.modify(
        state,
        (current): [Option.Option<OrchestrationV2ShellSnapshot>, EnvironmentShellState] => {
          if (Option.isNone(current.snapshot)) return [Option.none(), current];
          const snapshot = current.snapshot.value;
          let changed = false;
          const threads = snapshot.threads.map((thread) => {
            if (!arrivedRows.has(thread) || !arrivedIds.has(thread.id)) return thread;
            const links = linksByThreadId.get(thread.id);
            if (sameThreadPullRequests(thread.pullRequests, links)) return thread;
            changed = true;
            if (links === undefined) {
              const { pullRequests: _previous, ...row } = thread;
              return row;
            }
            return { ...thread, pullRequests: links };
          });
          if (!changed) return [Option.none(), current];
          const next = { ...snapshot, threads };
          return [Option.some(next), { ...current, snapshot: Option.some(next) }];
        },
      );
      pendingLinkRows = new Set();
      const live = yield* Ref.get(latestLive);
      if (Option.isNone(live)) return;
      const latest = Option.isSome(filled) ? filled.value : live.value.snapshot;
      yield* Ref.set(latestLive, Option.some({ snapshot: latest, origin: live.value.origin }));
      yield* Queue.offer(persistence, latest);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value, cachedSnapshot.value);
  }

  const applyHttpSnapshot = Effect.fnUntraced(function* (
    loaded: ShellSnapshotLoader.ShellHttpSnapshot,
    identity: ShellOriginIdentity | null,
  ) {
    const { projectIdentities: _identities, ...deferred } = loaded;
    yield* cancelActiveFill;
    const previous = yield* SubscriptionRef.get(state);
    const snapshot = reuseUnchangedThreadShells(
      Option.getOrNull(previous.snapshot),
      withoutDeferredPullRequests(deferred),
    );
    const pendingLinkIds = new Set(
      deferred.loadPullRequests === undefined ? [] : deferred.threads.map((thread) => thread.id),
    );
    yield* snapshotWriteLock.withPermit(
      applyLocked([{ kind: "snapshot", snapshot }], identity, pendingLinkIds),
    );
    const current = yield* SubscriptionRef.get(state);
    if (Option.isSome(current.snapshot)) {
      yield* fillDeferredPullRequests(deferred, current.snapshot.value);
    }
  }, Effect.uninterruptible);

  /**
   * One request to the HTTP shell route. Held rows that may resume are named, so the server
   * answers that they still can, in a few bytes, or sends the snapshot that replaces them.
   */
  const loadOverHttp = Effect.fn("EnvironmentShellState.loadOverHttp")(function* (
    prepared: PreparedConnection,
    identity: ShellOriginIdentity | null,
  ) {
    const held = yield* SubscriptionRef.get(state);
    const resumeFrom =
      Option.isSome(held.snapshot) &&
      canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis)
        ? held.snapshot.value.snapshotSequence
        : undefined;
    // HTTP and the socket must agree, or omitted children would return through the socket.
    const answer = yield* snapshotLoader.load(prepared, {
      omitIdleSubagents: identity?.omitIdleSubagents === true,
      omitOlderSettled: identity?.omitOlderSettled === true,
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
    });
    if (Option.isNone(answer)) return { kind: "failed" } satisfies HttpShellOutcome;
    if ("resumable" in answer.value) return { kind: "resumable" } satisfies HttpShellOutcome;
    yield* applyHttpSnapshot(answer.value, identity);
    return {
      kind: "snapshot",
      projectIdentities: answer.value.projectIdentities,
    } satisfies HttpShellOutcome;
  });

  // A server whose descriptor names its shell flags is asked for the shell as soon as the
  // connection is prepared, while the socket opens and the config downloads. The subscription
  // claims that load, and reloads when the live config disagrees with the descriptor.
  const earlyLoad = yield* SynchronizedRef.make<EarlyShellLoad | null>(null);
  const useEarlyLoad = (prepared: PreparedConnection | null, claim: boolean) =>
    SynchronizedRef.modifyEffect(
      earlyLoad,
      Effect.fnUntraced(function* (current) {
        // A rotated credential replaces the prepared connection of a session that stays up.
        if (current !== null && prepared !== null && sameConnection(current.prepared, prepared)) {
          const next = { ...current, prepared, claimed: current.claimed || claim };
          // A claimed load that still runs is handed out again. A second request could
          // answer first, and this one would then replace its rows under a passed cursor.
          const done = current.fiber.pollUnsafe() !== undefined;
          return [current.claimed && done ? null : current, next] as const;
        }
        if (current !== null) yield* Fiber.interrupt(current.fiber);
        const identity = descriptorShellIdentity(prepared?.descriptor);
        if (prepared === null || identity === null) return [null, null] as const;
        // Items a closed session still has in flight must not land on the rows this loads.
        yield* Ref.set(activeSubscription, null);
        const fiber = yield* loadOverHttp(prepared, identity).pipe(Effect.forkIn(stateScope));
        const next: EarlyShellLoad = { prepared, identity, fiber, claimed: claim };
        return [next, next] as const;
      }),
    ).pipe(
      // Covers the store too. A cancel that lands during the wait above would otherwise take
      // effect before the store, and the load just started would run on with no record.
      Effect.uninterruptible,
    );
  /**
   * The subscription waits for the early load, so its answer is applied before the socket
   * moves the rows on. Held rows that can resume wait a limited time only: after that the
   * load is ended, so a late answer applies nothing, and the socket resumes them.
   */
  const awaitEarlyLoad = Effect.fnUntraced(function* (
    early: EarlyShellLoad,
    identity: ShellOriginIdentity | null,
  ) {
    const resumable =
      Option.isSome((yield* SubscriptionRef.get(state)).snapshot) &&
      canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis);
    if (!resumable) return yield* Fiber.await(early.fiber);
    const answered = yield* Fiber.await(early.fiber).pipe(Effect.timeoutOption(EARLY_LOAD_GRACE));
    if (Option.isSome(answered)) return answered.value;
    // Returns after an answer that is being applied has finished, so the cursor below is read
    // from rows that no longer change under it.
    yield* Fiber.interrupt(early.fiber);
    return yield* Fiber.await(early.fiber);
  });

  yield* SubscriptionRef.changes(supervisor.prepared).pipe(
    // Reads the connection of this moment: a change handled late must not start a load for a
    // connection that ended, which would also drop the items of the session that replaced it.
    Stream.runForEach(() =>
      SubscriptionRef.get(supervisor.prepared).pipe(
        Effect.flatMap((prepared) => useEarlyLoad(Option.getOrNull(prepared), false)),
      ),
    ),
    Effect.forkScoped,
  );

  const resubscriptions = Stream.merge(
    Stream.fromQueue(reloadRequests),
    Option.match(wakeups, {
      onNone: () => Stream.never,
      onSome: (service) =>
        service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
    }),
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicWithSession(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        const identity = yield* session.initialConfig.pipe(
          Effect.map((config) => shellIdentity(config.environment, config)),
          Effect.orElseSucceed(() => null),
        );
        const { omitIdleSubagents, omitOlderSettled } = identity ?? {
          omitIdleSubagents: false,
          omitOlderSettled: false,
        };
        const early = yield* useEarlyLoad(
          Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared)),
          true,
        );
        const earlyExit = early === null ? null : yield* awaitEarlyLoad(early, identity);
        // Rows the descriptor's flags or build loaded are not kept when the live config differs:
        // their origin then cannot resume, so the load below replaces them.
        let loaded =
          early !== null &&
          earlyExit !== null &&
          Exit.isSuccess(earlyExit) &&
          identity !== null &&
          sameShellIdentity(early.identity, identity)
            ? earlyExit.value
            : null;
        yield* Ref.set(activeSubscription, { session, identity });
        yield* Ref.set(awaitingCompletion, true);
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          omitsThreads: omitIdleSubagents || omitOlderSettled,
        }));
        yield* setSynchronizing;

        // Rows from a recent server snapshot with the same omissions and server build resume
        // from their cursor, in memory or from the cache. Anything else reloads the HTTP
        // snapshot so a valid cursor cannot preserve stale or incomplete data. A `resumable`
        // answer is checked again too: the rows can pass their age limit while the socket opens.
        const resumingHeldRows =
          loaded?.kind !== "snapshot" &&
          Option.isSome((yield* SubscriptionRef.get(state)).snapshot) &&
          canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis);
        if (!resumingHeldRows && loaded === null) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          loaded = yield* loadOverHttp(prepared, identity);
        }

        const current = yield* SubscriptionRef.get(state);
        const omission = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitOlderSettled ? { omitOlderSettled: true as const } : {}),
        };
        if (Option.isNone(current.snapshot) || !(resumingHeldRows || loaded?.kind === "snapshot")) {
          return { ...omission, requestCompletionMarker: true as const };
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          // Only rows the client already held may be refused; a cursor from the snapshot just
          // loaded falls back to the socket snapshot, so a refusal cannot loop.
          ...(resumingHeldRows ? { httpSnapshotFallback: true as const } : {}),
          // No stream item has touched the snapshot just loaded, so its identities still hold.
          ...(loaded?.kind === "snapshot" && loaded.projectIdentities !== undefined
            ? { knownProjectIdentities: loaded.projectIdentities }
            : {}),
          ...omission,
          requestCompletionMarker: true as const,
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: resubscriptions,
      },
    ).pipe(Stream.runForEachArray((entries) => applyItems(entries))),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly firstError: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  firstError: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.firstError === right.firstError
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let firstError: string | null = null;

    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      firstError,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

/**
 * Every shell push replaces the state, so views that gate on load progress read these
 * primitives instead and stay put while threads stream.
 */
function createEnvironmentShellProgressAtoms(
  stateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
) {
  return {
    statusAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(stateValueAtom(environmentId)).status).pipe(
        Atom.withLabel(`environment-shell-status:${environmentId}`),
      ),
    ),
    hasSnapshotAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => Option.isSome(get(stateValueAtom(environmentId)).snapshot)).pipe(
        Atom.withLabel(`environment-shell-has-snapshot:${environmentId}`),
      ),
    ),
  };
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ShellSnapshotLoader.ShellSnapshotLoader
    | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      AsyncResult.getOrElse(get(stateAtom(environmentId)), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  const { statusAtom, hasSnapshotAtom } = createEnvironmentShellProgressAtoms(stateValueAtom);

  return {
    stateAtom,
    stateValueAtom,
    statusAtom,
    hasSnapshotAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellPullRequests.ts";
export * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
export * from "./steadyShells.ts";

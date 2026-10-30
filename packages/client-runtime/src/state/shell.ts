import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { request, subscribeDynamic } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvent,
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
        Effect.as(Option.none<DeferredShellSnapshot>()),
      ),
    ),
  );
  const cachedSnapshot = Option.map(cached, withoutDeferredPullRequests);
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  const pendingThreadEvictions = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const omittedThreadIds = new Set<ThreadId>();
  let supportsMembership = false;
  const lastAuthoritativeSession = yield* Ref.make<RpcSession | null>(null);
  const activeSubscriptionSession = yield* Ref.make<RpcSession | null>(null);
  const latestLiveSnapshot = yield* Ref.make<Option.Option<OrchestrationV2ShellSnapshot>>(
    Option.none(),
  );
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
  let lastPersisted: OrchestrationV2ShellSnapshot | undefined;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(latest) || latest.value === lastPersisted) return;
      if (latest.value.threads.some((thread) => pendingLinkRows.has(thread))) return;
      const snapshot = latest.value;
      if (
        lastPersisted !== undefined &&
        snapshot.snapshotSequence >= lastPersisted.snapshotSequence &&
        snapshot.schemaVersion === lastPersisted.schemaVersion &&
        snapshot.projects === lastPersisted.projects &&
        snapshot.threads === lastPersisted.threads &&
        snapshot.archivedThreads === lastPersisted.archivedThreads
      ) {
        // Keep the live cursor without rewriting the rows. Remember it here too so a
        // later authoritative reset to a lower sequence still reaches the cache.
        lastPersisted = snapshot;
        return;
      }
      const saved = yield* cache.saveShell(environmentId, snapshot).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = snapshot;
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

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(
    function* (
      items: ReadonlyArray<OrchestrationV2ShellStreamItem>,
      pendingLinkIds?: ReadonlySet<ThreadId>,
    ) {
      const initial = yield* SubscriptionRef.get(state);
      let waiting = yield* Ref.get(awaitingCompletion);
      /* oxlint-disable oxc/no-accumulating-spread -- This copies a fixed-shape state record, not a growing collection. */
      let next = initial;
      let receivedSnapshot = false;
      let receivedAuthoritativeSnapshot = false;
      const removedThreadIds = new Set<ThreadId>();
      const sequencedEvictions = new Set<ThreadId>();
      for (const item of items) {
        if (item.kind === "synchronized") {
          waiting = false;
          if (Option.isSome(next.snapshot)) {
            next = { ...next, status: "live", error: Option.none() };
          }
          continue;
        }
        const authoritative =
          item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined;
        const nextSnapshot =
          item.kind === "snapshot"
            ? mergeShellSnapshotProjects(
                Option.getOrNull(next.snapshot),
                item.snapshot,
                item.resolvedRepositoryIdentityRoots === undefined
                  ? undefined
                  : {
                      resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots,
                    },
              )
            : Option.match(next.snapshot, {
                onNone: () => null,
                onSome: (snapshot) =>
                  item.sequence > snapshot.snapshotSequence
                    ? applyShellStreamEvent(snapshot, item)
                    : snapshot,
              });
        if (nextSnapshot === null) continue;
        if (
          Option.isSome(next.snapshot) &&
          (item.kind !== "snapshot" || next.omitsThreads !== true)
        ) {
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
        receivedSnapshot ||= item.kind === "snapshot";
        const removal =
          item.kind === "thread.removed" &&
          Option.exists(next.snapshot, (snapshot) => item.sequence > snapshot.snapshotSequence)
            ? item
            : null;
        if (removal !== null) removedThreadIds.add(removal.threadId);
        receivedAuthoritativeSnapshot ||=
          item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined;
        next = {
          omitsThreads: next.omitsThreads === true,
          snapshot: Option.some(nextSnapshot),
          status: waiting ? "synchronizing" : "live",
          error: Option.none(),
          generation: authoritative ? ++lastShellGeneration : next.generation,
          removedAt: authoritative
            ? EMPTY_REMOVALS
            : removal === null
              ? next.removedAt
              : new Map(next.removedAt).set(removal.threadId, removal.sequence),
        };
      }
      /* oxlint-enable oxc/no-accumulating-spread */
      yield* Ref.set(awaitingCompletion, waiting);
      if (next === initial || Option.isNone(next.snapshot)) return;
      if (pendingLinkIds !== undefined) {
        pendingLinkRows = new Set(
          next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
        );
      }
      yield* Ref.set(latestLiveSnapshot, next.snapshot);
      const nextSnapshot = next.snapshot.value;
      const previousThreads = Option.match(initial.snapshot, {
        onNone: () => undefined,
        onSome: (snapshot) => snapshot.threads,
      });
      const membershipChanged =
        previousThreads !== undefined && !sameThreadIds(previousThreads, nextSnapshot.threads);
      const pendingEvictions = yield* Ref.get(pendingThreadEvictions);
      // Partial shells validate only known omissions, without fetching their shells
      // or bodies. Open details own disk eviction and may postdate this snapshot.
      const persistedThreadIds =
        receivedAuthoritativeSnapshot && (next.omitsThreads !== true || supportsMembership)
          ? yield* listPersistedThreadIds
          : [];
      const membershipEvictions = new Map<ThreadId, { generation: number; sequence: number }>();
      if (receivedAuthoritativeSnapshot && next.omitsThreads === true) {
        const listedIds = new Set(nextSnapshot.threads.map((thread) => thread.id));
        for (const thread of previousThreads ?? []) omittedThreadIds.add(thread.id);
        for (const id of persistedThreadIds) {
          if (!isCachedThreadLive(cache, environmentId, id)) omittedThreadIds.add(id);
        }
        for (const id of listedIds) omittedThreadIds.delete(id);
        const candidates = supportsMembership ? [...omittedThreadIds] : [];
        const session = yield* Ref.get(activeSubscriptionSession);
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
      if (receivedSnapshot) {
        const session = yield* Ref.get(activeSubscriptionSession);
        if (session !== null) {
          yield* Ref.set(lastAuthoritativeSession, session);
        }
      }
      if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
        yield* Queue.offer(persistence, next.snapshot.value);
      }
    },
    Effect.scoped,
    snapshotWriteLock.withPermit,
  );

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
      const live = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(live)) return;
      const latest = Option.isSome(filled) ? filled : live;
      yield* Ref.set(latestLiveSnapshot, latest);
      yield* Queue.offer(persistence, latest.value);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value, cachedSnapshot.value);
  }

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        yield* Ref.set(activeSubscriptionSession, session);
        const { omitIdleSubagents, omitOlderSettled, membership } =
          yield* session.initialConfig.pipe(
            Effect.map((config) => ({
              membership: config.shellThreadMembership === true,
              omitIdleSubagents: config.shellThreadFamilies === true,
              omitOlderSettled:
                config.shellOlderSettled === true && config.shellThreadFamilies === true,
            })),
            Effect.orElseSucceed(() => ({
              membership: false,
              omitIdleSubagents: false,
              omitOlderSettled: false,
            })),
          );
        supportsMembership = membership;
        yield* Ref.set(awaitingCompletion, true);
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          omitsThreads: omitIdleSubagents || omitOlderSettled,
        }));
        yield* setSynchronizing;

        // Foreground resubscriptions on the same live session can resume from
        // the in-memory cursor. A new session reloads the authoritative HTTP
        // snapshot so a valid cursor cannot preserve incomplete cached data.
        const hasAuthoritativeSnapshot = (yield* Ref.get(lastAuthoritativeSession)) === session;
        let canResume = hasAuthoritativeSnapshot;
        let current = yield* SubscriptionRef.get(state);
        if (!hasAuthoritativeSnapshot || Option.isNone(current.snapshot)) {
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
          // HTTP and the socket must agree, or omitted children would return through the socket.
          const httpSnapshot = yield* snapshotLoader.load(prepared, {
            omitIdleSubagents,
            omitOlderSettled,
          });
          if (Option.isSome(httpSnapshot)) {
            yield* cancelActiveFill;
            const previous = yield* SubscriptionRef.get(state);
            const snapshot = reuseUnchangedThreadShells(
              Option.getOrNull(previous.snapshot),
              withoutDeferredPullRequests(httpSnapshot.value),
            );
            const pendingLinkIds = new Set(
              httpSnapshot.value.loadPullRequests === undefined
                ? []
                : httpSnapshot.value.threads.map((thread) => thread.id),
            );
            yield* applyItems([{ kind: "snapshot", snapshot }], pendingLinkIds);
            canResume = true;
            current = yield* SubscriptionRef.get(state);
            if (Option.isSome(current.snapshot)) {
              yield* fillDeferredPullRequests(httpSnapshot.value, current.snapshot.value);
            }
          }
        }

        const omission = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitOlderSettled ? { omitOlderSettled: true as const } : {}),
        };
        if (!canResume || Option.isNone(current.snapshot)) {
          return { ...omission, requestCompletionMarker: true as const };
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          ...omission,
          requestCompletionMarker: true as const,
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray((items) => applyItems(items))),
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

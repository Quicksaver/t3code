import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";

interface ThreadCacheState {
  generation: number;
  evicted: boolean;
  // A failed disk removal keeps the body-free tombstone after its last
  // retainer leaves, so a reopen cannot admit the stale persisted detail.
  removalFailed: boolean;
  retainers: number;
  // Open detail subscriptions, a subset of retainers. Warm resume snapshots and
  // in-flight commands retain state without observing the thread's lifecycle.
  subscriptions: number;
  operations: number;
  // Highest shell sequence at which an applied authoritative shell item listed
  // the thread as active; -1 when none was observed for this state.
  activeSequence: number;
  // Sequence of the archive (acknowledgement, detail event or detail snapshot)
  // that evicted the thread; -1 once a sequence reset made it older than any
  // new sequence. A later active observation proves an unarchive and revives it.
  evictionSequence: number | undefined;
  readonly evictionListeners: Set<() => void>;
  readonly lock: Semaphore.Semaphore;
}

type EnvironmentThreadCacheStates = Map<ThreadId, ThreadCacheState>;
type CacheStates = Map<EnvironmentId, EnvironmentThreadCacheStates>;

const cacheStates = new WeakMap<Persistence.EnvironmentCacheStore["Service"], CacheStates>();
// Advances when an environment's shell sequence space is replaced (a lower
// authoritative snapshot), so sequences captured before it are not compared.
const sequenceEpochs = new WeakMap<
  Persistence.EnvironmentCacheStore["Service"],
  Map<EnvironmentId, number>
>();

export function cachedThreadSequenceEpoch(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
): number {
  return sequenceEpochs.get(cache)?.get(environmentId) ?? 0;
}

function existingThreadCacheState(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadCacheState | undefined {
  return cacheStates.get(cache)?.get(environmentId)?.get(threadId);
}

function threadCacheState(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadCacheState {
  let environmentEntries = cacheStates.get(cache);
  if (environmentEntries === undefined) {
    environmentEntries = new Map();
    cacheStates.set(cache, environmentEntries);
  }

  let threadEntries = environmentEntries.get(environmentId);
  if (threadEntries === undefined) {
    threadEntries = new Map();
    environmentEntries.set(environmentId, threadEntries);
  }

  const existing = threadEntries.get(threadId);
  if (existing !== undefined) {
    return existing;
  }

  const created: ThreadCacheState = {
    generation: 0,
    evicted: false,
    removalFailed: false,
    retainers: 0,
    subscriptions: 0,
    operations: 0,
    activeSequence: -1,
    evictionSequence: undefined,
    evictionListeners: new Set(),
    lock: Semaphore.makeUnsafe(1),
  };
  threadEntries.set(threadId, created);
  return created;
}

function pruneThreadCacheState(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: ThreadCacheState,
): void {
  if (state.retainers > 0 || state.operations > 0 || state.removalFailed) return;

  const environmentEntries = cacheStates.get(cache);
  const threadEntries = environmentEntries?.get(environmentId);
  if (threadEntries?.get(threadId) !== state) return;

  threadEntries.delete(threadId);
  if (threadEntries.size === 0) {
    environmentEntries?.delete(environmentId);
  }
  if (environmentEntries?.size === 0) {
    cacheStates.delete(cache);
  }
}

function withThreadCacheState<A, E, R>(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  use: (state: ThreadCacheState) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const state = threadCacheState(cache, environmentId, threadId);
      state.operations += 1;
      return state;
    }),
    use,
    (state) =>
      Effect.sync(() => {
        state.operations -= 1;
        pruneThreadCacheState(cache, environmentId, threadId, state);
      }),
  );
}

// Warm snapshots retain this boundary after the RPC scope closes. Their
// disposer releases both the listener and the otherwise collectible tombstone.
export function retainCachedThreadUnsafe(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  onEviction?: () => void,
): () => void {
  const state = threadCacheState(cache, environmentId, threadId);
  state.retainers += 1;
  if (onEviction) state.evictionListeners.add(onEviction);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (onEviction) state.evictionListeners.delete(onEviction);
    state.retainers -= 1;
    pruneThreadCacheState(cache, environmentId, threadId, state);
  };
}

// Held by an open detail subscription for its scope; marks the thread live.
export const retainLiveCachedThread = Effect.fn("EnvironmentThreadCache.retainLive")(function* (
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const release = retainCachedThreadUnsafe(cache, environmentId, threadId);
      const state = threadCacheState(cache, environmentId, threadId);
      state.subscriptions += 1;
      return () => {
        state.subscriptions -= 1;
        release();
      };
    }),
    (release) => Effect.sync(release),
  );
});

export function cachedThreadGeneration(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number {
  return existingThreadCacheState(cache, environmentId, threadId)?.generation ?? 0;
}

export function isCachedThreadEvicted(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return existingThreadCacheState(cache, environmentId, threadId)?.evicted === true;
}

// An open detail subscription owns its own archive and restore transitions.
export function isCachedThreadLive(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  const state = existingThreadCacheState(cache, environmentId, threadId);
  return state !== undefined && !state.evicted && state.subscriptions > 0;
}

export const persistCachedThread = Effect.fn("EnvironmentThreadCache.persist")(function* (
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  snapshot: Parameters<Persistence.EnvironmentCacheStore["Service"]["saveThread"]>[1],
  generation: number,
) {
  const threadId = snapshot.projection.thread.id;
  return yield* withThreadCacheState(cache, environmentId, threadId, (state) =>
    // Keep persistence under the same permit as eviction. Otherwise an older
    // write can pass its generation check and finish after cache removal.
    state.lock.withPermit(
      Effect.gen(function* () {
        if (state.evicted || state.generation !== generation) {
          return false;
        }
        return yield* cache.saveThread(environmentId, snapshot).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not persist the thread cache.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(false),
            ),
          ),
        );
      }),
    ),
  );
});

export const evictCachedThread = Effect.fn("EnvironmentThreadCache.evict")(function* (
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  isCurrent: () => boolean = () => true,
  // The sequence of the archive causing this eviction. The shell coalesces an
  // archive and a later unarchive into one active update, so an active
  // observation after this sequence skips the eviction, and one arriving later
  // revives it (`observeActiveCachedThreads`). Deletions pass none.
  evictionSequence?: number,
) {
  return yield* withThreadCacheState(cache, environmentId, threadId, (state) =>
    state.lock.withPermit(
      Effect.gen(function* () {
        if (!isCurrent()) return false;
        if (evictionSequence !== undefined && state.activeSequence > evictionSequence) {
          return false;
        }
        // An eviction retried on a tombstone never weakens its marker: an
        // unsequenced one (deletion or shell removal) stays unsequenced, and an
        // older archive cannot lower a newer archive's sequence.
        state.evictionSequence = !state.evicted
          ? evictionSequence
          : state.evictionSequence === undefined || evictionSequence === undefined
            ? undefined
            : Math.max(state.evictionSequence, evictionSequence);
        state.generation += 1;
        state.evicted = true;
        for (const onEviction of state.evictionListeners) onEviction();
        const removed = yield* cache.removeThread(environmentId, threadId).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not evict cached thread detail.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(false),
            ),
          ),
        );
        state.removalFailed = !removed;
        return removed;
      }),
    ),
  );
});

function reviveThreadCacheState(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  isCurrent: (state: ThreadCacheState) => boolean,
  invalidate: boolean,
) {
  return withThreadCacheState(cache, environmentId, threadId, (state) =>
    state.lock.withPermit(
      Effect.sync(() => {
        if (!isCurrent(state)) return;
        if (state.evicted || invalidate) {
          // Invalidate writes that captured the eviction generation while the
          // tombstone was active before making the cache writable again.
          state.generation += 1;
          state.evicted = false;
          state.removalFailed = false;
          state.evictionSequence = undefined;
        }
      }),
    ),
  );
}

export const reviveCachedThread = Effect.fn("EnvironmentThreadCache.revive")(function* (
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  isCurrent: () => boolean = () => true,
) {
  yield* reviveThreadCacheState(cache, environmentId, threadId, isCurrent, false);
});

// Revives after an archive and restore that may not have evicted, such as both
// arriving in one shell batch. The generation still advances, so an archive
// acknowledgement captured before them cannot evict the restored thread.
export const restoreCachedThread = Effect.fn("EnvironmentThreadCache.restore")(function* (
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  yield* reviveThreadCacheState(cache, environmentId, threadId, () => true, true);
});

// Records that an applied authoritative shell item (an active update or an
// authoritative snapshot) listed these threads as active at `sequence`. Only
// threads with cache state are tracked: an archive acknowledgement retains it.
// `reset` marks a snapshot that replaced the sequence space (lower than the
// applied one): it advances the epoch, drops old observations and makes old
// eviction sequences older than any new one. Returns the threads a sequenced
// archive eviction removed before `sequence`; the caller revives those still
// active at the end of its batch with `reviveSequencedEviction`.
export function observeActiveCachedThreads(
  cache: Persistence.EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadIds: Iterable<ThreadId>,
  sequence: number,
  reset: boolean,
): ReadonlyArray<ThreadId> {
  if (reset) {
    let epochs = sequenceEpochs.get(cache);
    if (epochs === undefined) {
      epochs = new Map();
      sequenceEpochs.set(cache, epochs);
    }
    epochs.set(environmentId, cachedThreadSequenceEpoch(cache, environmentId) + 1);
  }
  const states = cacheStates.get(cache)?.get(environmentId);
  if (states === undefined) return [];
  if (reset) {
    for (const state of states.values()) {
      state.activeSequence = -1;
      if (state.evictionSequence !== undefined) state.evictionSequence = -1;
    }
  }
  const revivals: ThreadId[] = [];
  for (const threadId of threadIds) {
    const state = states.get(threadId);
    if (state === undefined) continue;
    state.activeSequence = Math.max(state.activeSequence, sequence);
    if (
      state.evicted &&
      state.evictionSequence !== undefined &&
      state.evictionSequence < sequence
    ) {
      revivals.push(threadId);
    }
  }
  return revivals;
}

export const reviveSequencedEviction = Effect.fn("EnvironmentThreadCache.reviveSequencedEviction")(
  function* (
    cache: Persistence.EnvironmentCacheStore["Service"],
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    yield* reviveThreadCacheState(
      cache,
      environmentId,
      threadId,
      (state) =>
        state.evicted &&
        state.evictionSequence !== undefined &&
        state.activeSequence > state.evictionSequence,
      false,
    );
  },
);

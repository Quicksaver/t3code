export class VersionControlCommandInterrupted extends Error {
  constructor() {
    super("The Version Control command was interrupted.");
    this.name = "VersionControlCommandInterrupted";
  }
}

export const VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS = {
  reportFailure: false,
  throwOnFailure: true,
} as const;

export function retainPullRefreshIndicator(current: boolean, pullRequest: boolean): boolean {
  return current || pullRequest;
}

export interface VersionControlRefreshOptions {
  readonly pull?: boolean;
  readonly refresh?: "full" | "working-tree";
  // Mutation follow-ups read a fresh full snapshot instead of joining a coalesced query.
  readonly authoritative?: boolean;
}

export function mergeVersionControlRefreshOptions(
  current: VersionControlRefreshOptions | null,
  next: VersionControlRefreshOptions,
): VersionControlRefreshOptions {
  return {
    ...(current?.pull === true || next.pull === true ? { pull: true } : {}),
    ...(current?.authoritative === true || next.authoritative === true
      ? { authoritative: true }
      : {}),
    refresh:
      next.refresh !== "working-tree" || (current !== null && current.refresh !== "working-tree")
        ? "full"
        : "working-tree",
  };
}

/**
 * Orders one route controller's snapshot reads: only the latest read for the still-selected cwd
 * may apply. `dispose` runs on controller cleanup, invalidating reads in flight and refusing new
 * ones until `activate` runs again on (re)mount.
 */
export function createSnapshotRequestScope() {
  let latest = 0;
  let active = true;
  return {
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      latest += 1;
    },
    /** Returns the new read's id, or null when the controller is no longer mounted. */
    begin(): number | null {
      if (!active) return null;
      latest += 1;
      return latest;
    },
    isCurrent(requestId: number, requestCwd: string | null, currentCwd: string | null): boolean {
      return active && requestId === latest && requestCwd === currentCwd;
    },
  };
}

export interface VersionControlRefreshQueue {
  readonly cwd: string | null;
  queued: VersionControlRefreshOptions | null;
  promise: Promise<void>;
}

/**
 * Joins the active refresh run for `cwd`, or starts one that drains every request joined while
 * it runs. A run stops when another cwd replaces it in `slot`.
 */
export function requestVersionControlRefresh(
  slot: { current: VersionControlRefreshQueue | null },
  cwd: string | null,
  options: VersionControlRefreshOptions,
  perform: (options: VersionControlRefreshOptions) => Promise<void>,
): Promise<void> {
  const active = slot.current;
  if (active?.cwd === cwd) {
    active.queued = mergeVersionControlRefreshOptions(active.queued, options);
    return active.promise;
  }

  const queue: VersionControlRefreshQueue = { cwd, queued: null, promise: Promise.resolve() };
  slot.current = queue;
  queue.promise = (async () => {
    let nextOptions: VersionControlRefreshOptions | null = options;
    while (nextOptions !== null) {
      await perform(nextOptions);
      if (slot.current !== queue) return;
      nextOptions = queue.queued;
      queue.queued = null;
      // Release in the same tick the queue drains, so a later request starts a new run
      // instead of joining one that has already finished.
      if (nextOptions === null) slot.current = null;
    }
  })().finally(() => {
    if (slot.current === queue) slot.current = null;
  });
  return queue.promise;
}

export async function runAutomaticRemoteFetch(options: {
  readonly cwd: string;
  readonly inFlightCwds: Set<string>;
  readonly fetch: () => Promise<boolean>;
  readonly refresh: () => Promise<unknown>;
}): Promise<boolean> {
  if (options.inFlightCwds.has(options.cwd)) return false;
  options.inFlightCwds.add(options.cwd);
  try {
    const fetched = await options.fetch();
    if (fetched) await options.refresh();
    return fetched;
  } catch {
    return false;
  } finally {
    options.inFlightCwds.delete(options.cwd);
  }
}

export async function retryInterruptedVersionControlRequest<TResult>(
  request: () => Promise<TResult>,
  maxRetries = 1,
): Promise<TResult> {
  let retries = 0;
  while (true) {
    try {
      return await request();
    } catch (cause) {
      if (!(cause instanceof VersionControlCommandInterrupted) || retries >= maxRetries) {
        throw cause;
      }
      retries += 1;
    }
  }
}

export interface WorkingTreeEnrichmentBatch {
  readonly cwd: string;
  readonly paths: readonly string[];
}

const WORKING_TREE_ENRICHMENT_BATCH_SIZE = 64;
const WORKING_TREE_ENRICHMENT_DELAY_MS = 50;

/**
 * Runs working-tree enrichment in bounded per-cwd batches, one request at a time. A `request`
 * with the same cwd/path identities as a traversal still in progress keeps that traversal and
 * coalesces into one follow-up pass over all of its paths, so repeated snapshot reads cannot
 * starve progress yet every accepted read is still revalidated. Any other `request` replaces the
 * queued work and drops results still in flight. A failed batch stops only its own pass; the
 * next `request` retries it. `request([])` cancels.
 */
export function createWorkingTreeEnrichmentQueue<TResult>(options: {
  readonly enrich: (batch: WorkingTreeEnrichmentBatch) => Promise<TResult>;
  readonly onResult: (batch: WorkingTreeEnrichmentBatch, result: TResult) => void;
}) {
  let generation = 0;
  let requested: readonly WorkingTreeEnrichmentBatch[] = [];
  let requestedKey = "[]";
  let revalidate = false;
  let pending: WorkingTreeEnrichmentBatch[] = [];
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const nextBatch = () => {
    if (pending.length === 0 && revalidate) {
      revalidate = false;
      pending = [...requested];
    }
    return pending.shift();
  };

  const flush = async () => {
    timer = null;
    if (running) return;
    running = true;
    try {
      let next = nextBatch();
      while (next !== undefined) {
        const batch = {
          cwd: next.cwd,
          paths: next.paths.slice(0, WORKING_TREE_ENRICHMENT_BATCH_SIZE),
        };
        if (next.paths.length > batch.paths.length) {
          pending.unshift({
            cwd: next.cwd,
            paths: next.paths.slice(WORKING_TREE_ENRICHMENT_BATCH_SIZE),
          });
        }
        const batchGeneration = generation;
        try {
          const result = await options.enrich(batch);
          if (batchGeneration === generation) options.onResult(batch, result);
        } catch {
          // A superseded failure must not strand the newer request's queue.
          if (batchGeneration === generation) pending = [];
        }
        next = nextBatch();
      }
    } finally {
      running = false;
    }
  };

  return {
    request(batches: readonly WorkingTreeEnrichmentBatch[]) {
      const nextRequested = batches.filter((batch) => batch.paths.length > 0);
      const nextKey = JSON.stringify(nextRequested.map((batch) => [batch.cwd, batch.paths]));
      const inProgress = running || pending.length > 0;
      if (inProgress && nextKey === requestedKey) {
        revalidate = true;
        return;
      }
      generation += 1;
      requested = nextRequested;
      requestedKey = nextKey;
      revalidate = false;
      pending = [...nextRequested];
      if (pending.length > 0 && !running && timer === null) {
        timer = setTimeout(() => void flush(), WORKING_TREE_ENRICHMENT_DELAY_MS);
      }
    },
  };
}

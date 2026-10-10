/** Stops on mutation failure, continues after follow-up failure, and reports each archive at most once. */
export async function archiveEligibleThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
  canArchive?: (entry: TEntry) => boolean;
  onArchived?: (entry: TEntry) => void;
  onSkipped?: (entry: TEntry) => void;
}): Promise<{
  archivedThreadKeys: readonly string[];
  skippedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const skippedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    if (input.canArchive && !input.canArchive(entry)) {
      skippedThreadKeys.push(entry.threadKey);
      input.onSkipped?.(entry);
      continue;
    }
    let didArchive = false;
    const markArchived = () => {
      if (didArchive) return;
      didArchive = true;
      input.onArchived?.(entry);
    };
    const result = await input.archive(entry, markArchived);
    // A success that never marked (the thread was already gone) still counts.
    if (result._tag === "Success") markArchived();
    if (didArchive) archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, skippedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, skippedThreadKeys, mutationFailure: null, followupFailures };
}

export function getCompletedArchiveThreadKeys(input: {
  archivedThreadKeys: readonly string[];
  skippedThreadKeys: readonly string[];
}): readonly string[] {
  return [...input.archivedThreadKeys, ...input.skippedThreadKeys];
}

export type ArchiveOutcomeNotice<TFailure> =
  | { readonly type: "error"; readonly title: string; readonly failure: TFailure }
  | { readonly type: "warning"; readonly title: string; readonly description: string };

/**
 * Notices for one archive batch. Completed archives are never reported as
 * failed: a later navigation failure and an archive failure read differently,
 * and eligibility skips are a warning rather than an error.
 */
export function getArchiveOutcomeNotices<TFailure>(input: {
  readonly outcome: {
    readonly archivedThreadKeys: readonly string[];
    readonly skippedThreadKeys: readonly string[];
    readonly mutationFailure: TFailure | null;
    readonly followupFailures: readonly TFailure[];
  };
  readonly entryCount: number;
  readonly isInterrupted: (failure: TFailure) => boolean;
}): ArchiveOutcomeNotice<TFailure>[] {
  const { outcome } = input;
  const notices: ArchiveOutcomeNotice<TFailure>[] = [];
  for (const failure of outcome.followupFailures) {
    if (input.isInterrupted(failure)) continue;
    notices.push({ type: "error", title: "Thread archived, but navigation failed", failure });
  }
  if (outcome.mutationFailure !== null && !input.isInterrupted(outcome.mutationFailure)) {
    notices.push({
      type: "error",
      title: input.entryCount === 1 ? "Failed to archive thread" : "Failed to archive threads",
      failure: outcome.mutationFailure,
    });
  }
  const skippedCount = outcome.skippedThreadKeys.length;
  if (skippedCount > 0) {
    notices.push({
      type: "warning",
      title:
        outcome.archivedThreadKeys.length === 0
          ? "No threads archived"
          : "Some threads were not archived",
      description:
        skippedCount === 1
          ? "1 thread was no longer eligible for this archive action and was skipped."
          : `${skippedCount} threads were no longer eligible for this archive action and were skipped.`,
    });
  }
  return notices;
}

const sharedThreadArchiveReservations = new Map<string, Promise<ReadonlySet<string>>>();

/**
 * Queues each thread behind its current holder in start order, so waits only
 * point at older flows and can never form a cycle. Each thread is omitted when
 * its predecessor completed it (archived or intentionally skipped) and retried
 * otherwise. Completing a thread detaches its queue: requests already queued
 * behind it still omit it, while a fresh request (for example after Undo)
 * starts a new queue instead of inheriting the old completion.
 */
export async function withCoordinatedThreadArchiveEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  reservations?: Map<string, Promise<ReadonlySet<string>>>;
  run: (
    entries: readonly TEntry[],
    onCompleted: (threadKey: string) => void,
  ) => Promise<readonly string[]>;
}): Promise<readonly string[]> {
  const reservations = input.reservations ?? sharedThreadArchiveReservations;
  let resolveReservation: (completedThreadKeys: ReadonlySet<string>) => void = () => undefined;
  const reservation = new Promise<ReadonlySet<string>>((resolve) => {
    resolveReservation = resolve;
  });
  const uniqueEntries: TEntry[] = [];
  const threadKeys = new Set<string>();
  const predecessors = new Map<string, Promise<ReadonlySet<string>>>();
  for (const entry of input.entries) {
    if (threadKeys.has(entry.threadKey)) continue;
    threadKeys.add(entry.threadKey);
    uniqueEntries.push(entry);
    const predecessor = reservations.get(entry.threadKey);
    if (predecessor) predecessors.set(entry.threadKey, predecessor);
    reservations.set(entry.threadKey, reservation);
  }
  const completedThreadKeys = new Set<string>();
  const release = (threadKey: string) => {
    if (reservations.get(threadKey) === reservation) reservations.delete(threadKey);
  };
  // Only this flow's own first completion may drop a successor's entry: an
  // inherited or repeated completion could otherwise remove a newer queue.
  const complete = (threadKey: string) => {
    if (!threadKeys.has(threadKey) || completedThreadKeys.has(threadKey)) return;
    completedThreadKeys.add(threadKey);
    reservations.delete(threadKey);
  };

  try {
    // Uncontested flows start synchronously; only contested ones await.
    if (predecessors.size > 0) {
      await Promise.all(
        [...predecessors].map(async ([threadKey, predecessor]) => {
          if (!(await predecessor).has(threadKey)) return;
          completedThreadKeys.add(threadKey);
          release(threadKey);
        }),
      );
    }
    const pendingEntries = uniqueEntries.filter(
      ({ threadKey }) => !completedThreadKeys.has(threadKey),
    );
    if (pendingEntries.length === 0) return [];

    const completedByRun = await input.run(pendingEntries, complete);
    for (const threadKey of completedByRun) complete(threadKey);
    return completedByRun;
  } finally {
    resolveReservation(completedThreadKeys);
    for (const threadKey of threadKeys) release(threadKey);
  }
}

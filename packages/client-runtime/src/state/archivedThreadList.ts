import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ArchivedSnapshotEntry } from "./archivedThreads.ts";
import type { EnvironmentThreadShell } from "./shell.ts";

const ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET = 5_000;
const ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PHRASE_SCORE_MAX = ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET - 1;
const ARCHIVED_THREAD_ALL_TOKENS_SCORE_MAX =
  ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET - ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET - 1;
const DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY = 4;

export type ArchivedThreadSortField = "archivedAt" | "createdAt";
export type ArchivedThreadSortDirection = "asc" | "desc";

export interface ArchivedThreadSortState {
  readonly field: ArchivedThreadSortField;
  readonly direction: ArchivedThreadSortDirection;
}

export interface ArchivedThreadSearchInput {
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
}

export interface ArchivedThreadActionLock {
  readonly keys: ReadonlyArray<string>;
}

export type ArchivedThreadBulkTarget = Pick<EnvironmentThreadShell, "environmentId" | "id"> & {
  readonly lineage?: Pick<EnvironmentThreadShell["lineage"], "parentThreadId" | "sideChat">;
};

export function getArchivedSideChatsByParent(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
  targets: ReadonlyArray<ScopedThreadRef>,
  action: "unarchive" | "delete",
): ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>> {
  const selected = new Set(targets.map(archivedThreadActionKey));
  const sideChats = new Map<string, ScopedThreadRef[]>();
  for (const { environmentId, snapshot } of snapshots) {
    const archivedAtById =
      action === "unarchive"
        ? new Map(snapshot.threads.map(({ id, archivedAt }) => [id, archivedAt]))
        : null;
    for (const thread of snapshot.threads) {
      const { parentThreadId, sideChat } = thread.lineage;
      if (!sideChat || !parentThreadId || thread.archivedAt === null) continue;
      const parentKey = archivedThreadActionKey({ environmentId, threadId: parentThreadId });
      if (!selected.has(parentKey)) continue;
      if (archivedAtById !== null) {
        const parentArchivedAt = archivedAtById.get(parentThreadId);
        if (
          parentArchivedAt == null ||
          DateTime.toEpochMillis(thread.archivedAt) < DateTime.toEpochMillis(parentArchivedAt)
        ) {
          continue;
        }
      }
      let children = sideChats.get(parentKey);
      if (children === undefined) {
        children = [];
        sideChats.set(parentKey, children);
      }
      children.push({ environmentId, threadId: thread.id });
    }
  }
  return sideChats;
}

export async function runArchivedThreadActionWorkers<T extends ArchivedThreadBulkTarget>(
  threads: ReadonlyArray<T>,
  action: (thread: T) => Promise<void>,
  concurrency = DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY,
): Promise<ReadonlyArray<unknown>> {
  const workerCount = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY;
  const selected = new Set(
    threads.map(({ environmentId, id }) =>
      archivedThreadActionKey({ environmentId, threadId: id }),
    ),
  );
  const sideChats: T[] = [];
  const remaining: T[] = [];
  for (const thread of threads) {
    const { environmentId, lineage } = thread;
    const parentThreadId = lineage?.sideChat ? lineage.parentThreadId : null;
    const batch =
      parentThreadId &&
      selected.has(archivedThreadActionKey({ environmentId, threadId: parentThreadId }))
        ? sideChats
        : remaining;
    batch.push(thread);
  }

  const errors: unknown[] = [];
  // The server can restore or delete a side chat with its parent. Run selected side chats first.
  for (const batch of [sideChats, remaining]) {
    if (batch.length === 0) continue;
    let nextIndex = 0;
    async function worker() {
      while (errors.length === 0 && nextIndex < batch.length) {
        const thread = batch[nextIndex++]!;
        try {
          await action(thread);
        } catch (error) {
          errors.push(error);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(workerCount, batch.length) }, worker));
    if (errors.length > 0) break;
  }
  return errors;
}

export function archivedThreadActionKey(threadRef: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId]);
}

export function tryAcquireArchivedThreadActionLock(
  inFlightThreadKeys: Set<string>,
  threadRefs: ReadonlyArray<{ readonly environmentId: string; readonly threadId: string }>,
): ArchivedThreadActionLock | null {
  const keys = [...new Set(threadRefs.map(archivedThreadActionKey))];
  if (keys.some((key) => inFlightThreadKeys.has(key))) {
    return null;
  }
  for (const key of keys) {
    inFlightThreadKeys.add(key);
  }
  return { keys };
}

export function releaseArchivedThreadActionLock(
  inFlightThreadKeys: Set<string>,
  lock: ArchivedThreadActionLock,
): void {
  for (const key of lock.keys) {
    inFlightThreadKeys.delete(key);
  }
}

export function parseArchivedThreadSearchInput(query: string): ArchivedThreadSearchInput {
  const normalizedQuery = normalizeSearchQuery(query);
  return {
    normalizedQuery,
    tokens: normalizedQuery.split(/\s+/u).filter((token) => token.length > 0),
    isSearching: normalizedQuery.length > 0,
  };
}

// Lower search scores are more relevant, matching the shared search-ranking helpers.
export function archivedThreadSearchScore(input: {
  readonly normalizedTitle: string;
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
}): number | null {
  if (input.normalizedQuery.length === 0) {
    return 0;
  }

  if (!input.normalizedTitle) {
    return null;
  }

  const phraseScore = scoreQueryMatch({
    value: input.normalizedTitle,
    query: input.normalizedQuery,
    exactBase: 0,
    prefixBase: 1,
    boundaryBase: 2,
    includesBase: 3,
  });
  if (phraseScore !== null) {
    return Math.min(phraseScore, ARCHIVED_THREAD_PHRASE_SCORE_MAX);
  }

  const distinctTokens = [...new Set(input.tokens)];
  let matchedTokenCount = 0;
  let tokenScore = 0;
  let earliestMatchIndex = Number.POSITIVE_INFINITY;
  for (const token of distinctTokens) {
    const score = scoreQueryMatch({
      value: input.normalizedTitle,
      query: token,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
    });
    if (score === null) {
      continue;
    }

    matchedTokenCount += 1;
    tokenScore += score;
    earliestMatchIndex = Math.min(earliestMatchIndex, input.normalizedTitle.indexOf(token));
  }

  if (matchedTokenCount === 0) {
    return null;
  }

  if (matchedTokenCount === distinctTokens.length) {
    return (
      ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET +
      Math.min(tokenScore, ARCHIVED_THREAD_ALL_TOKENS_SCORE_MAX)
    );
  }

  // Partial matches rank by matched-token count, then by the earliest matched token.
  return (
    ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET +
    (distinctTokens.length - matchedTokenCount) * ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET +
    Math.min(earliestMatchIndex, ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET - 1)
  );
}

export function archivedThreadTimestampValue(
  thread: { readonly archivedAt: string | null; readonly createdAt: string },
  field: ArchivedThreadSortField,
): string {
  return field === "createdAt" ? thread.createdAt : (thread.archivedAt ?? thread.createdAt);
}

export function archivedThreadSortTimestamp(
  thread: { readonly archivedAt: string | null; readonly createdAt: string },
  field: ArchivedThreadSortField,
): number {
  return Date.parse(archivedThreadTimestampValue(thread, field));
}

export function compareArchivedThreads<
  T extends { readonly id: string; readonly archivedAt: string | null; readonly createdAt: string },
>(left: T, right: T, sort: ArchivedThreadSortState): number {
  const leftTimestamp = archivedThreadSortTimestamp(left, sort.field);
  const rightTimestamp = archivedThreadSortTimestamp(right, sort.field);
  const timestampComparison =
    sort.direction === "asc" ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  return timestampComparison || left.id.localeCompare(right.id);
}

export function nextArchivedThreadSortState(
  current: ArchivedThreadSortState,
  field: ArchivedThreadSortField,
): ArchivedThreadSortState {
  if (current.field !== field) {
    return { field, direction: "desc" };
  }
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}

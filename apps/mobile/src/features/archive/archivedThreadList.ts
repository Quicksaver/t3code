import {
  archivedThreadActionKey as sharedArchivedThreadActionKey,
  archivedThreadSearchScore,
  archivedThreadSortTimestamp,
  compareArchivedThreads,
  runArchivedThreadActionWorkers,
  type ArchivedThreadBulkTarget,
  type ArchivedThreadSearchInput,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";
export {
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";

import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchScore: number;
}

export interface ArchivedThreadActionSummary {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

export class ArchivedThreadActionError extends AggregateError {
  readonly summary: ArchivedThreadActionSummary;
  readonly totalCount: number;

  constructor(errors: Iterable<unknown>, summary: ArchivedThreadActionSummary, totalCount: number) {
    super(errors, "Archived thread action failed");
    this.name = "ArchivedThreadActionError";
    this.summary = summary;
    this.totalCount = totalCount;
  }
}

export type ArchivedThreadActionResult = "succeeded" | "failed" | "skipped";

export function archivedThreadActionKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): string {
  return sharedArchivedThreadActionKey({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
}

export function archivedThreadActionSummaryDescription(
  summary: ArchivedThreadActionSummary,
  failureMessages: ReadonlyArray<string> = [],
): string {
  const outcome = describeArchiveOutcome(summary);
  const distinctMessages = [...new Set(failureMessages)];
  if (distinctMessages.length === 0) return outcome;
  return `${outcome} ${describeArchiveFailures(distinctMessages)}`;
}

export function archivedThreadActionExceptionDescription(
  error: unknown,
  commandFailureMessages: ReadonlyArray<string> = [],
): string {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const failureMessages = [
    ...new Set([
      ...errors.map(
        (entry) =>
          (entry instanceof Error ? errorDisplayMessage(entry, m) : null) ??
          m(msg("An error occurred.")),
      ),
      ...commandFailureMessages,
    ]),
  ];
  const outcome =
    error instanceof ArchivedThreadActionError
      ? (() => {
          const notAttemptedCount = Math.max(
            0,
            error.totalCount -
              error.summary.succeeded -
              error.summary.failed -
              error.summary.skipped -
              error.errors.length,
          );
          return m(
            msg(
              "Partial outcome: {succeeded} succeeded, {failed, plural, =0 {} other {{failed} failed, }}{skipped, plural, =0 {} other {{skipped} skipped because already in progress, }}{unexpected} failed unexpectedly, {notAttempted} not attempted.",
            ),
            { ...error.summary, unexpected: error.errors.length, notAttempted: notAttemptedCount },
          );
        })()
      : m(msg("One or more archived thread actions failed unexpectedly."));
  return `${outcome} ${describeArchiveFailures(failureMessages)}`;
}

function describeArchiveOutcome(summary: ArchivedThreadActionSummary): string {
  const { succeeded, failed, skipped } = summary;
  if (failed > 0 && skipped > 0) {
    return m(
      msg(
        "{succeeded} succeeded, {failed} failed, and {skipped} skipped because already in progress.",
      ),
      { succeeded, failed, skipped },
    );
  }
  if (failed > 0) {
    return m(msg("{succeeded} succeeded and {failed} failed."), { succeeded, failed });
  }
  if (skipped > 0) {
    return m(msg("{succeeded} succeeded and {skipped} skipped because already in progress."), {
      succeeded,
      skipped,
    });
  }
  return m(msg("{succeeded} succeeded."), { succeeded });
}

function describeArchiveFailures(failures: ReadonlyArray<string>): string {
  if (failures.length <= 1) return failures[0] ?? m(msg("An error occurred."));
  const shown = failures.slice(0, 3);
  const remaining = failures.length - shown.length;
  const messages = shown.join("; ");
  return remaining === 0
    ? m(msg("Failures: {messages}"), { messages })
    : m(msg("Failures: {messages}; {count} more"), { messages, count: remaining });
}

function archivedProjectGroupKey(environmentId: EnvironmentId, projectId: string): string {
  return JSON.stringify([environmentId, projectId]);
}

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly environmentId: EnvironmentId | null;
  readonly search: ArchivedThreadSearchInput;
  readonly sort: ArchivedThreadSortState;
}): ReadonlyArray<ArchivedThreadGroup> {
  const groups: ArchivedThreadGroup[] = [];

  for (const entry of input.snapshots) {
    if (input.environmentId !== null && input.environmentId !== entry.environmentId) continue;

    const threadsByProjectId = new Map<
      string,
      Array<{ readonly thread: EnvironmentThreadShell; readonly searchScore: number }>
    >();
    for (const rawThread of entry.snapshot.threads) {
      if (rawThread.archivedAt === null) continue;
      const searchScore = archivedThreadSearchScore({
        normalizedTitle: normalizeSearchQuery(rawThread.title),
        normalizedQuery: input.search.normalizedQuery,
        tokens: input.search.tokens,
      });
      if (searchScore === null) continue;
      const threads = threadsByProjectId.get(rawThread.projectId) ?? [];
      threads.push({ thread: scopeThreadShell(entry.environmentId, rawThread), searchScore });
      threadsByProjectId.set(rawThread.projectId, threads);
    }

    for (const rawProject of entry.snapshot.projects) {
      const project = scopeProject(entry.environmentId, rawProject);
      const projectThreads = threadsByProjectId.get(project.id);
      if (!projectThreads || projectThreads.length === 0) continue;
      const searchScore = projectThreads.reduce(
        (minimum, entry) => Math.min(minimum, entry.searchScore),
        Number.POSITIVE_INFINITY,
      );
      groups.push({
        key: archivedProjectGroupKey(project.environmentId, project.id),
        project,
        threads: projectThreads
          .sort((left, right) =>
            input.search.isSearching
              ? left.searchScore - right.searchScore ||
                compareArchivedThreads(left.thread, right.thread, input.sort)
              : compareArchivedThreads(left.thread, right.thread, input.sort),
          )
          .map((entry) => entry.thread),
        searchScore,
      });
    }
  }

  if (input.search.isSearching) {
    return groups.sort(
      (left, right) =>
        left.searchScore - right.searchScore ||
        left.project.title.localeCompare(right.project.title),
    );
  }

  return Arr.sort(
    groups,
    Order.mapInput(
      Order.Struct({
        timestamp: input.sort.direction === "asc" ? Order.Number : Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (group: ArchivedThreadGroup) => {
        let timestamp = archivedThreadSortTimestamp(group.threads[0]!, input.sort.field);
        for (let index = 1; index < group.threads.length; index += 1) {
          const candidate = archivedThreadSortTimestamp(group.threads[index]!, input.sort.field);
          timestamp =
            input.sort.direction === "asc"
              ? Math.min(timestamp, candidate)
              : Math.max(timestamp, candidate);
        }
        return {
          timestamp,
          title: group.project.title,
          key: group.key,
        };
      },
    ),
  );
}

export async function runArchivedThreadActions<T extends ArchivedThreadBulkTarget>(
  items: ReadonlyArray<T>,
  action: (item: T) => Promise<ArchivedThreadActionResult>,
  options: { readonly concurrency?: number } = {},
): Promise<ArchivedThreadActionSummary> {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const thrownErrors = await runArchivedThreadActionWorkers(
    items,
    async (item) => {
      const result = await action(item);
      if (result === "succeeded") succeeded += 1;
      else if (result === "failed") failed += 1;
      else skipped += 1;
    },
    options.concurrency,
  );
  if (thrownErrors.length > 0) {
    throw new ArchivedThreadActionError(thrownErrors, { succeeded, failed, skipped }, items.length);
  }
  return { succeeded, failed, skipped };
}

import {
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  activeThreadAnchorTimestampMs,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  buildVisibleThreadLineage,
  rebaseThreadDepthsToVisibleAncestors,
  threadShellKey,
} from "../../lib/threadLineage";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export { snoozeWakeLabel };

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + Sidebar.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "input" | "working" | "failed" | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  /** Row is on the snoozed shelf. */
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

/**
 * The point at which a queued-turn snooze guard expires on its own. Rows arm
 * a one-shot timer for this boundary so Snooze appears without waiting for an
 * unrelated render. User-blocked threads return null because only fresh
 * server data can make them snoozable.
 */
export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/**
 * The flat Thread List v2 is the default on every app variant; the Settings →
 * Legacy toggle opts a device back into the grouped legacy list. Preferences
 * persist as sparse patches, so `undefined` genuinely means "never chosen".
 *
 * `preferencesLoaded` guards the startup window: preferences load
 * asynchronously, and rendering one list before the stored choice arrives would
 * remount the whole thing a tick later. While loading, hold the default — that
 * is where every device without an explicit legacy opt-in lands anyway.
 */
export function resolveThreadListV2Enabled(input: {
  readonly legacyPreference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) {
    return true;
  }
  return input.legacyPreference !== true;
}

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

export function canUseThreadListV2LifecycleActions(
  thread: Pick<EnvironmentThreadShell, "parentRelation">,
): boolean {
  return thread.parentRelation?.kind !== "subagent";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * v2 sort: static order, newest anchor on top. Activity NEVER reorders the
 * list — a row holds its position between lifecycle transitions. The anchor
 * is creation time until an un-settle re-anchors it (see
 * activeThreadAnchorTimestampMs), so an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Mirrors web's
 * sortThreadsForSidebar.
 */
export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Mobile lineage depth after contextual visibility/search rebasing. */
  readonly depth: number;
  /** Recursive subagent total for this conversation in the current list scope. */
  readonly descendantCount: number;
  /** Whether this conversation's direct children are currently disclosed. */
  readonly descendantsExpanded: boolean;
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  /** Pinned-block row: renders the pin glyph and offers Unpin. */
  readonly pinned: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Snoozed threads matching the current filters. */
  readonly snoozedCount: number;
  /** Index in `items` where the Snoozed shelf header belongs. The header is
      still rendered when the shelf is collapsed and no snoozed rows exist. */
  readonly snoozedShelfHeaderIndex: number | null;
  /** Total settled threads in scope, including rows hidden by collapse/paging. */
  readonly settledCount: number;
  /** Index in `items` where the Settled shelf header belongs. */
  readonly settledShelfHeaderIndex: number | null;
  /** Soonest wake time among snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** Precomputed so recycled-list equality can see a minute-tick change. */
  readonly snoozeWakeLabelText: string | undefined;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First queued row after the active block draws the PENDING divider. */
  readonly showPendingDivider: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

/**
 * Builds the shared mobile order: active → pending → snoozed shelf → settled.
 * Pending tasks are waiting rather than asking, and parked work remains
 * reachable without competing with either the inbox or settled history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
}): ThreadListV2ListItem[] {
  const threadItems = input.items.map((item): ThreadListV2ListItem => ({
    type: "v2-thread",
    key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
    item,
    snoozeWakeLabelText:
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined,
  }));
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-pending:${pendingTask.message.messageId}`,
    pendingTask,
    showPendingDivider: index === 0,
  }));
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const activeEnd = snoozedShelfHeaderIndex ?? settledShelfHeaderIndex ?? threadItems.length;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const result: ThreadListV2ListItem[] = [...threadItems.slice(0, activeEnd), ...pendingItems];
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  return result;
}

/**
 * Partitions visible threads into the active card block (creation order) and
 * the settled recency tail, matching the web v2 list.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  /** Selected child route whose terminal lineage must remain visible. */
  readonly activeThreadKey?: string | null;
  /** Conversations whose direct subagent children should be disclosed. Each
      nested generation requires its own explicit expansion. */
  readonly expandedThreadKeys?: ReadonlySet<string>;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  /** Environments whose server supports thread.settle/unsettle. Threads on
      other environments never classify as settled — the user could neither
      un-settle nor pin them. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Same
      contract as settlementEnvironmentIds. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /**
   * Settled-row budget. Lineage groups stay atomic, so the newest group can
   * exceed the budget and the selected settled group is always retained.
   */
  readonly settledLimit?: number;
  /** Second-precise clock used for time-based classification. */
  readonly now: string;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly snoozedShelfExpanded?: boolean;
  /** Expands the settled shelf into rows. Expanded is the default. */
  readonly settledShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
}): ThreadListV2Layout {
  const now = input.now;
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const scopedThreads: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    // Callers pass live shells. The server stamps settledOverride for the tail.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (
      query.length > 0 &&
      !thread.title.toLocaleLowerCase().includes(query) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    ) {
      continue;
    }
    scopedThreads.push(thread);
  }

  const matchingThreadKeys = query.length === 0 ? null : new Set(scopedThreads.map(threadShellKey));
  const lineage = buildVisibleThreadLineage({
    threads: scopedThreads,
    activeThreadKey: input.activeThreadKey,
    // Search can navigate to a matching terminal child. Outside search, only
    // running subagents and the exact active child belong in the sidebar.
    additionalVisibleThreadKeys: matchingThreadKeys ?? undefined,
    sortRootThreads: sortThreadsForListV2,
  });
  const searchedThreads =
    query.length === 0
      ? lineage.threads
      : lineage.threads.filter(
          (thread) => matchingThreadKeys?.has(threadShellKey(thread)) === true,
        );
  const threadDepths =
    query.length === 0
      ? lineage.threadDepths
      : rebaseThreadDepthsToVisibleAncestors(searchedThreads);
  const activePathKeys = threadListV2ActivePathKeys(scopedThreads, input.activeThreadKey);
  const expandedThreadKeys = input.expandedThreadKeys ?? new Set<string>();
  const visibleThreads =
    query.length > 0
      ? searchedThreads
      : filterThreadListV2ExpandedLineage({
          threads: searchedThreads,
          threadDepths,
          expandedThreadKeys,
          activePathKeys,
        });
  const visibleThreadKeys = new Set(visibleThreads.map(threadShellKey));

  const snoozedByThreadKey = new Map<string, boolean>();
  const pinnedByThreadKey = new Map<string, boolean>();
  const settledByThreadKey = new Map<string, boolean>();
  let snoozedCount = 0;
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of searchedThreads) {
    const key = threadShellKey(thread);
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    const snoozed = supportsSnooze && effectiveSnoozed(thread, { now });
    snoozedByThreadKey.set(key, snoozed);
    pinnedByThreadKey.set(key, !snoozed && thread.pinnedAt != null);
    if (
      snoozed &&
      thread.snoozedUntil != null &&
      (nextSnoozeWakeAt === null ||
        parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
    ) {
      nextSnoozeWakeAt = thread.snoozedUntil;
    }
    if (snoozed) snoozedCount += 1;
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    settledByThreadKey.set(key, supportsSettlement && thread.settledOverride === "settled");
  }

  // Partition whole visible lineage groups. Classifying flattened rows
  // independently can move an auto-settled parent away from its running
  // child, while slicing the settled tail can hide part of a selected path.
  type LineageGroup = [EnvironmentThreadShell, ...EnvironmentThreadShell[]];
  const lineageGroups: LineageGroup[] = [];
  for (const thread of searchedThreads) {
    const depth = threadDepths.get(threadShellKey(thread)) ?? 0;
    const currentGroup = lineageGroups.at(-1);
    if (depth === 0 || currentGroup === undefined) {
      lineageGroups.push([thread]);
    } else {
      currentGroup.push(thread);
    }
  }
  const activeGroups: LineageGroup[] = [];
  const pinnedGroups: LineageGroup[] = [];
  const snoozedGroups: LineageGroup[] = [];
  const settledGroups: LineageGroup[] = [];
  for (const group of lineageGroups) {
    // Snooze is per thread. Shelve a snoozed thread together with its own
    // descendants, but leave an unsnoozed ancestor and sibling subtrees in
    // their ordinary lifecycle partition. A snoozed root naturally captures
    // the entire lineage without allowing its children to be promoted.
    const remainingGroup: EnvironmentThreadShell[] = [];
    let currentSnoozedGroup: LineageGroup | null = null;
    let currentSnoozedDepth = Number.POSITIVE_INFINITY;
    for (const thread of group) {
      const key = threadShellKey(thread);
      const depth = threadDepths.get(key) ?? 0;
      if (currentSnoozedGroup !== null && depth > currentSnoozedDepth) {
        currentSnoozedGroup.push(thread);
        continue;
      }
      currentSnoozedGroup = null;
      if (snoozedByThreadKey.get(key) === true) {
        currentSnoozedGroup = [thread];
        currentSnoozedDepth = depth;
        snoozedGroups.push(currentSnoozedGroup);
      } else {
        remainingGroup.push(thread);
      }
    }
    if (remainingGroup.length === 0) continue;
    const remainingLineageGroup = remainingGroup as LineageGroup;
    const containsRunningSubagent = remainingLineageGroup.some(
      (thread) =>
        thread.parentRelation?.kind === "subagent" && thread.parentRelation.status === "running",
    );
    const everyThreadSettled = remainingLineageGroup.every(
      (thread) => settledByThreadKey.get(threadShellKey(thread)) === true,
    );
    const containsPinnedThread = remainingLineageGroup.some(
      (thread) => pinnedByThreadKey.get(threadShellKey(thread)) === true,
    );
    // Selection affects lineage visibility, not lifecycle classification.
    // Running descendants override settlement unless that running subtree is
    // itself snoozed, in which case it has already moved to the shelf above.
    if (everyThreadSettled) {
      settledGroups.push(remainingLineageGroup);
    } else if (containsPinnedThread) {
      pinnedGroups.push(remainingLineageGroup);
    } else if (containsRunningSubagent) {
      activeGroups.push(remainingLineageGroup);
    } else {
      activeGroups.push(remainingLineageGroup);
    }
  }
  const runningSubagentThreadKeys = new Set(
    scopedThreads
      .filter(
        (thread) =>
          thread.parentRelation?.kind === "subagent" &&
          (thread.parentRelation.status === "running" || thread.session?.status === "running"),
      )
      .map(threadShellKey),
  );
  const descendantCountByThreadKey = threadListV2DescendantCounts(
    scopedThreads,
    runningSubagentThreadKeys,
  );

  // Lineage traversal already sorts active roots by creation. Re-sorting the
  // flattened rows would promote children to root positions. Settled groups
  // retain their internal lineage order while sorting by root recency.
  const orderedActive = activeGroups.flat();
  const pinnedGroupByRepresentativeKey = new Map<string, LineageGroup>();
  const pinnedGroupRepresentatives = pinnedGroups.map((group) => {
    const representative =
      group.find((thread) => pinnedByThreadKey.get(threadShellKey(thread)) === true) ?? group[0];
    pinnedGroupByRepresentativeKey.set(threadShellKey(representative), group);
    return representative;
  });
  const orderedPinned = sortPinnedThreadsByOrderKey(pinnedGroupRepresentatives).flatMap(
    (representative) => pinnedGroupByRepresentativeKey.get(threadShellKey(representative)) ?? [],
  );
  const orderedSnoozedGroups = snoozedGroups
    .map((group) => ({
      group,
      wakeAtMs: group.reduce(
        (earliest, thread) =>
          snoozedByThreadKey.get(threadShellKey(thread)) === true && thread.snoozedUntil != null
            ? Math.min(earliest, parseTimestampMs(thread.snoozedUntil))
            : earliest,
        Number.POSITIVE_INFINITY,
      ),
    }))
    .sort((left, right) => left.wakeAtMs - right.wakeAtMs)
    .map(({ group }) => group);
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleSnoozedGroups =
    input.snoozedShelfExpanded === true
      ? orderedSnoozedGroups
      : orderedSnoozedGroups.filter((group) =>
          group.some((thread) => threadShellKey(thread) === selectedThreadKey),
        );
  const orderedSettledGroups = [...settledGroups].sort(
    (left, right) =>
      parseTimestampMs(resolveSettledThreadTimestamp(right[0]) ?? "") -
      parseTimestampMs(resolveSettledThreadTimestamp(left[0]) ?? ""),
  );
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const pagedSettledGroups = new Set<LineageGroup>();
  let pagedSettledCount = 0;
  if (settledLimit > 0) {
    for (const group of orderedSettledGroups) {
      if (pagedSettledCount > 0 && pagedSettledCount + group.length > settledLimit) break;
      pagedSettledGroups.add(group);
      pagedSettledCount += group.length;
    }
  }
  const retainedSettledThreadKey = input.activeThreadKey ?? selectedThreadKey;
  if (retainedSettledThreadKey != null) {
    const selectedGroup = orderedSettledGroups.find((group) =>
      group.some((thread) => threadShellKey(thread) === retainedSettledThreadKey),
    );
    if (selectedGroup) {
      pagedSettledGroups.add(selectedGroup);
    }
  }
  const orderedSettled = orderedSettledGroups.flat();
  const pagedSettled = orderedSettledGroups.filter((group) => pagedSettledGroups.has(group)).flat();
  const visibleSettledGroups =
    input.settledShelfExpanded !== false
      ? orderedSettledGroups.filter((group) => pagedSettledGroups.has(group))
      : orderedSettledGroups.filter(
          (group) =>
            pagedSettledGroups.has(group) &&
            group.some((thread) => threadShellKey(thread) === retainedSettledThreadKey),
        );
  const visibleSettled = visibleSettledGroups.flat();

  const items: ThreadListV2Item[] = [];
  for (const thread of orderedPinned) {
    const key = threadShellKey(thread);
    if (!visibleThreadKeys.has(key)) continue;
    items.push({
      thread,
      variant: "card",
      depth: threadDepths.get(key) ?? 0,
      descendantCount: descendantCountByThreadKey.get(key) ?? 0,
      descendantsExpanded: expandedThreadKeys.has(key),
      snoozed: false,
      pinned: pinnedByThreadKey.get(key) === true,
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    const key = threadShellKey(thread);
    if (!visibleThreadKeys.has(key)) continue;
    items.push({
      thread,
      variant: "card",
      depth: threadDepths.get(key) ?? 0,
      descendantCount: descendantCountByThreadKey.get(key) ?? 0,
      descendantsExpanded: expandedThreadKeys.has(key),
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozedGroups.length > 0 ? items.length : null;
  for (const group of visibleSnoozedGroups) {
    const rootDepth = threadDepths.get(threadShellKey(group[0])) ?? 0;
    const selectedPathKeys = threadListV2ActivePathKeys(group, selectedThreadKey);
    const visibleSnoozedKeys = new Set<string>();
    for (const thread of group) {
      const key = threadShellKey(thread);
      const depth = Math.max(0, (threadDepths.get(key) ?? rootDepth) - rootDepth);
      const parentKey = threadListV2ParentKey(thread);
      const visible =
        query.length > 0 ||
        depth === 0 ||
        selectedPathKeys.has(key) ||
        (parentKey !== null &&
          visibleSnoozedKeys.has(parentKey) &&
          expandedThreadKeys.has(parentKey));
      if (!visible) continue;
      visibleSnoozedKeys.add(key);
      items.push({
        thread,
        variant: "slim",
        depth,
        descendantCount: descendantCountByThreadKey.get(key) ?? 0,
        descendantsExpanded: expandedThreadKeys.has(key),
        snoozed: snoozedByThreadKey.get(key) === true,
        pinned: pinnedByThreadKey.get(key) === true,
        isLast: false,
      });
    }
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    const key = threadShellKey(thread);
    if (!visibleThreadKeys.has(key)) continue;
    items.push({
      thread,
      variant: "slim",
      depth: threadDepths.get(key) ?? 0,
      descendantCount: descendantCountByThreadKey.get(key) ?? 0,
      descendantsExpanded: expandedThreadKeys.has(key),
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    snoozedCount,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}

function threadListV2ParentKey(thread: EnvironmentThreadShell): string | null {
  const relation = thread.parentRelation;
  return relation?.kind === "subagent"
    ? `${thread.environmentId}:${relation.parentThreadId}`
    : null;
}

export function threadListV2DescendantCounts(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  countedThreadKeys?: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const threadKeys = new Set(threads.map(threadShellKey));
  const childrenByParentKey = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const parentKey = threadListV2ParentKey(thread);
    if (!parentKey || !threadKeys.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentKey.set(parentKey, [thread]);
    }
  }

  const counts = new Map<string, number>();
  for (const thread of threads) {
    const rootKey = threadShellKey(thread);
    const visited = new Set<string>([rootKey]);
    const pending = [...(childrenByParentKey.get(rootKey) ?? [])];
    let count = 0;
    while (pending.length > 0) {
      const descendant = pending.pop();
      if (!descendant) continue;
      const descendantKey = threadShellKey(descendant);
      if (visited.has(descendantKey)) continue;
      visited.add(descendantKey);
      if (!countedThreadKeys || countedThreadKeys.has(descendantKey)) {
        count += 1;
      }
      pending.push(...(childrenByParentKey.get(descendantKey) ?? []));
    }
    if (count > 0) counts.set(rootKey, count);
  }
  return counts;
}

function threadListV2ActivePathKeys(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  activeThreadKey: string | null | undefined,
): ReadonlySet<string> {
  const path = new Set<string>();
  if (!activeThreadKey) return path;
  const threadByKey = new Map(threads.map((thread) => [threadShellKey(thread), thread] as const));
  let current = threadByKey.get(activeThreadKey) ?? null;
  while (current) {
    const key = threadShellKey(current);
    if (path.has(key)) break;
    path.add(key);
    const parentKey = threadListV2ParentKey(current);
    current = parentKey ? (threadByKey.get(parentKey) ?? null) : null;
  }
  return path;
}

function filterThreadListV2ExpandedLineage(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadDepths: ReadonlyMap<string, number>;
  readonly expandedThreadKeys: ReadonlySet<string>;
  readonly activePathKeys: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const visibleKeys = new Set<string>();
  const result: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    const key = threadShellKey(thread);
    const depth = input.threadDepths.get(key) ?? 0;
    const parentKey = threadListV2ParentKey(thread);
    const visible =
      depth === 0 ||
      input.activePathKeys.has(key) ||
      (parentKey !== null && visibleKeys.has(parentKey) && input.expandedThreadKeys.has(parentKey));
    if (!visible) continue;
    visibleKeys.add(key);
    result.push(thread);
  }
  return result;
}

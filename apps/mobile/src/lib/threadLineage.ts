import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedThreadKey } from "./scopedEntities";

export interface ThreadLineageNavigationResult {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadDepths: ReadonlyMap<string, number>;
}

export function threadShellKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): string {
  return scopedThreadKey(thread.environmentId, thread.id);
}

export function includeThreadShellIfMissing(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  thread: EnvironmentThreadShell | null,
): ReadonlyArray<EnvironmentThreadShell> {
  if (thread === null) {
    return threads;
  }
  const selectedKey = threadShellKey(thread);
  if (threads.some((candidate) => threadShellKey(candidate) === selectedKey)) {
    return threads;
  }
  return [...threads, thread];
}

/**
 * Selects the default Home subset without orphaning selected subagent children.
 *
 * `visibleThreads` is the source of truth for both output membership and output
 * order. `getFallbackThreads` is called only when no recent threads qualify,
 * and its returned threads should normally come from `visibleThreads`; fallback
 * or forced keys that are not in `visibleThreads` can keep no row visible by
 * themselves. `alwaysIncludeThreadKey` is a canonical `threadShellKey` string,
 * typically the active child route, and is additive to the fallback set so an
 * otherwise quiet project still shows recent context plus the active child.
 */
export function selectRecentThreadLineage(input: {
  readonly visibleThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly isRecentThread: (thread: EnvironmentThreadShell) => boolean;
  readonly getFallbackThreads: () => ReadonlyArray<EnvironmentThreadShell>;
  readonly alwaysIncludeThreadKey?: string | null;
}): ReadonlyArray<EnvironmentThreadShell> {
  const selectedKeys = new Set<string>();

  for (const thread of input.visibleThreads) {
    if (input.isRecentThread(thread)) {
      selectedKeys.add(threadShellKey(thread));
    }
  }
  if (selectedKeys.size === 0) {
    for (const thread of input.getFallbackThreads()) {
      selectedKeys.add(threadShellKey(thread));
    }
  }
  if (input.alwaysIncludeThreadKey) {
    selectedKeys.add(input.alwaysIncludeThreadKey);
  }

  const byKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.visibleThreads) {
    byKey.set(threadShellKey(thread), thread);
  }

  const keysToVisit = Array.from(selectedKeys);
  const visitedKeys = new Set<string>();
  for (let index = 0; index < keysToVisit.length; index += 1) {
    const key = keysToVisit[index];
    if (visitedKeys.has(key)) {
      continue;
    }
    visitedKeys.add(key);
    const thread = byKey.get(key) ?? null;
    if (thread === null) {
      continue;
    }
    const parentKey = subagentParentKey(thread);
    if (!parentKey || selectedKeys.has(parentKey)) {
      continue;
    }
    const parent = byKey.get(parentKey) ?? null;
    if (parent !== null) {
      selectedKeys.add(parentKey);
      keysToVisit.push(parentKey);
    }
  }

  return input.visibleThreads.filter((thread) => selectedKeys.has(threadShellKey(thread)));
}

function subagentParentKey(thread: EnvironmentThreadShell): string | null {
  const relation = thread.parentRelation;
  return relation?.kind === "subagent"
    ? scopedThreadKey(thread.environmentId, relation.parentThreadId)
    : null;
}

function isTerminalSubagent(thread: EnvironmentThreadShell): boolean {
  const relation = thread.parentRelation;
  return relation?.kind === "subagent" && relation.status !== "running";
}

function visibleNavigationThreadKeys(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  activeThreadKey: string | null | undefined,
  additionalVisibleThreadKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    threads
      .filter((thread) => {
        const key = threadShellKey(thread);
        return (
          !isTerminalSubagent(thread) ||
          key === activeThreadKey ||
          additionalVisibleThreadKeys.has(key)
        );
      })
      .map(threadShellKey),
  );
}

function compareSubagentChildren(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
): number {
  const leftRelation = left.parentRelation?.kind === "subagent" ? left.parentRelation : null;
  const rightRelation = right.parentRelation?.kind === "subagent" ? right.parentRelation : null;
  const sequence =
    (leftRelation?.parentActivitySequence ?? 0) - (rightRelation?.parentActivitySequence ?? 0);
  if (sequence !== 0) {
    return sequence;
  }
  const startedAt = (leftRelation?.startedAt ?? left.createdAt).localeCompare(
    rightRelation?.startedAt ?? right.createdAt,
  );
  if (startedAt !== 0) {
    return startedAt;
  }
  return threadShellKey(left).localeCompare(threadShellKey(right));
}

export function buildVisibleThreadLineage(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeThreadKey?: string | null;
  /** Terminal rows that should remain visible without retaining their ancestors. */
  readonly additionalVisibleThreadKeys?: ReadonlySet<string>;
  readonly sortRootThreads: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
  ) => ReadonlyArray<EnvironmentThreadShell>;
}): ThreadLineageNavigationResult {
  const visibleThreadKeys = visibleNavigationThreadKeys(
    input.threads,
    input.activeThreadKey,
    input.additionalVisibleThreadKeys ?? new Set(),
  );
  const allThreadKeys = new Set(input.threads.map(threadShellKey));
  const childrenByParentKey = new Map<string, EnvironmentThreadShell[]>();
  const roots: EnvironmentThreadShell[] = [];

  for (const thread of input.threads) {
    const parentKey = subagentParentKey(thread);
    if (!parentKey || !allThreadKeys.has(parentKey)) {
      roots.push(thread);
      continue;
    }
    const children = childrenByParentKey.get(parentKey);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentKey.set(parentKey, [thread]);
    }
  }

  for (const children of childrenByParentKey.values()) {
    children.sort(compareSubagentChildren);
  }

  const orderedThreads: EnvironmentThreadShell[] = [];
  const threadDepths = new Map<string, number>();
  const visited = new Set<string>();
  const visit = (thread: EnvironmentThreadShell, depth: number) => {
    const key = threadShellKey(thread);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    if (visibleThreadKeys.has(key)) {
      orderedThreads.push(thread);
      threadDepths.set(key, depth);
    }
    for (const child of childrenByParentKey.get(key) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of input.sortRootThreads(roots)) {
    visit(root, 0);
  }

  return { threads: orderedThreads, threadDepths };
}

export function rebaseThreadDepthsToVisibleAncestors(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, number> {
  const visibleKeys = new Set(threads.map(threadShellKey));
  const rebasedDepths = new Map<string, number>();

  for (const thread of threads) {
    const key = threadShellKey(thread);
    const parentKey = subagentParentKey(thread);
    const parentDepth =
      parentKey && visibleKeys.has(parentKey) ? (rebasedDepths.get(parentKey) ?? 0) : -1;
    rebasedDepths.set(key, parentDepth + 1);
  }

  return rebasedDepths;
}

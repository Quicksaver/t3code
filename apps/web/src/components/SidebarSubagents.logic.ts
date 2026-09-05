import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "../types";

export interface RenderedSidebarThread {
  thread: SidebarThreadSummary;
  depth: number;
}

export function sidebarThreadKey(
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function sidebarThreadParentKey(thread: SidebarThreadSummary): string | null {
  const relation = thread.parentRelation;
  if (relation?.kind !== "subagent") {
    return null;
  }
  return scopedThreadKey(scopeThreadRef(thread.environmentId, relation.parentThreadId));
}

function compareSubagentSidebarChildren(
  left: SidebarThreadSummary,
  right: SidebarThreadSummary,
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
  return sidebarThreadKey(left).localeCompare(sidebarThreadKey(right));
}

function subagentSidebarStatus(thread: SidebarThreadSummary) {
  const relation = thread.parentRelation;
  return relation?.kind === "subagent" ? relation.status : null;
}

function subagentIsRunningInSidebar(thread: SidebarThreadSummary): boolean {
  return subagentSidebarStatus(thread) === "running" || thread.session?.status === "running";
}

export function activeSidebarThreadAncestorKeys(
  threads: readonly SidebarThreadSummary[],
  activeThreadKey: string | null | undefined,
): Set<string> {
  const ancestors = new Set<string>();
  if (!activeThreadKey) {
    return ancestors;
  }
  const threadByKey = new Map(threads.map((thread) => [sidebarThreadKey(thread), thread] as const));
  const activeThread = threadByKey.get(activeThreadKey) ?? null;
  const activeParentKey = activeThread ? sidebarThreadParentKey(activeThread) : null;
  let current = activeParentKey ? (threadByKey.get(activeParentKey) ?? null) : null;
  while (current) {
    const key = sidebarThreadKey(current);
    if (ancestors.has(key)) {
      break;
    }
    ancestors.add(key);
    const parentKey = sidebarThreadParentKey(current);
    current = parentKey ? (threadByKey.get(parentKey) ?? null) : null;
  }
  return ancestors;
}

export function visibleSidebarThreads(
  threads: readonly SidebarThreadSummary[],
  activeThreadKey: string | null | undefined,
): SidebarThreadSummary[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (thread.parentRelation?.kind !== "subagent" ||
        subagentIsRunningInSidebar(thread) ||
        sidebarThreadKey(thread) === activeThreadKey),
  );
}

export function flattenSidebarThreadTree(input: {
  allThreads: readonly SidebarThreadSummary[];
  roots: readonly SidebarThreadSummary[];
  visibleThreadKeys?: ReadonlySet<string>;
}): RenderedSidebarThread[] {
  const allThreadKeys = new Set(input.allThreads.map(sidebarThreadKey));
  const childrenByParentKey = new Map<string, SidebarThreadSummary[]>();
  for (const thread of input.allThreads) {
    const parentKey = sidebarThreadParentKey(thread);
    if (!parentKey || !allThreadKeys.has(parentKey)) {
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
    children.sort(compareSubagentSidebarChildren);
  }

  const result: RenderedSidebarThread[] = [];
  const visited = new Set<string>();
  const visit = (thread: SidebarThreadSummary, depth: number) => {
    const key = sidebarThreadKey(thread);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    if (!input.visibleThreadKeys || input.visibleThreadKeys.has(key)) {
      result.push({ thread, depth });
    }
    for (const child of childrenByParentKey.get(key) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of input.roots) {
    visit(root, 0);
  }
  return result;
}

export function sidebarSubagentDescendantCounts(input: {
  allThreads: readonly SidebarThreadSummary[];
  visibleThreadKeys?: ReadonlySet<string>;
}): ReadonlyMap<string, number> {
  const allThreadKeys = new Set(input.allThreads.map(sidebarThreadKey));
  const childrenByParentKey = new Map<string, SidebarThreadSummary[]>();
  for (const thread of input.allThreads) {
    const parentKey = sidebarThreadParentKey(thread);
    if (!parentKey || !allThreadKeys.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentKey.set(parentKey, [thread]);
    }
  }

  const result = new Map<string, number>();
  for (const thread of input.allThreads) {
    const rootKey = sidebarThreadKey(thread);
    const visited = new Set<string>([rootKey]);
    const pending = [...(childrenByParentKey.get(rootKey) ?? [])];
    let count = 0;
    while (pending.length > 0) {
      const descendant = pending.pop();
      if (!descendant) continue;
      const descendantKey = sidebarThreadKey(descendant);
      if (visited.has(descendantKey)) continue;
      visited.add(descendantKey);
      if (!input.visibleThreadKeys || input.visibleThreadKeys.has(descendantKey)) {
        count += 1;
      }
      pending.push(...(childrenByParentKey.get(descendantKey) ?? []));
    }
    if (count > 0) result.set(rootKey, count);
  }
  return result;
}

/**
 * Provider-native agents are not guaranteed to have standalone child thread
 * shells. Prefer whichever source sees more live agents without double
 * counting agents represented by both sources.
 */
export function resolveSidebarSubagentCount(input: {
  readonly descendantCount: number;
  readonly activeSubagentCount?: number | undefined;
}): number {
  return Math.max(input.descendantCount, input.activeSubagentCount ?? 0);
}

export function flattenExpandedSidebarThreadTree(input: {
  allThreads: readonly SidebarThreadSummary[];
  roots: readonly SidebarThreadSummary[];
  expandedThreadKeys: ReadonlySet<string>;
  /** Structural ancestors that should be traversed so the exact active
      descendant remains visible without exposing hidden terminal ancestors. */
  alwaysExpandedThreadKeys?: ReadonlySet<string>;
  visibleThreadKeys?: ReadonlySet<string>;
}): RenderedSidebarThread[] {
  const allThreadKeys = new Set(input.allThreads.map(sidebarThreadKey));
  const childrenByParentKey = new Map<string, SidebarThreadSummary[]>();
  for (const thread of input.allThreads) {
    const parentKey = sidebarThreadParentKey(thread);
    if (!parentKey || !allThreadKeys.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentKey.set(parentKey, [thread]);
    }
  }
  for (const children of childrenByParentKey.values()) {
    children.sort(compareSubagentSidebarChildren);
  }

  const result: RenderedSidebarThread[] = [];
  const visited = new Set<string>();
  const visit = (thread: SidebarThreadSummary, depth: number) => {
    const key = sidebarThreadKey(thread);
    if (visited.has(key)) return;
    visited.add(key);
    const isVisible = !input.visibleThreadKeys || input.visibleThreadKeys.has(key);
    if (isVisible) result.push({ thread, depth });

    if (
      isVisible &&
      !input.expandedThreadKeys.has(key) &&
      !input.alwaysExpandedThreadKeys?.has(key)
    ) {
      return;
    }
    for (const child of childrenByParentKey.get(key) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of input.roots) visit(root, 0);
  return result;
}

export function collectSearchableSidebarThreads(input: {
  allThreads: readonly SidebarThreadSummary[];
  activeRoots: readonly SidebarThreadSummary[];
  snoozedRoots: readonly SidebarThreadSummary[];
  settledRoots: readonly SidebarThreadSummary[];
  visibleThreadKeys?: ReadonlySet<string>;
}): SidebarThreadSummary[] {
  const expandedThreadKeys = new Set(input.allThreads.map(sidebarThreadKey));
  return flattenExpandedSidebarThreadTree({
    allThreads: input.allThreads,
    roots: [...input.activeRoots, ...input.snoozedRoots, ...input.settledRoots],
    expandedThreadKeys,
    ...(input.visibleThreadKeys ? { visibleThreadKeys: input.visibleThreadKeys } : {}),
  }).map(({ thread }) => thread);
}

export function resolveSidebarRootThread(
  threads: readonly SidebarThreadSummary[],
  threadKey: string,
  threadByKey = new Map(threads.map((thread) => [sidebarThreadKey(thread), thread] as const)),
): SidebarThreadSummary | null {
  let current = threadByKey.get(threadKey) ?? null;
  const seen = new Set<string>();
  while (current) {
    const currentKey = sidebarThreadKey(current);
    if (seen.has(currentKey)) {
      return current;
    }
    seen.add(currentKey);
    const parentKey = sidebarThreadParentKey(current);
    if (!parentKey) {
      return current;
    }
    const parent = threadByKey.get(parentKey);
    if (!parent) {
      return current;
    }
    current = parent;
  }
  return null;
}

export function rootSidebarThreads(
  threads: readonly SidebarThreadSummary[],
  allThreads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  const keys = new Set(allThreads.map(sidebarThreadKey));
  return threads.filter((thread) => {
    const parentKey = sidebarThreadParentKey(thread);
    return !parentKey || !keys.has(parentKey);
  });
}

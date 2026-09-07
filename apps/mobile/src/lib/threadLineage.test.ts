import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectRecentThreadLineage, threadShellKey } from "./threadLineage";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

function subagentRelation(input: {
  readonly parentThreadId: ThreadId;
  readonly rootThreadId?: ThreadId;
  readonly depth?: number;
  readonly sequence: number;
  readonly status?: "running" | "completed" | "errored" | "interrupted" | "stopped";
}) {
  const timestampSecond = String(input.sequence).padStart(2, "0");
  return {
    kind: "subagent" as const,
    rootThreadId: input.rootThreadId ?? input.parentThreadId,
    parentThreadId: input.parentThreadId,
    parentTurnId: TurnId.make("turn-parent"),
    parentItemId: ProviderItemId.make(`item-${input.sequence}`),
    parentActivitySequence: input.sequence,
    providerThreadId: `provider-child-${input.sequence}`,
    titleSeed: "Inspect child work",
    depth: input.depth ?? 1,
    startedAt: `2026-06-01T00:00:${timestampSecond}.000Z`,
    completedAt: input.status && input.status !== "running" ? "2026-06-01T00:01:00.000Z" : null,
    status: input.status ?? "running",
  };
}

function threadIds(threads: ReadonlyArray<EnvironmentThreadShell>): ReadonlyArray<string> {
  return threads.map((thread) => String(thread.id));
}

describe("selectRecentThreadLineage", () => {
  it("retains visible subagent ancestors for recent child selections", () => {
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({ parentThreadId: parent.id, sequence: 1 }),
    });
    const unrelated = makeThread({
      id: ThreadId.make("thread-unrelated"),
      title: "Unrelated",
    });
    let fallbackCalled = false;

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [parent, child, unrelated],
      isRecentThread: (thread) => thread.id === child.id,
      getFallbackThreads: () => {
        fallbackCalled = true;
        return [];
      },
    });

    expect(threadIds(selectedThreads)).toEqual(["thread-parent", "thread-child"]);
    expect(fallbackCalled).toBe(false);
  });

  it("uses caller-provided fallback threads in visible thread order", () => {
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({ parentThreadId: parent.id, sequence: 1 }),
    });
    const siblingRoot = makeThread({
      id: ThreadId.make("thread-sibling-root"),
      title: "Sibling root",
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [parent, child, siblingRoot],
      isRecentThread: () => false,
      getFallbackThreads: () => [child, siblingRoot],
    });

    expect(threadIds(selectedThreads)).toEqual([
      "thread-parent",
      "thread-child",
      "thread-sibling-root",
    ]);
  });

  it("keeps an explicitly included active terminal child and its ancestors", () => {
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: parent.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [parent, child],
      isRecentThread: () => false,
      getFallbackThreads: () => [],
      alwaysIncludeThreadKey: threadShellKey(child),
    });

    expect(threadIds(selectedThreads)).toEqual(["thread-parent", "thread-child"]);
  });

  it("does not synthesize unavailable ancestors while retaining the selected child shell", () => {
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: ThreadId.make("thread-missing-parent"),
        sequence: 1,
      }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [child],
      isRecentThread: (thread) => thread.id === child.id,
      getFallbackThreads: () => [],
    });

    expect(threadIds(selectedThreads)).toEqual(["thread-child"]);
  });

  it("retains a shared ancestor once for multiple recent children", () => {
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
    });
    const firstChild = makeThread({
      id: ThreadId.make("thread-first-child"),
      title: "First child",
      parentRelation: subagentRelation({ parentThreadId: parent.id, sequence: 1 }),
    });
    const secondChild = makeThread({
      id: ThreadId.make("thread-second-child"),
      title: "Second child",
      parentRelation: subagentRelation({ parentThreadId: parent.id, sequence: 2 }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [parent, firstChild, secondChild],
      isRecentThread: (thread) => thread.id === firstChild.id || thread.id === secondChild.id,
      getFallbackThreads: () => [],
    });

    expect(threadIds(selectedThreads)).toEqual([
      "thread-parent",
      "thread-first-child",
      "thread-second-child",
    ]);
  });

  it("walks newly discovered ancestors in deep subagent chains", () => {
    const grandparent = makeThread({
      id: ThreadId.make("thread-grandparent"),
      title: "Grandparent",
    });
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
      parentRelation: subagentRelation({
        rootThreadId: grandparent.id,
        parentThreadId: grandparent.id,
        sequence: 1,
        depth: 1,
      }),
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({
        rootThreadId: grandparent.id,
        parentThreadId: parent.id,
        sequence: 2,
        depth: 2,
      }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [grandparent, parent, child],
      isRecentThread: (thread) => thread.id === child.id,
      getFallbackThreads: () => [],
    });

    expect(threadIds(selectedThreads)).toEqual([
      "thread-grandparent",
      "thread-parent",
      "thread-child",
    ]);
  });

  it("stops ancestor walking when a deeper chain has a missing grandparent", () => {
    const missingGrandparentId = ThreadId.make("thread-missing-grandparent");
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
      parentRelation: subagentRelation({
        rootThreadId: missingGrandparentId,
        parentThreadId: missingGrandparentId,
        sequence: 1,
        depth: 1,
      }),
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentRelation: subagentRelation({
        rootThreadId: missingGrandparentId,
        parentThreadId: parent.id,
        sequence: 2,
        depth: 2,
      }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [parent, child],
      isRecentThread: (thread) => thread.id === child.id,
      getFallbackThreads: () => [],
    });

    expect(threadIds(selectedThreads)).toEqual(["thread-parent", "thread-child"]);
  });

  it("terminates on malformed cyclic subagent relations", () => {
    const first = makeThread({
      id: ThreadId.make("thread-first"),
      title: "First",
      parentRelation: subagentRelation({
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: ThreadId.make("thread-second"),
        sequence: 1,
        depth: 2,
      }),
    });
    const second = makeThread({
      id: ThreadId.make("thread-second"),
      title: "Second",
      parentRelation: subagentRelation({
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: first.id,
        sequence: 2,
        depth: 1,
      }),
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [first, second],
      isRecentThread: (thread) => thread.id === first.id,
      getFallbackThreads: () => [],
    });

    expect(threadIds(selectedThreads)).toEqual(["thread-first", "thread-second"]);
  });

  it("does not return fallback threads outside visibleThreads", () => {
    const visibleThread = makeThread({
      id: ThreadId.make("thread-visible"),
      title: "Visible",
    });
    const externalFallback = makeThread({
      id: ThreadId.make("thread-external-fallback"),
      title: "External fallback",
    });

    const selectedThreads = selectRecentThreadLineage({
      visibleThreads: [visibleThread],
      isRecentThread: () => false,
      getFallbackThreads: () => [externalFallback],
    });

    expect(threadIds(selectedThreads)).toEqual([]);
  });
});

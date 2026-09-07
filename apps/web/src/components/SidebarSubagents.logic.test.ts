import { describe, expect, it } from "vite-plus/test";
import {
  canUseRootThreadLifecycleActions,
  canUseSelectedRootThreadLifecycleActions,
  sortPinnedThreadsForSidebar,
} from "./Sidebar.logic";
import {
  activeSidebarThreadAncestorKeys,
  collectSearchableSidebarThreads,
  flattenExpandedSidebarThreadTree,
  flattenSidebarThreadTree,
  resolveSidebarSubagentCount,
  rootSidebarThreads,
  sidebarSubagentDescendantCounts,
  sidebarThreadKey,
  visibleSidebarThreads,
} from "./SidebarSubagents.logic";
import { selectSidebarProjectLineageThreads } from "../sidebarProjectGrouping";
import {
  EnvironmentId,
  ProjectId,
  ProviderItemId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeSidebarThread(input: {
  id: string;
  createdAt?: string;
  projectId?: string;
  parentThreadId?: string;
  parentActivitySequence?: number;
  startedAt?: string;
  status?: "running" | "completed" | "errored" | "interrupted" | "stopped";
}): SidebarThreadSummary {
  return {
    id: ThreadId.make(input.id),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make(input.projectId ?? "project-1"),
    title: input.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: input.createdAt ?? "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    parentRelation: input.parentThreadId
      ? {
          kind: "subagent",
          rootThreadId: ThreadId.make("root-thread"),
          parentThreadId: ThreadId.make(input.parentThreadId),
          parentTurnId: null,
          parentItemId: ProviderItemId.make(`item-${input.id}`),
          parentActivitySequence: input.parentActivitySequence ?? 1,
          providerThreadId: `provider-${input.id}`,
          titleSeed: input.id,
          depth: 1,
          startedAt: input.startedAt ?? "2026-03-09T10:00:00.000Z",
          completedAt: input.status === "running" ? null : "2026-03-09T10:01:00.000Z",
          status: input.status ?? "running",
        }
      : {
          kind: "root",
          rootThreadId: ThreadId.make(input.id),
        },
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("subagent sidebar tree helpers", () => {
  it("allows root lifecycle actions only for non-subagent threads", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const runningChild = makeSidebarThread({
      id: "running-child",
      parentThreadId: "root-thread",
      status: "running",
    });
    const terminalChild = makeSidebarThread({
      id: "terminal-child",
      parentThreadId: "root-thread",
      status: "completed",
    });

    expect(canUseRootThreadLifecycleActions(root)).toBe(true);
    expect(canUseRootThreadLifecycleActions(runningChild)).toBe(false);
    expect(canUseRootThreadLifecycleActions(terminalChild)).toBe(false);
    expect(canUseRootThreadLifecycleActions(null)).toBe(true);
  });

  it("fails closed for selected lifecycle actions with unresolved threads", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const runningChild = makeSidebarThread({
      id: "running-child",
      parentThreadId: "root-thread",
      status: "running",
    });
    const threadByKey = new Map([
      [sidebarThreadKey(root), root],
      [sidebarThreadKey(runningChild), runningChild],
    ]);

    expect(canUseSelectedRootThreadLifecycleActions([sidebarThreadKey(root)], threadByKey)).toBe(
      true,
    );
    expect(
      canUseSelectedRootThreadLifecycleActions(
        [sidebarThreadKey(root), "environment:missing-thread"],
        threadByKey,
      ),
    ).toBe(false);
    expect(
      canUseSelectedRootThreadLifecycleActions([sidebarThreadKey(runningChild)], threadByKey),
    ).toBe(false);
  });

  it("keeps running descendants nested under hidden terminal ancestors", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const terminalChild = makeSidebarThread({
      id: "terminal-child",
      parentThreadId: "root-thread",
      parentActivitySequence: 1,
      status: "completed",
    });
    const runningGrandchild = makeSidebarThread({
      id: "running-grandchild",
      parentThreadId: "terminal-child",
      parentActivitySequence: 1,
      status: "running",
    });
    const allThreads = [root, terminalChild, runningGrandchild];
    const visibleThreads = visibleSidebarThreads(allThreads, null);

    expect(visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("root-thread"),
      ThreadId.make("running-grandchild"),
    ]);
    expect(rootSidebarThreads(visibleThreads, allThreads).map((thread) => thread.id)).toEqual([
      ThreadId.make("root-thread"),
    ]);

    const rendered = flattenSidebarThreadTree({
      allThreads,
      roots: [root],
      visibleThreadKeys: new Set(visibleThreads.map(sidebarThreadKey)),
    });

    expect(rendered.map(({ thread, depth }) => [thread.id, depth])).toEqual([
      [ThreadId.make("root-thread"), 0],
      [ThreadId.make("running-grandchild"), 2],
    ]);
  });

  it("shows only the exact open terminal subagent through its hidden parent path", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const terminalChild = makeSidebarThread({
      id: "terminal-child",
      parentThreadId: "root-thread",
      status: "completed",
    });
    const terminalGrandchild = makeSidebarThread({
      id: "terminal-grandchild",
      parentThreadId: "terminal-child",
      status: "completed",
    });
    const allThreads = [root, terminalChild, terminalGrandchild];
    const terminalGrandchildKey = sidebarThreadKey(terminalGrandchild);
    const activeAncestorKeys = activeSidebarThreadAncestorKeys(allThreads, terminalGrandchildKey);
    const visibleThreads = visibleSidebarThreads(allThreads, terminalGrandchildKey);
    const visibleThreadKeys = new Set(visibleThreads.map(sidebarThreadKey));
    const runningThreadKeys = new Set(
      visibleSidebarThreads(allThreads, null).map(sidebarThreadKey),
    );

    expect(visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("root-thread"),
      ThreadId.make("terminal-grandchild"),
    ]);
    expect([...activeAncestorKeys]).toEqual([
      sidebarThreadKey(terminalChild),
      sidebarThreadKey(root),
    ]);
    expect(
      sidebarSubagentDescendantCounts({
        allThreads,
        visibleThreadKeys: runningThreadKeys,
      }).has(sidebarThreadKey(root)),
    ).toBe(false);
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads,
        roots: [root],
        expandedThreadKeys: new Set(),
        alwaysExpandedThreadKeys: activeAncestorKeys,
        visibleThreadKeys,
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([
      [ThreadId.make("root-thread"), 0],
      [ThreadId.make("terminal-grandchild"), 2],
    ]);
  });

  it("orders sibling subagents by parent sequence, start time, and thread key", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const laterSequence = makeSidebarThread({
      id: "child-d",
      parentThreadId: "root-thread",
      parentActivitySequence: 2,
      startedAt: "2026-03-09T10:03:00.000Z",
    });
    const earlierSequence = makeSidebarThread({
      id: "child-a",
      parentThreadId: "root-thread",
      parentActivitySequence: 1,
      startedAt: "2026-03-09T10:05:00.000Z",
    });
    const sameSequenceLaterKey = makeSidebarThread({
      id: "child-c",
      parentThreadId: "root-thread",
      parentActivitySequence: 2,
      startedAt: "2026-03-09T10:02:00.000Z",
    });
    const sameSequenceEarlierKey = makeSidebarThread({
      id: "child-b",
      parentThreadId: "root-thread",
      parentActivitySequence: 2,
      startedAt: "2026-03-09T10:02:00.000Z",
    });

    const rendered = flattenSidebarThreadTree({
      allThreads: [
        root,
        laterSequence,
        earlierSequence,
        sameSequenceLaterKey,
        sameSequenceEarlierKey,
      ],
      roots: [root],
    });

    expect(rendered.map(({ thread }) => thread.id)).toEqual([
      ThreadId.make("root-thread"),
      ThreadId.make("child-a"),
      ThreadId.make("child-b"),
      ThreadId.make("child-c"),
      ThreadId.make("child-d"),
    ]);
  });

  it("counts subagents across every visible descendant depth", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const child = makeSidebarThread({
      id: "child-thread",
      parentThreadId: "root-thread",
    });
    const grandchild = makeSidebarThread({
      id: "grandchild-thread",
      parentThreadId: "child-thread",
    });
    const sibling = makeSidebarThread({
      id: "sibling-thread",
      parentThreadId: "root-thread",
    });
    const threads = [root, child, grandchild, sibling];

    const counts = sidebarSubagentDescendantCounts({ allThreads: threads });

    expect(counts.get(sidebarThreadKey(root))).toBe(3);
    expect(counts.get(sidebarThreadKey(child))).toBe(1);
    expect(counts.has(sidebarThreadKey(grandchild))).toBe(false);
  });

  it("uses live native-agent counts when child conversation shells are absent", () => {
    expect(resolveSidebarSubagentCount({ descendantCount: 0, activeSubagentCount: 2 })).toBe(2);
    expect(resolveSidebarSubagentCount({ descendantCount: 3, activeSubagentCount: 2 })).toBe(3);
    expect(resolveSidebarSubagentCount({ descendantCount: 0 })).toBe(0);
  });

  it("reveals each nested subagent list only after its indicator is expanded", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const child = makeSidebarThread({
      id: "child-thread",
      parentThreadId: "root-thread",
    });
    const grandchild = makeSidebarThread({
      id: "grandchild-thread",
      parentThreadId: "child-thread",
    });
    const threads = [root, child, grandchild];

    const collapsed = flattenExpandedSidebarThreadTree({
      allThreads: threads,
      roots: [root],
      expandedThreadKeys: new Set(),
    });
    const rootExpanded = flattenExpandedSidebarThreadTree({
      allThreads: threads,
      roots: [root],
      expandedThreadKeys: new Set([sidebarThreadKey(root)]),
    });
    const allExpanded = flattenExpandedSidebarThreadTree({
      allThreads: threads,
      roots: [root],
      expandedThreadKeys: new Set([sidebarThreadKey(root), sidebarThreadKey(child)]),
    });

    expect(collapsed.map(({ thread }) => thread.id)).toEqual([ThreadId.make("root-thread")]);
    expect(rootExpanded.map(({ thread, depth }) => [thread.id, depth])).toEqual([
      [ThreadId.make("root-thread"), 0],
      [ThreadId.make("child-thread"), 1],
    ]);
    expect(allExpanded.map(({ thread, depth }) => [thread.id, depth])).toEqual([
      [ThreadId.make("root-thread"), 0],
      [ThreadId.make("child-thread"), 1],
      [ThreadId.make("grandchild-thread"), 2],
    ]);
  });

  it("does not expand subagents just because their parent conversation is active", () => {
    const root = makeSidebarThread({ id: "root-thread" });
    const child = makeSidebarThread({
      id: "child-thread",
      parentThreadId: "root-thread",
    });
    const grandchild = makeSidebarThread({
      id: "grandchild-thread",
      parentThreadId: "child-thread",
    });
    const threads = [root, child, grandchild];
    const activeRootKey = sidebarThreadKey(root);

    expect(activeSidebarThreadAncestorKeys(threads, activeRootKey)).toEqual(new Set());
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads: threads,
        roots: [root],
        expandedThreadKeys: new Set(),
        alwaysExpandedThreadKeys: activeSidebarThreadAncestorKeys(threads, activeRootKey),
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([[ThreadId.make("root-thread"), 0]]);
  });

  it("keeps recursive subagents inside a grouped project scope", () => {
    const root = makeSidebarThread({
      id: "root-thread",
      projectId: "project-stale",
    });
    const terminalChild = makeSidebarThread({
      id: "terminal-child",
      projectId: "project-canonical",
      parentThreadId: "root-thread",
      status: "completed",
    });
    const otherRoot = makeSidebarThread({
      id: "other-root",
      projectId: "project-other",
    });
    const structuralThreads = selectSidebarProjectLineageThreads({
      threads: [root, terminalChild, otherRoot],
      projectKeys: new Set([
        `${localEnvironmentId}:${ProjectId.make("project-stale")}`,
        `${localEnvironmentId}:${ProjectId.make("project-canonical")}`,
      ]),
    });
    const visibleThreads = visibleSidebarThreads(
      structuralThreads,
      sidebarThreadKey(terminalChild),
    );
    const visibleThreadKeys = new Set(visibleThreads.map(sidebarThreadKey));
    const roots = rootSidebarThreads(visibleThreads, structuralThreads);
    const descendantCounts = sidebarSubagentDescendantCounts({
      allThreads: structuralThreads,
      visibleThreadKeys,
    });

    expect(structuralThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("root-thread"),
      ThreadId.make("terminal-child"),
    ]);
    expect(roots.map((thread) => thread.id)).toEqual([ThreadId.make("root-thread")]);
    expect(descendantCounts.get(sidebarThreadKey(root))).toBe(1);
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads: structuralThreads,
        roots,
        expandedThreadKeys: new Set(),
        visibleThreadKeys,
      }).map(({ thread }) => thread.id),
    ).toEqual([ThreadId.make("root-thread")]);
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads: structuralThreads,
        roots,
        expandedThreadKeys: new Set([sidebarThreadKey(root)]),
        visibleThreadKeys,
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([
      [ThreadId.make("root-thread"), 0],
      [ThreadId.make("terminal-child"), 1],
    ]);
  });

  it("bounds malformed cyclic subagent lineage without duplicating rows", () => {
    const first = makeSidebarThread({
      id: "cycle-first",
      parentThreadId: "cycle-second",
      parentActivitySequence: 1,
    });
    const second = makeSidebarThread({
      id: "cycle-second",
      parentThreadId: "cycle-first",
      parentActivitySequence: 2,
    });

    const rendered = flattenSidebarThreadTree({
      allThreads: [first, second],
      roots: [first],
    });

    expect(rendered.map(({ thread, depth }) => [thread.id, depth])).toEqual([
      [ThreadId.make("cycle-first"), 0],
      [ThreadId.make("cycle-second"), 1],
    ]);
  });
});

describe("collectSearchableSidebarThreads", () => {
  it("preserves lifecycle root order while collecting every descendant depth", () => {
    const activeRoot = makeSidebarThread({ id: "active-root" });
    const activeChild = makeSidebarThread({
      id: "active-child",
      parentThreadId: "active-root",
    });
    const activeGrandchild = makeSidebarThread({
      id: "active-grandchild",
      parentThreadId: "active-child",
    });
    const snoozedRoot = makeSidebarThread({ id: "snoozed-root" });
    const snoozedChild = makeSidebarThread({
      id: "snoozed-child",
      parentThreadId: "snoozed-root",
    });
    const settledRoot = makeSidebarThread({ id: "settled-root" });
    const allThreads = [
      settledRoot,
      activeGrandchild,
      snoozedChild,
      activeRoot,
      snoozedRoot,
      activeChild,
    ];

    expect(
      collectSearchableSidebarThreads({
        allThreads,
        activeRoots: [activeRoot],
        snoozedRoots: [snoozedRoot],
        settledRoots: [settledRoot],
      }).map((thread) => thread.id),
    ).toEqual([
      ThreadId.make("active-root"),
      ThreadId.make("active-child"),
      ThreadId.make("active-grandchild"),
      ThreadId.make("snoozed-root"),
      ThreadId.make("snoozed-child"),
      ThreadId.make("settled-root"),
    ]);
  });

  it("keeps descendants searchable across grouped-project member references", () => {
    const root = makeSidebarThread({
      id: "group-root",
      projectId: "project-stale",
    });
    const child = makeSidebarThread({
      id: "group-child",
      projectId: "project-canonical",
      parentThreadId: "group-root",
    });
    const outsideRoot = makeSidebarThread({
      id: "outside-root",
      projectId: "project-outside",
    });
    const structuralThreads = selectSidebarProjectLineageThreads({
      threads: [root, child, outsideRoot],
      projectKeys: new Set([
        `${localEnvironmentId}:${ProjectId.make("project-stale")}`,
        `${localEnvironmentId}:${ProjectId.make("project-canonical")}`,
      ]),
    });
    const visibleThreadKeys = new Set(structuralThreads.map(sidebarThreadKey));

    expect(
      collectSearchableSidebarThreads({
        allThreads: structuralThreads,
        activeRoots: rootSidebarThreads(structuralThreads, structuralThreads),
        snoozedRoots: [],
        settledRoots: [],
        visibleThreadKeys,
      }).map((thread) => thread.id),
    ).toEqual([ThreadId.make("group-root"), ThreadId.make("group-child")]);
  });
});

describe("sortPinnedThreadsForSidebar subagent lineage", () => {
  it("sorts roots before flattening their expanded subagent lineages", () => {
    const laterRoot = {
      ...makeSidebarThread({ id: "a-later-root" }),
      pinOrderKey: "z",
    };
    const laterChild = makeSidebarThread({
      id: "later-child",
      parentThreadId: "a-later-root",
    });
    const earlierRoot = {
      ...makeSidebarThread({ id: "z-earlier-root" }),
      pinOrderKey: "a",
    };
    const earlierChild = makeSidebarThread({
      id: "earlier-child",
      parentThreadId: "z-earlier-root",
    });
    const allThreads = [laterRoot, laterChild, earlierRoot, earlierChild];
    const orderedRoots = sortPinnedThreadsForSidebar([laterRoot, earlierRoot]);

    expect(
      flattenExpandedSidebarThreadTree({
        allThreads,
        roots: orderedRoots,
        expandedThreadKeys: new Set(orderedRoots.map(sidebarThreadKey)),
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([
      [earlierRoot.id, 0],
      [earlierChild.id, 1],
      [laterRoot.id, 0],
      [laterChild.id, 1],
    ]);
  });
});

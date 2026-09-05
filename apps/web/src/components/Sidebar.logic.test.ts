import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import {
  animatePinnedLayoutChanges,
  archiveSelectedThreadEntries,
  buildBulkTitleRegenerationContextMenuItem,
  buildMultiSelectThreadContextMenuItems,
  buildSidebarV2ThreadContextMenuSlots,
  composeSidebarV2ThreadContextMenuItems,
  shouldShowSidebarV2SettledHeader,
  buildSidebarThreadRows,
  canUseRootThreadLifecycleActions,
  canUseSelectedRootThreadLifecycleActions,
  createThreadJumpHintVisibilityController,
  filterArchivableSidebarThreads,
  filterSidebarThreadsByProjectScope,
  filterVisibleSidebarThreadTree,
  filterVisibleSidebarThreads,
  getCompletedArchiveThreadKeys,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  isContextualSubagentSidebarThread,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isRootSidebarThread,
  isThreadSessionRunning,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarOptionsMenuVisibility,
  resolveSidebarStageBadgeLabel,
  resolveSidebarTriggerVisibilityClassName,
  resolveThreadListClassName,
  resolveThreadRowClassName,
  resolveThreadRowIndentStyle,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  SIDEBAR_TRIGGER_DESKTOP_HIDDEN_CLASS,
  resolveWorkingStartedAt,
  searchSidebarThreadsByTitle,
  formatWorkingDurationLabel,
  shouldNavigateAfterProjectRemoval,
  shouldClearThreadSelectionOnMouseDown,
  sortLogicalProjectsForSidebar,
  sortSettledThreadsForSidebar,
  pinOrderKeyBetween,
  planPinnedReorder,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  shouldCreateNewThreadInCurrentProject,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
  withCoordinatedThreadArchiveEntries,
} from "./Sidebar.logic";
import {
  activeSidebarThreadAncestorKeys,
  collectSearchableSidebarThreads,
  flattenExpandedSidebarThreadTree,
  resolveSidebarSubagentCount,
  rootSidebarThreads,
  sidebarSubagentDescendantCounts,
  sidebarThreadKey,
  visibleSidebarThreads,
} from "./SidebarSubagents.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderItemId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("animatePinnedLayoutChanges", () => {
  const baseArgs: Parameters<AnimateLayoutChanges>[0] = {
    active: null,
    containerId: "pinned-threads",
    isDragging: false,
    isSorting: false,
    id: "thread-a",
    index: 1,
    items: ["thread-b", "thread-a"],
    newIndex: 0,
    previousItems: ["thread-a", "thread-b"],
    previousContainerId: "pinned-threads",
    transition: { duration: 200, easing: "ease" },
    wasDragging: true,
  };

  it("does not replay layout movement after the pointer is released", () => {
    expect(defaultAnimateLayoutChanges(baseArgs)).toBe(true);
    expect(animatePinnedLayoutChanges(baseArgs)).toBe(false);
  });

  it("keeps layout movement while the user is sorting", () => {
    expect(animatePinnedLayoutChanges({ ...baseArgs, isSorting: true })).toBe(true);
  });
});

describe("shouldNavigateAfterProjectRemoval", () => {
  const projectThreads = [{ environmentId: "environment-local", id: "thread-1" }];

  it("navigates away from a draft route owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-1" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(true);
  });

  it("does not navigate away from a different draft route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-2" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(false);
  });

  it("navigates away from a server thread owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: {
          kind: "server",
          threadRef: {
            environmentId: EnvironmentId.make("environment-local"),
            threadId: ThreadId.make("thread-1"),
          },
        },
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(true);
  });

  it("does not navigate from an unrelated route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: null,
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(false);
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      skippedThreadKeys: [],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });

  it("reports completed entries before a later archive throws", async () => {
    const onArchived = vi.fn();

    await expect(
      archiveSelectedThreadEntries({
        entries,
        archive: async (entry, markArchived) => {
          if (entry.threadKey === "two") throw new Error("archive failed");
          markArchived();
          return success;
        },
        onArchived,
      }),
    ).rejects.toThrow("archive failed");

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(onArchived).toHaveBeenCalledWith(entries[0]);
  });

  it("re-checks eligibility before each batch mutation", async () => {
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive,
      canArchive: (entry) => entry.threadKey !== "two",
    });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenNthCalledWith(1, entries[0], expect.any(Function));
    expect(archive).toHaveBeenNthCalledWith(2, entries[2], expect.any(Function));
    expect(outcome.archivedThreadKeys).toEqual(["one", "three"]);
    expect(outcome.skippedThreadKeys).toEqual(["two"]);
  });

  it("reports when every entry becomes ineligible before mutation", async () => {
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive,
      canArchive: () => false,
    });

    expect(archive).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      archivedThreadKeys: [],
      skippedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });
});

describe("withCoordinatedThreadArchiveEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }] as const;

  it("waits for owners and omits entries they successfully archived", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });

    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));
    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    await Promise.resolve();
    expect(secondRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("retries entries when their owner cancels without archiving", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let cancelFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          cancelFirstFlow = () => resolve([]);
        }),
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));
    const secondRun = vi.fn(async () => ["one", "two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });

    cancelFirstFlow?.();
    await expect(firstFlow).resolves.toEqual([]);
    await expect(secondFlow).resolves.toEqual(["one", "two"]);
    expect(secondRun).toHaveBeenCalledWith(entries, expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("releases reservations when the archive flow fails", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();

    await expect(
      withCoordinatedThreadArchiveEntries({
        entries,
        reservations,
        run: async () => {
          throw new Error("archive failed");
        },
      }),
    ).rejects.toThrow("archive failed");
    expect(reservations.size).toBe(0);
  });

  it("reserves uncontested siblings while waiting for an owner", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));

    let finishSecondFlow: (() => void) | undefined;
    const secondRun = vi.fn(
      async () =>
        new Promise<readonly string[]>((resolve) => {
          finishSecondFlow = () => resolve(["two"]);
        }),
    );
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    await vi.waitFor(() => expect(reservations.has("two")).toBe(true));

    const thirdRun = vi.fn(async () => ["two"]);
    const thirdFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[1]],
      reservations,
      run: thirdRun,
    });
    await Promise.resolve();
    expect(thirdRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await vi.waitFor(() =>
      expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function)),
    );
    expect(thirdRun).not.toHaveBeenCalled();

    finishSecondFlow?.();
    await expect(secondFlow).resolves.toEqual(["two"]);
    await expect(thirdFlow).resolves.toEqual([]);
    expect(thirdRun).not.toHaveBeenCalled();
    expect(reservations.size).toBe(0);
  });

  it("publishes completed archives when a flow later throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let failFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (_ownedEntries, onArchived) => {
        onArchived("one");
        await new Promise<void>((_resolve, reject) => {
          failFirstFlow = () => reject(new Error("archive failed"));
        });
        return [];
      },
    });
    await vi.waitFor(() => expect(reservations.size).toBe(2));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    failFirstFlow?.();

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("publishes intentional skips when a later archive throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let failArchive: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (ownedEntries, onCompleted) => {
        const outcome = await archiveSelectedThreadEntries({
          entries: ownedEntries,
          canArchive: (entry) => entry.threadKey !== "one",
          archive: async () =>
            new Promise<never>((_resolve, reject) => {
              failArchive = () => reject(new Error("archive failed"));
            }),
          onArchived: (entry) => onCompleted(entry.threadKey),
          onSkipped: (entry) => onCompleted(entry.threadKey),
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    await vi.waitFor(() => expect(reservations.size).toBe(2));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    failArchive?.();

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("does not retry entries an owner intentionally skipped", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishEligibilityCheck: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async (ownedEntries) => {
        await new Promise<void>((resolve) => {
          finishEligibilityCheck = resolve;
        });
        const outcome = await archiveSelectedThreadEntries({
          entries: ownedEntries,
          archive: vi.fn(async () => ({ _tag: "Success" }) as const),
          canArchive: () => false,
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    finishEligibilityCheck?.();

    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasArchiveBlockedThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread has active work", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasArchiveBlockedThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });

  it("omits archive and delete actions when the selection contains subagent threads", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({
        count: 2,
        hasArchiveBlockedThread: false,
        canUseLifecycleActions: false,
      }),
    ).toEqual([{ id: "mark-unread", label: "Mark unread (2)" }]);
  });
});

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });
});

describe("resolveSidebarTriggerVisibilityClassName", () => {
  it("keeps the upstream desktop breakpoint behavior", () => {
    expect(resolveSidebarTriggerVisibilityClassName()).toBe(SIDEBAR_TRIGGER_DESKTOP_HIDDEN_CLASS);
  });
});

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: undefined,
        session: null,
      }),
    ).toBe(false);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

function makeSidebarThread(
  overrides: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "id" | "projectId">,
): SidebarThreadSummary {
  return {
    environmentId: localEnvironmentId,
    title: "Thread",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  } as SidebarThreadSummary;
}

function makeSubagentSidebarThread(input: {
  id: string;
  parentThreadId: string;
  rootThreadId?: string;
  parentActivitySequence?: number;
  status?: "running" | "completed";
}): SidebarThreadSummary {
  return makeSidebarThread({
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project"),
    parentRelation: {
      kind: "subagent",
      rootThreadId: ThreadId.make(input.rootThreadId ?? input.parentThreadId),
      parentThreadId: ThreadId.make(input.parentThreadId),
      parentTurnId: TurnId.make(`turn-${input.parentThreadId}`),
      parentItemId: ProviderItemId.make(`item-${input.id}`),
      parentActivitySequence: input.parentActivitySequence ?? 0,
      providerThreadId: `provider-${input.id}`,
      titleSeed: input.id,
      depth: 1,
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: input.status === "completed" ? "2026-03-09T10:01:00.000Z" : null,
      status: input.status ?? "running",
    },
  });
}

describe("sidebar v2 subagent trees", () => {
  const root = makeSidebarThread({
    id: ThreadId.make("root-thread"),
    projectId: ProjectId.make("project"),
  });
  const child = makeSubagentSidebarThread({
    id: "child-thread",
    parentThreadId: "root-thread",
  });
  const grandchild = makeSubagentSidebarThread({
    id: "grandchild-thread",
    parentThreadId: "child-thread",
    rootThreadId: "root-thread",
  });

  it("counts all descendants at every depth", () => {
    const counts = sidebarSubagentDescendantCounts({
      allThreads: [root, child, grandchild],
    });

    expect(counts.get(sidebarThreadKey(root))).toBe(2);
    expect(counts.get(sidebarThreadKey(child))).toBe(1);
    expect(counts.has(sidebarThreadKey(grandchild))).toBe(false);
  });

  it("uses live native-agent counts when child conversation shells are absent", () => {
    expect(resolveSidebarSubagentCount({ descendantCount: 0, activeSubagentCount: 2 })).toBe(2);
    expect(resolveSidebarSubagentCount({ descendantCount: 3, activeSubagentCount: 2 })).toBe(3);
    expect(resolveSidebarSubagentCount({ descendantCount: 0 })).toBe(0);
  });

  it("reveals each level only after its own indicator is expanded", () => {
    const threads = [root, child, grandchild];
    const render = (expandedThreadKeys: ReadonlySet<string>) =>
      flattenExpandedSidebarThreadTree({
        allThreads: threads,
        roots: [root],
        expandedThreadKeys,
      }).map(({ thread, depth }) => [thread.id, depth]);

    expect(render(new Set())).toEqual([[root.id, 0]]);
    expect(render(new Set([sidebarThreadKey(root)]))).toEqual([
      [root.id, 0],
      [child.id, 1],
    ]);
    expect(render(new Set([sidebarThreadKey(root), sidebarThreadKey(child)]))).toEqual([
      [root.id, 0],
      [child.id, 1],
      [grandchild.id, 2],
    ]);
  });

  it("does not expand subagents just because their parent conversation is active", () => {
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
    ).toEqual([[root.id, 0]]);
  });

  it("hides every descendant while an archived root is optimistic", () => {
    expect(
      filterVisibleSidebarThreadTree([root, child, grandchild], new Set([sidebarThreadKey(root)])),
    ).toEqual([]);
  });

  it("counts a running descendant through a hidden terminal parent", () => {
    const terminalChild = makeSubagentSidebarThread({
      id: "terminal-child",
      parentThreadId: "root-thread",
      status: "completed",
    });
    const runningGrandchild = makeSubagentSidebarThread({
      id: "running-grandchild",
      parentThreadId: "terminal-child",
      rootThreadId: "root-thread",
    });
    const threads = [root, terminalChild, runningGrandchild];
    const visible = visibleSidebarThreads(threads, null);
    const visibleThreadKeys = new Set(visible.map(sidebarThreadKey));
    const counts = sidebarSubagentDescendantCounts({
      allThreads: threads,
      visibleThreadKeys,
    });
    const expanded = flattenExpandedSidebarThreadTree({
      allThreads: threads,
      roots: [root],
      expandedThreadKeys: new Set([sidebarThreadKey(root)]),
      visibleThreadKeys,
    });

    expect(counts.get(sidebarThreadKey(root))).toBe(1);
    expect(expanded.map(({ thread, depth }) => [thread.id, depth])).toEqual([
      [root.id, 0],
      [runningGrandchild.id, 2],
    ]);
  });

  it("keeps recursive subagents inside a grouped project scope", () => {
    const groupedRoot = makeSidebarThread({
      id: ThreadId.make("grouped-root"),
      projectId: ProjectId.make("project-stale"),
      parentRelation: {
        kind: "root",
        rootThreadId: ThreadId.make("grouped-root"),
      },
    });
    const terminalChild = makeSidebarThread({
      id: ThreadId.make("grouped-terminal-child"),
      projectId: ProjectId.make("project-canonical"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: groupedRoot.id,
        parentThreadId: groupedRoot.id,
        parentTurnId: TurnId.make("turn-grouped-root"),
        parentItemId: ProviderItemId.make("item-grouped-terminal-child"),
        parentActivitySequence: 1,
        providerThreadId: "provider-grouped-terminal-child",
        titleSeed: "Grouped terminal child",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:01:00.000Z",
        status: "completed",
      },
    });
    const otherRoot = makeSidebarThread({
      id: ThreadId.make("other-root"),
      projectId: ProjectId.make("project-other"),
    });
    const scopedThreads = filterSidebarThreadsByProjectScope(
      [groupedRoot, terminalChild, otherRoot],
      new Set([`${localEnvironmentId}:project-stale`, `${localEnvironmentId}:project-canonical`]),
    );
    const structuralThreads = filterVisibleSidebarThreadTree(scopedThreads, new Set());
    const visibleThreads = visibleSidebarThreads(
      structuralThreads,
      sidebarThreadKey(terminalChild),
    );
    const visibleThreadKeys = new Set(visibleThreads.map(sidebarThreadKey));
    const roots = rootSidebarThreads(visibleThreads, structuralThreads);

    expect(structuralThreads.map((thread) => thread.id)).toEqual([
      groupedRoot.id,
      terminalChild.id,
    ]);
    expect(roots.map((thread) => thread.id)).toEqual([groupedRoot.id]);
    expect(
      sidebarSubagentDescendantCounts({
        allThreads: structuralThreads,
        visibleThreadKeys,
      }).get(sidebarThreadKey(groupedRoot)),
    ).toBe(1);
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads: structuralThreads,
        roots,
        expandedThreadKeys: new Set([sidebarThreadKey(groupedRoot)]),
        visibleThreadKeys,
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([
      [groupedRoot.id, 0],
      [terminalChild.id, 1],
    ]);
  });

  it("shows the exact open terminal subagent without counting it as running", () => {
    const terminalChild = makeSubagentSidebarThread({
      id: "terminal-child",
      parentThreadId: "root-thread",
      status: "completed",
    });
    const openGrandchild = makeSubagentSidebarThread({
      id: "open-grandchild",
      parentThreadId: "terminal-child",
      rootThreadId: "root-thread",
      status: "completed",
    });
    const threads = [root, terminalChild, openGrandchild];
    const openGrandchildKey = sidebarThreadKey(openGrandchild);
    const visibleThreadKeys = new Set(
      visibleSidebarThreads(threads, openGrandchildKey).map(sidebarThreadKey),
    );
    const runningThreadKeys = new Set(visibleSidebarThreads(threads, null).map(sidebarThreadKey));

    expect(
      sidebarSubagentDescendantCounts({
        allThreads: threads,
        visibleThreadKeys: runningThreadKeys,
      }).has(sidebarThreadKey(root)),
    ).toBe(false);
    expect(
      flattenExpandedSidebarThreadTree({
        allThreads: threads,
        roots: [root],
        expandedThreadKeys: new Set(),
        alwaysExpandedThreadKeys: activeSidebarThreadAncestorKeys(threads, openGrandchildKey),
        visibleThreadKeys,
      }).map(({ thread, depth }) => [thread.id, depth]),
    ).toEqual([
      [root.id, 0],
      [openGrandchild.id, 2],
    ]);
  });
});

describe("buildBulkTitleRegenerationContextMenuItem", () => {
  it("counts only threads that can start a new regeneration", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 4,
        actionableCount: 3,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerate titles (3)",
    });
  });

  it("shows a disabled progress item when every supported thread is pending", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 2,
        actionableCount: 0,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerating… (2)",
      disabled: true,
    });
  });

  it("omits the action when no selected environment supports it", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 0,
        actionableCount: 0,
      }),
    ).toBeNull();
  });
});

describe("buildSidebarV2ThreadContextMenuSlots", () => {
  it("offers archive for active and settled root threads", () => {
    const activeSlots = buildSidebarV2ThreadContextMenuSlots({
      canUseLifecycleActions: true,
      supportsSettlement: true,
      isSettled: false,
      isArchiveBlocked: false,
    });
    const settledSlots = buildSidebarV2ThreadContextMenuSlots({
      canUseLifecycleActions: true,
      supportsSettlement: true,
      isSettled: true,
      isArchiveBlocked: false,
    });

    expect(activeSlots.lifecycleItems.map((item) => item.id)).toEqual(["settle", "archive"]);
    expect(settledSlots.lifecycleItems.map((item) => item.id)).toEqual(["unsettle", "archive"]);
    expect(activeSlots.renameItem.id).toBe("rename");
    expect(activeSlots.markUnreadItem.id).toBe("mark-unread");
    expect(activeSlots.destructiveItems).toEqual([
      { id: "delete", label: "Delete", destructive: true, icon: "trash" },
    ]);
  });

  it("keeps archive visible but disabled while a root thread is running", () => {
    const slots = buildSidebarV2ThreadContextMenuSlots({
      canUseLifecycleActions: true,
      supportsSettlement: true,
      isSettled: false,
      isArchiveBlocked: true,
    });

    expect(slots.lifecycleItems.find((item) => item.id === "archive")).toMatchObject({
      disabled: true,
    });
  });

  it("omits root lifecycle actions for nested subagents", () => {
    const slots = buildSidebarV2ThreadContextMenuSlots({
      canUseLifecycleActions: false,
      supportsSettlement: false,
      isSettled: false,
      isArchiveBlocked: false,
    });

    expect(slots.lifecycleItems).toEqual([]);
    expect(slots.renameItem).toEqual({ id: "rename", label: "Rename thread" });
    expect(slots.markUnreadItem).toEqual({ id: "mark-unread", label: "Mark unread" });
    expect(slots.destructiveItems).toEqual([]);
  });

  it("composes upstream actions around the fork-owned slots", () => {
    const slots = buildSidebarV2ThreadContextMenuSlots({
      canUseLifecycleActions: true,
      supportsSettlement: true,
      isSettled: false,
      isArchiveBlocked: false,
    });

    const items = composeSidebarV2ThreadContextMenuItems({
      pinningItems: [],
      slots,
      leadingItems: [{ id: "new-thread-on-branch", label: "New thread on branch" }],
      snoozeItems: [{ id: "snooze", label: "Snooze" }],
      titleRegenerationItems: [{ id: "regenerate-title", label: "Regenerate title" }],
      copyItems: [
        { id: "copy-path", label: "Copy path" },
        { id: "copy-branch", label: "Copy branch" },
      ],
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "settle",
      "archive",
      "snooze",
      "rename",
      "regenerate-title",
      "mark-unread",
      "copy-path",
      "copy-branch",
      "delete",
    ]);
  });
});

describe("shouldShowSidebarV2SettledHeader", () => {
  it("shows above the first settled row even when the list starts settled", () => {
    expect(shouldShowSidebarV2SettledHeader({ isSettled: true, previousIsSettled: false })).toBe(
      true,
    );
  });

  it("hides for active rows and later settled rows", () => {
    expect(shouldShowSidebarV2SettledHeader({ isSettled: false, previousIsSettled: false })).toBe(
      false,
    );
    expect(shouldShowSidebarV2SettledHeader({ isSettled: true, previousIsSettled: true })).toBe(
      false,
    );
  });
});

describe("sidebar thread lifecycle guards", () => {
  it("allows root lifecycle actions only for non-subagent threads", () => {
    const root = makeSidebarThread({
      id: ThreadId.make("root-thread"),
      projectId: ProjectId.make("project"),
    });
    const runningChild = makeSidebarThread({
      id: ThreadId.make("running-child"),
      projectId: ProjectId.make("project"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-running"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-running-child",
        titleSeed: "Running child",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: null,
        status: "running",
      },
    });
    const terminalChild = makeSidebarThread({
      id: ThreadId.make("terminal-child"),
      projectId: ProjectId.make("project"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-terminal"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-terminal-child",
        titleSeed: "Terminal child",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });

    expect(canUseRootThreadLifecycleActions(root)).toBe(true);
    expect(canUseRootThreadLifecycleActions(runningChild)).toBe(false);
    expect(canUseRootThreadLifecycleActions(terminalChild)).toBe(false);
    expect(canUseRootThreadLifecycleActions(null)).toBe(true);
  });

  it("fails closed for selected lifecycle actions with unresolved threads", () => {
    const root = makeSidebarThread({
      id: ThreadId.make("root-thread"),
      projectId: ProjectId.make("project"),
    });
    const runningChild = makeSidebarThread({
      id: ThreadId.make("running-child"),
      projectId: ProjectId.make("project"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-running"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-running-child",
        titleSeed: "Running child",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: null,
        status: "running",
      },
    });
    const threadByKey = new Map([
      [`${localEnvironmentId}:${root.id}`, root],
      [`${localEnvironmentId}:${runningChild.id}`, runningChild],
    ]);

    expect(
      canUseSelectedRootThreadLifecycleActions([`${localEnvironmentId}:${root.id}`], threadByKey),
    ).toBe(true);
    expect(
      canUseSelectedRootThreadLifecycleActions(
        [`${localEnvironmentId}:${root.id}`, `${localEnvironmentId}:missing-thread`],
        threadByKey,
      ),
    ).toBe(false);
    expect(
      canUseSelectedRootThreadLifecycleActions(
        [`${localEnvironmentId}:${runningChild.id}`],
        threadByKey,
      ),
    ).toBe(false);
  });

  it("filters running and nested threads from archive batches", () => {
    const root = makeSidebarThread({
      id: ThreadId.make("root-thread"),
      projectId: ProjectId.make("project"),
    });
    const running = makeSidebarThread({
      id: ThreadId.make("running-thread"),
      projectId: ProjectId.make("project"),
      session: {
        threadId: ThreadId.make("running-thread"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        activeTurnId: TurnId.make("turn-running"),
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    });
    const nested = makeSubagentSidebarThread({
      id: "nested-thread",
      parentThreadId: "root-thread",
      status: "completed",
    });

    expect(isThreadSessionRunning(running.session)).toBe(true);
    expect(filterArchivableSidebarThreads([root, running, nested])).toEqual([root]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("isSidebarNestedLinkClick", () => {
  const linkTarget = {
    closest: (selector: string) => (selector === "a[href]" ? ({} as Element) : null),
  } as unknown as EventTarget;

  it("ignores row clicks that originated on a nested link", () => {
    expect(isSidebarNestedLinkClick(linkTarget)).toBe(true);
  });

  it("walks up from a text node to the enclosing link", () => {
    expect(isSidebarNestedLinkClick({ parentElement: linkTarget } as unknown as EventTarget)).toBe(
      true,
    );
  });

  it("leaves ordinary row clicks alone", () => {
    expect(isSidebarNestedLinkClick({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(isSidebarNestedLinkClick(null)).toBe(false);
  });
});

describe("shouldCreateNewThreadInCurrentProject", () => {
  it("creates directly on shift+click in a multi-project setup", () => {
    expect(shouldCreateNewThreadInCurrentProject(true, 2)).toBe(true);
  });

  it("opens the picker on a plain click in a multi-project setup", () => {
    expect(shouldCreateNewThreadInCurrentProject(false, 2)).toBe(false);
  });

  it("creates directly on any click with a single project", () => {
    expect(shouldCreateNewThreadInCurrentProject(false, 1)).toBe(true);
    expect(shouldCreateNewThreadInCurrentProject(true, 1)).toBe(true);
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.make("thread-12"),
            ThreadId.make("thread-11"),
            ThreadId.make("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.make("thread-8"), ThreadId.make("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.make("thread-12"),
      ThreadId.make("thread-11"),
      ThreadId.make("thread-10"),
      ThreadId.make("thread-8"),
      ThreadId.make("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [ThreadId.make("thread-hidden-2"), ThreadId.make("thread-hidden-1")],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.make("thread-12"), ThreadId.make("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.make("thread-12"), ThreadId.make("thread-11")]);
  });
});

describe("isRootSidebarThread", () => {
  it("keeps root threads and hides subagent child threads from root sidebar lists", () => {
    expect(isRootSidebarThread(makeThread())).toBe(true);
    expect(
      isRootSidebarThread(
        makeThread({
          id: ThreadId.make("thread-subagent"),
          parentRelation: {
            kind: "subagent",
            rootThreadId: ThreadId.make("thread-root"),
            parentThreadId: ThreadId.make("thread-root"),
            parentTurnId: TurnId.make("turn-root"),
            parentItemId: ProviderItemId.make("item-root"),
            parentActivitySequence: 0,
            providerThreadId: "provider-thread-subagent",
            titleSeed: "Inspect auth flow",
            depth: 1,
            startedAt: "2026-03-09T10:00:00.000Z",
            completedAt: null,
            status: "running",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isContextualSubagentSidebarThread", () => {
  it("shows subagents only when they are active or running", () => {
    const child = makeThread({
      id: ThreadId.make("thread-subagent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: ThreadId.make("thread-root"),
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-root"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-subagent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });

    expect(isContextualSubagentSidebarThread(child, null)).toBe(false);
    expect(isContextualSubagentSidebarThread(child, child.id)).toBe(true);
    expect(
      isContextualSubagentSidebarThread(
        {
          ...child,
          parentRelation: {
            ...child.parentRelation!,
            status: "running",
          },
        },
        null,
      ),
    ).toBe(true);
  });
});

describe("buildSidebarThreadRows", () => {
  it("nests active and running subagents under their parent without showing completed inactive ones", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const activeChild = makeThread({
      id: ThreadId.make("thread-active-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-active"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-active-child",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const runningChild = makeThread({
      id: ThreadId.make("thread-running-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-running"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-running-child",
        titleSeed: "Check tests",
        depth: 1,
        startedAt: "2026-03-09T10:01:00.000Z",
        completedAt: null,
        status: "running",
      },
    });
    const inactiveChild = makeThread({
      id: ThreadId.make("thread-inactive-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-inactive"),
        parentActivitySequence: 2,
        providerThreadId: "provider-thread-inactive-child",
        titleSeed: "Summarize docs",
        depth: 1,
        startedAt: "2026-03-09T10:02:00.000Z",
        completedAt: "2026-03-09T10:03:00.000Z",
        status: "completed",
      },
    });

    expect(
      buildSidebarThreadRows([root, activeChild, runningChild, inactiveChild], activeChild.id),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: activeChild, indentLevel: 1 },
      { thread: runningChild, indentLevel: 1 },
    ]);
  });

  it("shows only the exact open terminal subagent through hidden terminal ancestors", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const terminalParent = makeThread({
      id: ThreadId.make("thread-terminal-parent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-parent"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-terminal-parent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const activeGrandchild = makeThread({
      id: ThreadId.make("thread-active-grandchild"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: terminalParent.id,
        parentTurnId: TurnId.make("turn-child"),
        parentItemId: ProviderItemId.make("item-grandchild"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-active-grandchild",
        titleSeed: "Check nested route",
        depth: 2,
        startedAt: "2026-03-09T10:03:00.000Z",
        completedAt: "2026-03-09T10:04:00.000Z",
        status: "completed",
      },
    });

    expect(
      buildSidebarThreadRows([root, terminalParent, activeGrandchild], activeGrandchild.id),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: activeGrandchild, indentLevel: 2 },
    ]);
  });

  it("keeps running descendants under hidden terminal ancestors before unrelated roots", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const unrelatedRoot = makeThread({ id: ThreadId.make("thread-unrelated-root") });
    const terminalParent = makeThread({
      id: ThreadId.make("thread-terminal-parent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-parent"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-terminal-parent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const runningGrandchild = makeThread({
      id: ThreadId.make("thread-running-grandchild"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: terminalParent.id,
        parentTurnId: TurnId.make("turn-child"),
        parentItemId: ProviderItemId.make("item-grandchild"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-running-grandchild",
        titleSeed: "Check nested route",
        depth: 2,
        startedAt: "2026-03-09T10:03:00.000Z",
        completedAt: null,
        status: "running",
      },
    });

    expect(
      buildSidebarThreadRows([root, unrelatedRoot, terminalParent, runningGrandchild], null),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: runningGrandchild, indentLevel: 2 },
      { thread: unrelatedRoot, indentLevel: 0 },
    ]);
  });

  it("bounds malformed cyclic subagent lineage without duplicating rows", () => {
    const first = makeThread({
      id: ThreadId.make("thread-cycle-first"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: ThreadId.make("thread-cycle-second"),
        parentTurnId: TurnId.make("turn-cycle-second"),
        parentItemId: ProviderItemId.make("item-cycle-first"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-cycle-first",
        titleSeed: "First",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: null,
        status: "running",
      },
    });
    const second = makeThread({
      id: ThreadId.make("thread-cycle-second"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: first.id,
        parentTurnId: TurnId.make("turn-cycle-first"),
        parentItemId: ProviderItemId.make("item-cycle-second"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-cycle-second",
        titleSeed: "Second",
        depth: 2,
        startedAt: "2026-03-09T10:01:00.000Z",
        completedAt: null,
        status: "running",
      },
    });

    expect(buildSidebarThreadRows([first, second], first.id)).toEqual([
      { thread: first, indentLevel: 1 },
      { thread: second, indentLevel: 2 },
    ]);
  });
});

describe("resolveThreadRowIndentStyle", () => {
  it("increases row indentation for each visible subagent generation", () => {
    expect(resolveThreadRowIndentStyle({ indentLevel: 0, flattenHierarchyChrome: false })).toBe(
      undefined,
    );
    expect(resolveThreadRowIndentStyle({ indentLevel: 1, flattenHierarchyChrome: false })).toEqual({
      paddingLeft: "1.25rem",
    });
    expect(resolveThreadRowIndentStyle({ indentLevel: 2, flattenHierarchyChrome: false })).toEqual({
      paddingLeft: "2.125rem",
    });
  });

  it("suppresses hierarchy indentation when chrome is flattened", () => {
    expect(resolveThreadRowIndentStyle({ indentLevel: 2, flattenHierarchyChrome: true })).toBe(
      undefined,
    );
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const session = {
    threadId: ThreadId.make("thread-1"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };

  it("prioritizes approval over a running session", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, session })).toBe(
      "approval",
    );
  });

  it("prioritizes awaiting input over a running session, below approval", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, session })).toBe(
      "input",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session,
      }),
    ).toBe("approval");
  });

  it("reports working for running and starting sessions", () => {
    expect(resolveSidebarThreadStatus({ ...idle, session })).toBe("working");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "starting" as const },
      }),
    ).toBe("working");
  });

  it("reports failed only while the session status is error", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "error" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "stopped" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "ready" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
  });

  it("defaults to ready with no session", () => {
    expect(resolveSidebarThreadStatus({ ...idle, session: null })).toBe("ready");
  });
});

describe("searchSidebarThreadsByTitle", () => {
  const threads = [
    { id: "thread-1", title: "Fix workspace search", project: "Alpha" },
    { id: "thread-2", title: "Review providers", project: "Workspace" },
    { id: "thread-3", title: "WORKTREE cleanup", project: "Beta" },
  ];

  it("matches thread titles case-insensitively and preserves their order", () => {
    expect(searchSidebarThreadsByTitle(threads, "work")).toEqual([threads[0], threads[2]]);
  });

  it("does not match project metadata", () => {
    expect(searchSidebarThreadsByTitle(threads, "workspace")).toEqual([threads[0]]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSidebarThreadsByTitle(threads, "   ")).toEqual([]);
  });
});

describe("collectSearchableSidebarThreads", () => {
  it("preserves lifecycle root order while collecting every descendant depth", () => {
    const activeRoot = makeSidebarThread({
      id: ThreadId.make("active-root"),
      projectId: ProjectId.make("project"),
    });
    const activeChild = makeSubagentSidebarThread({
      id: "active-child",
      parentThreadId: "active-root",
      rootThreadId: "active-root",
    });
    const activeGrandchild = makeSubagentSidebarThread({
      id: "active-grandchild",
      parentThreadId: "active-child",
      rootThreadId: "active-root",
    });
    const snoozedRoot = makeSidebarThread({
      id: ThreadId.make("snoozed-root"),
      projectId: ProjectId.make("project"),
    });
    const snoozedChild = makeSubagentSidebarThread({
      id: "snoozed-child",
      parentThreadId: "snoozed-root",
      rootThreadId: "snoozed-root",
    });
    const settledRoot = makeSidebarThread({
      id: ThreadId.make("settled-root"),
      projectId: ProjectId.make("project"),
    });
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
      id: ThreadId.make("group-root"),
      projectId: ProjectId.make("project-stale"),
    });
    const child = makeSubagentSidebarThread({
      id: "group-child",
      parentThreadId: "group-root",
      rootThreadId: "group-root",
    });
    const canonicalChild = {
      ...child,
      projectId: ProjectId.make("project-canonical"),
    };
    const outsideRoot = makeSidebarThread({
      id: ThreadId.make("outside-root"),
      projectId: ProjectId.make("project-outside"),
    });
    const structuralThreads = filterSidebarThreadsByProjectScope(
      [root, canonicalChild, outsideRoot],
      new Set([`${localEnvironmentId}:project-stale`, `${localEnvironmentId}:project-canonical`]),
    );
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

describe("sortThreadsForSidebar", () => {
  const sortable = (input: { id: string; createdAt: string }) => ({
    id: input.id,
    createdAt: input.createdAt,
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForSidebar([
      sortable({ id: "oldest", createdAt: "2026-03-09T08:00:00.000Z" }),
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      sortable({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks creation-time ties by id so the order is stable", () => {
    const sorted = sortThreadsForSidebar([
      sortable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z" }),
      sortable({ id: "a", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("surfaces an un-settled thread at the top via its re-entry stamp", () => {
    const sorted = sortThreadsForSidebar([
      {
        id: "old-unsettled",
        createdAt: "2026-03-09T08:00:00.000Z",
        unsettledAt: "2026-03-09T13:00:00.000Z",
      },
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      sortable({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["old-unsettled", "newest", "middle"]);
  });

  it("ignores a re-entry stamp older than the thread's creation", () => {
    const sorted = sortThreadsForSidebar([
      {
        id: "stale-stamp",
        createdAt: "2026-03-09T10:00:00.000Z",
        unsettledAt: "2026-03-09T09:00:00.000Z",
      },
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "stale-stamp"]);
  });
});

describe("pinOrderKeyBetween", () => {
  it("produces keys that sort between their bounds", () => {
    const middle = pinOrderKeyBetween(null, null)!;
    const top = pinOrderKeyBetween(null, middle)!;
    const bottom = pinOrderKeyBetween(middle, null)!;
    expect(top < middle).toBe(true);
    expect(middle < bottom).toBe(true);

    const between = pinOrderKeyBetween(top, middle)!;
    expect(top < between && between < middle).toBe(true);
  });

  it("extends into new digits when bounds are adjacent", () => {
    const key = pinOrderKeyBetween("g", "h")!;
    expect("g" < key && key < "h").toBe(true);
  });

  it("stays strictly ordered under repeated top insertion", () => {
    // Every new pin lands at the head of the arranged run; keys must keep
    // sorting before the previous head without ever bottoming out.
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("planPinnedReorder", () => {
  it("writes only the moved thread when neighbors are keyed", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["a", "c", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.id).toBe("c");
    expect(assignments[0]!.orderKey > "f" && assignments[0]!.orderKey < "m").toBe(true);
  });

  it("treats list edges as open bounds", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["b", "a"],
      keysById: new Map([
        ["a", "m"],
        ["b", null],
      ]),
      movedId: "b",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.orderKey < "m").toBe(true);
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["b", "a", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
    });
    expect(assignments.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    const keys = assignments.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("sorts roots before flattening their expanded subagent lineages", () => {
    const laterRoot = {
      ...makeSidebarThread({
        id: ThreadId.make("a-later-root"),
        projectId: ProjectId.make("project"),
      }),
      pinOrderKey: "z",
    };
    const laterChild = makeSubagentSidebarThread({
      id: "later-child",
      parentThreadId: "a-later-root",
    });
    const earlierRoot = {
      ...makeSidebarThread({
        id: ThreadId.make("z-earlier-root"),
        projectId: ProjectId.make("project"),
      }),
      pinOrderKey: "a",
    };
    const earlierChild = makeSubagentSidebarThread({
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

describe("sortSettledThreadsForSidebar", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    latestTurn?: OrchestrationLatestTurn | null;
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestTurn: input.latestTurn ?? null,
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("orders by settle time, most recently settled first", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({
        id: "settled-first",
        settledAt: "2026-03-09T10:00:00.000Z",
        // Created/active later than the other thread: settle time must win.
        latestUserMessageAt: "2026-03-09T09:59:00.000Z",
      }),
      settled({
        id: "settled-last",
        settledAt: "2026-03-09T12:00:00.000Z",
        latestUserMessageAt: "2026-03-09T08:00:00.000Z",
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["settled-last", "settled-first"]);
  });

  it("falls back to last activity for auto-settled threads without a settledAt stamp", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "auto-old", latestUserMessageAt: "2026-03-09T08:00:00.000Z" }),
      settled({ id: "explicit", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "auto-recent", latestUserMessageAt: "2026-03-09T11:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["auto-recent", "explicit", "auto-old"]);
  });

  it("counts a turn completion as activity for auto-settled threads", () => {
    // The message came in before the other thread's, but its turn finished
    // after: completion time is the real "work ended" moment.
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "message-only", latestUserMessageAt: "2026-03-09T10:04:00.000Z" }),
      settled({
        id: "completed-later",
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:30:00.000Z" }),
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["completed-later", "message-only"]);
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveWorkingStartedAt", () => {
  const session = {
    threadId: ThreadId.make("thread-1"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("uses the running turn's start time", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("uses the request time while a turn awaits adoption", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ startedAt: null, completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the session transition when the latest turn already completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn(),
        session,
      }),
    ).toBe("2026-03-09T10:02:00.000Z");
  });

  it("skips a malformed startedAt instead of returning it", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ startedAt: "not-a-date", completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("returns null with neither a running turn nor a session", () => {
    expect(resolveWorkingStartedAt({ latestTurn: null, session: null })).toBeNull();
  });
});

describe("formatWorkingDurationLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatWorkingDurationLabel(0)).toBe("0s");
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("clamps negative and non-finite elapsed values to zero", () => {
    expect(formatWorkingDurationLabel(-5_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the active sidebar surface when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("text-sidebar-foreground");
    expect(className).not.toContain("bg-primary");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-sidebar-row-selected");
    expect(className).toContain("hover:bg-sidebar-row-active");
    expect(className).not.toContain("bg-primary");
  });

  it("uses the active sidebar surface for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("hover:bg-sidebar-row-active");
  });
});

describe("resolveThreadListClassName", () => {
  it("keeps the project grouping rail for normal multi-project sidebars", () => {
    const className = resolveThreadListClassName({ hideThreadGroupRail: false });

    expect(className).not.toContain("border-l-0");
  });

  it("removes the project grouping rail when requested", () => {
    const className = resolveThreadListClassName({ hideThreadGroupRail: true });

    expect(className).toContain("border-l-0");
    expect(className).toContain("mx-0");
    expect(className).toContain("px-0");
    expect(className).toContain("sm:mx-0");
    expect(className).toContain("sm:px-0");
  });
});

describe("resolveSidebarOptionsMenuVisibility", () => {
  it("keeps sidebar options visible when project chrome is shown", () => {
    expect(resolveSidebarOptionsMenuVisibility({ hideProjectChrome: false })).toEqual({
      showButton: true,
      showProjectOptions: true,
      showThreadOptions: true,
    });
  });

  it("keeps sidebar options visible with only thread options when project chrome is hidden", () => {
    expect(resolveSidebarOptionsMenuVisibility({ hideProjectChrome: true })).toEqual({
      showButton: true,
      showProjectOptions: false,
      showThreadOptions: true,
    });
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
      ThreadId.make("thread-4"),
      ThreadId.make("thread-5"),
      ThreadId.make("thread-6"),
      ThreadId.make("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-7")]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

describe("filterVisibleSidebarThreads", () => {
  it("excludes archived shells and optimistically archived threads", () => {
    const visibleThread = makeThread({ id: ThreadId.make("thread-visible") });
    const optimisticThread = makeThread({ id: ThreadId.make("thread-optimistic") });
    const archivedThread = makeThread({
      id: ThreadId.make("thread-archived"),
      archivedAt: "2026-03-09T10:05:00.000Z",
    });
    const optimisticThreadKey = scopedThreadKey(
      scopeThreadRef(optimisticThread.environmentId, optimisticThread.id),
    );

    expect(
      filterVisibleSidebarThreads(
        [visibleThread, optimisticThread, archivedThread],
        new Set([optimisticThreadKey]),
      ).map((thread) => thread.id),
    ).toEqual([visibleThread.id]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            turnId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            turnId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });

  it("does not use optimistically archived threads as project activity", () => {
    const visibleProjectId = ProjectId.make("project-visible");
    const optimisticProjectId = ProjectId.make("project-optimistic");
    const optimisticThread = makeThread({
      id: ThreadId.make("thread-optimistic"),
      projectId: optimisticProjectId,
      updatedAt: "2026-03-09T10:10:00.000Z",
    });
    const sorted = sortScopedProjectsForSidebar(
      [
        makeProject({
          id: visibleProjectId,
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: optimisticProjectId,
          title: "Optimistic-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: visibleProjectId,
          updatedAt: "2026-03-09T10:02:00.000Z",
        }),
        optimisticThread,
      ],
      "updated_at",
      new Set([
        scopedThreadKey(scopeThreadRef(optimisticThread.environmentId, optimisticThread.id)),
      ]),
    );

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Optimistic-only project",
    ]);
  });
});

describe("sortLogicalProjectsForSidebar", () => {
  it("uses saved order only in manual mode and activity order otherwise", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "Older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    expect(sortLogicalProjectsForSidebar(projects, threads, "manual")).toEqual(projects);
    expect(
      sortLogicalProjectsForSidebar(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });

  it("does not use optimistically archived threads as logical project activity", () => {
    const visibleProjectId = ProjectId.make("project-visible");
    const optimisticProjectId = ProjectId.make("project-optimistic");
    const projects = [
      {
        ...makeProject({
          id: visibleProjectId,
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        projectKey: "logical-visible",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: visibleProjectId }],
      },
      {
        ...makeProject({
          id: optimisticProjectId,
          title: "Optimistic-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
        projectKey: "logical-optimistic",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: optimisticProjectId }],
      },
    ];
    const optimisticThread = makeThread({
      id: ThreadId.make("thread-optimistic"),
      projectId: optimisticProjectId,
      updatedAt: "2026-03-09T10:10:00.000Z",
    });

    expect(
      sortLogicalProjectsForSidebar(
        projects,
        [
          makeThread({
            id: ThreadId.make("thread-visible"),
            projectId: visibleProjectId,
            updatedAt: "2026-03-09T10:02:00.000Z",
          }),
          optimisticThread,
        ],
        "updated_at",
        new Set([
          scopedThreadKey(scopeThreadRef(optimisticThread.environmentId, optimisticThread.id)),
        ]),
      ).map((project) => project.projectKey),
    ).toEqual(["logical-visible", "logical-optimistic"]);
  });
});

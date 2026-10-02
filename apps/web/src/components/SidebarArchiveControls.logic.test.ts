import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import {
  buildMultiSelectThreadContextMenuItems,
  canArchiveSettledSidebarThread,
  filterArchivableSidebarThreads,
  shouldRenderSidebarArchiveAll,
} from "./SidebarArchiveControls.logic";
import { isSidebarThreadWorking } from "./Sidebar.logic";
import { archiveSelectedThreadEntries } from "./threadArchive.logic";

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
});

describe("shouldRenderSidebarArchiveAll", () => {
  it("keeps the action mounted only while work exists or a batch is in flight", () => {
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 1, isArchiving: false })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: true })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: false })).toBe(false);
  });
});

describe("archive eligibility with the Working shelf", () => {
  const settledThread = {
    threadKey: "settled-thread",
    session: null,
    backgroundLiveness: null,
    latestTurn: {
      turnId: TurnId.make("turn-completed"),
      state: "completed",
      assistantMessageId: null,
      requestedAt: "2026-10-02T12:00:00.000Z",
      startedAt: "2026-10-02T12:00:00.000Z",
      completedAt: "2026-10-02T12:01:00.000Z",
    },
    interactionMode: "default",
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } satisfies Parameters<typeof isSidebarThreadWorking>[0] & { threadKey: string };

  it.each([
    { name: "background work", backgroundLiveness: "working", inWorking: true },
    { name: "monitoring", backgroundLiveness: "monitoring", inWorking: true },
    {
      name: "an approval during background work",
      backgroundLiveness: "working",
      hasPendingApprovals: true,
      inWorking: false,
    },
    {
      name: "a question during monitoring",
      backgroundLiveness: "monitoring",
      hasPendingUserInput: true,
      inWorking: false,
    },
    {
      name: "a ready plan during background work",
      backgroundLiveness: "working",
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      inWorking: false,
    },
  ] as const)(
    "skips a settled thread when $name starts after confirmation",
    async ({ name: _name, inWorking, ...state }) => {
      const sibling = { ...settledThread, threadKey: "idle-sibling" };
      const confirmedEntries = filterArchivableSidebarThreads([settledThread, sibling]);
      const liveThread = { ...settledThread, ...state };
      const settledThreadKeys = new Set(confirmedEntries.map((thread) => thread.threadKey));

      expect(isSidebarThreadWorking(liveThread)).toBe(inWorking);
      expect(filterArchivableSidebarThreads([liveThread, sibling])).toEqual([sibling]);

      const archivedThreadKeys: string[] = [];
      const outcome = await archiveSelectedThreadEntries({
        entries: confirmedEntries,
        canArchive: (entry) =>
          canArchiveSettledSidebarThread({
            ...(entry.threadKey === liveThread.threadKey ? liveThread : sibling),
            settledThreadKeys,
          }),
        archive: async (entry, onArchived) => {
          archivedThreadKeys.push(entry.threadKey);
          onArchived();
          return { _tag: "Success" } as const;
        },
      });

      expect(archivedThreadKeys).toEqual([sibling.threadKey]);
      expect(outcome).toEqual({
        archivedThreadKeys: [sibling.threadKey],
        skippedThreadKeys: [liveThread.threadKey],
        mutationFailure: null,
        followupFailures: [],
      });
    },
  );
});

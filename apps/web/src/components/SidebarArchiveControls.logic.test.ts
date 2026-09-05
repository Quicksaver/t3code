import { describe, expect, it } from "vite-plus/test";

import {
  buildMultiSelectThreadContextMenuItems,
  filterArchivableSidebarThreads,
  shouldRenderSidebarArchiveAll,
} from "./SidebarArchiveControls.logic";

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

  it("omits root lifecycle actions for a selection containing child threads", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({
        count: 2,
        hasArchiveBlockedThread: false,
        canUseLifecycleActions: false,
      }),
    ).toEqual([{ id: "mark-unread", label: "Mark unread (2)" }]);
  });
});

describe("filterArchivableSidebarThreads", () => {
  it("keeps only idle root conversations", () => {
    const threads = [
      {
        id: "root",
        parentRelation: { kind: "root" },
        session: null,
        backgroundLiveness: null,
      },
      {
        id: "subagent",
        parentRelation: { kind: "subagent" },
        session: null,
        backgroundLiveness: null,
      },
      {
        id: "magi",
        parentRelation: { kind: "magi" },
        session: null,
        backgroundLiveness: null,
      },
      {
        id: "running",
        parentRelation: { kind: "root" },
        session: { status: "running", activeTurnId: "turn-1" },
        backgroundLiveness: null,
      },
    ] as const;

    expect(filterArchivableSidebarThreads(threads).map((thread) => thread.id)).toEqual(["root"]);
  });
});

describe("shouldRenderSidebarArchiveAll", () => {
  it("keeps the action mounted only while work exists or a batch is in flight", () => {
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 1, isArchiving: false })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: true })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: false })).toBe(false);
  });
});

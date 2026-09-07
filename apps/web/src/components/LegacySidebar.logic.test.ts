import { describe, expect, it } from "vite-plus/test";

import {
  buildLegacySidebarThreadContextMenuItems,
  canDispatchLegacySidebarBulkLifecycleAction,
  canUseLegacySidebarThreadLifecycleActions,
  shouldShowLegacySidebarInlineArchive,
} from "./LegacySidebar.logic";

const root = {
  branch: "main",
  parentRelation: { kind: "root" as const },
};
const legacyRoot = {
  branch: null,
  parentRelation: null,
};
const subagent = {
  branch: "feature/subagent",
  parentRelation: { kind: "subagent" as const },
};

const menuIds = (thread: Parameters<typeof buildLegacySidebarThreadContextMenuItems>[0]) =>
  buildLegacySidebarThreadContextMenuItems(thread).map((item) => item.id);
type LegacyLifecycleThread = NonNullable<
  Parameters<typeof canUseLegacySidebarThreadLifecycleActions>[0]
>;
const lifecycleThreadMap = (
  entries: ReadonlyArray<readonly [string, LegacyLifecycleThread]>,
): ReadonlyMap<string, LegacyLifecycleThread> => new Map(entries);

describe("Legacy Sidebar single-thread lifecycle permissions", () => {
  it("preserves inline archive and context-menu delete for resolved root shells", () => {
    expect(canUseLegacySidebarThreadLifecycleActions(root)).toBe(true);
    expect(canUseLegacySidebarThreadLifecycleActions(legacyRoot)).toBe(true);
    expect(shouldShowLegacySidebarInlineArchive({ thread: root, isRunning: false })).toBe(true);
    expect(menuIds(legacyRoot)).toEqual([
      "rename",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "project-settings",
      "delete",
    ]);
    expect(menuIds(root)).toEqual([
      "new-thread-on-branch",
      "rename",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "project-settings",
      "delete",
    ]);
  });

  it("hides inline archive and context-menu delete for persisted subagent shells", () => {
    expect(canUseLegacySidebarThreadLifecycleActions(subagent)).toBe(false);
    expect(shouldShowLegacySidebarInlineArchive({ thread: subagent, isRunning: false })).toBe(
      false,
    );
    expect(menuIds(subagent)).toEqual([
      "new-thread-on-branch",
      "rename",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "project-settings",
    ]);
  });

  it("fails closed when the shell is stale or unresolved", () => {
    expect(canUseLegacySidebarThreadLifecycleActions(null)).toBe(false);
    expect(canUseLegacySidebarThreadLifecycleActions(undefined)).toBe(false);
    expect(shouldShowLegacySidebarInlineArchive({ thread: null, isRunning: false })).toBe(false);
    expect(menuIds(null)).toEqual([]);
  });

  it("keeps inline archive hidden while a permitted root is running", () => {
    expect(shouldShowLegacySidebarInlineArchive({ thread: root, isRunning: true })).toBe(false);
  });
});

describe("Legacy Sidebar bulk lifecycle dispatch permissions", () => {
  const initialThreadKeys = new Set(["root", "legacy-root"]);

  it("accepts only the unchanged selection of resolved root shells", () => {
    expect(
      canDispatchLegacySidebarBulkLifecycleAction({
        initialThreadKeys,
        currentThreadKeys: ["legacy-root", "root"],
        currentThreadByKey: lifecycleThreadMap([
          ["root", root],
          ["legacy-root", legacyRoot],
        ]),
      }),
    ).toBe(true);
  });

  it("rejects changed selections and unresolved or subagent shells", () => {
    expect(
      canDispatchLegacySidebarBulkLifecycleAction({
        initialThreadKeys,
        currentThreadKeys: ["root", "replacement"],
        currentThreadByKey: lifecycleThreadMap([
          ["root", root],
          ["replacement", legacyRoot],
        ]),
      }),
    ).toBe(false);
    expect(
      canDispatchLegacySidebarBulkLifecycleAction({
        initialThreadKeys,
        currentThreadKeys: ["root", "legacy-root"],
        currentThreadByKey: lifecycleThreadMap([["root", root]]),
      }),
    ).toBe(false);
    expect(
      canDispatchLegacySidebarBulkLifecycleAction({
        initialThreadKeys,
        currentThreadKeys: ["root", "legacy-root"],
        currentThreadByKey: lifecycleThreadMap([
          ["root", root],
          ["legacy-root", subagent],
        ]),
      }),
    ).toBe(false);
  });
});

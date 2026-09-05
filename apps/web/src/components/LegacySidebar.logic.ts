import type { ContextMenuItem } from "@t3tools/contracts";

import { canUseRootThreadLifecycleActions } from "./threadActionMenu.logic";

type LegacySidebarParentRelation = { readonly kind: string } | null | undefined;

type LegacySidebarLifecycleShell = {
  readonly branch?: string | null | undefined;
  readonly parentRelation?: LegacySidebarParentRelation;
};

export type LegacySidebarThreadContextMenuId =
  | "new-thread-on-branch"
  | "rename"
  | "mark-unread"
  | "copy-path"
  | "copy-thread-id"
  | "project-settings"
  | "delete";

/** A missing shell is stale state, not an implicit legacy root. */
export function canUseLegacySidebarThreadLifecycleActions(
  thread: { readonly parentRelation?: LegacySidebarParentRelation } | null | undefined,
): boolean {
  return thread != null && canUseRootThreadLifecycleActions(thread);
}

export function shouldShowLegacySidebarInlineArchive(input: {
  thread: LegacySidebarLifecycleShell | null | undefined;
  isRunning: boolean;
}): boolean {
  return !input.isRunning && canUseLegacySidebarThreadLifecycleActions(input.thread);
}

export function canDispatchLegacySidebarBulkLifecycleAction(input: {
  initialThreadKeys: ReadonlySet<string>;
  currentThreadKeys: readonly string[];
  currentThreadByKey: ReadonlyMap<string, LegacySidebarLifecycleShell>;
}): boolean {
  if (input.currentThreadKeys.length !== input.initialThreadKeys.size) return false;
  if (!input.currentThreadKeys.every((threadKey) => input.initialThreadKeys.has(threadKey))) {
    return false;
  }
  return input.currentThreadKeys.every((threadKey) =>
    canUseLegacySidebarThreadLifecycleActions(input.currentThreadByKey.get(threadKey)),
  );
}

export function buildLegacySidebarThreadContextMenuItems(
  thread: LegacySidebarLifecycleShell | null | undefined,
): ReadonlyArray<ContextMenuItem<LegacySidebarThreadContextMenuId>> {
  if (!thread) return [];

  return [
    ...(thread.branch
      ? [{ id: "new-thread-on-branch" as const, label: `New thread on ${thread.branch}` }]
      : []),
    { id: "rename", label: "Rename thread" },
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-thread-id", label: "Copy Thread ID" },
    { id: "project-settings", label: "Project settings" },
    ...(canUseLegacySidebarThreadLifecycleActions(thread)
      ? [{ id: "delete" as const, label: "Delete", destructive: true, icon: "trash" as const }]
      : []),
  ];
}

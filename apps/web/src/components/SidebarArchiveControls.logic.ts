import type { ContextMenuItem } from "@t3tools/contracts";
import { isThreadArchiveBlocked, type ThreadArchiveState } from "./threadArchive.logic";
import { canUseRootThreadLifecycleActions } from "./threadActionMenu.logic";

export function shouldRenderSidebarArchiveAll(input: {
  archivableCount: number;
  isArchiving: boolean;
}): boolean {
  return input.archivableCount > 0 || input.isArchiving;
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasArchiveBlockedThread: boolean;
  canUseLifecycleActions?: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    ...(input.canUseLifecycleActions === false
      ? []
      : [
          {
            id: "archive" as const,
            label: `Archive (${input.count})`,
            disabled: input.hasArchiveBlockedThread,
          },
          { id: "delete" as const, label: `Delete (${input.count})`, destructive: true },
        ]),
  ];
}

export function canArchiveSettledSidebarThread(input: {
  readonly threadKey: string;
  readonly settledThreadKeys: ReadonlySet<string>;
  readonly session: ThreadArchiveState["session"];
  readonly backgroundLiveness: ThreadArchiveState["backgroundLiveness"];
}): boolean {
  return (
    input.settledThreadKeys.has(input.threadKey) &&
    !isThreadArchiveBlocked({
      session: input.session,
      backgroundLiveness: input.backgroundLiveness,
    })
  );
}

export function filterArchivableSidebarThreads<
  T extends ThreadArchiveState & {
    readonly parentRelation?: { readonly kind: string } | null | undefined;
  },
>(threads: readonly T[]): T[] {
  return threads.filter(
    (thread) => canUseRootThreadLifecycleActions(thread) && !isThreadArchiveBlocked(thread),
  );
}

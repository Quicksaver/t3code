import { T, useGT } from "gt-react";
import { ArchiveIcon, Undo2Icon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

export const SIDEBAR_LIFECYCLE_BUTTON_SURFACE_CLASS_NAME =
  "cursor-pointer rounded-md bg-transparent text-muted-foreground hover:text-foreground";
const SIDEBAR_ICON_LIFECYCLE_BUTTON_CLASS_NAME = cn(
  "inline-flex size-6 items-center justify-center",
  SIDEBAR_LIFECYCLE_BUTTON_SURFACE_CLASS_NAME,
);

export function SidebarSettledLifecycleControls({
  canUnsettle,
  archiveDisabled,
  preserveWokeStatus,
  onUnsettle,
  onUnsettlePointerDown,
  onArchive,
}: {
  canUnsettle: boolean;
  archiveDisabled: boolean;
  preserveWokeStatus: boolean;
  onUnsettle: (event: ReactMouseEvent) => void;
  onUnsettlePointerDown: (event: ReactPointerEvent) => void;
  onArchive: (() => void) | undefined;
}) {
  const gt = useGT();
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex items-center opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
        preserveWokeStatus && "has-[:focus-visible]:static group-any-hover/sidebar-row:static",
      )}
    >
      {canUnsettle ? (
        <SharedTooltipTrigger
          side="right"
          label={<T>Un-settle thread</T>}
          render={
            <button
              type="button"
              aria-label={gt("Un-settle thread")}
              onClick={onUnsettle}
              onPointerDown={onUnsettlePointerDown}
              className={SIDEBAR_ICON_LIFECYCLE_BUTTON_CLASS_NAME}
            />
          }
        >
          <Undo2Icon aria-hidden className="mb-px size-3.5" />
        </SharedTooltipTrigger>
      ) : null}
      {onArchive ? (
        <SharedTooltipTrigger
          side="right"
          label={
            archiveDisabled
              ? gt("Cannot archive while the provider is active.")
              : gt("Archive thread")
          }
          render={
            <button
              type="button"
              aria-label={gt("Archive thread")}
              aria-disabled={archiveDisabled || undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!archiveDisabled) onArchive();
              }}
              className={cn(
                SIDEBAR_ICON_LIFECYCLE_BUTTON_CLASS_NAME,
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:text-muted-foreground",
              )}
            >
              <ArchiveIcon aria-hidden className="size-3.5" />
            </button>
          }
        />
      ) : null}
    </span>
  );
}

export function SidebarArchiveAllButton({
  archivableCount,
  hasUnloadedThreads = false,
  isArchiving,
  onArchiveAll,
}: {
  archivableCount: number;
  hasUnloadedThreads?: boolean;
  isArchiving: boolean;
  onArchiveAll: () => void;
}) {
  const gt = useGT();
  // An in-flight batch stays mounted and focusable after its last row leaves;
  // the caller ignores repeat activations while it runs.
  return archivableCount > 0 || hasUnloadedThreads || isArchiving ? (
    <button
      type="button"
      aria-label={
        isArchiving
          ? gt("Archiving settled threads")
          : hasUnloadedThreads
            ? gt("Archive all settled threads")
            : gt(
                "{count, plural, =1 {Archive all {count} settled thread} other {Archive all {count} settled threads}}",
                { count: archivableCount },
              )
      }
      aria-disabled={isArchiving || undefined}
      aria-busy={isArchiving || undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onArchiveAll();
      }}
      className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-3xs text-sidebar-muted-foreground/70 transition-colors not-aria-disabled:hover:bg-sidebar-row-hover not-aria-disabled:hover:text-sidebar-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      <ArchiveIcon aria-hidden className="size-3" />
      <T>Archive all</T>
    </button>
  ) : null;
}

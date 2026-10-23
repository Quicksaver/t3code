import { ArchiveIcon, Undo2Icon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const SIDEBAR_LIFECYCLE_BUTTON_SURFACE_CLASS_NAME =
  "cursor-pointer rounded-md bg-transparent text-muted-foreground hover:text-foreground";
const SIDEBAR_ICON_LIFECYCLE_BUTTON_CLASS_NAME = cn(
  "inline-flex size-6 items-center justify-center",
  SIDEBAR_LIFECYCLE_BUTTON_SURFACE_CLASS_NAME,
);

export function SidebarSettledLifecycleControls({
  settlementSupported,
  archiveDisabled,
  preserveWokeStatus,
  onUnsettle,
  onUnsettlePointerDown,
  onArchive,
}: {
  settlementSupported: boolean;
  archiveDisabled: boolean;
  preserveWokeStatus: boolean;
  onUnsettle: (event: ReactMouseEvent) => void;
  onUnsettlePointerDown: (event: ReactPointerEvent) => void;
  onArchive: () => void;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex items-center opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
        preserveWokeStatus && "has-[:focus-visible]:static group-any-hover/sidebar-row:static",
      )}
    >
      {settlementSupported ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Un-settle thread"
                onClick={onUnsettle}
                onPointerDown={onUnsettlePointerDown}
                className={SIDEBAR_ICON_LIFECYCLE_BUTTON_CLASS_NAME}
              />
            }
          >
            <Undo2Icon aria-hidden className="mb-px size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Un-settle thread</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Archive thread"
              aria-disabled={archiveDisabled || undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                // The row is clickable: keep this click off it. A disabled
                // control stays focusable for its tooltip but never archives.
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
        <TooltipPopup side="top">
          {archiveDisabled ? "Cannot archive while the provider is active." : "Archive thread"}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

export function SidebarArchiveAllButton({
  archivableCount,
  isArchiving,
  onArchiveAll,
}: {
  archivableCount: number;
  isArchiving: boolean;
  onArchiveAll: () => void;
}) {
  // An in-flight batch stays mounted and focusable after its last row leaves;
  // the caller ignores repeat activations while it runs.
  return archivableCount > 0 || isArchiving ? (
    <button
      type="button"
      aria-label={
        isArchiving && archivableCount === 0
          ? "Archiving settled threads"
          : `Archive all ${archivableCount} settled thread${archivableCount === 1 ? "" : "s"}`
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
      Archive all
    </button>
  ) : null;
}

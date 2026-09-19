import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { SettingsGroup } from "./SettingsGroup";

/** Keeps editor and unavailable states the same height at the same panel width. */
export function SettingsListDetailFrame({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <SettingsGroup
      divided={false}
      className={cn(
        "@min-[48rem]/settings-list-detail:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/settings-list-detail:min-h-[32rem]",
        className,
      )}
    >
      {children}
    </SettingsGroup>
  );
}

export function SettingsListDetail({
  listLabel,
  controlLabel,
  items,
  footer,
  detail,
}: {
  readonly listLabel: ReactNode;
  readonly controlLabel?: ReactNode;
  readonly items: ReactNode;
  readonly footer?: ReactNode;
  readonly detail: ReactNode;
}) {
  return (
    <SettingsListDetailFrame className="overflow-hidden @min-[48rem]/settings-list-detail:grid @min-[48rem]/settings-list-detail:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/settings-list-detail:flex @min-[48rem]/settings-list-detail:min-h-0 @min-[48rem]/settings-list-detail:flex-col @min-[48rem]/settings-list-detail:border-r @min-[48rem]/settings-list-detail:border-b-0">
        <div className="flex min-h-9 shrink-0 items-center justify-between border-b border-border/70 px-3 text-[11px] font-medium text-muted-foreground">
          <span>{listLabel}</span>
          {controlLabel ? <span>{controlLabel}</span> : null}
        </div>
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="@min-[48rem]/settings-list-detail:min-h-0 @min-[48rem]/settings-list-detail:flex-1"
        >
          <div className="divide-y divide-border/60">{items}</div>
        </ScrollArea>
        {footer ? <div className="shrink-0 border-t border-border/60">{footer}</div> : null}
      </div>
      <div className="min-w-0 @min-[48rem]/settings-list-detail:min-h-0">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="h-auto @min-[48rem]/settings-list-detail:h-full"
        >
          {detail}
        </ScrollArea>
      </div>
    </SettingsListDetailFrame>
  );
}

export function SettingsListDetailRow({
  selected,
  inactive = false,
  onSelect,
  selectionLabel,
  leading,
  title,
  description,
  descriptionIndicator,
  secondary,
  control,
}: {
  readonly selected: boolean;
  readonly inactive?: boolean;
  readonly onSelect: () => void;
  readonly selectionLabel?: string;
  readonly leading: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly descriptionIndicator?: ReactNode;
  readonly secondary?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
        selected ? "bg-muted/45" : "hover:bg-muted/25",
      )}
    >
      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
          inactive && !selected && "opacity-60 group-hover:opacity-100",
        )}
      >
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={
            selectionLabel ?? (typeof title === "string" ? `Select ${title}` : "Select item")
          }
        />
        {leading}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            {secondary ? (
              <span className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                {secondary}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
            {descriptionIndicator ? (
              <span className="flex h-[1.45em] shrink-0 items-center">{descriptionIndicator}</span>
            ) : null}
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{description}</span>
          </span>
        </span>
      </div>
      {control ? <span className="flex h-5 shrink-0 items-center">{control}</span> : null}
    </div>
  );
}

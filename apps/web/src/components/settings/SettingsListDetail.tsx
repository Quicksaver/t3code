import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

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
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 lg:grid lg:h-[min(44rem,calc(100dvh-11rem))] lg:min-h-[32rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="border-b border-border/60 bg-muted/10 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex min-h-9 shrink-0 items-center justify-between border-b border-border/70 px-3 text-[11px] font-medium text-muted-foreground">
          <span>{listLabel}</span>
          {controlLabel ? <span>{controlLabel}</span> : null}
        </div>
        <div className="divide-y divide-border/60 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {items}
        </div>
        {footer ? <div className="shrink-0 border-t border-border/60">{footer}</div> : null}
      </div>
      <div className="min-w-0 lg:min-h-0">{detail}</div>
    </div>
  );
}

export function SettingsListDetailRow({
  selected,
  inactive = false,
  onSelect,
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
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
          inactive && !selected && "opacity-60 group-hover:opacity-100",
        )}
        onClick={onSelect}
        aria-pressed={selected}
      >
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
      </button>
      {control ? <span className="flex h-5 shrink-0 items-center">{control}</span> : null}
    </div>
  );
}

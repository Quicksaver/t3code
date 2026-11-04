import { WorkingIndicator } from "../WorkingIndicator";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { conversationItemStyles } from "../sidebar/conversationItemStyles";

import {
  SourceControlItemEnvironmentIcons,
  type SourceControlItemEnvironment,
} from "./SourceControlItemEnvironments";

export const actionableItemClassName = cn(
  conversationItemStyles.surface,
  conversationItemStyles.cardContent,
  "group/actionable-item min-w-0",
);

export function SourceControlActionableItem({
  kind,
  icon,
  title,
  metadata,
  trailingMetadata,
  time,
  activityLabel,
  actions,
  environments = [],
}: {
  readonly kind: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly metadata: ReactNode;
  readonly trailingMetadata?: ReactNode;
  readonly time?: ReactNode;
  readonly activityLabel?: string | null | undefined;
  readonly actions: ReactNode;
  readonly environments?: readonly SourceControlItemEnvironment[] | undefined;
}) {
  return (
    <>
      <div className={cn("flex h-5 min-w-0 items-center gap-1.5", conversationItemStyles.metadata)}>
        <span className="inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{kind}</span>
        {activityLabel ? (
          <WorkingIndicator label={activityLabel} />
        ) : (
          <div className="ml-auto grid shrink-0 items-center justify-items-end">
            <span className="pointer-events-none col-start-1 row-start-1 tabular-nums group-hover/actionable-item:opacity-0 group-focus-visible/actionable-item:opacity-0 group-has-[:focus-visible]/actionable-item:opacity-0 group-has-[[aria-busy=true]]/actionable-item:opacity-0">
              {time}
            </span>
            <div
              className="pointer-events-none col-start-1 row-start-1 flex items-center gap-0.5 opacity-0 group-hover/actionable-item:pointer-events-auto group-hover/actionable-item:opacity-100 group-focus-visible/actionable-item:pointer-events-auto group-focus-visible/actionable-item:opacity-100 group-has-[:focus-visible]/actionable-item:pointer-events-auto group-has-[:focus-visible]/actionable-item:opacity-100 group-has-[[aria-busy=true]]/actionable-item:pointer-events-auto group-has-[[aria-busy=true]]/actionable-item:opacity-100"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {actions}
            </div>
          </div>
        )}
      </div>
      <div className={cn("mt-1 truncate", conversationItemStyles.title)}>{title}</div>
      <div
        className={cn("mt-0.5 flex min-w-0 items-center gap-1.5", conversationItemStyles.metadata)}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <SourceControlItemEnvironmentIcons environments={environments} />
          {metadata}
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5 tabular-nums">
          {trailingMetadata}
        </div>
      </div>
    </>
  );
}

import { BotIcon, SquareIcon } from "lucide-react";

import {
  formatSubagentDuration,
  formatTerminalSubagentStatusDuration,
  LiveSubagentDuration,
  subagentStatusToneClass,
  type SubagentThreadStatus,
} from "../../subagentDisplay";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export function SubagentControlBar(props: {
  readonly title: string;
  readonly status: SubagentThreadStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly stopping: boolean;
  readonly onStop: () => void;
}) {
  const statusDuration =
    props.status === "running" ? (
      <LiveSubagentDuration startedAt={props.startedAt} />
    ) : (
      formatTerminalSubagentStatusDuration(
        props.status,
        formatSubagentDuration(props.startedAt, props.completedAt),
      )
    );

  return (
    <div className="rounded-xl border border-border/70 bg-card/55 px-3 py-2 shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full border",
            subagentStatusToneClass(props.status),
          )}
          aria-hidden="true"
        >
          <BotIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">Subagent - {props.title}</p>
          <p className="truncate text-xs text-muted-foreground">{statusDuration}</p>
        </div>
        {props.status === "running" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.stopping}
            onClick={props.onStop}
          >
            <SquareIcon className="size-3.5" />
            Stop
          </Button>
        ) : null}
      </div>
    </div>
  );
}

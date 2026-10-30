import { CircleDashedIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function WorkingIndicator({
  label,
  announce = true,
  size = "md",
}: {
  readonly label: string;
  readonly announce?: boolean;
  readonly size?: "sm" | "md";
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-info">
      <CircleDashedIcon
        aria-hidden
        className={cn("shrink-0", size === "sm" ? "size-3" : "size-4")}
      />
      <span role={announce ? "status" : undefined}>{label}</span>
    </span>
  );
}

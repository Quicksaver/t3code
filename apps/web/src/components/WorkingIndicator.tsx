import { CircleDashedIcon } from "lucide-react";

export function WorkingIndicator({ label, announce = true }: { readonly label: string; readonly announce?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-info">
      <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      <span role={announce ? "status" : undefined}>{label}</span>
    </span>
  );
}

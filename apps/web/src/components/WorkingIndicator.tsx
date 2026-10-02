import { CircleDashedIcon } from "lucide-react";

export function WorkingIndicator({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-working-foreground">
      <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      <span role="status">{label}</span>
    </span>
  );
}

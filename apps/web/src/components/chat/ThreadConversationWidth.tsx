import type { ComponentPropsWithRef, CSSProperties } from "react";

import { cn } from "~/lib/utils";

type ThreadConversationWidthVariant = "timeline" | "composer";
export type ThreadConversationMaxWidthPx = number | null | undefined;

export function normalizeThreadConversationMaxWidthStyleValue(
  maxWidthPx: ThreadConversationMaxWidthPx,
): number | "none" | undefined {
  if (maxWidthPx === undefined) {
    return undefined;
  }
  if (maxWidthPx === null) {
    return "none";
  }
  return Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? maxWidthPx : undefined;
}

export function resolveThreadConversationMaxWidthStyle(
  maxWidthPx: ThreadConversationMaxWidthPx,
): CSSProperties | undefined {
  const normalizedMaxWidth = normalizeThreadConversationMaxWidthStyleValue(maxWidthPx);
  if (normalizedMaxWidth === undefined) {
    return undefined;
  }
  return {
    maxWidth: normalizedMaxWidth === "none" ? "none" : `${normalizedMaxWidth}px`,
  };
}

function threadConversationWidthClassName(
  _variant: ThreadConversationWidthVariant,
  className: string | undefined,
) {
  return cn("t3-thread-conversation-width mx-auto max-w-none", className);
}

interface ThreadConversationWidthContainerProps extends ComponentPropsWithRef<"div"> {
  readonly variant?: ThreadConversationWidthVariant;
}

export function ThreadConversationWidthContainer({
  variant = "timeline",
  className,
  ...props
}: ThreadConversationWidthContainerProps) {
  return <div className={threadConversationWidthClassName(variant, className)} {...props} />;
}

interface ThreadConversationWidthFormProps extends ComponentPropsWithRef<"form"> {
  readonly variant?: ThreadConversationWidthVariant;
}

export function ThreadConversationWidthForm({
  variant = "timeline",
  className,
  ...props
}: ThreadConversationWidthFormProps) {
  return <form className={threadConversationWidthClassName(variant, className)} {...props} />;
}

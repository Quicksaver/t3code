import type { CSSProperties } from "react";

export type ThreadConversationMaxWidthPx = number | null | undefined;

const NO_THREAD_CONVERSATION_MAX_WIDTH_STYLE: CSSProperties = { maxWidth: "none" };

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
  if (normalizedMaxWidth === "none") {
    return NO_THREAD_CONVERSATION_MAX_WIDTH_STYLE;
  }
  return { maxWidth: `${normalizedMaxWidth}px` };
}

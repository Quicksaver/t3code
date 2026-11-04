export const conversationItemStyles = {
  surface:
    "group/conversation-item relative w-full cursor-pointer rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  idle: "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  receded:
    "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  active:
    "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
  selected:
    "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
  title: "text-sm font-medium text-foreground",
  readTitle:
    "text-sm font-normal text-foreground/75 group-hover/conversation-item:text-foreground group-focus-visible/conversation-item:text-foreground",
  metadata: "text-xs font-normal text-secondary-label",
  cardContent: "px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
} as const;

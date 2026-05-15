import type { ComponentPropsWithRef } from "react";

import { cn } from "~/lib/utils";

type ThreadConversationWidthVariant = "timeline" | "composer";

const variantClassNames: Record<ThreadConversationWidthVariant, string> = {
  timeline: "max-w-3xl",
  composer: "max-w-208",
};

function threadConversationWidthClassName(
  variant: ThreadConversationWidthVariant,
  className: string | undefined,
) {
  return cn("t3-thread-conversation-width mx-auto", variantClassNames[variant], className);
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

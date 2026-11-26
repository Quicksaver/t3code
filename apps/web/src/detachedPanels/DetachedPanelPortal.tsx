import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { PortalContainerProvider } from "../components/ui/portalContainer";
import { SharedTooltipProvider } from "../components/ui/shared-tooltip";
import type { DetachedWindow } from "./detachedWindows";

export function DetachedPanelPortal(props: {
  readonly detachedWindow: DetachedWindow;
  readonly target: "panelRoot" | "webviewRoot";
  readonly children: ReactNode;
}) {
  // The shared tooltip renders from its provider, so the provider must use the trigger's document.
  return createPortal(
    <PortalContainerProvider container={props.detachedWindow.portalRoot}>
      <SharedTooltipProvider>{props.children}</SharedTooltipProvider>
    </PortalContainerProvider>,
    props.detachedWindow[props.target],
  );
}

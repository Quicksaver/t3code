import { createContext, useContext } from "react";

import type { DetachedWindow } from "./detachedWindows";

export const DetachedPanelWindowContext = createContext<DetachedWindow | null>(null);

/** The detached window a panel renders in, or null inside the main window. */
export function useDetachedPanelWindow(): DetachedWindow | null {
  return useContext(DetachedPanelWindowContext);
}

import { createContext, useContext, type ReactNode } from "react";

import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

/** Where floating UI portals render; null means the main document body. */
const PortalContainerContext = createContext<HTMLElement | null>(null);

export function PortalContainerProvider(props: {
  readonly container: HTMLElement | null;
  readonly children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={props.container}>
      {props.children}
    </PortalContainerContext.Provider>
  );
}

/** Undefined keeps Base UI's default container, the document body. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}

/** Titlebar inset for overlays; a detached window's native frame sits outside its page. */
export function usePortalTitlebarHeight(): number {
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  return useContext(PortalContainerContext) ? 0 : nativeTitlebarHeight;
}

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, T } from "gt-react";
import { AppWindowIcon, PanelRightOpenIcon } from "lucide-react";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "../components/ui/button";
import type { MessageResolver } from "../i18n/messages";
import type { RightPanelSurface } from "../rightPanelStore";
import { reattachPanelSurface, focusDetachedPanel } from "./detachedPanelActions";
import { DetachedPanelWindowContext } from "./detachedPanelContext";
import { DetachedPanelPortal } from "./DetachedPanelPortal";
import {
  type DetachableSurface,
  detachedPanelWindowName,
  isDetachableSurface,
  selectThreadDetachedSurfaceIds,
  useDetachedPanelStore,
} from "./detachedPanelStore";
import { type DetachedWindow, setDetachedWindowTitle, useDetachedWindows } from "./detachedWindows";
import { claimDetachedPanelOwnership } from "./DetachedPanelsHost";

const SURFACE_KIND_LABELS = {
  preview: msg("Browser"),
  terminal: msg("Terminal"),
  device: msg("Device"),
  diff: msg("Diff"),
  files: msg("Files"),
  file: msg("File"),
  "pull-request": msg("Pull request"),
  "pull-requests": msg("Linked items"),
} satisfies Record<DetachableSurface["kind"], string>;

/** Panel kind, tab name and conversation, without repeating a tab named after its kind. */
export function detachedPanelWindowTitle(
  surface: DetachableSurface,
  tabName: string,
  conversationTitle: string,
  resolve: MessageResolver,
): string {
  const kind = resolve(SURFACE_KIND_LABELS[surface.kind]);
  return [kind, tabName === kind ? null : tabName, conversationTitle]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(" · ");
}

function useDocumentVisible(doc: Document): boolean {
  return useSyncExternalStore(
    (listener) => {
      doc.addEventListener("visibilitychange", listener);
      return () => doc.removeEventListener("visibilitychange", listener);
    },
    () => doc.visibilityState === "visible",
  );
}

interface DetachedPanelSurfacesProps {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: readonly RightPanelSurface[];
  readonly titleFor: (surface: DetachableSurface) => string;
  /** Renders the same content as the panel, with the window's visibility. */
  readonly renderSurface: (surface: RightPanelSurface, visible: boolean) => ReactNode;
  /** Panel-scoped shortcuts; returns whether the key was handled. */
  readonly onKeyDown: (
    surface: RightPanelSurface,
    event: KeyboardEvent,
    detachedWindow: Window & typeof globalThis,
  ) => boolean;
}

/** Renders the conversation's detached surfaces into their windows while it is the one shown. */
export function DetachedPanelSurfaces(props: DetachedPanelSurfacesProps) {
  const { threadRef, surfaces } = props;
  const threadKey = scopedThreadKey(threadRef);
  const detachedSurfaceIds = useDetachedPanelStore(
    useShallow((state) => selectThreadDetachedSurfaceIds(state.byName, threadKey)),
  );
  const windows = useDetachedWindows();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the window host which conversation's windows to show
  useEffect(() => claimDetachedPanelOwnership(threadKey), [threadKey]);

  return surfaces.map((surface) => {
    const name = detachedPanelWindowName(threadKey, surface.id);
    const detachedWindow = detachedSurfaceIds.includes(surface.id) ? windows.get(name) : undefined;
    if (!detachedWindow || !isDetachableSurface(surface)) return null;
    return (
      <DetachedPanelPortal key={name} detachedWindow={detachedWindow} target="panelRoot">
        <DetachedPanelFrame
          detachedWindow={detachedWindow}
          threadRef={threadRef}
          surface={surface}
          title={props.titleFor(surface)}
          renderSurface={props.renderSurface}
          onKeyDown={props.onKeyDown}
        />
      </DetachedPanelPortal>
    );
  });
}

function DetachedPanelFrame(props: {
  readonly detachedWindow: DetachedWindow;
  readonly threadRef: ScopedThreadRef;
  readonly surface: RightPanelSurface;
  readonly title: string;
  readonly renderSurface: DetachedPanelSurfacesProps["renderSurface"];
  readonly onKeyDown: DetachedPanelSurfacesProps["onKeyDown"];
}) {
  const { detachedWindow, surface, title, onKeyDown } = props;
  const visible = useDocumentVisible(detachedWindow.window.document);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the OS window title follows its document title
  useEffect(() => {
    setDetachedWindowTitle(detachedWindow, title);
  }, [detachedWindow, title]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for panel shortcuts in the detached window, which the main window never hears
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!onKeyDown(surface, event, detachedWindow.window)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    detachedWindow.window.addEventListener("keydown", listener, true);
    return () => detachedWindow.window.removeEventListener("keydown", listener, true);
  }, [detachedWindow, onKeyDown, surface]);

  return (
    <DetachedPanelWindowContext.Provider value={detachedWindow}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
        <Button
          size="compact"
          variant="ghost"
          onClick={() => reattachPanelSurface(props.threadRef, surface.id)}
        >
          <PanelRightOpenIcon />
          <T>Re-attach</T>
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {props.renderSurface(surface, visible)}
      </div>
    </DetachedPanelWindowContext.Provider>
  );
}

/** What the panel shows for a tab whose content lives in its own window. */
export function DetachedSurfacePlaceholder(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: RightPanelSurface;
}) {
  const { threadRef, surface } = props;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <AppWindowIcon className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        <T>This tab is open in its own window.</T>
      </p>
      <div className="flex gap-2">
        <Button
          size="compact"
          variant="outline"
          onClick={() => focusDetachedPanel(threadRef, surface.id)}
        >
          <T>Show window</T>
        </Button>
        <Button
          size="compact"
          variant="ghost"
          onClick={() => reattachPanelSurface(threadRef, surface.id)}
        >
          <PanelRightOpenIcon />
          <T>Re-attach</T>
        </Button>
      </div>
    </div>
  );
}

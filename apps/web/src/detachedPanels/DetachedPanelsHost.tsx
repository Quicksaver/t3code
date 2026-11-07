import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  cancelConfirmDialogsIn,
  setConfirmDialogContainerResolver,
  withConfirmDialogContainer,
} from "../confirmDialog";
import { setClipboardViewResolver } from "../hooks/useCopyToClipboard";
import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import {
  detachedPanelWindowName,
  isDetachedPanelsSupported,
  useDetachedPanelStore,
} from "./detachedPanelStore";
import {
  closeDetachedWindow,
  openDetachedWindow,
  readDetachedWindows,
  useDetachedWindows,
} from "./detachedWindows";

/**
 * The conversation whose detached windows show: the one rendering their content. Settings
 * opens over it and keeps it; a draft or the pull requests page renders none, so all hide.
 */
const useDetachedPanelOwnerStore = create<{
  readonly threadKey: string | null;
  /** Conversations shown this session; only their windows exist, so a launch opens no others. */
  readonly claimed: ReadonlySet<string>;
}>(() => ({ threadKey: null, claimed: new Set() }));

/** Returns the release for when that conversation stops rendering. */
export function claimDetachedPanelOwnership(threadKey: string): () => void {
  const { claimed } = useDetachedPanelOwnerStore.getState();
  useDetachedPanelOwnerStore.setState({
    threadKey,
    claimed: claimed.has(threadKey) ? claimed : new Set([...claimed, threadKey]),
  });
  return () => {
    if (useDetachedPanelOwnerStore.getState().threadKey === threadKey) {
      useDetachedPanelOwnerStore.setState({ threadKey: null });
    }
  };
}

/** App-lifetime owner of detached panel windows. Desktop only. */
export function DetachedPanelsHost() {
  return isDetachedPanelsSupported() ? <DetachedPanelWindows /> : null;
}

function DetachedPanelWindows() {
  const ownerThreadKey = useDetachedPanelOwnerStore((state) => state.threadKey);
  const claimed = useDetachedPanelOwnerStore((state) => state.claimed);
  // Names only: bounds change on every window move and must not re-run these effects.
  const names = useDetachedPanelStore(useShallow((state) => Object.keys(state.byName)));
  const windows = useDetachedWindows();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens and closes OS windows to match the detached panels
  useEffect(() => {
    const { byName } = useDetachedPanelStore.getState();
    const wanted = names.filter((name) => claimed.has(byName[name]?.threadKey ?? ""));
    for (const name of wanted) {
      if (!windows.has(name)) openDetachedWindow(name, byName[name]?.bounds ?? null);
    }
    for (const name of windows.keys()) {
      if (!wanted.includes(name)) closeDetachedWindow(name);
    }
  }, [claimed, names, windows]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the owner conversation's windows and hides the rest in the desktop
  useEffect(() => {
    const { byName } = useDetachedPanelStore.getState();
    const visible = names.filter(
      (name) => byName[name]?.threadKey === ownerThreadKey && windows.has(name),
    );
    // A confirmation left in a window that hides could not be answered and would block the rest.
    for (const [name, detached] of windows) {
      if (!visible.includes(name)) cancelConfirmDialogsIn(detached.portalRoot);
    }
    const bridge = window.desktopBridge?.detachedPanels;
    void bridge?.sync(visible);
    for (const name of windowsToFocus) {
      // A request outlives neither its surface nor its conversation being the one shown.
      if (byName[name]?.threadKey !== ownerThreadKey) windowsToFocus.delete(name);
      else if (visible.includes(name)) {
        windowsToFocus.delete(name);
        void bridge?.focus(name);
      }
    }
  }, [names, ownerThreadKey, windows]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop window events and the right panel store
  useEffect(() => {
    const bridge = window.desktopBridge?.detachedPanels;
    if (!bridge) return;
    const stopBounds = bridge.onBoundsChanged(({ name, bounds }) => {
      useDetachedPanelStore.getState().setBounds(name, bounds);
    });
    const stopCloseRequests = bridge.onCloseRequested(requestDetachedPanelClose);
    const pruneAndReveal = (
      next: ReturnType<typeof useRightPanelStore.getState>,
      previous: ReturnType<typeof useRightPanelStore.getState>,
    ) => {
      const activation = next.surfaceActivation;
      if (activation !== null && activation !== previous.surfaceActivation) {
        const name = detachedPanelWindowName(activation.threadKey, activation.surfaceId);
        // Navigating inside a detached window replaces its surface; the window follows it.
        if (activation.replaces !== undefined) {
          const replacedName = detachedPanelWindowName(activation.threadKey, activation.replaces);
          if (replacedName in useDetachedPanelStore.getState().byName) {
            if (readDetachedWindows().get(replacedName)?.window.document.hasFocus()) {
              windowsToFocus.add(name);
            }
            useDetachedPanelStore
              .getState()
              .replaceSurface(activation.threadKey, activation.replaces, activation.surfaceId);
          }
        }
        // A tab click, an open or an agent reveal of a detached surface brings its window back
        // up, even when that surface was already the active one.
        if (name in useDetachedPanelStore.getState().byName) void bridge.reveal(name);
      }
      if (next.byThreadKey === previous.byThreadKey) return;
      const detached = useDetachedPanelStore.getState().byName;
      const threadKeys = new Set(Object.values(detached).map((panel) => panel.threadKey));
      for (const threadKey of threadKeys) {
        const after = next.byThreadKey[threadKey];
        if (after === previous.byThreadKey[threadKey]) continue;
        const surfaceIds = new Set((after?.surfaces ?? []).map((surface) => surface.id));
        useDetachedPanelStore.getState().retainSurfaces(threadKey, surfaceIds);
      }
    };
    const stopPanels = useRightPanelStore.subscribe(pruneAndReveal);
    // A confirmation or copy started from a detached window, by a click or a key, uses that window.
    const focusedDetachedWindow = () =>
      [...readDetachedWindows().values()].find((detached) => detached.window.document.hasFocus());
    setConfirmDialogContainerResolver(() => focusedDetachedWindow()?.portalRoot ?? null);
    setClipboardViewResolver(() => focusedDetachedWindow()?.window ?? null);
    // Surfaces may have closed while the app was not running.
    const panels = useRightPanelStore.getState().byThreadKey;
    for (const threadKey of new Set(
      Object.values(useDetachedPanelStore.getState().byName).map((panel) => panel.threadKey),
    )) {
      const surfaces = panels[threadKey]?.surfaces ?? [];
      useDetachedPanelStore
        .getState()
        .retainSurfaces(threadKey, new Set(surfaces.map((surface) => surface.id)));
    }
    return () => {
      stopBounds();
      stopCloseRequests();
      stopPanels();
      setConfirmDialogContainerResolver(null);
      setClipboardViewResolver(null);
    };
  }, []);

  return ownerThreadKey === null ? null : (
    <DetachedPanelCloser key={ownerThreadKey} threadKey={ownerThreadKey} />
  );
}

// Windows that replaced a focused one and take its focus once they open.
const windowsToFocus = new Set<string>();

type SurfaceCloser = (surfaceId: string) => void;
const closers = new Map<string, SurfaceCloser>();

/** A window close follows its tab's close path, confirmation included. */
function requestDetachedPanelClose(name: string) {
  const panel = useDetachedPanelStore.getState().byName[name];
  if (!panel) {
    closeDetachedWindow(name);
    return;
  }
  const closer = closers.get(panel.threadKey);
  const container = readDetachedWindows().get(name)?.portalRoot;
  if (!closer || !container) return;
  withConfirmDialogContainer(container, () => closer(panel.surfaceId));
}

function DetachedPanelCloser(props: { readonly threadKey: string }) {
  const { threadKey } = props;
  const threadRef = parseScopedThreadKey(threadKey);
  const sessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const terminalLabelsById = new Map(
    (sessions ?? [])
      .filter((session) => session.target.threadId === threadRef?.threadId)
      .map((session) => [
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      ]),
  );
  const { closeSurface } = useRightPanelSurfaceClose({ threadRef, terminalLabelsById });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this conversation's close path for desktop window close requests
  useEffect(() => {
    if (!threadRef) return;
    const closer: SurfaceCloser = (surfaceId) => {
      const surface = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.find((entry) => entry.id === surfaceId);
      if (surface) closeSurface(surface);
      else useDetachedPanelStore.getState().reattach(detachedPanelWindowName(threadKey, surfaceId));
    };
    closers.set(threadKey, closer);
    return () => {
      if (closers.get(threadKey) === closer) closers.delete(threadKey);
    };
  }, [closeSurface, threadKey, threadRef]);

  return null;
}

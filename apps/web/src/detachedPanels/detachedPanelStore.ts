import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DESKTOP_DETACHED_PANEL_WINDOW_PREFIX,
  type DesktopDetachedPanelBounds,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import type { RightPanelSurface } from "../rightPanelStore";

export interface DetachedPanel {
  readonly threadKey: string;
  readonly surfaceId: string;
  readonly bounds: DesktopDetachedPanelBounds | null;
}

/** What a closed detached tab remembers, so reopening it detaches it again at its last bounds. */
export interface ClosedDetachedPanel {
  readonly bounds: DesktopDetachedPanelBounds | null;
}

interface DetachedPanelStoreState {
  /** Keyed by window name. */
  readonly byName: Record<string, DetachedPanel>;
  readonly detach: (
    ref: ScopedThreadRef,
    surfaceId: string,
    bounds?: DesktopDetachedPanelBounds | null,
  ) => void;
  readonly reattach: (name: string) => void;
  readonly setBounds: (name: string, bounds: DesktopDetachedPanelBounds) => void;
  /**
   * Moves a detached surface's window to the surface that replaced it in place, such as a folder
   * navigated from inside its window. A destination that is already detached keeps its own window.
   */
  readonly replaceSurface: (threadKey: string, fromSurfaceId: string, toSurfaceId: string) => void;
  /** Drops a thread's detached panels whose surfaces are gone, remembering them for reopen. */
  readonly retainSurfaces: (threadKey: string, surfaceIds: ReadonlySet<string>) => void;
  readonly removeThread: (threadKey: string) => void;
}

export function detachedPanelWindowName(threadKey: string, surfaceId: string): string {
  return `${DESKTOP_DETACHED_PANEL_WINDOW_PREFIX}${encodeURIComponent(threadKey)}/${encodeURIComponent(surfaceId)}`;
}

/** Side chats, the new-tab picker and device setup are transient, so they stay in the panel. */
export function isDetachableSurface(surface: RightPanelSurface): boolean {
  return surface.kind !== "side-chat" && surface.id !== "browser:new" && surface.id !== "device";
}

export function isDetachedPanelsSupported(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.detachedPanels !== undefined;
}

const CLOSED_PANEL_MEMORY = 40;
const recentlyClosed = new Map<string, ClosedDetachedPanel>();

function rememberClosed(name: string, panel: DetachedPanel) {
  recentlyClosed.delete(name);
  recentlyClosed.set(name, { bounds: panel.bounds });
  for (const oldest of recentlyClosed.keys()) {
    if (recentlyClosed.size <= CLOSED_PANEL_MEMORY) break;
    recentlyClosed.delete(oldest);
  }
}

export function isSurfaceDetached(ref: ScopedThreadRef, surfaceId: string): boolean {
  const name = detachedPanelWindowName(scopedThreadKey(ref), surfaceId);
  return name in useDetachedPanelStore.getState().byName;
}

/** Whether a tab being closed is, or just was, detached. */
export function closedDetachedPanel(
  threadKey: string,
  surfaceId: string,
): ClosedDetachedPanel | undefined {
  const name = detachedPanelWindowName(threadKey, surfaceId);
  const current = useDetachedPanelStore.getState().byName[name];
  return current ? { bounds: current.bounds } : recentlyClosed.get(name);
}

const withoutNames = (
  byName: Record<string, DetachedPanel>,
  remove: (panel: DetachedPanel) => boolean,
): Record<string, DetachedPanel> => {
  let changed = false;
  const next: Record<string, DetachedPanel> = {};
  for (const [name, panel] of Object.entries(byName)) {
    if (remove(panel)) {
      changed = true;
      continue;
    }
    next[name] = panel;
  }
  return changed ? next : byName;
};

export const useDetachedPanelStore = create<DetachedPanelStoreState>()(
  persist(
    (set) => ({
      byName: {},
      detach: (ref, surfaceId, bounds = null) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const name = detachedPanelWindowName(threadKey, surfaceId);
          if (state.byName[name]) return state;
          recentlyClosed.delete(name);
          return { byName: { ...state.byName, [name]: { threadKey, surfaceId, bounds } } };
        }),
      reattach: (name) =>
        set((state) => {
          if (!(name in state.byName)) return state;
          const { [name]: _removed, ...byName } = state.byName;
          return { byName };
        }),
      setBounds: (name, bounds) =>
        set((state) => {
          const current = state.byName[name];
          if (!current) return state;
          return { byName: { ...state.byName, [name]: { ...current, bounds } } };
        }),
      replaceSurface: (threadKey, fromSurfaceId, toSurfaceId) =>
        set((state) => {
          const fromName = detachedPanelWindowName(threadKey, fromSurfaceId);
          const from = state.byName[fromName];
          if (!from) return state;
          const { [fromName]: _replaced, ...byName } = state.byName;
          const toName = detachedPanelWindowName(threadKey, toSurfaceId);
          if (byName[toName]) return { byName };
          return {
            byName: {
              ...byName,
              [toName]: { threadKey, surfaceId: toSurfaceId, bounds: from.bounds },
            },
          };
        }),
      retainSurfaces: (threadKey, surfaceIds) =>
        set((state) => {
          const byName = withoutNames(state.byName, (panel) => {
            if (panel.threadKey !== threadKey || surfaceIds.has(panel.surfaceId)) return false;
            rememberClosed(detachedPanelWindowName(panel.threadKey, panel.surfaceId), panel);
            return true;
          });
          return byName === state.byName ? state : { byName };
        }),
      removeThread: (threadKey) =>
        set((state) => {
          const byName = withoutNames(state.byName, (panel) => panel.threadKey === threadKey);
          return byName === state.byName ? state : { byName };
        }),
    }),
    {
      name: "t3code:detached-panels:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ byName }) => ({ byName }),
    },
  ),
);

/** A thread's detached surface ids, for a shallow-compared selector that ignores bounds. */
export function selectThreadDetachedSurfaceIds(
  byName: Record<string, DetachedPanel>,
  threadKey: string | null,
): string[] {
  if (threadKey === null) return [];
  return Object.values(byName)
    .filter((panel) => panel.threadKey === threadKey)
    .map((panel) => panel.surfaceId);
}

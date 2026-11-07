import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  detachedPanelWindowName,
  isDetachableSurface,
  isDetachedPanelsSupported,
  useDetachedPanelStore,
} from "./detachedPanelStore";

function closesMiniPlayer(ref: ScopedThreadRef, surface: RightPanelSurface): boolean {
  const source = usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(ref)]?.source;
  if (!source) return false;
  if (source.kind === "browser") {
    return surface.kind === "preview" && surface.resourceId === source.tabId;
  }
  return (
    surface.kind === "device" &&
    surface.target?.hostId === source.hostId &&
    surface.target.deviceId === source.deviceId
  );
}

export function canDetachSurface(surface: RightPanelSurface): boolean {
  return isDetachedPanelsSupported() && isDetachableSurface(surface);
}

export function detachPanelSurface(ref: ScopedThreadRef, surface: RightPanelSurface): void {
  if (!canDetachSurface(surface)) return;
  // One webview or stream view cannot show in two places.
  if (closesMiniPlayer(ref, surface)) usePreviewMiniPlayerStore.getState().close(ref);
  useDetachedPanelStore.getState().detach(ref, surface.id);
}

export function reattachPanelSurface(ref: ScopedThreadRef, surfaceId: string): void {
  useDetachedPanelStore
    .getState()
    .reattach(detachedPanelWindowName(scopedThreadKey(ref), surfaceId));
}

export function focusDetachedPanel(ref: ScopedThreadRef, surfaceId: string): void {
  void window.desktopBridge?.detachedPanels?.focus(
    detachedPanelWindowName(scopedThreadKey(ref), surfaceId),
  );
}

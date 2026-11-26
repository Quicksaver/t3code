import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { DesktopPreviewOverlay } from "~/previewStateStore";

import { previewBridge } from "./preview/previewBridge";

/**
 * Label and enabled state for a browser tab's mute menu entry. Overlay state
 * must exist before the desktop tab can safely be addressed.
 */
export function browserTabMuteMenuItem(
  input: {
    overlay: DesktopPreviewOverlay | null;
    canResolveRuntimeTabId: boolean;
  },
  resolve: MessageResolver = m,
): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? resolve(msg("Unmute tab")) : resolve(msg("Mute tab")),
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

export function setBrowserTabAudioMuted(runtimeTabId: string, muted: boolean): void {
  void previewBridge?.setAudioMuted(runtimeTabId, muted).catch(() => undefined);
}

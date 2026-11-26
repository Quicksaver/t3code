export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "back"
  | "forward"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom"
  | "find";

/** Preview keybinding commands a detached browser window handles itself. */
export const PREVIEW_COMMAND_ACTIONS: Readonly<Record<string, PreviewAction>> = {
  "preview.refresh": "refresh",
  "preview.focusUrl": "focus-url",
  "preview.zoomIn": "zoom-in",
  "preview.zoomOut": "zoom-out",
  "preview.resetZoom": "reset-zoom",
  "preview.find": "find",
};

const EVENT_NAME = "t3code:preview-action";

/** `target` is the window whose previews act: the main window, or one detached panel window. */
export function dispatchPreviewAction(
  action: PreviewAction,
  target?: Window & typeof globalThis,
): void {
  const view = target ?? (typeof window === "undefined" ? undefined : window);
  if (view === undefined) return;
  view.dispatchEvent(new view.CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(
  listener: (action: PreviewAction) => void,
  target?: Window & typeof globalThis,
): () => void {
  const view = target ?? (typeof window === "undefined" ? undefined : window);
  if (view === undefined) return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  view.addEventListener(EVENT_NAME, handler);
  return () => view.removeEventListener(EVENT_NAME, handler);
}

// @effect-diagnostics globalTimers:off -- Electron window listeners debounce bounds outside the Effect runtime.
import type * as Electron from "electron";

import {
  DESKTOP_DETACHED_PANEL_WINDOW_PREFIX,
  type DesktopDetachedPanelBounds,
  type DesktopDetachedPanelBoundsEvent,
} from "@t3tools/contracts";

import {
  DETACHED_PANELS_BOUNDS_CHANNEL,
  DETACHED_PANELS_CLOSE_REQUESTED_CHANNEL,
} from "../ipc/channels.ts";

const DETACHED_PANEL_DEFAULT_SIZE = { width: 760, height: 680 } as const;
export const DETACHED_PANEL_MIN_SIZE = { width: 360, height: 260 } as const;
const BOUNDS_PERSIST_DEBOUNCE_MS = 300;
// A restored window must leave this much of its top edge on a display, so its title bar stays grabbable.
const MIN_VISIBLE_TITLE_BAR = { width: 120, height: 32 } as const;

type Rectangle = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

/**
 * App menu accelerators a detached window keeps: editing roles, plus macOS Quit and the window
 * management roles (minimize, hide, hide others, full screen) that act on the focused window.
 */
export function keepsDetachedMenuShortcut(
  input: Pick<Electron.Input, "code" | "meta" | "control" | "alt" | "shift">,
  platform: NodeJS.Platform,
  isEditingShortcut: boolean,
): boolean {
  if (isEditingShortcut) return true;
  if (platform !== "darwin" || !input.meta || input.shift) return false;
  // Option changes the key on macOS, so match the physical key.
  if (input.control) return !input.alt && input.code === "KeyF";
  if (input.alt) return input.code === "KeyH";
  return input.code === "KeyQ" || input.code === "KeyM" || input.code === "KeyH";
}

function isDetachedPanelWindowName(name: string): boolean {
  return (
    name.startsWith(DESKTOP_DETACHED_PANEL_WINDOW_PREFIX) &&
    name.length > DESKTOP_DETACHED_PANEL_WINDOW_PREFIX.length
  );
}

/** Reads `left`, `top`, `width` and `height` from a `window.open` features string. */
export function parseDetachedPanelWindowFeatures(
  features: string,
): Partial<DesktopDetachedPanelBounds> {
  const keys = { left: "x", top: "y", width: "width", height: "height" } as const;
  const bounds: { -readonly [Key in keyof DesktopDetachedPanelBounds]?: number } = {};
  for (const entry of features.split(",")) {
    const [rawKey, rawValue] = entry.split("=");
    const key = keys[rawKey?.trim().toLowerCase() as keyof typeof keys];
    const value = Number(rawValue?.trim());
    if (key !== undefined && rawValue !== undefined && Number.isFinite(value)) {
      bounds[key] = Math.round(value);
    }
  }
  return bounds;
}

/**
 * Keeps the requested position only while its title bar stays on a connected display;
 * otherwise Electron centers the window.
 */
export function resolveDetachedPanelWindowBounds(
  requested: Partial<DesktopDetachedPanelBounds>,
  displays: readonly Rectangle[],
): { x?: number; y?: number; width: number; height: number } {
  const width = Math.max(
    DETACHED_PANEL_MIN_SIZE.width,
    requested.width ?? DETACHED_PANEL_DEFAULT_SIZE.width,
  );
  const height = Math.max(
    DETACHED_PANEL_MIN_SIZE.height,
    requested.height ?? DETACHED_PANEL_DEFAULT_SIZE.height,
  );
  const { x, y } = requested;
  if (x === undefined || y === undefined) return { width, height };
  const titleBarVisible = displays.some((display) => {
    const overlapWidth = Math.min(x + width, display.x + display.width) - Math.max(x, display.x);
    const overlapHeight =
      Math.min(y + MIN_VISIBLE_TITLE_BAR.height, display.y + display.height) -
      Math.max(y, display.y);
    return (
      overlapWidth >= MIN_VISIBLE_TITLE_BAR.width && overlapHeight >= MIN_VISIBLE_TITLE_BAR.height
    );
  });
  return titleBarVisible ? { x, y, width, height } : { width, height };
}

interface DetachedPanelWindow {
  readonly window: Electron.BrowserWindow;
  /** Set before an app-initiated close, so `close` does not become a user close request. */
  closeAllowed: boolean;
  /** Hidden because another conversation is active, not by the user. */
  hiddenByApp: boolean;
  /** Minimized when the app hid it; showing it again keeps it minimized. */
  minimizedWhenHidden: boolean;
  boundsTimer: ReturnType<typeof setTimeout> | null;
}

export interface DetachedPanelWindowsOptions {
  readonly isQuitting: () => boolean;
  /** Window options shared with the app, such as icon and background color. */
  readonly windowOptions: () => Electron.BrowserWindowConstructorOptions;
  readonly displays: () => readonly Rectangle[];
  /** Detached windows render through the main renderer, so it must not throttle while one shows. */
  readonly setMainRendererUnthrottled: (unthrottled: boolean) => void;
  /** Installs webview hardening, context menus and other per-contents handlers on a new window. */
  readonly onWindowCreated: (window: Electron.BrowserWindow) => void;
  readonly onExternalUrl: (url: string) => void;
  /** App menu accelerators stay off in detached windows except these, such as editing roles. */
  readonly keepsMenuShortcut: (input: Electron.Input) => boolean;
}

export interface DetachedPanelWindows {
  /** Answers the main window's `window.open` handler, or null for names it does not own. */
  readonly windowOpenResponse: (
    details: Pick<Electron.HandlerDetails, "frameName" | "features" | "url">,
  ) => Electron.WindowOpenHandlerResponse | null;
  readonly attach: (mainWindow: Electron.BrowserWindow) => void;
  readonly sync: (visible: readonly string[]) => void;
  readonly reveal: (name: string) => void;
  readonly focus: (name: string) => void;
  readonly close: (name: string) => void;
  readonly closeAll: () => void;
}

export function makeDetachedPanelWindows(
  options: DetachedPanelWindowsOptions,
): DetachedPanelWindows {
  const windows = new Map<string, DetachedPanelWindow>();
  let mainWindow: Electron.BrowserWindow | null = null;
  let mainUnthrottled = false;

  const isLive = (entry: DetachedPanelWindow) => !entry.window.isDestroyed();

  const updateMainThrottling = () => {
    const anyShown = [...windows.values()].some(
      (entry) => isLive(entry) && entry.window.isVisible() && !entry.window.isMinimized(),
    );
    if (anyShown === mainUnthrottled) return;
    mainUnthrottled = anyShown;
    options.setMainRendererUnthrottled(anyShown);
  };

  const sendToMain = (channel: string, payload: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  };

  const closeEntry = (entry: DetachedPanelWindow) => {
    if (!isLive(entry)) return;
    entry.closeAllowed = true;
    entry.window.close();
  };

  const closeAll = () => {
    for (const entry of windows.values()) closeEntry(entry);
  };

  const adopt = (window: Electron.BrowserWindow, name: string) => {
    const existing = windows.get(name);
    if (existing && isLive(existing)) closeEntry(existing);
    const entry: DetachedPanelWindow = {
      window,
      closeAllowed: false,
      hiddenByApp: true,
      minimizedWhenHidden: false,
      boundsTimer: null,
    };
    windows.set(name, entry);
    const publishBounds = () => {
      entry.boundsTimer = null;
      if (!isLive(entry)) return;
      const bounds = window.getNormalBounds();
      const event: DesktopDetachedPanelBoundsEvent = {
        name,
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        },
      };
      sendToMain(DETACHED_PANELS_BOUNDS_CHANNEL, event);
    };
    const scheduleBounds = () => {
      if (entry.boundsTimer !== null) clearTimeout(entry.boundsTimer);
      entry.boundsTimer = setTimeout(publishBounds, BOUNDS_PERSIST_DEBOUNCE_MS);
    };
    window.on("move", scheduleBounds);
    window.on("resize", scheduleBounds);
    window.on("show", updateMainThrottling);
    window.on("hide", updateMainThrottling);
    window.on("minimize", updateMainThrottling);
    window.on("restore", updateMainThrottling);
    window.on("close", (event) => {
      if (entry.closeAllowed || options.isQuitting()) return;
      event.preventDefault();
      sendToMain(DETACHED_PANELS_CLOSE_REQUESTED_CHANNEL, name);
    });
    window.on("closed", () => {
      if (entry.boundsTimer !== null) clearTimeout(entry.boundsTimer);
      if (windows.get(name) === entry) windows.delete(name);
      updateMainThrottling();
    });
    // App-wide accelerators (reload, zoom, settings) would act on the main window from here.
    window.webContents.setIgnoreMenuShortcuts(true);
    window.webContents.on("before-input-event", (_event, input) => {
      if (window.isDestroyed() || input.type !== "keyDown") return;
      window.webContents.setIgnoreMenuShortcuts(!options.keepsMenuShortcut(input));
    });
    // The renderer owns this document; nothing may navigate it away from about:blank.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      options.onExternalUrl(url);
      return { action: "deny" };
    });
    options.onWindowCreated(window);
  };

  return {
    windowOpenResponse: ({ frameName, features, url }) => {
      if (!isDetachedPanelWindowName(frameName)) return null;
      if (options.isQuitting() || (url !== "about:blank" && url !== "")) return { action: "deny" };
      const bounds = resolveDetachedPanelWindowBounds(
        parseDetachedPanelWindowFeatures(features),
        options.displays(),
      );
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...options.windowOptions(),
          ...bounds,
          minWidth: DETACHED_PANEL_MIN_SIZE.width,
          minHeight: DETACHED_PANEL_MIN_SIZE.height,
          show: false,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: true,
            disableHtmlFullscreenWindowResize: true,
          },
        },
      };
    },
    attach: (window) => {
      mainWindow = window;
      window.webContents.on("did-create-window", (child, details) => {
        if (isDetachedPanelWindowName(details.frameName)) adopt(child, details.frameName);
      });
      // Detached documents are driven by this renderer; a new document orphans them.
      window.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) closeAll();
      });
      window.webContents.on("render-process-gone", closeAll);
      window.on("close", closeAll);
      window.on("closed", () => {
        if (mainWindow === window) mainWindow = null;
      });
    },
    sync: (visible) => {
      const shown = new Set(visible);
      for (const [name, entry] of windows) {
        if (!isLive(entry)) continue;
        const { window } = entry;
        if (shown.has(name)) {
          if (!entry.hiddenByApp) continue;
          entry.hiddenByApp = false;
          if (entry.minimizedWhenHidden) window.minimize();
          else window.showInactive();
        } else if (!entry.hiddenByApp) {
          entry.hiddenByApp = true;
          entry.minimizedWhenHidden = window.isMinimized();
          window.hide();
        }
      }
      updateMainThrottling();
    },
    reveal: (name) => {
      const entry = windows.get(name);
      if (!entry || !isLive(entry) || entry.hiddenByApp) return;
      if (entry.window.isMinimized() || !entry.window.isVisible()) entry.window.showInactive();
    },
    focus: (name) => {
      const entry = windows.get(name);
      if (!entry || !isLive(entry)) return;
      entry.hiddenByApp = false;
      entry.minimizedWhenHidden = false;
      if (entry.window.isMinimized()) entry.window.restore();
      entry.window.show();
      entry.window.focus();
    },
    close: (name) => {
      const entry = windows.get(name);
      if (entry) closeEntry(entry);
    },
    closeAll,
  };
}

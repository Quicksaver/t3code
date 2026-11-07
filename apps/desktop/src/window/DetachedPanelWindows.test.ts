// @effect-diagnostics nodeBuiltinImport:off - EventEmitters stand in for Electron windows.
import * as NodeEvents from "node:events";
import { DESKTOP_DETACHED_PANEL_WINDOW_PREFIX } from "@t3tools/contracts";
import type * as Electron from "electron";
import { describe, expect, it } from "vite-plus/test";

import { DETACHED_PANELS_CLOSE_REQUESTED_CHANNEL } from "../ipc/channels.ts";
import {
  DETACHED_PANEL_MIN_SIZE,
  keepsDetachedMenuShortcut,
  makeDetachedPanelWindows,
  parseDetachedPanelWindowFeatures,
  resolveDetachedPanelWindowBounds,
} from "./DetachedPanelWindows.ts";

class FakeWindow extends NodeEvents.EventEmitter {
  destroyed = false;
  visible = false;
  minimized = false;
  readonly calls: string[] = [];
  readonly sent: Array<readonly [string, unknown]> = [];
  ignoresMenuShortcuts = false;
  readonly webContents = Object.assign(new NodeEvents.EventEmitter(), {
    send: (channel: string, payload: unknown) => {
      this.sent.push([channel, payload]);
    },
    setWindowOpenHandler: () => {},
    setIgnoreMenuShortcuts: (ignore: boolean) => {
      this.ignoresMenuShortcuts = ignore;
    },
  });

  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  showInactive() {
    this.calls.push("showInactive");
    this.visible = true;
    this.minimized = false;
    this.emit("show");
  }
  hide() {
    this.calls.push("hide");
    this.visible = false;
    this.emit("hide");
  }
  minimize() {
    this.calls.push("minimize");
    this.visible = true;
    this.minimized = true;
    this.emit("minimize");
  }
  restore() {
    this.minimized = false;
  }
  show() {
    this.visible = true;
  }
  focus() {}
  getNormalBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  close() {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit("close", event);
    if (event.defaultPrevented) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

const NAME_A = `${DESKTOP_DETACHED_PANEL_WINDOW_PREFIX}thread-1/terminal%3A1`;
const NAME_B = `${DESKTOP_DETACHED_PANEL_WINDOW_PREFIX}thread-2/device`;

function setup() {
  let quitting = false;
  const throttling: boolean[] = [];
  const main = new FakeWindow();
  const panels = makeDetachedPanelWindows({
    isQuitting: () => quitting,
    windowOptions: () => ({}),
    displays: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
    setMainRendererUnthrottled: (unthrottled) => throttling.push(unthrottled),
    onWindowCreated: () => {},
    onExternalUrl: () => {},
    keepsMenuShortcut: (input) => input.control && input.key === "c",
  });
  panels.attach(main as unknown as Electron.BrowserWindow);
  const open = (name: string) => {
    const child = new FakeWindow();
    main.webContents.emit("did-create-window", child, { frameName: name });
    return child;
  };
  return {
    main,
    panels,
    open,
    throttling,
    quit: () => {
      quitting = true;
    },
  };
}

const closeRequests = (main: FakeWindow) =>
  main.sent.filter(([channel]) => channel === DETACHED_PANELS_CLOSE_REQUESTED_CHANNEL);

describe("detached panel windows", () => {
  it("turns only a user close into a close request", () => {
    const { main, panels, open, quit } = setup();
    const userClosed = open(NAME_A);
    userClosed.close();
    expect(userClosed.destroyed).toBe(false);
    expect(closeRequests(main)).toEqual([[DETACHED_PANELS_CLOSE_REQUESTED_CHANNEL, NAME_A]]);

    panels.close(NAME_A);
    expect(userClosed.destroyed).toBe(true);

    const reloaded = open(NAME_A);
    main.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(reloaded.destroyed).toBe(true);

    const mainClosed = open(NAME_A);
    main.emit("close");
    expect(mainClosed.destroyed).toBe(true);

    const quitClosed = open(NAME_B);
    quit();
    quitClosed.close();
    expect(quitClosed.destroyed).toBe(true);
    expect(closeRequests(main)).toHaveLength(1);
  });

  it("shows the owner's windows without focus and keeps a minimized one minimized", () => {
    const { panels, open, throttling } = setup();
    const owned = open(NAME_A);
    const other = open(NAME_B);

    panels.sync([NAME_A]);
    expect(owned.calls).toEqual(["showInactive"]);
    expect(other.visible).toBe(false);
    expect(throttling).toEqual([true]);

    owned.minimize();
    panels.sync([NAME_B]);
    panels.sync([NAME_A]);
    expect(owned.calls).toEqual(["showInactive", "minimize", "hide", "minimize"]);
    expect(other.calls).toEqual(["showInactive", "hide"]);
    // Only a minimized window is shown, so the main renderer may throttle again.
    expect(throttling.at(-1)).toBe(false);
  });

  it("lets only allowed menu accelerators through a detached window", () => {
    const { open } = setup();
    const child = open(NAME_A);
    const contents = child.webContents;
    const press = (key: string) =>
      contents.emit("before-input-event", {}, { type: "keyDown", key, control: true });
    expect(child.ignoresMenuShortcuts).toBe(true);
    press("c");
    expect(child.ignoresMenuShortcuts).toBe(false);
    press("r");
    expect(child.ignoresMenuShortcuts).toBe(true);

    child.destroyed = true;
    Object.defineProperty(child, "webContents", {
      get: () => {
        throw new TypeError("Object has been destroyed");
      },
    });
    expect(() => press("c")).not.toThrow();

    const mac = (code: string, modifiers: { control?: boolean; alt?: boolean } = {}) =>
      keepsDetachedMenuShortcut(
        { code, meta: true, control: false, alt: false, shift: false, ...modifiers },
        "darwin",
        false,
      );
    expect(["KeyQ", "KeyM", "KeyH"].map((code) => mac(code))).toEqual([true, true, true]);
    expect(mac("KeyH", { alt: true })).toBe(true);
    expect(mac("KeyF", { control: true })).toBe(true);
    expect(mac("KeyR")).toBe(false);
    expect(mac("Comma")).toBe(false);
  });

  it("answers only its own window names", () => {
    const { panels, quit } = setup();
    expect(panels.windowOpenResponse({ frameName: "", features: "", url: "about:blank" })).toBe(
      null,
    );
    expect(
      panels.windowOpenResponse({ frameName: NAME_A, features: "", url: "https://example.com" }),
    ).toEqual({ action: "deny" });
    expect(
      panels.windowOpenResponse({ frameName: NAME_A, features: "", url: "about:blank" })?.action,
    ).toBe("allow");
    quit();
    expect(
      panels.windowOpenResponse({ frameName: NAME_A, features: "", url: "about:blank" }),
    ).toEqual({ action: "deny" });
  });

  it("keeps a saved position only while its title bar stays on a display", () => {
    const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const requested = parseDetachedPanelWindowFeatures("left=100,top=50,width=900,height=700");
    expect(requested).toEqual({ x: 100, y: 50, width: 900, height: 700 });
    expect(resolveDetachedPanelWindowBounds(requested, displays)).toEqual(requested);
    expect(
      resolveDetachedPanelWindowBounds({ x: 2400, y: 50, width: 900, height: 700 }, displays),
    ).toEqual({ width: 900, height: 700 });
    expect(resolveDetachedPanelWindowBounds({ width: 10, height: 10 }, displays)).toEqual(
      DETACHED_PANEL_MIN_SIZE,
    );
  });
});

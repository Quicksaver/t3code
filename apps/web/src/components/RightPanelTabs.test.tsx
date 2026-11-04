import { vi } from "vite-plus/test";
import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestTabLink, surfaceShortcutTargetsTypingContext } from "./RightPanelTabs";

function shortcutEvent(
  key: string,
  overrides: Partial<Parameters<typeof surfaceShortcutActionForKey>[1]> = {},
): Parameters<typeof surfaceShortcutActionForKey>[1] {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ...overrides,
  };
}

describe("surface shortcuts", () => {
  const actions = [
    { shortcut: "B", available: true, label: "Browser" },
    { shortcut: "D", available: false, label: "Diff" },
    { shortcut: "T", available: true, label: "Terminal" },
    { shortcut: "M", available: true, label: "Device" },
  ] as const;

  it("falls back to the physical key when the layout types a non-Latin letter or mark", () => {
    // Ukrainian layout: the B key types "и".
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("\u0438", { code: "KeyB" }))).toBe(
      actions[0],
    );
    // Greek layout: the B key types "β".
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("\u03b2", { code: "KeyB" }))).toBe(
      actions[0],
    );
    // Thai layout: the B key types the vowel sign "\u0e34", a combining mark.
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("\u0e34", { code: "KeyB" }))).toBe(
      actions[0],
    );
    // Arabic (101) layout: the B key types lam alef "\u0644\u0627", two code points.
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("\u0644\u0627", { code: "KeyB" })),
    ).toBe(actions[0]);
    // Ukrainian layout: the D key types "\u0432", but the Diff surface is unavailable.
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("\u0432", { code: "KeyD" })),
    ).toBeNull();
  });

  it("follows the typed letter on Latin layouts that move it", () => {
    // Dvorak: the key at QWERTY B types "x", and "b" sits on QWERTY N.
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("x", { code: "KeyB" }))).toBeNull();
    // The same key with Shift or Caps Lock types "X".
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("X", { code: "KeyB" }))).toBeNull();
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b", { code: "KeyN" }))).toBe(
      actions[0],
    );
  });

  it("keeps accented Latin letters typed on a letter key", () => {
    // Bépo: the T key types "è".
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("\u00e8", { code: "KeyT" })),
    ).toBeNull();
  });

  it("keeps punctuation typed on a letter key", () => {
    // French AZERTY: the M key types ",".
    expect(surfaceShortcutActionForKey(actions, shortcutEvent(",", { code: "KeyM" }))).toBeNull();
  });

  it("keeps a dead key on a letter key", () => {
    // A dead key starts an accented letter on a Latin layout.
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("Dead", { code: "KeyT" })),
    ).toBeNull();
  });

  it("leaves modified, composing, and already-handled key events alone", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { defaultPrevented: true })),
    ).toBeNull();
  });

  it("leaves AltGr text alone unless it is a plain letter", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    // German layout: AltGr+M types "\u00b5" and sets only AltGraph on Linux and Windows.
    expect(
      surfaceShortcutActionForKey(
        actions,
        shortcutEvent("\u00b5", { code: "KeyM", getModifierState }),
      ),
    ).toBeNull();
    // Finnish layout: AltGr+B types "b", which still matches, as it does in keybindings.ts.
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { code: "KeyB", getModifierState })),
    ).toBe(actions[0]);
  });
});

describe("surface shortcut typing contexts", () => {
  const makeTarget = (matches: string | null) => ({
    closest(selectors: string) {
      if (matches === null || !selectors.includes(matches)) return null;
      return {};
    },
  });

  it("treats form fields and every editable region as typing contexts", () => {
    expect(surfaceShortcutTargetsTypingContext(makeTarget("input"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("textarea"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("select"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("[contenteditable]"))).toBe(true);
  });
});

describe("pull request tab snapshots", () => {
  const environmentId = EnvironmentId.make("local");
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/api",
    number: 7,
    url: "https://github.com/acme/api/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unknown linked state authoritative and scopes matches to environment and host", () => {
    const threads = [{ environmentId, pullRequests: [link] }];
    expect(resolvePullRequestTabLink(threads, environmentId, "github.com", link)).toBe(link);
    expect(
      resolvePullRequestTabLink(threads, EnvironmentId.make("remote"), "github.com", link),
    ).toBeUndefined();
    expect(
      resolvePullRequestTabLink(threads, environmentId, "github.enterprise.test", link),
    ).toBeUndefined();
  });
  it("uses the newest snapshot when several threads link the same PR", () => {
    const snapshot = {
      state: "merged" as const,
      title: "API",
      headBranch: "api",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-02-01T00:00:00Z",
    };
    const newer = { ...link, snapshot };
    expect(
      resolvePullRequestTabLink(
        [{ environmentId, pullRequests: [link, newer] }],
        environmentId,
        "github.com",
        link,
      ),
    ).toBe(newer);
  });
});

import { buildAddSurfaceActions, surfaceShortcutActionForKey } from "./rightPanelSurfaceActions";
function actionProps() {
  return {
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddSourceControl: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddDevice: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: true,
    sourceControlAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
  };
}
describe("RightPanelTabs add-surface actions", () => {
  it("places Version Control directly after Diff in the empty state", () => {
    const actions = buildAddSurfaceActions(actionProps(), "empty-state");

    expect(actions.map((action) => action.id)).toEqual([
      "browser",
      "terminal",
      "files",
      "diff",
      "source-control",
      "pull-request",
      "pull-requests",
      "device",
    ]);
  });

  it("places Version Control directly after Diff, once, in the add menu", () => {
    const ids = buildAddSurfaceActions(actionProps(), "menu").map((action) => action.id);

    expect(ids.indexOf("source-control")).toBe(ids.indexOf("diff") + 1);
    expect(ids.filter((id) => id === "source-control")).toHaveLength(1);
  });

  it("shows the short hint in the empty state and the full reason in the add menu", () => {
    const props = { ...actionProps(), sourceControlAvailable: false };
    const reasonFor = (placement: "empty-state" | "menu") =>
      buildAddSurfaceActions(props, placement).find((action) => action.id === "source-control")
        ?.disabledReason;

    expect(reasonFor("empty-state")).toBe("Available for Git repositories.");
    expect(reasonFor("menu")).toBe(
      "Version Control is only available when a project is open in a Git repository.",
    );
  });
});

describe("surface shortcuts", () => {
  it("matches available surface shortcuts case-insensitively", () => {
    const actions = buildAddSurfaceActions(actionProps(), "menu");
    const sourceControl = actions.find((action) => action.id === "source-control");

    expect(surfaceShortcutActionForKey(actions, shortcutEvent("v"))).toBe(sourceControl);
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("V"))).toBe(sourceControl);
  });

  it("does not activate unavailable surfaces", () => {
    const actions = buildAddSurfaceActions({ ...actionProps(), diffAvailable: false }, "menu");

    expect(surfaceShortcutActionForKey(actions, shortcutEvent("d"))).toBeNull();
  });

  it("leaves modified, composing, and already-handled key events alone", () => {
    const actions = buildAddSurfaceActions(actionProps(), "menu");

    expect(surfaceShortcutActionForKey(actions, shortcutEvent("v", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("v", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("v", { defaultPrevented: true })),
    ).toBeNull();
  });
});

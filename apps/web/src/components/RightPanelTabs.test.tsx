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
  ] as const;

  it("leaves modified, composing, and already-handled key events alone", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { defaultPrevented: true })),
    ).toBeNull();
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
import { browserTabMuteMenuItem as tabMuteMenuItem } from "./rightPanelBrowserTabState";
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

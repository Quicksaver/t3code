import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ChatHeader, resolveRenameCommit, shouldShowOpenInPicker } from "./ChatHeader";

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: () => [],
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn() }),
}));

describe("ChatHeader parent conversation action", () => {
  const baseProps = {
    activeThreadEnvironmentId: EnvironmentId.make("environment-primary"),
    activeThreadId: ThreadId.make("thread-child"),
    activeThreadTitle: "Child thread",
    isServerThread: false,
    activeProjectName: undefined,
    activeProjectCwd: null,
    activeProjectFaviconPath: null,
    activeProjectIcon: null,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: {} as ResolvedKeybindingsConfig,
    availableEditors: [],
    rightPanelOpen: false,
    gitCwd: null,
    onNewThreadInProject: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(),
    onUpdateProjectScript: vi.fn(),
    onDeleteProjectScript: vi.fn(),
  } satisfies ComponentProps<typeof ChatHeader>;

  it("renders the tooltip trigger after the semantic breadcrumb list", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatHeader, { ...baseProps, onOpenParentThread: vi.fn() }),
    );

    expect(markup).toMatch(
      /<\/ol><div data-workspace-breadcrumb-trailing-action="true"[^>]*><button[^>]*data-slot="tooltip-trigger"[^>]*aria-label="Open parent conversation"/,
    );
  });

  it("omits the trailing action when there is no parent conversation", () => {
    const markup = renderToStaticMarkup(createElement(ChatHeader, baseProps));

    expect(markup).not.toContain("data-workspace-breadcrumb-trailing-action");
    expect(markup).not.toContain('aria-label="Open parent conversation"');
  });
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});

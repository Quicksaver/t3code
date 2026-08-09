import { describe, expect, it } from "vite-plus/test";

import {
  isNewTaskProviderSkillsWorkspaceModeSettled,
  promptHasNewTaskProviderSkillReference,
  resolveNewTaskProviderSkillsCwd,
  shouldLoadNewTaskProviderWorkspaceSkills,
} from "./new-task-provider-skills";

describe("promptHasNewTaskProviderSkillReference", () => {
  it("loads workspace metadata only after a skill reference is complete", () => {
    expect(promptHasNewTaskProviderSkillReference("Use $")).toBe(false);
    expect(promptHasNewTaskProviderSkillReference("Use $review-follow-up")).toBe(true);
    expect(promptHasNewTaskProviderSkillReference("Use $review-follow-up?")).toBe(true);
    expect(promptHasNewTaskProviderSkillReference("Use $review-follow-up next")).toBe(true);
  });

  it("ignores non-skill composer tokens", () => {
    expect(promptHasNewTaskProviderSkillReference("Read @AGENTS.md next")).toBe(false);
  });
});

describe("shouldLoadNewTaskProviderWorkspaceSkills", () => {
  it("loads workspace skills while a partial skill query is active", () => {
    expect(
      shouldLoadNewTaskProviderWorkspaceSkills({
        composerSkillMenuActive: true,
        defaultWorkspaceModeSettled: true,
        prompt: "Use $upd",
      }),
    ).toBe(true);
  });

  it("waits for the default workspace mode before loading checkout skills", () => {
    expect(
      shouldLoadNewTaskProviderWorkspaceSkills({
        composerSkillMenuActive: true,
        defaultWorkspaceModeSettled: false,
        prompt: "Use $upd",
      }),
    ).toBe(false);
  });

  it("retains lazy loading for ordinary drafts", () => {
    expect(
      shouldLoadNewTaskProviderWorkspaceSkills({
        composerSkillMenuActive: false,
        defaultWorkspaceModeSettled: true,
        prompt: "Explain this repository",
      }),
    ).toBe(false);
  });
});

describe("isNewTaskProviderSkillsWorkspaceModeSettled", () => {
  it("waits for the server configuration after the project file settles", () => {
    expect(
      isNewTaskProviderSkillsWorkspaceModeSettled({
        defaultWorkspaceModeSettled: true,
        serverConfigLoaded: false,
      }),
    ).toBe(false);
  });

  it("settles after both workspace defaults are available", () => {
    expect(
      isNewTaskProviderSkillsWorkspaceModeSettled({
        defaultWorkspaceModeSettled: true,
        serverConfigLoaded: true,
      }),
    ).toBe(true);
  });
});

describe("resolveNewTaskProviderSkillsCwd", () => {
  it("uses the selected checkout only for local tasks", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        defaultWorkspaceModeSettled: true,
        workspaceMode: "local",
        selectedWorktreePath: "/repo/worktrees/feature",
        projectWorkspaceRoot: "/repo",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("uses the project root when a local task has no alternate checkout", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        defaultWorkspaceModeSettled: true,
        workspaceMode: "local",
        selectedWorktreePath: null,
        projectWorkspaceRoot: "/repo",
      }),
    ).toBe("/repo");
  });

  it("uses provider fallback while a future worktree has no cwd", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        defaultWorkspaceModeSettled: true,
        workspaceMode: "worktree",
        selectedWorktreePath: "/repo/worktrees/existing-feature",
        projectWorkspaceRoot: "/repo",
      }),
    ).toBeNull();
  });

  it("does not retain checkout skills while the default mode is provisional", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        defaultWorkspaceModeSettled: false,
        workspaceMode: "local",
        selectedWorktreePath: "/repo/worktrees/feature",
        projectWorkspaceRoot: "/repo",
      }),
    ).toBeNull();
  });
});

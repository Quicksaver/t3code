import { describe, expect, it, vi } from "vite-plus/test";
import { detectComposerTrigger } from "@t3tools/shared/composerTrigger";

vi.mock("../../state/use-composer-path-search", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));

import {
  composerSelectionAtEnd,
  resolveComposerWorkspaceSkillMenu,
} from "./use-composer-command-menu";

const fallbackSkill = {
  name: "global-skill",
  path: "/global/SKILL.md",
  enabled: true,
};
const workspaceSkill = {
  name: "workspace-skill",
  path: "/workspace/SKILL.md",
  enabled: true,
};

describe("composerSelectionAtEnd", () => {
  it("resets a changed draft owner to the new draft end", () => {
    expect(composerSelectionAtEnd("queued task 🧪")).toEqual({ start: 14, end: 14 });
  });
});

describe("resolveComposerWorkspaceSkillMenu", () => {
  it("uses workspace results and feedback for an active skill trigger", () => {
    const state = resolveComposerWorkspaceSkillMenu({
      trigger: detectComposerTrigger("$work", 5),
      workspaceSkills: {
        skills: [workspaceSkill],
        isPending: true,
        error: "Workspace skills are refreshing.",
      },
      fallbackSkills: [fallbackSkill],
    });

    expect(state).toEqual({
      skills: [workspaceSkill],
      lookupActive: true,
      isLoading: true,
      error: "Workspace skills are refreshing.",
    });
  });

  it("falls back to provider snapshot skills before workspace lookup has state", () => {
    const state = resolveComposerWorkspaceSkillMenu({
      trigger: detectComposerTrigger("$global", 7),
      workspaceSkills: undefined,
      fallbackSkills: [fallbackSkill],
    });

    expect(state).toEqual({
      skills: [fallbackSkill],
      lookupActive: true,
      isLoading: false,
      error: null,
    });
  });

  it("keeps workspace feedback out of path completion", () => {
    const state = resolveComposerWorkspaceSkillMenu({
      trigger: detectComposerTrigger("@src", 4),
      workspaceSkills: {
        skills: [workspaceSkill],
        isPending: true,
        error: "Workspace lookup failed.",
      },
      fallbackSkills: [fallbackSkill],
    });

    expect(state).toEqual({
      skills: [workspaceSkill],
      lookupActive: false,
      isLoading: false,
      error: null,
    });
  });
});

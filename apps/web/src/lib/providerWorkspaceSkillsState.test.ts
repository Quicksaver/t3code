import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: vi.fn(() => null),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
  subscribeProviderInvalidations: vi.fn(() => () => undefined),
}));

import { resolvePendingProviderWorkspaceSkills } from "./providerWorkspaceSkillsState";

function skill(name: string): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  };
}

describe("resolvePendingProviderWorkspaceSkills", () => {
  it("preserves current skills while refreshing the same workspace key", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolvePendingProviderWorkspaceSkills({
        currentKey: "environment:codex:/repo",
        nextKey: "environment:codex:/repo",
        currentSkills,
      }),
    ).toBe(currentSkills);
  });

  it("does not expose previous or snapshot skills while a different workspace key is pending", () => {
    const pendingSkills = resolvePendingProviderWorkspaceSkills({
      currentKey: "environment:codex:/old-repo",
      nextKey: "environment:codex:/new-repo",
      currentSkills: [skill("old-repo-skill"), skill("snapshot-skill")],
    });

    expect(pendingSkills).toEqual([]);
  });
});

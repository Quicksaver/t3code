import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveTimelineProviderWorkspaceSkillsTarget,
  timelineMessagesHaveCompleteSkillReference,
  timelineProviderInstancePreferenceOrder,
  type TimelineProviderWorkspaceSkillsInput,
} from "./useTimelineProviderWorkspaceSkills";

const environmentId = EnvironmentId.make("environment-local");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function skill(name: string): ServerProviderSkill {
  return { name, path: `/skills/${name}/SKILL.md`, enabled: true };
}

function provider(input: {
  driver: ProviderDriverKind;
  instanceId: string;
  skills: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: input.skills,
  };
}

const settings = {
  providerInstances: {},
  providers: {
    codex: { enabled: true },
    claudeAgent: { enabled: true },
  } as never,
} satisfies Pick<ServerSettings, "providerInstances" | "providers">;

function targetInput(
  overrides: Partial<TimelineProviderWorkspaceSkillsInput> = {},
): TimelineProviderWorkspaceSkillsInput {
  return {
    environmentId,
    providerStatuses: [
      provider({ driver: codex, instanceId: "codex", skills: [skill("codex-skill")] }),
      provider({ driver: claude, instanceId: "claudeAgent", skills: [skill("claude-skill")] }),
    ],
    settings,
    lockedProvider: null,
    sessionProviderInstanceId: null,
    threadModelInstanceId: null,
    composerDraftInstanceId: null,
    projectDefaultInstanceId: null,
    cwd: "/repo",
    connectionAvailable: true,
    messages: [],
    ...overrides,
  };
}

describe("timelineMessagesHaveCompleteSkillReference", () => {
  it("keeps empty drafts and unrelated messages from requesting workspace skills", () => {
    expect(timelineMessagesHaveCompleteSkillReference([])).toBe(false);
    expect(
      timelineMessagesHaveCompleteSkillReference([
        { role: "user", text: "Inspect @AGENTS.md" },
        { role: "user", text: "$" },
        { role: "user", text: "$123invalid" },
        { role: "user", text: "echo $HOME/.codex" },
        { role: "user", text: "use PHP $value;" },
      ]),
    ).toBe(false);
  });

  it("ignores complete skill references in assistant messages", () => {
    expect(
      timelineMessagesHaveCompleteSkillReference([
        { role: "assistant", text: "Try $repo-skill next." },
      ]),
    ).toBe(false);
  });

  it("requests workspace skills when a sent user prompt contains a complete skill token", () => {
    expect(
      timelineMessagesHaveCompleteSkillReference([
        { role: "user", text: "Use $repo-skill to inspect this." },
      ]),
    ).toBe(true);
    expect(
      timelineMessagesHaveCompleteSkillReference([{ role: "user", text: "Use $repo-skill" }]),
    ).toBe(true);
    expect(
      timelineMessagesHaveCompleteSkillReference([{ role: "user", text: "Use $repo-skill?" }]),
    ).toBe(true);
  });
});

describe("timelineProviderInstancePreferenceOrder", () => {
  it("keeps the session and persisted thread ahead of the composer draft", () => {
    const sessionInstanceId = ProviderInstanceId.make("codex_session");
    const threadInstanceId = ProviderInstanceId.make("codex_thread");
    const draftInstanceId = ProviderInstanceId.make("codex_draft");
    const projectInstanceId = ProviderInstanceId.make("codex_project");

    expect(
      timelineProviderInstancePreferenceOrder({
        sessionProviderInstanceId: sessionInstanceId,
        threadModelInstanceId: threadInstanceId,
        composerDraftInstanceId: draftInstanceId,
        projectDefaultInstanceId: projectInstanceId,
      }),
    ).toEqual([sessionInstanceId, threadInstanceId, draftInstanceId, projectInstanceId]);
  });
});

describe("resolveTimelineProviderWorkspaceSkillsTarget", () => {
  it("uses the active session provider ahead of the next-turn composer draft", () => {
    const target = resolveTimelineProviderWorkspaceSkillsTarget(
      targetInput({
        sessionProviderInstanceId: ProviderInstanceId.make("codex"),
        composerDraftInstanceId: ProviderInstanceId.make("claudeAgent"),
        messages: [{ role: "user", text: "Use $codex-skill" }],
      }),
    );

    expect(target).toMatchObject({
      environmentId,
      instanceId: "codex",
      cwd: "/repo",
      enabled: true,
      connectionAvailable: true,
    });
    expect(target.fallbackSkills).toEqual([skill("codex-skill")]);
  });

  it("uses settings-adjusted availability when falling through provider preferences", () => {
    const disabledCustom = ProviderInstanceId.make("codex_personal");
    const target = resolveTimelineProviderWorkspaceSkillsTarget(
      targetInput({
        providerStatuses: [
          provider({ driver: codex, instanceId: disabledCustom, skills: [skill("disabled")] }),
          provider({ driver: claude, instanceId: "claudeAgent", skills: [skill("fallback")] }),
        ],
        settings: {
          providerInstances: {
            [disabledCustom]: { driver: codex, enabled: false },
          },
          providers: { claudeAgent: { enabled: true } } as never,
        },
        composerDraftInstanceId: disabledCustom,
        projectDefaultInstanceId: ProviderInstanceId.make("claudeAgent"),
      }),
    );

    expect(target.instanceId).toBe("claudeAgent");
    expect(target.fallbackSkills).toEqual([skill("fallback")]);
    expect(target.enabled).toBe(false);
  });

  it("does not cross a provider lock to decorate timeline messages", () => {
    const target = resolveTimelineProviderWorkspaceSkillsTarget(
      targetInput({
        lockedProvider: codex,
        providerStatuses: [
          provider({ driver: codex, instanceId: "codex", skills: [skill("disabled")] }),
          provider({ driver: claude, instanceId: "claudeAgent", skills: [skill("fallback")] }),
        ],
        settings: {
          providerInstances: {},
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: true },
          } as never,
        },
        threadModelInstanceId: ProviderInstanceId.make("codex"),
        messages: [{ role: "user", text: "Use $repo-skill" }],
      }),
    );

    expect(target.instanceId).toBeNull();
    expect(target.fallbackSkills).toEqual([]);
    expect(target.enabled).toBe(true);
  });
});

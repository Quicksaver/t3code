import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderSkillsListError,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLockedProviderDriverKind,
  deriveProviderInstanceSelectionEntries,
  formatProviderWorkspaceSkillsError,
  prepareProviderWorkspaceSkillsTarget,
  providerWorkspaceSkillsTargetKey,
  resolveNextProviderWorkspaceSkillsSnapshot,
  resolveProviderInstanceSelection,
  resolveProviderWorkspaceSkills,
  resolveProviderWorkspaceSkillsQuery,
} from "./providerWorkspaceSkills.ts";

function skill(name: string): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  };
}

function provider(input: {
  instanceId: string;
  driver?: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  status?: ServerProvider["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? input.instanceId),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [skill(input.instanceId)],
  };
}

describe("resolveProviderInstanceSelection", () => {
  it("sorts each driver with its default instance before custom fallbacks", () => {
    const custom = ProviderInstanceId.make("codex_personal");
    const defaultInstance = ProviderInstanceId.make("codex");
    const entries = deriveProviderInstanceSelectionEntries(
      [
        provider({ instanceId: custom, driver: "codex" }),
        provider({ instanceId: defaultInstance, driver: "codex" }),
        provider({ instanceId: "claudeAgent" }),
      ],
      {
        providerInstances: {
          [custom]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
          },
        },
        providers: {
          [ProviderDriverKind.make("codex")]: { enabled: true },
          [ProviderDriverKind.make("claudeAgent")]: { enabled: true },
        } as never,
      },
    );

    expect(entries.map((entry) => entry.instanceId)).toEqual([
      defaultInstance,
      custom,
      ProviderInstanceId.make("claudeAgent"),
    ]);
    expect(
      resolveProviderInstanceSelection({
        entries,
        preferredInstanceIds: [ProviderInstanceId.make("missing")],
        lockedDriverKind: null,
        lockedInstanceId: null,
      }).entry?.instanceId,
    ).toBe(defaultInstance);
  });

  it("applies settings and availability before choosing a deterministic fallback", () => {
    const disabled = ProviderInstanceId.make("codex_personal");
    const unavailable = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const entries = deriveProviderInstanceSelectionEntries(
      [
        provider({ instanceId: disabled, driver: "codex" }),
        provider({
          instanceId: unavailable,
          driver: "codex",
          availability: "unavailable",
        }),
        provider({ instanceId: fallback }),
      ],
      {
        providerInstances: {
          [disabled]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
        },
        providers: {
          [ProviderDriverKind.make("codex")]: { enabled: true },
          [ProviderDriverKind.make("claudeAgent")]: { enabled: true },
        } as never,
      },
    );

    expect(
      resolveProviderInstanceSelection({
        entries,
        preferredInstanceIds: [disabled, unavailable],
        lockedDriverKind: null,
        lockedInstanceId: null,
      }).entry?.instanceId,
    ).toBe(fallback);
  });
});

describe("deriveLockedProviderDriverKind", () => {
  it("correlates default and custom instance ids to their driver kind", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
      },
      {
        instanceId: ProviderInstanceId.make("codex_personal"),
        driverKind: ProviderDriverKind.make("codex"),
      },
    ];
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: null,
        sessionProviderInstanceId: null,
        threadProvider: "codex",
        selectedProvider: null,
        entries,
      }),
    ).toBe("codex");
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: null,
        sessionProviderInstanceId: null,
        threadProvider: "codex_personal",
        selectedProvider: null,
        entries,
      }),
    ).toBe("codex");
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: "codex",
        sessionProviderInstanceId: "codex_personal",
        threadProvider: "codex_personal",
        selectedProvider: null,
        entries,
      }),
    ).toBe("codex");
  });

  it("prioritizes a known session instance and falls through stale routing values", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex_personal"),
        driverKind: ProviderDriverKind.make("codex"),
      },
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driverKind: ProviderDriverKind.make("claudeAgent"),
      },
    ];
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: null,
        sessionProviderInstanceId: "codex_personal",
        threadProvider: "claudeAgent",
        selectedProvider: null,
        entries,
      }),
    ).toBe("codex");
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: null,
        sessionProviderInstanceId: "removed_instance",
        threadProvider: "codex",
        selectedProvider: null,
        entries: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driverKind: ProviderDriverKind.make("codex"),
          },
        ],
      }),
    ).toBe("codex");
  });

  it("keeps driver names separate from instance ids and does not guess without entries", () => {
    const collisionEntries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("ollama"),
      },
      {
        instanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
      },
    ];
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: "codex",
        sessionProviderInstanceId: null,
        threadProvider: null,
        selectedProvider: null,
        entries: collisionEntries,
      }),
    ).toBe("codex");
    expect(
      deriveLockedProviderDriverKind({
        hasStarted: true,
        sessionProviderName: null,
        sessionProviderInstanceId: "codex_personal",
        threadProvider: "codex",
        selectedProvider: null,
        entries: [],
      }),
    ).toBeNull();
  });
});

describe("providerWorkspaceSkillsTargetKey", () => {
  it("normalizes an enabled environment, provider, and cwd target", () => {
    expect(
      providerWorkspaceSkillsTargetKey({
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "  /repo/worktree  ",
        enabled: true,
      }),
    ).toBe("local:codex:/repo/worktree");
  });

  it("disables workspace queries without a usable cwd", () => {
    expect(
      providerWorkspaceSkillsTargetKey({
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "   ",
        enabled: true,
      }),
    ).toBeNull();
  });
});

describe("prepareProviderWorkspaceSkillsTarget", () => {
  it("centralizes lazy and connection-aware query preparation", () => {
    const unavailable = prepareProviderWorkspaceSkillsTarget({
      environmentId: EnvironmentId.make("local"),
      instanceId: ProviderInstanceId.make("codex"),
      cwd: "  /repo/worktree  ",
      enabled: true,
      connectionAvailable: false,
      fallbackSkills: [],
    });

    expect(unavailable).toEqual({
      targetKey: "local:codex:/repo/worktree",
      key: "local:codex:/repo/worktree",
      unavailable: true,
      queryTarget: null,
    });

    expect(
      prepareProviderWorkspaceSkillsTarget({
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "/repo/worktree",
        enabled: false,
        fallbackSkills: [],
      }),
    ).toEqual({
      targetKey: "local:codex:/repo/worktree",
      key: null,
      unavailable: false,
      queryTarget: null,
    });
  });
});

describe("resolveProviderWorkspaceSkills", () => {
  it("preserves loaded skills while the same workspace refreshes", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "local:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(currentSkills);
  });

  it("does not leak skills across workspace switches", () => {
    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo-b",
        nextSkills: null,
        isPending: true,
        error: null,
        currentKey: "local:codex:/repo-a",
        currentSkills: [skill("repo-a")],
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toEqual([]);
  });

  it("preserves verified same-workspace skills while the environment is unavailable", () => {
    const currentSkills = [skill("repo-local")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo",
        nextSkills: null,
        isPending: false,
        error: null,
        unavailable: true,
        currentKey: "local:codex:/repo",
        currentSkills,
        fallbackSkills: [skill("provider-fallback")],
      }),
    ).toBe(currentSkills);
  });

  it("uses provider fallback for an empty same-workspace snapshot while unavailable", () => {
    const fallbackSkills = [skill("provider-fallback")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo",
        nextSkills: null,
        isPending: false,
        error: null,
        unavailable: true,
        currentKey: "local:codex:/repo",
        currentSkills: [],
        fallbackSkills,
      }),
    ).toBe(fallbackSkills);
  });

  it("uses provider fallback skills when a different workspace is unavailable", () => {
    const fallbackSkills = [skill("provider-fallback")];

    expect(
      resolveProviderWorkspaceSkills({
        nextKey: "local:codex:/repo-b",
        nextSkills: null,
        isPending: false,
        error: null,
        unavailable: true,
        currentKey: "local:codex:/repo-a",
        currentSkills: [skill("repo-a")],
        fallbackSkills,
      }),
    ).toBe(fallbackSkills);
  });

  it("uses provider snapshot skills for empty and failed workspace responses", () => {
    const fallbackSkills = [skill("provider-fallback")];
    const base = {
      nextKey: "local:codex:/repo",
      currentKey: null,
      currentSkills: [],
      fallbackSkills,
    } as const;

    expect(
      resolveProviderWorkspaceSkills({
        ...base,
        nextSkills: [],
        isPending: false,
        error: null,
      }),
    ).toBe(fallbackSkills);
    expect(
      resolveProviderWorkspaceSkills({
        ...base,
        // Effect AsyncResult failures retain the previous success, so query
        // consumers can receive stale data and an error at the same time.
        nextSkills: [skill("stale-workspace-skill")],
        isPending: false,
        error: "Failed to list skills.",
      }),
    ).toBe(fallbackSkills);
  });
});

describe("resolveNextProviderWorkspaceSkillsSnapshot", () => {
  it("preserves only the same target snapshot while lookup is inactive", () => {
    const current = {
      key: "local:codex:/repo",
      skills: [skill("repo-local")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: current.key,
        skills: null,
        isPending: false,
        error: null,
        inactive: true,
        current,
      }),
    ).toBe(current);
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/other-repo",
        skills: null,
        isPending: false,
        error: null,
        inactive: true,
        current,
      }),
    ).toBeNull();
  });

  it("keeps the settled snapshot during refresh and clears it when disabled", () => {
    const current = {
      key: "local:codex:/repo",
      skills: [skill("repo-local")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: current.key,
        skills: [skill("fresh-repo-local")],
        isPending: true,
        error: null,
        current,
      }),
    ).toBe(current);
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: null,
        skills: current.skills,
        isPending: false,
        error: null,
        current,
      }),
    ).toBeNull();
  });

  it("clears a different workspace snapshot while the next lookup is pending", () => {
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/repo-b",
        skills: null,
        isPending: true,
        error: null,
        current: {
          key: "local:codex:/repo-a",
          skills: [skill("repo-a")],
        },
      }),
    ).toBeNull();
  });

  it("clears a stale snapshot after a failed refresh", () => {
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/repo",
        skills: [skill("stale-repo-local")],
        isPending: false,
        error: "Failed to list skills.",
        current: {
          key: "local:codex:/repo",
          skills: [skill("repo-local")],
        },
      }),
    ).toBeNull();
  });

  it("retains only a same-workspace snapshot while unavailable", () => {
    const current = {
      key: "local:codex:/repo-a",
      skills: [skill("repo-a")],
    };

    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: current.key,
        skills: null,
        isPending: false,
        error: null,
        unavailable: true,
        current,
      }),
    ).toBe(current);
    expect(
      resolveNextProviderWorkspaceSkillsSnapshot({
        key: "local:codex:/repo-b",
        skills: null,
        isPending: false,
        error: null,
        unavailable: true,
        current,
      }),
    ).toBeNull();
  });
});

describe("resolveProviderWorkspaceSkillsQuery", () => {
  it("centralizes snapshot and visible-state resolution for client adapters", () => {
    const loadedSkills = [skill("repo-local")];
    const target = prepareProviderWorkspaceSkillsTarget({
      environmentId: EnvironmentId.make("local"),
      instanceId: ProviderInstanceId.make("codex"),
      cwd: "/repo",
      enabled: true,
      fallbackSkills: [skill("provider-fallback")],
    });

    expect(
      resolveProviderWorkspaceSkillsQuery({
        target,
        query: {
          data: { skills: loadedSkills },
          error: null,
          errorCause: null,
          isPending: false,
        },
        fallbackSkills: [skill("provider-fallback")],
        current: null,
      }),
    ).toEqual({
      snapshot: {
        key: "local:codex:/repo",
        skills: loadedSkills,
      },
      state: {
        skills: loadedSkills,
        isPending: false,
        error: null,
      },
    });
  });

  it("shows a verified same-workspace snapshot while lazy lookup is inactive", () => {
    const loadedSkills = [skill("repo-local")];
    const target = prepareProviderWorkspaceSkillsTarget({
      environmentId: EnvironmentId.make("local"),
      instanceId: ProviderInstanceId.make("codex"),
      cwd: "/repo",
      enabled: false,
      fallbackSkills: [skill("provider-fallback")],
    });
    const current = {
      key: "local:codex:/repo",
      skills: loadedSkills,
    };

    expect(
      resolveProviderWorkspaceSkillsQuery({
        target,
        query: {
          data: null,
          error: null,
          errorCause: null,
          isPending: false,
        },
        fallbackSkills: [skill("provider-fallback")],
        current,
      }),
    ).toEqual({
      snapshot: current,
      state: {
        skills: loadedSkills,
        isPending: false,
        error: null,
      },
    });
  });
});

describe("formatProviderWorkspaceSkillsError", () => {
  it("adds bounded structured detail without exposing a raw cause", () => {
    const error = new ServerProviderSkillsListError({
      reason: "invalid-cwd",
      operation: "ProviderSkillsLister.normalizeCwd",
      message: "Invalid Codex skills cwd '/missing'.",
      detail: "Workspace root does not exist: /missing.",
      cause: new Error("raw platform detail"),
    });

    expect(
      formatProviderWorkspaceSkillsError({
        error: error.message,
        cause: Cause.fail(error),
      }),
    ).toBe("Invalid Codex skills cwd '/missing'. Workspace root does not exist: /missing.");
  });
});

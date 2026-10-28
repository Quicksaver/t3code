import {
  AuthProvidersManageScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentOptions,
  classifyEnvironmentSettingsAccess,
  isEnvironmentSettingsAvailable,
  resolveSelectedEnvironmentId,
  resolveSettingsSearchEnvironmentId,
  resolveSessionOperateAccess,
} from "./EnvironmentSettingsPanel.logic";
import { buildProviderInstanceOverridePatch } from "./ProviderSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("settings permissions", () => {
  it.each(["settings:write", "providers:manage", "orchestration:operate"] as const)(
    "checks the settings grant independently of %s",
    (scope) => {
      const session = {
        authenticated: true,
        scopes: [scope],
        auth: { serverUpdateScope: "environment:maintain" as const },
      };
      for (const requiredScope of [AuthSettingsWriteScope, AuthProvidersManageScope]) {
        expect(
          resolveSessionOperateAccess({
            session,
            isPending: true,
            hasError: false,
            requiredScope,
          }),
        ).toBe(scope === requiredScope ? "granted" : "denied");
      }
    },
  );
});

describe("settings environment selection", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isEnvironmentSettingsAvailable({
        connectionPhase: "connected",
        hasServerConfig: true,
      }),
    ).toBe(true);
    expect(
      isEnvironmentSettingsAvailable({
        connectionPhase: "reconnecting",
        hasServerConfig: true,
      }),
    ).toBe(false);
    expect(
      isEnvironmentSettingsAvailable({
        connectionPhase: "connected",
        hasServerConfig: false,
      }),
    ).toBe(false);
  });
  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildEnvironmentOptions(environments, primaryId);

    expect(resolveSelectedEnvironmentId(options, sshId, primaryId)).toBe(sshId);
    expect(
      resolveSelectedEnvironmentId(
        options.filter((environment) => environment.environmentId !== sshId),
        sshId,
        primaryId,
      ),
    ).toBe(primaryId);
    expect(resolveSelectedEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(relayId);
    expect(resolveSelectedEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("settings search device selection", () => {
  const search = {
    environments: [
      {
        environmentId: primaryId,
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: { os: "windows" } } },
      },
      {
        environmentId: relayId,
        connection: { phase: "offline" },
        serverConfig: { environment: { platform: { os: "darwin" } } },
      },
      {
        environmentId: sshId,
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: { os: "darwin" } } },
      },
    ],
    selectedEnvironmentId: primaryId,
    scoped: false,
    searchTargetId: "cursor-keychain-usage",
    searchTargetIds: ["cursor-keychain-usage"],
    searchPlatform: "darwin",
  } as const;

  it("routes a macOS-only search past a connected Windows device and an offline Mac", () => {
    expect(resolveSettingsSearchEnvironmentId(search)).toBe(sshId);
  });

  it("preserves an explicitly scoped device and an already matching selection", () => {
    expect(resolveSettingsSearchEnvironmentId({ ...search, scoped: true })).toBeUndefined();
    expect(
      resolveSettingsSearchEnvironmentId({ ...search, selectedEnvironmentId: sshId }),
    ).toBeUndefined();
  });

  it("does not redirect when matching devices are offline or have no config", () => {
    expect(
      resolveSettingsSearchEnvironmentId({
        ...search,
        environments: search.environments.slice(0, 2),
      }),
    ).toBeUndefined();
    expect(
      resolveSettingsSearchEnvironmentId({
        ...search,
        environments: [{ ...search.environments[2], serverConfig: null }],
      }),
    ).toBeUndefined();
  });

  it("does not redirect for inactive or unrelated searches", () => {
    expect(resolveSettingsSearchEnvironmentId({ ...search, searchTargetId: null })).toBeUndefined();
    expect(
      resolveSettingsSearchEnvironmentId({ ...search, searchTargetId: "appearance" }),
    ).toBeUndefined();
  });

  it("keeps generic settings on an available selection and recovers an unavailable one", () => {
    expect(
      resolveSettingsSearchEnvironmentId({ ...search, searchPlatform: undefined }),
    ).toBeUndefined();
    expect(
      resolveSettingsSearchEnvironmentId({
        ...search,
        searchPlatform: undefined,
        selectedEnvironmentId: relayId,
      }),
    ).toBe(primaryId);
  });
});

describe("settings environment access", () => {
  it("allows connected environments with config and operate access", () => {
    expect(
      classifyEnvironmentSettingsAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "editable" });
  });

  it("waits for config before exposing controls", () => {
    expect(
      classifyEnvironmentSettingsAccess({
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "loading", reason: "config" });
  });

  it("waits for unresolved operate access instead of assuming it is editable", () => {
    expect(
      classifyEnvironmentSettingsAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "pending",
      }),
    ).toEqual({ kind: "loading", reason: "permissions" });
  });

  it("represents known missing operate access as read only", () => {
    expect(
      classifyEnvironmentSettingsAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "denied",
      }),
    ).toEqual({ kind: "read-only" });
  });

  it.each(["available", "offline", "connecting", "reconnecting"] as const)(
    "keeps %s environments unavailable",
    (connectionPhase) => {
      expect(
        classifyEnvironmentSettingsAccess({
          connectionPhase,
          hasServerConfig: true,
          operateAccess: "granted",
        }),
      ).toEqual({ kind: "unavailable" });
    },
  );

  it("separates connection errors from other unavailable states", () => {
    expect(
      classifyEnvironmentSettingsAccess({
        connectionPhase: "error",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId, siblingId], instanceId, false),
    ).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      [siblingId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [instanceId]: { enabled: false } },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("sends providerInstances: {} explicitly when clearing the last instance override leaves other keys", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: true } },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
    });
  });
});

describe("Providers settings permission", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: {
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveSessionOperateAccess({
        requiredScope: AuthProvidersManageScope,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});

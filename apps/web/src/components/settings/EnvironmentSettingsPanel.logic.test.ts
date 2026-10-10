import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentOptions,
  classifyEnvironmentSettingsAccess,
  isEnvironmentSettingsAvailable,
  resolveSelectedEnvironmentId,
  resolveSettingsSearchEnvironmentId,
  resolvePrimaryOperateAccess as resolvePrimaryEnvironmentAccess,
  resolveRemoteOperateAccess as resolveRemoteEnvironmentAccess,
} from "./EnvironmentSettingsPanel.logic";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("Magi settings permission", () => {
  it.each(["settings:write", "providers:manage", "orchestration:operate"] as const)(
    "checks the settings grant independently of %s",
    (scope) => {
      const session = {
        authenticated: true,
        scopes: [scope],
        auth: { serverUpdateScope: "environment:maintain" as const },
      };
      const state = {
        session,
        isPending: true,
        hasError: false,
        requiredScope: AuthSettingsWriteScope,
      };
      const expected = scope === AuthSettingsWriteScope ? "granted" : "denied";
      expect(
        resolvePrimaryEnvironmentAccess({ ...state, isPrimary: true, hasDesktopBridge: true }),
      ).toBe(expected);
      expect(resolveRemoteEnvironmentAccess(state)).toBe(expected);
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

describe("primary operate access", () => {
  const authenticated = {
    authenticated: true as const,
    scopes: [AuthProvidersManageScope],
  };

  it("keeps cached session data authoritative while SWR revalidates", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: authenticated,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("reports pending only before any session has resolved", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });

  it("denies writes when the session fetch fails", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("denied");
  });

  it("denies unauthenticated sessions and sessions without the operate scope", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("waits for explicit grants on desktop and remote environments", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });
});

describe("remote operate access", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveRemoteOperateAccess({
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
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("reports pending before the first session resolve, then keeps cached data", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("denies writes when the session fetch fails or scopes are missing", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "denied",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});

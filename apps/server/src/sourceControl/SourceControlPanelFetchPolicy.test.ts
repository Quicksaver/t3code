import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
import { getBackgroundActivityPresetSettings } from "@t3tools/shared/backgroundActivitySettings";
import * as DateTime from "effect/DateTime";

import { panelFetchOverridesHostLock } from "./SourceControlPanelFetchPolicy.ts";

const NOW = DateTime.makeUnsafe("2026-10-01T22:00:00.000Z");
const CWD = "/repo";
const balanced = getBackgroundActivityPresetSettings("balanced");

const lockedHost: HostPowerSnapshot = {
  source: "electron-main",
  idle: "true",
  idleSeconds: 900,
  locked: "true",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: false,
  updatedAt: NOW,
};

const remoteLease: ClientActivityLease = {
  sessionId: AuthSessionId.make("session"),
  rpcClientId: RpcClientId.make(0),
  clientId: "remote-client",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: false,
  scopes: [{ type: "git-refs", cwd: CWD }],
  updatedAt: NOW,
  expiresAt: DateTime.add(NOW, { seconds: 45 }),
};

const policy = (
  hostPower: Partial<HostPowerSnapshot> = {},
  leases: ReadonlyArray<ClientActivityLease> = [remoteLease],
): BackgroundPolicySnapshot => ({
  hostPower: { ...lockedHost, ...hostPower },
  leases,
  activeForegroundLeaseCount: leases.length,
  activeScopeKeys: [],
  shouldRunOpportunisticWork: false,
  updatedAt: NOW,
});

describe("panelFetchOverridesHostLock", () => {
  it("lets a foreground client fetch its panel while the host is locked", () => {
    expect(panelFetchOverridesHostLock({ policy: policy(), settings: balanced, cwd: CWD })).toBe(
      true,
    );
  });

  it("keeps the lock pause without a foreground lease for that cwd", () => {
    const background = { ...remoteLease, focused: false, recentlyInteracted: false };
    const otherRepo = { ...remoteLease, scopes: [{ type: "git-refs" as const, cwd: "/other" }] };
    for (const lease of [background, otherRepo]) {
      expect(
        panelFetchOverridesHostLock({ policy: policy({}, [lease]), settings: balanced, cwd: CWD }),
      ).toBe(false);
    }
  });

  it("keeps every non-lock host constraint", () => {
    for (const host of [
      { suspended: true },
      { thermalState: "serious" as const },
      { lowPowerMode: "true" as const },
    ]) {
      expect(
        panelFetchOverridesHostLock({ policy: policy(host), settings: balanced, cwd: CWD }),
      ).toBe(false);
    }
  });

  it("does not apply when the lock is not what paused the fetch", () => {
    for (const host of [{ locked: "false" as const }, { stale: true }]) {
      expect(
        panelFetchOverridesHostLock({ policy: policy(host), settings: balanced, cwd: CWD }),
      ).toBe(false);
    }
  });
});

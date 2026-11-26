import type { BackgroundPolicySnapshot } from "@t3tools/contracts";
import type { ResolvedBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";

// Foreground remote panel demand can override a host lock, which only signals
// local inactivity. Every other host and client constraint still pauses fetching.
export function panelFetchOverridesHostLock(input: {
  readonly policy: BackgroundPolicySnapshot;
  readonly settings: ResolvedBackgroundActivitySettings;
  readonly cwd: string;
}): boolean {
  const { policy, settings, cwd } = input;
  const host = policy.hostPower;
  if (host.stale || host.locked !== "true" || !settings.pauseWhenHostLocked) return false;
  if (
    host.suspended ||
    host.thermalState === "serious" ||
    host.thermalState === "critical" ||
    (settings.pauseWhenHostLowPower && host.lowPowerMode === "true") ||
    (settings.pauseWhenOnBattery && host.onBattery === "true")
  ) {
    return false;
  }
  // Snapshot leases are already limited to unexpired ones.
  return policy.leases.some(
    (lease) =>
      lease.visible &&
      (lease.focused || lease.recentlyInteracted) &&
      !(settings.pauseWhenClientLowPower && lease.lowPowerMode === "true") &&
      lease.scopes.some(
        (scope) => (scope.type === "git-refs" || scope.type === "vcs-status") && scope.cwd === cwd,
      ),
  );
}

import type {
  DesktopEnvironmentBootstrap,
  T3HostVscodeWorkspaceBootstrap,
} from "@t3tools/contracts";

export function getHostLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  return (
    window.t3HostBridge?.getLocalEnvironmentBootstrap() ??
    window.desktopBridge?.getLocalEnvironmentBootstrap() ??
    null
  );
}

export function getHostVscodeWorkspaceBootstrap(): T3HostVscodeWorkspaceBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.t3HostBridge?.getVscodeWorkspaceBootstrap?.() ?? null;
}

export function getHostBearerToken(): string | null {
  const bootstrap = getHostLocalEnvironmentBootstrap();
  return typeof bootstrap?.bearerToken === "string" && bootstrap.bearerToken.length > 0
    ? bootstrap.bearerToken
    : null;
}

export function getHostBootstrapCredential(): string | null {
  const bootstrap = getHostLocalEnvironmentBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

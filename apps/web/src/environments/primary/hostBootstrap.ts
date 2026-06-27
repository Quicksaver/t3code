import type {
  T3HostLocalEnvironmentBootstrap,
  T3HostVscodeWorkspaceBootstrap,
} from "@t3tools/contracts";

export function getDesktopManagedEnvironmentBootstrap(): T3HostLocalEnvironmentBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.t3HostBridge?.getLocalEnvironmentBootstrap?.() ?? null;
}

// Legacy host-named aliases are retained for VS Code webview compatibility.
// New shared desktop/local environment callers should use the desktop-managed names.
export const getHostLocalEnvironmentBootstrap = getDesktopManagedEnvironmentBootstrap;

export function getHostVscodeWorkspaceBootstrap(): T3HostVscodeWorkspaceBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.t3HostBridge?.getVscodeWorkspaceBootstrap?.() ?? null;
}

export function getDesktopManagedBearerToken(): string | null {
  const bootstrap = getDesktopManagedEnvironmentBootstrap();
  return typeof bootstrap?.bearerToken === "string" && bootstrap.bearerToken.length > 0
    ? bootstrap.bearerToken
    : null;
}

export const getHostBearerToken = getDesktopManagedBearerToken;

export function getDesktopManagedBootstrapCredential(): string | null {
  return null;
}

export const getHostBootstrapCredential = getDesktopManagedBootstrapCredential;

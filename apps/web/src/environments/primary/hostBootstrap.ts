import type {
  DesktopEnvironmentBootstrap,
  T3HostLocalEnvironmentBootstrap,
  T3HostVscodeWorkspaceBootstrap,
} from "@t3tools/contracts";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

export type DesktopManagedEnvironmentBootstrap =
  | DesktopEnvironmentBootstrap
  | T3HostLocalEnvironmentBootstrap;

export function getDesktopManagedEnvironmentBootstrap(): DesktopManagedEnvironmentBootstrap | null {
  if (typeof window === "undefined") {
    return null;
  }

  const hostBootstrap = window.t3HostBridge?.getLocalEnvironmentBootstrap?.();
  if (hostBootstrap) {
    return hostBootstrap;
  }

  const desktopBootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps?.() ?? [];
  return desktopBootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ?? null;
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
  const bootstrap = getDesktopManagedEnvironmentBootstrap();
  const bootstrapToken =
    bootstrap !== null && "bootstrapToken" in bootstrap ? bootstrap.bootstrapToken : null;
  return typeof bootstrapToken === "string" && bootstrapToken.length > 0 ? bootstrapToken : null;
}

export const getHostBootstrapCredential = getDesktopManagedBootstrapCredential;

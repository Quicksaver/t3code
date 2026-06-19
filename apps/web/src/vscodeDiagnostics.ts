import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentRegistry,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { environmentCatalog } from "./connection/catalog";
import { connectionAtomRuntime } from "./connection/runtime";
import {
  getHostLocalEnvironmentBootstrap,
  getHostVscodeWorkspaceBootstrap,
} from "./environments/primary/hostBootstrap";
import { readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { isHostedStaticApp } from "./hostedPairing";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./state/environments";
import { useUiStateStore } from "./uiStateStore";
import { environmentProjects } from "./state/projects";
import { environmentSession } from "./state/session";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "./state/server";
import { environmentShell } from "./state/shell";

declare global {
  interface Window {
    __T3_VSCODE_DIAGNOSTICS__?: () => unknown;
    __T3_VSCODE_PROBE_PRIMARY__?: () => Promise<unknown>;
  }
}

function formatAsyncError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  return result._tag === "Failure" ? Cause.pretty(result.cause) : null;
}

function readEnvironmentDiagnostics(environmentId: EnvironmentId) {
  const connectionStateResult = appAtomRegistry.get(environmentCatalog.stateAtom(environmentId));
  const connectionState = Option.getOrNull(AsyncResult.value(connectionStateResult));
  const shellState = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
  const shellSnapshot = Option.getOrNull(shellState.snapshot);
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const projects = appAtomRegistry.get(environmentProjects.environmentProjectsAtom(environmentId));

  return {
    connectionState,
    connectionStateError: formatAsyncError(connectionStateResult),
    preparedConnection: prepared
      ? {
          environmentId: prepared.environmentId,
          label: prepared.label,
          httpBaseUrl: prepared.httpBaseUrl,
          socketUrl: prepared.socketUrl.replace(/([?&]wsTicket=)[^&]+/u, "$1<redacted>"),
          hasHttpAuthorization: prepared.httpAuthorization !== null,
          targetTag: prepared.target._tag,
        }
      : null,
    shell: {
      status: shellState.status,
      error: Option.getOrNull(shellState.error),
      hasSnapshot: shellSnapshot !== null,
      snapshotSequence: shellSnapshot?.snapshotSequence ?? null,
      projectCount: shellSnapshot?.projects.length ?? 0,
      threadCount: shellSnapshot?.threads.length ?? 0,
    },
    projects: projects.map((project) => ({
      id: project.id,
      key: scopedProjectKey(scopeProjectRef(environmentId, project.id)),
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    })),
  };
}

function environmentDescriptorUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = "/.well-known/t3/environment";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function installVscodeDiagnostics(): void {
  window.__T3_VSCODE_DIAGNOSTICS__ = () => {
    const workspace = getHostVscodeWorkspaceBootstrap();
    const local = getHostLocalEnvironmentBootstrap();
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    const targetEnvironmentId =
      workspace?.environmentId ?? local?.environmentId ?? primaryEnvironmentId;
    const primaryServerConfig = appAtomRegistry.get(primaryServerConfigAtom);
    const primaryServerWelcome = appAtomRegistry.get(primaryServerWelcomeAtom);

    return {
      href: window.location.href,
      bridge: {
        workspaceEnvironmentId: workspace?.environmentId ?? null,
        localEnvironmentId: local?.environmentId ?? null,
        httpBaseUrl: local?.httpBaseUrl ?? null,
        wsBaseUrl: local?.wsBaseUrl ?? null,
        hasBearerToken: typeof local?.bearerToken === "string" && local.bearerToken.length > 0,
        hasBootstrapToken:
          typeof local?.bootstrapToken === "string" && local.bootstrapToken.length > 0,
        bootstrapProjects: workspace?.bootstrapProjects ?? [],
      },
      runtime: {
        isVscodeWebview: window.__T3_IS_VSCODE_WEBVIEW === true,
        isHostedStaticApp: isHostedStaticApp(new URL(window.location.href)),
        hasHostPrimaryEnvironmentBootstrap: Boolean(local?.httpBaseUrl && local.wsBaseUrl),
      },
      catalog: {
        isReady: catalog.isReady,
        primaryEnvironmentId,
        environmentIds: [...catalog.entries.keys()],
        entries: [...catalog.entries.values()].map((entry) => ({
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          targetTag: entry.target._tag,
          hasBearerToken:
            "bearerToken" in entry.target &&
            typeof entry.target.bearerToken === "string" &&
            entry.target.bearerToken.length > 0,
        })),
      },
      primaryServer: {
        hasConfig: primaryServerConfig !== null,
        hasWelcome: primaryServerWelcome !== null,
        configEnvironmentId: primaryServerConfig?.environment.environmentId ?? null,
        welcomeEnvironmentId: primaryServerWelcome?.environment.environmentId ?? null,
        welcomeBootstrapProjects: primaryServerWelcome?.bootstrapProjects ?? null,
      },
      uiState: {
        threadLastVisitedKeys: Object.keys(useUiStateStore.getState().threadLastVisitedAtById),
      },
      targetEnvironment:
        targetEnvironmentId === null || targetEnvironmentId === undefined
          ? null
          : readEnvironmentDiagnostics(targetEnvironmentId),
    };
  };

  window.__T3_VSCODE_PROBE_PRIMARY__ = async () => {
    const local = getHostLocalEnvironmentBootstrap();
    const resolved = readPrimaryEnvironmentTarget();
    const runtimeResult = appAtomRegistry.get(connectionAtomRuntime);
    const runtimeContext = Option.getOrNull(AsyncResult.value(runtimeResult));
    const probe = {
      local: {
        environmentId: local?.environmentId ?? null,
        httpBaseUrl: local?.httpBaseUrl ?? null,
        wsBaseUrl: local?.wsBaseUrl ?? null,
        hasBearerToken: typeof local?.bearerToken === "string" && local.bearerToken.length > 0,
      },
      resolved,
      runtime: {
        tag: runtimeResult._tag,
        hasContext: runtimeContext !== null,
        error: formatAsyncError(runtimeResult),
      },
      descriptorFetch: null as null | {
        readonly ok: boolean;
        readonly status: number | null;
        readonly url: string | null;
        readonly bodyPreview: string | null;
        readonly parsed: unknown;
        readonly error: string | null;
      },
      registerPlatform: null as null | {
        readonly attempted: boolean;
        readonly ok: boolean;
        readonly error: string | null;
      },
    };

    if (!resolved) {
      return probe;
    }

    const descriptorUrl = environmentDescriptorUrl(resolved.target.httpBaseUrl);
    let descriptor: { readonly environmentId?: string; readonly label?: string } | null = null;
    try {
      const response = await fetch(descriptorUrl, { credentials: "include" });
      const body = await response.text();
      try {
        descriptor = JSON.parse(body) as {
          readonly environmentId?: string;
          readonly label?: string;
        };
      } catch {
        descriptor = null;
      }
      probe.descriptorFetch = {
        ok: response.ok,
        status: response.status,
        url: descriptorUrl,
        bodyPreview: body.slice(0, 500),
        parsed: descriptor,
        error: null,
      };
    } catch (error) {
      probe.descriptorFetch = {
        ok: false,
        status: null,
        url: descriptorUrl,
        bodyPreview: null,
        parsed: null,
        error: formatUnknownError(error),
      };
      return probe;
    }

    if (!runtimeContext || !descriptor?.environmentId || !descriptor.label) {
      return probe;
    }

    const registration = new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: (local?.environmentId ?? descriptor.environmentId) as EnvironmentId,
        label: descriptor.label,
        httpBaseUrl: resolved.target.httpBaseUrl,
        wsBaseUrl: resolved.target.wsBaseUrl,
        ...(local?.bearerToken ? { bearerToken: local.bearerToken } : {}),
      }),
    });

    try {
      await Effect.runPromise(
        EnvironmentRegistry.pipe(
          Effect.flatMap((registry) => registry.registerPlatform(registration)),
          Effect.provide(runtimeContext),
        ),
      );
      probe.registerPlatform = { attempted: true, ok: true, error: null };
    } catch (error) {
      probe.registerPlatform = {
        attempted: true,
        ok: false,
        error: formatUnknownError(error),
      };
    }

    return {
      ...probe,
      after: window.__T3_VSCODE_DIAGNOSTICS__?.(),
    };
  };
}

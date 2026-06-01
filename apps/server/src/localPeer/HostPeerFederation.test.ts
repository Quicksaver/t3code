// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationSessionStatus,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createLocalBackendAdvertisement,
  writeLocalBackendAdvertisement,
} from "@t3tools/shared/localBackendAdvertisement";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerConfigShape } from "../config.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeHostPeerFederation } from "./HostPeerFederation.ts";

const now = "2026-05-28T12:00:00.000Z";
const advertisementNowMs = Date.UTC(2099, 0, 1, 0, 0, 0);
const projectId = "project-1" as ProjectId;
const threadId = "thread-1" as ThreadId;
const workspaceRoot = "/repo/project";
const fetchMock = vi.fn<typeof fetch>();
let tempDirs: string[] = [];

describe("HostPeerFederation", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("routes owner-sensitive commands to the first matching VS Code backend peer", async () => {
    const baseDir = makeTempDir();
    writePeerAdvertisement(baseDir);
    fetchMock.mockImplementation(() => makeDispatchResponse());

    const federation = makeHostPeerFederation(makeConfig(baseDir), makeProjection("running"));
    const result = await Effect.runPromise(federation.dispatchCommand(interruptCommand()));

    expect(Option.getOrNull(result)).toEqual({ sequence: 42 });
    const request = getFetchRequest();
    expect(request.url).toBe("http://127.0.0.1:49111/api/local-peer/orchestration/dispatch");
    expect(request.init?.method).toBe("POST");
    expect(JSON.parse(decodeFetchBody(request.init?.body))).toEqual(interruptCommand());
  });

  it("does not dispatch owner-sensitive commands to later peers after one peer succeeds", async () => {
    const baseDir = makeTempDir();
    writePeerAdvertisement(baseDir, {
      backendId: "vscode-peer-a",
      httpBaseUrl: "http://127.0.0.1:49111",
    });
    writePeerAdvertisement(baseDir, {
      backendId: "vscode-peer-b",
      httpBaseUrl: "http://127.0.0.1:49112",
    });
    fetchMock.mockImplementation(() => makeDispatchResponse());

    const federation = makeHostPeerFederation(makeConfig(baseDir), makeProjection("running"));
    const result = await Effect.runPromise(federation.dispatchCommand(interruptCommand()));

    expect(Option.getOrNull(result)).toEqual({ sequence: 42 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = getFetchRequest();
    expect(request.url).toBe("http://127.0.0.1:49111/api/local-peer/orchestration/dispatch");
    expect(request.init?.method).toBe("POST");
    expect(JSON.parse(decodeFetchBody(request.init?.body))).toEqual(interruptCommand());
  });

  it("does not route a follow-up prompt after interruption so ownership can transfer locally", async () => {
    const baseDir = makeTempDir();
    writePeerAdvertisement(baseDir);

    const federation = makeHostPeerFederation(makeConfig(baseDir), makeProjection("interrupted"));
    const result = await Effect.runPromise(federation.dispatchCommand(turnStartCommand()));

    expect(Option.isNone(result)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to local dispatch when no matching backend peer is advertised", async () => {
    const baseDir = makeTempDir();

    const federation = makeHostPeerFederation(makeConfig(baseDir), makeProjection("running"));
    const result = await Effect.runPromise(federation.dispatchCommand(interruptCommand()));

    expect(Option.isNone(result)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send peer bearer tokens to non-loopback peer URLs", async () => {
    const baseDir = makeTempDir();
    writePeerAdvertisement(baseDir, { httpBaseUrl: "http://192.0.2.1:49111" });

    const federation = makeHostPeerFederation(makeConfig(baseDir), makeProjection("running"));

    await expect(Effect.runPromise(federation.dispatchCommand(interruptCommand()))).rejects.toThrow(
      "No reachable local owner backend is available",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is disabled inside VS Code-hosted backend processes", async () => {
    const baseDir = makeTempDir();
    writePeerAdvertisement(baseDir);

    const federation = makeHostPeerFederation(
      makeConfig(baseDir, { hostIntegration: "vscode" }),
      makeProjection("running"),
    );
    const result = await Effect.runPromise(federation.dispatchCommand(interruptCommand()));

    expect(Option.isNone(result)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-host-peer-federation-"));
  tempDirs.push(dir);
  return dir;
}

function makeDispatchResponse(): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ sequence: 42 }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
}

function getFetchRequest(index = 0): {
  readonly url: string;
  readonly init: RequestInit | undefined;
} {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index} to exist.`);
  }
  return {
    url: String(call[0]),
    init: call[1],
  };
}

function decodeFetchBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  throw new Error(`Unsupported fetch body type: ${typeof body}`);
}

function writePeerAdvertisement(
  baseDir: string,
  overrides: Partial<Parameters<typeof createLocalBackendAdvertisement>[0]> = {},
): void {
  writeLocalBackendAdvertisement({
    t3Home: baseDir,
    advertisement: createLocalBackendAdvertisement({
      backendId: "vscode-peer",
      nowMs: advertisementNowMs,
      httpBaseUrl: "http://127.0.0.1:49111",
      bearerToken: "peer-token",
      workspaceFolders: [
        {
          key: "file::/repo/project",
          name: "project",
          cwd: workspaceRoot,
          uriScheme: "file",
          uriAuthority: "",
        },
      ],
      activeWorkspaceFolderKey: "file::/repo/project",
      ...overrides,
    }),
  });
}

function makeConfig(baseDir: string, overrides?: Partial<ServerConfigShape>): ServerConfigShape {
  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "desktop",
    port: 0,
    host: "127.0.0.1",
    cwd: workspaceRoot,
    baseDir,
    stateDir: path.join(baseDir, "userdata"),
    dbPath: path.join(baseDir, "userdata", "state.sqlite"),
    keybindingsConfigPath: path.join(baseDir, "userdata", "keybindings.json"),
    settingsPath: path.join(baseDir, "userdata", "settings.json"),
    providerStatusCacheDir: path.join(baseDir, "caches"),
    worktreesDir: path.join(baseDir, "worktrees"),
    attachmentsDir: path.join(baseDir, "userdata", "attachments"),
    logsDir: path.join(baseDir, "userdata", "logs"),
    serverLogPath: path.join(baseDir, "userdata", "logs", "server.log"),
    serverTracePath: path.join(baseDir, "userdata", "logs", "server.trace.ndjson"),
    providerLogsDir: path.join(baseDir, "userdata", "logs", "provider"),
    providerEventLogPath: path.join(baseDir, "userdata", "logs", "provider", "events.log"),
    terminalLogsDir: path.join(baseDir, "userdata", "logs", "terminals"),
    anonymousIdPath: path.join(baseDir, "userdata", "anonymous-id"),
    environmentIdPath: path.join(baseDir, "userdata", "environment-id"),
    serverRuntimeStatePath: path.join(baseDir, "userdata", "server-runtime.json"),
    secretsDir: path.join(baseDir, "userdata", "secrets"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    hostIntegration: undefined,
    autoBootstrapProjectFromCwd: false,
    autoBootstrapWorkspaceFolders: [],
    activeBootstrapWorkspaceFolderKey: undefined,
    hostMcpServers: [],
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...overrides,
  } satisfies ServerConfigShape;
}

function makeProjection(status: OrchestrationSessionStatus): ProjectionSnapshotQueryShape {
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationThreadShell = {
    id: threadId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: "codex" as never, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: {
      threadId,
      status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const service: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (inputProjectId) =>
      Effect.succeed(inputProjectId === projectId ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (inputThreadId) =>
      Effect.succeed(inputThreadId === threadId ? Option.some(thread) : Option.none()),
    getThreadDetailById: () => Effect.die("unused"),
  };
  return service;
}

function interruptCommand(): OrchestrationCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: "command-1",
    threadId,
    createdAt: now,
  } as unknown as OrchestrationCommand;
}

function turnStartCommand(): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: "command-2",
    threadId,
    message: {
      messageId: "message-1",
      role: "user",
      text: "Continue",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  } as unknown as OrchestrationCommand;
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackendManager,
  type BackendManagerDependencies,
  type BackendSpawn,
  resolveMcpToolTimeoutSec,
} from "./backendManager.ts";

const vscodeState = vi.hoisted(() => ({
  workspaceFolderPath: "/workspace",
  activeEditorPath: "/workspace/src/file.ts",
  workspaceFolders: [
    {
      name: "workspace",
      uri: {
        scheme: "file",
        authority: "",
        path: "/workspace",
        fsPath: "/workspace",
      },
    },
  ],
  settings: {} as Record<string, unknown>,
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: {
      document: {
        uri: {
          get fsPath() {
            return vscodeState.activeEditorPath;
          },
          get path() {
            return vscodeState.activeEditorPath;
          },
        },
      },
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => vscodeState.settings[key],
    }),
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      vscodeState.workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
    get workspaceFolders() {
      return vscodeState.workspaceFolders;
    },
  },
}));

function makeOutputChannel() {
  return {
    append: vi.fn(),
    appendLine: vi.fn(),
  };
}

function makeChildProcess(onBootstrap: (value: string) => void): ChildProcessWithoutNullStreams {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdio: unknown[];
  };

  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [
    null,
    stdout,
    stderr,
    {
      write: vi.fn(),
      end: vi.fn(onBootstrap),
    },
  ];

  return child as unknown as ChildProcessWithoutNullStreams;
}

function makeDependencies(input: {
  readonly spawn: BackendSpawn;
  readonly fetch?: typeof fetch;
  readonly findAvailablePort?: () => Promise<number>;
  readonly mkdirSync?: typeof fs.mkdirSync;
  readonly pruneVirtualWorkspaceCache?: BackendManagerDependencies["pruneVirtualWorkspaceCache"];
  readonly randomBytes?: typeof import("node:crypto").randomBytes;
  readonly runCommand?: BackendManagerDependencies["runCommand"];
  readonly writeHostMcpAdvertisement?: BackendManagerDependencies["writeHostMcpAdvertisement"];
  readonly removeHostMcpAdvertisement?: BackendManagerDependencies["removeHostMcpAdvertisement"];
  readonly cleanupHostMcpAdvertisements?: BackendManagerDependencies["cleanupHostMcpAdvertisements"];
  readonly writeLocalBackendAdvertisement?: BackendManagerDependencies["writeLocalBackendAdvertisement"];
  readonly removeLocalBackendAdvertisement?: BackendManagerDependencies["removeLocalBackendAdvertisement"];
  readonly cleanupLocalBackendAdvertisements?: BackendManagerDependencies["cleanupLocalBackendAdvertisements"];
}): BackendManagerDependencies {
  return {
    fetch:
      input.fetch ??
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sessionToken: "vscode-bearer-token" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        )
        .mockResolvedValue(new Response(JSON.stringify({ revoked: true }), { status: 200 })),
    findAvailablePort: input.findAvailablePort ?? vi.fn().mockResolvedValue(49111),
    mkdirSync: input.mkdirSync ?? vi.fn(),
    pruneVirtualWorkspaceCache:
      input.pruneVirtualWorkspaceCache ??
      vi.fn(() => ({
        deleted: 0,
        kept: 0,
        errors: 0,
      })),
    randomBytes:
      input.randomBytes ??
      (vi.fn(() =>
        Buffer.from("0123456789abcdef01234567"),
      ) as unknown as typeof import("node:crypto").randomBytes),
    spawn: input.spawn,
    runCommand: input.runCommand ?? vi.fn().mockResolvedValue(undefined),
    writeHostMcpAdvertisement: input.writeHostMcpAdvertisement ?? vi.fn(),
    removeHostMcpAdvertisement: input.removeHostMcpAdvertisement ?? vi.fn(),
    cleanupHostMcpAdvertisements:
      input.cleanupHostMcpAdvertisements ?? vi.fn(() => ({ deleted: 0, errors: 0 })),
    writeLocalBackendAdvertisement: input.writeLocalBackendAdvertisement ?? vi.fn(),
    removeLocalBackendAdvertisement: input.removeLocalBackendAdvertisement ?? vi.fn(),
    cleanupLocalBackendAdvertisements:
      input.cleanupLocalBackendAdvertisements ?? vi.fn(() => ({ deleted: 0, errors: 0 })),
  };
}

describe("BackendManager", () => {
  let extensionRoot: string;

  beforeEach(() => {
    extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-vscode-extension-"));
    fs.mkdirSync(path.join(extensionRoot, "dist", "server"), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, "dist", "server", "bin.mjs"), "");
    vscodeState.settings = {};
    vscodeState.workspaceFolders = [
      {
        name: "workspace",
        uri: {
          scheme: "file",
          authority: "",
          path: vscodeState.workspaceFolderPath,
          fsPath: vscodeState.workspaceFolderPath,
        },
      },
    ];
    vscodeState.activeEditorPath = "/workspace/src/file.ts";
  });

  afterEach(() => {
    fs.rmSync(extensionRoot, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts the bundled backend with desktop bootstrap data on fd 3", async () => {
    let bootstrapJson = "";
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionToken: "vscode-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    const mkdirSyncMock = vi.fn<typeof fs.mkdirSync>();
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({
        fetch: fetchMock,
        mkdirSync: mkdirSyncMock,
        spawn: spawnMock,
      }),
    );

    await expect(manager.ensureStarted()).resolves.toEqual({
      httpBaseUrl: "http://127.0.0.1:49111",
      wsBaseUrl: "ws://127.0.0.1:49111",
      bootstrapToken: "303132333435363738396162636465663031323334353637",
      bearerToken: "vscode-bearer-token",
      cwd: "/workspace",
      t3Home: path.join(os.homedir(), ".t3"),
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(extensionRoot, "dist", "server", "bin.mjs"),
        "--bootstrap-fd",
        "3",
        "--auto-bootstrap-project-from-cwd",
        "/workspace",
      ],
      expect.objectContaining({
        cwd: "/workspace",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(mkdirSyncMock).toHaveBeenCalledWith(path.join(os.homedir(), ".t3"), {
      recursive: true,
    });
    expect(JSON.parse(bootstrapJson)).toEqual({
      mode: "desktop",
      hostIntegration: "vscode",
      noBrowser: true,
      port: 49111,
      t3Home: path.join(os.homedir(), ".t3"),
      host: "127.0.0.1",
      desktopBootstrapToken: "303132333435363738396162636465663031323334353637",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      workspaceFolders: [
        {
          key: "file::/workspace",
          name: "workspace",
          cwd: "/workspace",
          uriScheme: "file",
          uriAuthority: "",
        },
      ],
      activeWorkspaceFolderKey: "file::/workspace",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:49111/.well-known/t3/environment"),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:49111/api/auth/bootstrap/bearer"),
      {
        body: JSON.stringify({
          credential: "303132333435363738396162636465663031323334353637",
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("advertises the running local backend and removes the advertisement on stop", async () => {
    const writeLocalBackendAdvertisement = vi.fn();
    const removeLocalBackendAdvertisement = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionToken: "vscode-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true }), { status: 200 }));
    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({
        fetch: fetchMock,
        removeLocalBackendAdvertisement,
        spawn: spawnMock,
        writeLocalBackendAdvertisement,
      }),
    );

    await manager.ensureStarted();

    expect(writeLocalBackendAdvertisement).toHaveBeenCalledWith(
      expect.objectContaining({
        t3Home: path.join(os.homedir(), ".t3"),
        advertisement: expect.objectContaining({
          backendId: expect.stringMatching(/^vscode-backend-/),
          hostKind: "vscode",
          httpBaseUrl: "http://127.0.0.1:49111",
          bearerToken: "vscode-bearer-token",
          workspaceFolders: [
            {
              key: "file::/workspace",
              name: "workspace",
              cwd: "/workspace",
              uriScheme: "file",
              uriAuthority: "",
            },
          ],
          activeWorkspaceFolderKey: "file::/workspace",
        }),
      }),
    );

    const backendId =
      writeLocalBackendAdvertisement.mock.calls[0]?.[0]?.advertisement.backendId ?? "";
    await manager.stop();

    expect(removeLocalBackendAdvertisement).toHaveBeenCalledWith({
      t3Home: path.join(os.homedir(), ".t3"),
      backendId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:49111/api/auth/session/revoke"),
      {
        headers: {
          authorization: "Bearer vscode-bearer-token",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("includes VS Code MCP server bootstrap data when the bridge is enabled", async () => {
    let bootstrapJson = "";
    const writeHostMcpAdvertisement = vi.fn();
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock, writeHostMcpAdvertisement }),
      {
        ensureStarted: async () => ({
          name: "t3code-vscode",
          socketPath: "/tmp/t3code-vscode-mcp/mcp.sock",
        }),
      },
    );

    await manager.ensureStarted();

    expect(JSON.parse(bootstrapJson)).toMatchObject({
      mcpServers: [
        {
          name: "t3code-vscode",
          socketPath: "/tmp/t3code-vscode-mcp/mcp.sock",
          toolTimeoutSec: 120,
        },
      ],
    });
    expect(writeHostMcpAdvertisement).toHaveBeenCalledWith(
      expect.objectContaining({
        t3Home: path.join(os.homedir(), ".t3"),
        advertisement: expect.objectContaining({
          hostKind: "vscode",
          mcpServer: {
            name: "t3code-vscode",
            socketPath: "/tmp/t3code-vscode-mcp/mcp.sock",
            toolTimeoutSec: 120,
          },
          workspaceFolders: [
            {
              key: "file::/workspace",
              name: "workspace",
              cwd: "/workspace",
              uriScheme: "file",
              uriAuthority: "",
            },
          ],
          activeWorkspaceFolderKey: "file::/workspace",
        }),
      }),
    );
  });

  it("includes the configured MCP tool timeout in bootstrap data", async () => {
    vscodeState.settings["mcp.toolTimeoutSec"] = 900;
    let bootstrapJson = "";
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
      {
        ensureStarted: async () => ({
          name: "t3code-vscode",
          socketPath: "/tmp/t3code-vscode-mcp/mcp.sock",
        }),
      },
    );

    await manager.ensureStarted();

    expect(JSON.parse(bootstrapJson)).toMatchObject({
      mcpServers: [
        {
          name: "t3code-vscode",
          socketPath: "/tmp/t3code-vscode-mcp/mcp.sock",
          toolTimeoutSec: 900,
        },
      ],
    });
  });

  it.each([
    ["below minimum", 4],
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["fractional", 30.5],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("falls back to the default MCP tool timeout for %s values", (_name, value) => {
    vscodeState.settings["mcp.toolTimeoutSec"] = value;

    expect(resolveMcpToolTimeoutSec()).toBe(120);
  });

  it("uses an explicitly configured server command without leaking inherited backend env", async () => {
    vscodeState.settings["server.command"] = "/usr/local/bin/t3";
    vscodeState.settings["server.args"] = ["serve"];
    vscodeState.settings["server.cwd"] = "/configured/server";
    vscodeState.settings.home = "/custom/t3-home";
    vi.stubEnv("T3CODE_PORT", "3999");

    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
    );

    await manager.ensureStarted();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/t3",
      ["serve", "--bootstrap-fd", "3", "--auto-bootstrap-project-from-cwd", "/workspace"],
      expect.objectContaining({
        cwd: "/configured/server",
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env?.T3CODE_PORT).toBeUndefined();
    expect(spawnMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("passes all VS Code workspace folders and marks the active folder", async () => {
    vscodeState.workspaceFolders = [
      {
        name: "api",
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+box",
          path: "/workspaces/api",
          fsPath: "/workspaces/api",
        },
      },
      {
        name: "web",
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+box",
          path: "/workspaces/web",
          fsPath: "/workspaces/web",
        },
      },
    ];
    vscodeState.activeEditorPath = "/workspaces/web/src/App.tsx";
    let bootstrapJson = "";
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
    );

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      cwd: "/workspaces/web",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(extensionRoot, "dist", "server", "bin.mjs"),
        "--bootstrap-fd",
        "3",
        "--auto-bootstrap-project-from-cwd",
        "/workspaces/web",
      ],
      expect.objectContaining({
        cwd: "/workspaces/web",
      }),
    );
    expect(JSON.parse(bootstrapJson)).toMatchObject({
      workspaceFolders: [
        {
          key: "vscode-remote:ssh-remote+box:/workspaces/api",
          name: "api",
          cwd: "/workspaces/api",
          uriScheme: "vscode-remote",
          uriAuthority: "ssh-remote+box",
        },
        {
          key: "vscode-remote:ssh-remote+box:/workspaces/web",
          name: "web",
          cwd: "/workspaces/web",
          uriScheme: "vscode-remote",
          uriAuthority: "ssh-remote+box",
        },
      ],
      activeWorkspaceFolderKey: "vscode-remote:ssh-remote+box:/workspaces/web",
    });
  });

  it("materializes GitHub RemoteHub virtual workspaces before starting the backend", async () => {
    const t3Home = path.join(extensionRoot, "t3-home");
    vscodeState.settings.home = t3Home;
    vscodeState.workspaceFolders = [
      {
        name: "vscode",
        uri: {
          scheme: "vscode-vfs",
          authority: "github",
          path: "/microsoft/vscode",
          fsPath: "/microsoft/vscode",
        },
      },
    ];
    vscodeState.activeEditorPath = "/microsoft/vscode/src/vs/code/electron-main/main.ts";
    const key = "vscode-vfs:github:/microsoft/vscode";
    const checkoutHash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
    const checkoutPath = path.join(
      t3Home,
      "virtual-workspaces",
      "github",
      `microsoft-vscode-${checkoutHash}`,
    );
    let bootstrapJson = "";
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const runCommandMock = vi
      .fn<BackendManagerDependencies["runCommand"]>()
      .mockImplementation(async (_command, args) => {
        const checkoutDir = args[3];
        if (checkoutDir) {
          fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
        }
      });
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ runCommand: runCommandMock, spawn: spawnMock }),
    );

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      cwd: checkoutPath,
    });

    expect(runCommandMock).toHaveBeenCalledWith("git", [
      "clone",
      "--filter=blob:none",
      "https://github.com/microsoft/vscode.git",
      checkoutPath,
    ]);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(extensionRoot, "dist", "server", "bin.mjs"),
        "--bootstrap-fd",
        "3",
        "--auto-bootstrap-project-from-cwd",
        checkoutPath,
      ],
      expect.objectContaining({
        cwd: checkoutPath,
      }),
    );
    expect(JSON.parse(bootstrapJson)).toMatchObject({
      workspaceFolders: [
        {
          key,
          name: "vscode",
          cwd: checkoutPath,
          uriScheme: "vscode-vfs",
          uriAuthority: "github",
        },
      ],
      activeWorkspaceFolderKey: key,
    });
  });

  it("does not pass unsupported virtual workspace fsPath values as backend cwd", async () => {
    vscodeState.workspaceFolders = [
      {
        name: "virtual",
        uri: {
          scheme: "memfs",
          authority: "example",
          path: "/virtual/project",
          fsPath: "/virtual/project",
        },
      },
    ];
    vscodeState.activeEditorPath = "/virtual/project/file.ts";
    const outputChannel = makeOutputChannel();
    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const runCommandMock = vi
      .fn<BackendManagerDependencies["runCommand"]>()
      .mockResolvedValue(undefined);
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      outputChannel as never,
      makeDependencies({ runCommand: runCommandMock, spawn: spawnMock }),
    );

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      cwd: os.homedir(),
    });

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(extensionRoot, "dist", "server", "bin.mjs"),
        "--bootstrap-fd",
        "3",
        "--auto-bootstrap-project-from-cwd",
        os.homedir(),
      ],
      expect.objectContaining({
        cwd: os.homedir(),
      }),
    );
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Skipping unsupported virtual workspace folder"),
    );
  });

  it("reuses the active backend connection after readiness succeeds", async () => {
    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
    );

    await manager.ensureStarted();
    await manager.ensureStarted();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("terminates the child process when startup fails after spawn", async () => {
    let killMock: ReturnType<typeof vi.fn> | null = null;
    const spawnMock = vi.fn<BackendSpawn>(() => {
      const child = makeChildProcess(() => {});
      killMock = child.kill as ReturnType<typeof vi.fn>;
      return child;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ fetch: fetchMock, spawn: spawnMock }),
    );

    await expect(manager.ensureStarted()).rejects.toThrow(
      "Failed to create VS Code backend bearer session",
    );

    expect(killMock).toHaveBeenCalled();
  });
});

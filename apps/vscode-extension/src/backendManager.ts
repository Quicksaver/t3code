import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  spawn as spawnChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { DEFAULT_MCP_TOOL_TIMEOUT_SEC, normalizeMcpToolTimeoutSec } from "@t3tools/shared/mcp";
import {
  cleanupHostMcpAdvertisements,
  createHostMcpAdvertisement,
  HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS,
  removeHostMcpAdvertisement,
  writeHostMcpAdvertisement,
  type CleanupHostMcpAdvertisementsResult,
} from "@t3tools/shared/hostMcp";
import * as vscode from "vscode";

import {
  ensureGithubVirtualWorkspaceClone,
  parseGithubVirtualWorkspace,
  pruneVirtualWorkspaceCache as pruneVirtualWorkspaceCacheImpl,
} from "./virtualWorkspaceCache.ts";

const READINESS_PATH = "/.well-known/t3/environment";
const BOOTSTRAP_FD = 3;
const INHERITED_ENV_ALLOWLIST = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "Path",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

interface BackendBootstrap {
  readonly mode: "desktop";
  readonly hostIntegration: "vscode";
  readonly noBrowser: boolean;
  readonly port: number;
  readonly t3Home: string;
  readonly host: string;
  readonly desktopBootstrapToken: string;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly workspaceFolders?: readonly BootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolderKey?: string;
  readonly mcpServers?: readonly BackendMcpServerBootstrap[];
}

interface BootstrapWorkspaceFolder {
  readonly key: string;
  readonly name: string;
  readonly cwd: string;
  readonly uriScheme: string;
  readonly uriAuthority: string;
}

export interface BackendConnection {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
  readonly bearerToken: string;
  readonly cwd: string;
  readonly t3Home: string;
}

export interface BackendMcpServerBootstrap {
  readonly name: string;
  readonly socketPath: string;
  readonly toolTimeoutSec?: number;
}

export interface BackendMcpBridge {
  ensureStarted(): Promise<BackendMcpServerBootstrap | null>;
}

interface ResolvedServerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface BackendSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe", "pipe", "pipe"];
}

export type BackendSpawn = (
  command: string,
  args: readonly string[],
  options: BackendSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface BackendRunCommandOptions {
  readonly cwd?: string;
}

export type BackendRunCommand = (
  command: string,
  args: readonly string[],
  options?: BackendRunCommandOptions,
) => Promise<void>;

export interface BackendManagerDependencies {
  readonly findAvailablePort: () => Promise<number>;
  readonly fetch: typeof fetch;
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly pruneVirtualWorkspaceCache: typeof pruneVirtualWorkspaceCacheImpl;
  readonly randomBytes: typeof crypto.randomBytes;
  readonly spawn: BackendSpawn;
  readonly runCommand: BackendRunCommand;
  readonly writeHostMcpAdvertisement: typeof writeHostMcpAdvertisement;
  readonly removeHostMcpAdvertisement: typeof removeHostMcpAdvertisement;
  readonly cleanupHostMcpAdvertisements: typeof cleanupHostMcpAdvertisements;
}

const defaultBackendManagerDependencies: BackendManagerDependencies = {
  findAvailablePort,
  fetch,
  mkdirSync: fs.mkdirSync,
  pruneVirtualWorkspaceCache: pruneVirtualWorkspaceCacheImpl,
  randomBytes: crypto.randomBytes,
  spawn: (command, args, options) =>
    spawnChildProcess(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [...options.stdio],
    }) as ChildProcessWithoutNullStreams,
  runCommand,
  writeHostMcpAdvertisement,
  removeHostMcpAdvertisement,
  cleanupHostMcpAdvertisements,
};

export class BackendManager {
  #process: ChildProcessWithoutNullStreams | null = null;
  #connection: BackendConnection | null = null;
  #starting: Promise<BackendConnection> | null = null;
  #hostMcpAdvertisement: {
    readonly t3Home: string;
    readonly hostId: string;
    readonly interval: NodeJS.Timeout;
  } | null = null;
  #outputChannel: vscode.OutputChannel;
  readonly #context: vscode.ExtensionContext;
  readonly #dependencies: BackendManagerDependencies;
  readonly #mcpBridge: BackendMcpBridge | null;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    dependencies: BackendManagerDependencies = defaultBackendManagerDependencies,
    mcpBridge: BackendMcpBridge | null = null,
  ) {
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#dependencies = dependencies;
    this.#mcpBridge = mcpBridge;
  }

  async ensureStarted(): Promise<BackendConnection> {
    if (this.#connection && this.#process && !this.#process.killed) {
      return this.#connection;
    }

    if (this.#starting) {
      return this.#starting;
    }

    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  get activeCwd(): string | null {
    return this.#connection?.cwd ?? null;
  }

  async restart(): Promise<BackendConnection> {
    await this.stop();
    return await this.ensureStarted();
  }

  async stop(): Promise<void> {
    this.#stopHostMcpAdvertisement();
    const child = this.#process;
    this.#starting = null;
    this.#process = null;
    this.#connection = null;

    if (!child || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      void sleep(2_000).then(() => {
        if (resolved) return;
        child.kill("SIGKILL");
        finish();
      });
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
  }

  async #start(): Promise<BackendConnection> {
    const t3Home = resolveT3Home();
    this.#dependencies.mkdirSync(t3Home, { recursive: true });
    const workspaceFolders = await resolveBootstrapWorkspaceFolders({
      t3Home,
      dependencies: this.#dependencies,
      outputChannel: this.#outputChannel,
    });
    const activeWorkspaceFolder = resolveActiveWorkspaceFolder(workspaceFolders);
    const cwd = activeWorkspaceFolder?.cwd ?? os.homedir();
    const port = await this.#dependencies.findAvailablePort();
    const host = "127.0.0.1";
    const bootstrapToken = this.#dependencies.randomBytes(24).toString("hex");
    const command = resolveServerCommand(this.#context, cwd);
    const mcpServer = await this.#mcpBridge?.ensureStarted();
    const mcpToolTimeoutSec = resolveMcpToolTimeoutSec();
    this.#refreshHostMcpAdvertisement({
      t3Home,
      mcpServer: mcpServer ? { ...mcpServer, toolTimeoutSec: mcpToolTimeoutSec } : null,
      workspaceFolders,
      activeWorkspaceFolderKey: activeWorkspaceFolder?.key,
    });
    const bootstrap: BackendBootstrap = {
      mode: "desktop",
      hostIntegration: "vscode",
      noBrowser: true,
      port,
      t3Home,
      host,
      desktopBootstrapToken: bootstrapToken,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...(workspaceFolders.length > 0 ? { workspaceFolders } : {}),
      ...(activeWorkspaceFolder ? { activeWorkspaceFolderKey: activeWorkspaceFolder.key } : {}),
      ...(mcpServer ? { mcpServers: [{ ...mcpServer, toolTimeoutSec: mcpToolTimeoutSec }] } : {}),
    };
    const args = [
      ...command.args,
      "--bootstrap-fd",
      String(BOOTSTRAP_FD),
      "--auto-bootstrap-project-from-cwd",
      cwd,
    ];

    this.#outputChannel.appendLine(`[backend] Starting: ${command.command} ${args.join(" ")}`);

    const child = this.#dependencies.spawn(command.command, args, {
      cwd: command.cwd,
      env: backendEnv(),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.#process = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#outputChannel.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#outputChannel.append(chunk.toString());
    });
    child.once("exit", (code, signal) => {
      this.#outputChannel.appendLine(
        `[backend] Exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (this.#process === child) {
        this.#process = null;
        this.#connection = null;
      }
    });

    try {
      const bootstrapPipe = child.stdio[BOOTSTRAP_FD];
      if (!bootstrapPipe || !("write" in bootstrapPipe)) {
        throw new Error("Failed to open backend bootstrap pipe.");
      }
      bootstrapPipe.end(JSON.stringify(bootstrap));

      const httpBaseUrl = `http://${host}:${port}`;
      const wsBaseUrl = `ws://${host}:${port}`;
      await waitForBackendReady(httpBaseUrl, this.#dependencies.fetch);
      const bearerToken = await exchangeBootstrapBearerSession(
        httpBaseUrl,
        bootstrapToken,
        this.#dependencies.fetch,
      );

      this.#connection = {
        httpBaseUrl,
        wsBaseUrl,
        bootstrapToken,
        bearerToken,
        cwd,
        t3Home,
      };
      void Promise.resolve().then(() => {
        try {
          const result = this.#dependencies.pruneVirtualWorkspaceCache({
            t3Home,
            activeCheckoutPaths: workspaceFolders.map((folder) => folder.cwd),
            outputChannel: this.#outputChannel,
          });
          if (result.deleted > 0 || result.errors > 0) {
            this.#outputChannel.appendLine(
              `[backend] Pruned ${result.deleted} virtual workspace checkout(s); kept ${result.kept}; errors ${result.errors}.`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#outputChannel.appendLine(
            `[backend] Failed to prune virtual workspace cache: ${message}`,
          );
        }
      });
      void Promise.resolve().then(() => {
        try {
          const result = this.#dependencies.cleanupHostMcpAdvertisements({ t3Home });
          logHostMcpCleanupResult(this.#outputChannel, result);
        } catch (error) {
          this.#outputChannel.appendLine(
            `[mcp] Failed to clean host MCP advertisements: ${errorMessage(error)}`,
          );
        }
      });
      return this.#connection;
    } catch (error) {
      this.#stopHostMcpAdvertisement();
      if (this.#process === child) {
        this.#process = null;
        this.#connection = null;
      }
      if (!child.killed) {
        child.kill();
      }
      throw error;
    }
  }

  #refreshHostMcpAdvertisement(input: {
    readonly t3Home: string;
    readonly mcpServer: BackendMcpServerBootstrap | null;
    readonly workspaceFolders: readonly BootstrapWorkspaceFolder[];
    readonly activeWorkspaceFolderKey?: string | undefined;
  }): void {
    this.#stopHostMcpAdvertisement();
    if (!input.mcpServer || input.workspaceFolders.length === 0) {
      return;
    }

    const mcpServer = input.mcpServer;
    const hostId = `vscode-${process.pid}-${this.#dependencies.randomBytes(8).toString("hex")}`;
    const writeAdvertisement = () => {
      this.#dependencies.writeHostMcpAdvertisement({
        t3Home: input.t3Home,
        advertisement: createHostMcpAdvertisement({
          hostId,
          mcpServer,
          workspaceFolders: input.workspaceFolders,
          activeWorkspaceFolderKey: input.activeWorkspaceFolderKey,
        }),
      });
    };

    try {
      writeAdvertisement();
    } catch (error) {
      this.#outputChannel.appendLine(
        `[mcp] Failed to write host MCP advertisement: ${errorMessage(error)}`,
      );
      return;
    }

    // @effect-diagnostics-next-line globalTimers:off
    const interval = setInterval(() => {
      try {
        writeAdvertisement();
        const result = this.#dependencies.cleanupHostMcpAdvertisements({
          t3Home: input.t3Home,
        });
        logHostMcpCleanupResult(this.#outputChannel, result);
      } catch (error) {
        this.#outputChannel.appendLine(
          `[mcp] Failed to refresh host MCP advertisement: ${errorMessage(error)}`,
        );
      }
    }, HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS);
    interval.unref?.();
    this.#hostMcpAdvertisement = {
      t3Home: input.t3Home,
      hostId,
      interval,
    };
  }

  #stopHostMcpAdvertisement(): void {
    const advertisement = this.#hostMcpAdvertisement;
    this.#hostMcpAdvertisement = null;
    if (!advertisement) {
      return;
    }
    clearInterval(advertisement.interval);
    try {
      this.#dependencies.removeHostMcpAdvertisement({
        t3Home: advertisement.t3Home,
        hostId: advertisement.hostId,
      });
    } catch (error) {
      this.#outputChannel.appendLine(
        `[mcp] Failed to remove host MCP advertisement: ${errorMessage(error)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logHostMcpCleanupResult(
  outputChannel: vscode.OutputChannel,
  result: CleanupHostMcpAdvertisementsResult,
): void {
  if (result.deleted > 0 || result.errors > 0) {
    outputChannel.appendLine(
      `[mcp] Cleaned ${result.deleted} expired host MCP advertisement(s); errors ${result.errors}.`,
    );
  }
}

function resolveActiveWorkspaceFolder(
  workspaceFolders: readonly BootstrapWorkspaceFolder[],
): BootstrapWorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    const activeKey = activeWorkspaceFolder ? workspaceFolderKey(activeWorkspaceFolder) : null;
    if (activeKey) {
      return workspaceFolders.find((folder) => folder.key === activeKey);
    }
  }
  return workspaceFolders[0];
}

async function resolveBootstrapWorkspaceFolders(input: {
  readonly t3Home: string;
  readonly dependencies: Pick<BackendManagerDependencies, "mkdirSync" | "runCommand">;
  readonly outputChannel: vscode.OutputChannel;
}): Promise<BootstrapWorkspaceFolder[]> {
  const workspaceFolders: BootstrapWorkspaceFolder[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const resolvedFolder = await resolveBootstrapWorkspaceFolder(folder, input);
    if (resolvedFolder) {
      workspaceFolders.push(resolvedFolder);
    }
  }
  return workspaceFolders;
}

async function resolveBootstrapWorkspaceFolder(
  folder: vscode.WorkspaceFolder,
  input: {
    readonly t3Home: string;
    readonly dependencies: Pick<BackendManagerDependencies, "mkdirSync" | "runCommand">;
    readonly outputChannel: vscode.OutputChannel;
  },
): Promise<BootstrapWorkspaceFolder | null> {
  const uriScheme = folder.uri.scheme || "file";
  const uriAuthority = folder.uri.authority || "";
  const key = workspaceFolderKey(folder);
  if (uriScheme === "file" || uriScheme === "vscode-remote") {
    return {
      key,
      name: folder.name || path.basename(folder.uri.fsPath) || "workspace",
      cwd: folder.uri.fsPath,
      uriScheme,
      uriAuthority,
    };
  }

  const githubWorkspace = parseGithubVirtualWorkspace(folder);
  if (githubWorkspace) {
    const cwd = await ensureGithubVirtualWorkspaceClone({
      ...githubWorkspace,
      key,
      t3Home: input.t3Home,
      dependencies: input.dependencies,
      outputChannel: input.outputChannel,
    });
    return {
      key,
      name: folder.name || githubWorkspace.repository,
      cwd,
      uriScheme,
      uriAuthority,
    };
  }

  input.outputChannel.appendLine(
    `[backend] Skipping unsupported virtual workspace folder ${folder.name || key} (${key}). T3 Code requires a local filesystem checkout for agent execution.`,
  );
  return null;
}

function workspaceFolderKey(folder: vscode.WorkspaceFolder): string {
  return `${folder.uri.scheme || "file"}:${folder.uri.authority || ""}:${folder.uri.fsPath}`;
}

export function resolveT3Home(): string {
  const configured = vscode.workspace.getConfiguration("t3code").get<string>("home")?.trim();
  if (configured) {
    return configured.replace(/^~(?=$|[/\\])/, os.homedir());
  }
  return path.join(os.homedir(), ".t3");
}

export function resolveMcpToolTimeoutSec(): number {
  const configured = vscode.workspace
    .getConfiguration("t3code")
    .get<number>("mcp.toolTimeoutSec", DEFAULT_MCP_TOOL_TIMEOUT_SEC);
  return normalizeMcpToolTimeoutSec(configured);
}

function resolveServerCommand(
  context: vscode.ExtensionContext,
  workspaceCwd: string,
): ResolvedServerCommand {
  const configuration = vscode.workspace.getConfiguration("t3code");
  const configuredCommand = configuration.get<string>("server.command")?.trim();
  const configuredArgs = configuration.get<readonly string[]>("server.args") ?? [];
  const configuredCwd = configuration.get<string>("server.cwd")?.trim();

  if (configuredCommand) {
    return {
      command: configuredCommand,
      args: configuredArgs,
      cwd: configuredCwd || workspaceCwd,
    };
  }

  const bundledEntry = path.join(context.extensionPath, "dist", "server", "bin.mjs");
  if (fs.existsSync(bundledEntry)) {
    return {
      command: process.execPath,
      args: [bundledEntry],
      cwd: workspaceCwd,
    };
  }

  const developmentRepoRoot = findDevelopmentRepoRoot(context.extensionPath, workspaceCwd);
  if (developmentRepoRoot) {
    return {
      command: "bun",
      args: ["--cwd", path.join(developmentRepoRoot, "apps/server"), "run", "dev", "--"],
      cwd: developmentRepoRoot,
    };
  }

  throw new Error(
    "Unable to resolve a T3 backend. Build the extension package or configure t3code.server.command.",
  );
}

function findDevelopmentRepoRoot(...candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    while (true) {
      if (fs.existsSync(path.join(current, "apps/server/src/bin.ts"))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

function backendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to allocate a local backend port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function runCommand(
  command: string,
  args: readonly string[],
  options?: BackendRunCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChildProcess(command, [...args], {
      cwd: options?.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      reject(
        new Error(`Command failed: ${command} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`),
      );
    });
  });
}

async function waitForBackendReady(
  httpBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const readinessUrl = new URL(READINESS_PATH, httpBaseUrl);

  while (Date.now() < deadline) {
    try {
      const response = await fetchFn(readinessUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the backend binds the port.
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for T3 backend readiness at ${readinessUrl.toString()}.`);
}

async function exchangeBootstrapBearerSession(
  httpBaseUrl: string,
  bootstrapToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const bootstrapUrl = new URL("/api/auth/bootstrap/bearer", httpBaseUrl);
  const response = await fetchFn(bootstrapUrl, {
    body: JSON.stringify({ credential: bootstrapToken }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to create VS Code backend bearer session (${response.status}).`);
  }

  const body = (await response.json()) as { readonly sessionToken?: unknown };
  if (typeof body.sessionToken !== "string" || body.sessionToken.length === 0) {
    throw new Error("Backend bearer session response did not include a session token.");
  }

  return body.sessionToken;
}

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as fs from "node:fs";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import {
  HostMcpAdvertisement,
  type DesktopBootstrapMcpServer,
  type DesktopBootstrapWorkspaceFolder,
} from "@t3tools/contracts";

export const HOST_MCP_ADVERTISEMENT_TTL_MS = 30_000;
export const HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS = 10_000;
export const HOST_MCP_ADVERTISEMENT_CLEANUP_GRACE_MS = 15 * 60_000;
export const HOST_MCP_ADVERTISEMENT_CLEANUP_MAX_DELETES = 25;

const ADVERTISEMENT_DIR_PARTS = ["host-mcp", "advertisements"] as const;
const HOST_ID_PATTERN = /^[a-zA-Z0-9._-]+$/u;

export interface CreateHostMcpAdvertisementInput {
  readonly hostId: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly mcpServer: DesktopBootstrapMcpServer;
  readonly workspaceFolders: readonly DesktopBootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolderKey?: string | undefined;
}

export interface ReadHostMcpAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly workspaceRoot?: string | undefined;
}

export interface HostMcpAdvertisementReadResult {
  readonly advertisements: readonly HostMcpAdvertisement[];
  readonly malformed: number;
}

export interface CleanupHostMcpAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
  readonly maxDeletes?: number;
}

export interface CleanupHostMcpAdvertisementsResult {
  readonly deleted: number;
  readonly errors: number;
}

const decodeHostMcpAdvertisement = Schema.decodeUnknownSync(HostMcpAdvertisement);

export function resolveHostMcpAdvertisementDir(t3Home: string): string {
  return path.join(t3Home, ...ADVERTISEMENT_DIR_PARTS);
}

export function resolveHostMcpAdvertisementPath(t3Home: string, hostId: string): string {
  return path.join(resolveHostMcpAdvertisementDir(t3Home), `${sanitizeHostId(hostId)}.json`);
}

export function createHostMcpAdvertisement(
  input: CreateHostMcpAdvertisementInput,
): HostMcpAdvertisement {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (input.ttlMs ?? HOST_MCP_ADVERTISEMENT_TTL_MS);
  return {
    version: 1,
    hostId: sanitizeHostId(input.hostId),
    hostKind: "vscode",
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    mcpServer: input.mcpServer,
    workspaceFolders: [...input.workspaceFolders],
    ...(input.activeWorkspaceFolderKey
      ? { activeWorkspaceFolderKey: input.activeWorkspaceFolderKey }
      : {}),
  };
}

export function writeHostMcpAdvertisement(input: {
  readonly t3Home: string;
  readonly advertisement: HostMcpAdvertisement;
}): void {
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  fs.mkdirSync(dir, { recursive: true });
  const targetPath = resolveHostMcpAdvertisementPath(input.t3Home, input.advertisement.hostId);
  const tempPath = path.join(
    dir,
    `.${input.advertisement.hostId}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(input.advertisement, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, targetPath);
}

export function removeHostMcpAdvertisement(input: {
  readonly t3Home: string;
  readonly hostId: string;
}): void {
  fs.rmSync(resolveHostMcpAdvertisementPath(input.t3Home, input.hostId), { force: true });
}

export function readHostMcpAdvertisements(
  input: ReadHostMcpAdvertisementsInput,
): HostMcpAdvertisementReadResult {
  const nowMs = input.nowMs ?? Date.now();
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  const advertisements: HostMcpAdvertisement[] = [];
  let malformed = 0;

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let advertisement: HostMcpAdvertisement;
    try {
      advertisement = decodeHostMcpAdvertisement(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      malformed += 1;
      continue;
    }

    if (isExpired(advertisement, nowMs)) {
      continue;
    }
    const workspaceRoot = input.workspaceRoot;
    if (workspaceRoot) {
      const matchesWorkspaceRoot = advertisement.workspaceFolders.some((folder) =>
        workspaceRootsMatch(folder.cwd, workspaceRoot),
      );
      if (!matchesWorkspaceRoot) {
        continue;
      }
    }
    advertisements.push(advertisement);
  }

  return {
    advertisements: advertisements.toSorted(compareHostMcpAdvertisements),
    malformed,
  };
}

export function cleanupHostMcpAdvertisements(
  input: CleanupHostMcpAdvertisementsInput,
): CleanupHostMcpAdvertisementsResult {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.graceMs ?? HOST_MCP_ADVERTISEMENT_CLEANUP_GRACE_MS;
  const maxDeletes = input.maxDeletes ?? HOST_MCP_ADVERTISEMENT_CLEANUP_MAX_DELETES;
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (deleted >= maxDeletes) {
      break;
    }
    const filePath = path.join(dir, entry);
    let advertisement: HostMcpAdvertisement;
    try {
      advertisement = decodeHostMcpAdvertisement(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      continue;
    }
    const expiresAtMs = Date.parse(advertisement.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs + graceMs > nowMs) {
      continue;
    }
    try {
      fs.rmSync(filePath, { force: true });
      deleted += 1;
    } catch {
      errors += 1;
    }
  }

  return { deleted, errors };
}

export function mergeHostMcpServers(
  bootstrapServers: readonly DesktopBootstrapMcpServer[],
  discoveredServers: readonly DesktopBootstrapMcpServer[],
): readonly DesktopBootstrapMcpServer[] {
  const seenNames = new Set<string>();
  const merged: DesktopBootstrapMcpServer[] = [];
  for (const server of [...bootstrapServers, ...discoveredServers]) {
    if (seenNames.has(server.name)) {
      continue;
    }
    seenNames.add(server.name);
    merged.push(server);
  }
  return merged;
}

export function workspaceRootsMatch(left: string, right: string): boolean {
  return normalizeWorkspaceRootForMatch(left) === normalizeWorkspaceRootForMatch(right);
}

function readAdvertisementFilenames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function sanitizeHostId(hostId: string): string {
  const trimmed = hostId.trim();
  if (!trimmed || !HOST_ID_PATTERN.test(trimmed)) {
    throw new Error(
      "Host MCP advertisement hostId must contain only letters, numbers, '.', '_', or '-'.",
    );
  }
  return trimmed;
}

function isExpired(advertisement: HostMcpAdvertisement, nowMs: number): boolean {
  const expiresAtMs = Date.parse(advertisement.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function compareHostMcpAdvertisements(
  left: HostMcpAdvertisement,
  right: HostMcpAdvertisement,
): number {
  const activeLeft = left.workspaceFolders.some(
    (folder) => folder.key === left.activeWorkspaceFolderKey,
  );
  const activeRight = right.workspaceFolders.some(
    (folder) => folder.key === right.activeWorkspaceFolderKey,
  );
  if (activeLeft !== activeRight) {
    return activeLeft ? -1 : 1;
  }
  return left.hostId.localeCompare(right.hostId);
}

function normalizeWorkspaceRootForMatch(value: string): string {
  const normalized = path.normalize(value.trim());
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

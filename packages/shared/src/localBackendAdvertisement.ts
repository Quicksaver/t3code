// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as fs from "node:fs";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import {
  LocalBackendAdvertisement,
  type DesktopBootstrapWorkspaceFolder,
} from "@t3tools/contracts";
import {
  readAdvertisementFilenames,
  readAdvertisementJson,
  sanitizeAdvertisementId,
  workspaceRootsMatch,
  writeAdvertisementJson,
} from "./advertisementFiles.ts";

export const LOCAL_BACKEND_ADVERTISEMENT_TTL_MS = 30_000;
export const LOCAL_BACKEND_ADVERTISEMENT_HEARTBEAT_MS = 10_000;
export const LOCAL_BACKEND_ADVERTISEMENT_CLEANUP_GRACE_MS = 15 * 60_000;
export const LOCAL_BACKEND_ADVERTISEMENT_CLEANUP_MAX_DELETES = 25;

const ADVERTISEMENT_DIR_PARTS = ["local-backends", "advertisements"] as const;
const BACKEND_ID_PATTERN = /^[a-zA-Z0-9._-]+$/u;

export interface CreateLocalBackendAdvertisementInput {
  readonly backendId: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly workspaceFolders: readonly DesktopBootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolderKey?: string | undefined;
}

export interface ReadLocalBackendAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly workspaceRoot?: string | undefined;
}

export interface LocalBackendAdvertisementReadResult {
  readonly advertisements: readonly LocalBackendAdvertisement[];
  readonly malformed: number;
}

export interface CleanupLocalBackendAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
  readonly maxDeletes?: number;
}

export interface CleanupLocalBackendAdvertisementsResult {
  readonly deleted: number;
  readonly errors: number;
}

const decodeLocalBackendAdvertisement = Schema.decodeUnknownSync(LocalBackendAdvertisement);

export function resolveLocalBackendAdvertisementDir(t3Home: string): string {
  return path.join(t3Home, ...ADVERTISEMENT_DIR_PARTS);
}

export function resolveLocalBackendAdvertisementPath(t3Home: string, backendId: string): string {
  return path.join(
    resolveLocalBackendAdvertisementDir(t3Home),
    `${sanitizeBackendId(backendId)}.json`,
  );
}

export function createLocalBackendAdvertisement(
  input: CreateLocalBackendAdvertisementInput,
): LocalBackendAdvertisement {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (input.ttlMs ?? LOCAL_BACKEND_ADVERTISEMENT_TTL_MS);
  return {
    version: 1,
    backendId: sanitizeBackendId(input.backendId),
    hostKind: "vscode",
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
    workspaceFolders: [...input.workspaceFolders],
    ...(input.activeWorkspaceFolderKey
      ? { activeWorkspaceFolderKey: input.activeWorkspaceFolderKey }
      : {}),
    capabilities: {
      descriptor: true,
      health: true,
      shellSnapshot: true,
      orchestrationEvents: true,
      commandRouting: true,
    },
  };
}

export function writeLocalBackendAdvertisement(input: {
  readonly t3Home: string;
  readonly advertisement: LocalBackendAdvertisement;
}): void {
  const dir = resolveLocalBackendAdvertisementDir(input.t3Home);
  const targetPath = resolveLocalBackendAdvertisementPath(
    input.t3Home,
    input.advertisement.backendId,
  );
  writeAdvertisementJson({
    dir,
    targetPath,
    id: input.advertisement.backendId,
    value: input.advertisement,
  });
}

export function removeLocalBackendAdvertisement(input: {
  readonly t3Home: string;
  readonly backendId: string;
}): void {
  fs.rmSync(resolveLocalBackendAdvertisementPath(input.t3Home, input.backendId), { force: true });
}

export function readLocalBackendAdvertisements(
  input: ReadLocalBackendAdvertisementsInput,
): LocalBackendAdvertisementReadResult {
  const nowMs = input.nowMs ?? Date.now();
  const dir = resolveLocalBackendAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  const advertisements: LocalBackendAdvertisement[] = [];
  let malformed = 0;

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeLocalBackendAdvertisement);
    if (readResult._tag !== "ok") {
      if (readResult._tag === "invalid") {
        malformed += 1;
      }
      continue;
    }
    const advertisement = readResult.value;

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
    advertisements: advertisements.toSorted(compareLocalBackendAdvertisements),
    malformed,
  };
}

export function cleanupLocalBackendAdvertisements(
  input: CleanupLocalBackendAdvertisementsInput,
): CleanupLocalBackendAdvertisementsResult {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.graceMs ?? LOCAL_BACKEND_ADVERTISEMENT_CLEANUP_GRACE_MS;
  const maxDeletes = input.maxDeletes ?? LOCAL_BACKEND_ADVERTISEMENT_CLEANUP_MAX_DELETES;
  const dir = resolveLocalBackendAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (deleted >= maxDeletes) {
      break;
    }
    const filePath = path.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeLocalBackendAdvertisement);
    if (readResult._tag !== "ok") {
      continue;
    }
    const advertisement = readResult.value;
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

function sanitizeBackendId(backendId: string): string {
  return sanitizeAdvertisementId({
    id: backendId,
    pattern: BACKEND_ID_PATTERN,
    label: "Local backend advertisement backendId",
  });
}

function isExpired(advertisement: LocalBackendAdvertisement, nowMs: number): boolean {
  const expiresAtMs = Date.parse(advertisement.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function compareLocalBackendAdvertisements(
  left: LocalBackendAdvertisement,
  right: LocalBackendAdvertisement,
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
  return left.backendId.localeCompare(right.backendId);
}

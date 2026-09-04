// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Host coordination runs before the repository test runtime starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const SCRIPT_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const CONTROL_BRANCH = "refs/heads/base/main";
const BASELINE_SCHEMA_VERSION = 2;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const LOCK_OWNER_GRACE_MS = 10_000;
const LOCK_RECLAIM_SUFFIX = ".reclaim";
const CACHE_ROOT = NodePath.join(SCRIPT_ROOT, ".t3", "research", "worktree-baselines");
const INFRASTRUCTURE_FAILURE_PATTERNS = [
  /exit(?:ed with)?(?: code)? 137/i,
  /ELIFECYCLE.*137/i,
  /JavaScript heap out of memory/i,
] as const;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const WINDOWS_COMMAND_PROCESSOR = NodeProcess.env.ComSpec ?? "cmd.exe";

export interface BaselineCommandResult {
  readonly command: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number;
  readonly failureSignatures: readonly string[];
  readonly logPath: string;
}

export interface BaselineManifest {
  readonly commit: string;
  readonly completedAt: string;
  readonly environment: {
    readonly arch: string;
    readonly locale: string;
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly pnpm: string;
    readonly timeZone: string;
    readonly vp: string;
  };
  readonly expectedToolchain: {
    readonly node: string | null;
    readonly packageManager: string | null;
  };
  readonly fingerprint: string;
  readonly install: BaselineCommandResult;
  readonly overall: "failed" | "passed";
  readonly schemaVersion: 2;
  readonly tests: BaselineCommandResult;
  readonly typecheck: BaselineCommandResult;
}

interface LockOwner {
  readonly createdAt: string;
  readonly pid: number;
}

export interface SingleFlightCacheOptions<A> {
  readonly cacheFilePath: string;
  readonly create: () => Promise<A>;
  readonly isCachedValue: (value: unknown) => value is A;
  readonly logger?: Pick<Console, "log">;
  readonly pollIntervalMs?: number;
  readonly processExists?: (pid: number) => boolean;
}

interface CommandResult {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly output: string;
}

interface CommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export const buildPnpmInvocation = (
  platform: NodeJS.Platform,
  args: readonly string[],
  windowsCommandProcessor = WINDOWS_COMMAND_PROCESSOR,
): CommandInvocation =>
  platform === "win32"
    ? {
        args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
        command: windowsCommandProcessor,
      }
    : { args, command: "pnpm" };

const delay = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const isExisting = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";

const defaultProcessExists = (pid: number): boolean => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readJsonIfPresent = async (filePath: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const readLockOwner = async (lockPath: string): Promise<LockOwner | undefined> => {
  const value = await readJsonIfPresent(NodePath.join(lockPath, "owner.json"));
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== "number" || typeof record.createdAt !== "string") return undefined;
  return { createdAt: record.createdAt, pid: record.pid };
};

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await NodeFSP.rename(temporaryPath, filePath);
  } catch (error) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw error;
  }
};

const tryReclaimLock = async (
  lockPath: string,
  processExists: (pid: number) => boolean,
): Promise<void> => {
  const reclaimPath = `${lockPath}${LOCK_RECLAIM_SUFFIX}`;
  try {
    await NodeFSP.mkdir(reclaimPath);
  } catch (error) {
    if (isExisting(error)) return;
    throw error;
  }

  try {
    const owner = await readLockOwner(lockPath);
    const ownerMissingAndStale =
      owner === undefined &&
      (await NodeFSP.stat(lockPath).then(
        (stat) => Date.now() - stat.mtimeMs > LOCK_OWNER_GRACE_MS,
        (error: unknown) => {
          if (isMissing(error)) return false;
          throw error;
        },
      ));
    if (ownerMissingAndStale || (owner !== undefined && !processExists(owner.pid))) {
      await NodeFSP.rm(lockPath, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(reclaimPath, { recursive: true, force: true });
  }
};

export const ensureSingleFlightCache = async <A>(
  options: SingleFlightCacheOptions<A>,
): Promise<A> => {
  const cacheFilePath = NodePath.resolve(options.cacheFilePath);
  const lockPath = `${cacheFilePath}.lock`;
  const logger = options.logger ?? console;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const processExists = options.processExists ?? defaultProcessExists;
  let announcedWait = false;

  await NodeFSP.mkdir(NodePath.dirname(cacheFilePath), { recursive: true });

  while (true) {
    const cached = await readJsonIfPresent(cacheFilePath);
    if (cached !== undefined) {
      if (!options.isCachedValue(cached)) {
        throw new Error(`Cached baseline has an unsupported shape at ${cacheFilePath}.`);
      }
      return cached;
    }

    try {
      await NodeFSP.mkdir(lockPath);
      await writeJsonAtomic(NodePath.join(lockPath, "owner.json"), {
        createdAt: new Date().toISOString(),
        pid: NodeProcess.pid,
      } satisfies LockOwner);
    } catch (error) {
      if (!isExisting(error)) {
        await NodeFSP.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      await tryReclaimLock(lockPath, processExists);
      if (!announcedWait) {
        logger.log(`Waiting for baseline producer at ${cacheFilePath}.`);
        announcedWait = true;
      }
      await delay(pollIntervalMs);
      continue;
    }

    try {
      const value = await options.create();
      await writeJsonAtomic(cacheFilePath, value);
      return value;
    } finally {
      await NodeFSP.rm(lockPath, { recursive: true, force: true });
    }
  }
};

const runGit = (args: readonly string[]): string => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${String(result.status)}: ${(
        result.stderr ?? ""
      ).trim()}`,
    );
  }
  return result.stdout.trim();
};

const findControlWorktree = (): string => {
  const records = runGit(["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/u);
  for (const record of records) {
    const lines = record.split(/\r?\n/u);
    if (!lines.includes(`branch ${CONTROL_BRANCH}`)) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (worktreeLine !== undefined) return NodePath.resolve(worktreeLine.slice("worktree ".length));
  }
  throw new Error(`No active worktree is registered for ${CONTROL_BRANCH}.`);
};

const readArgument = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const resolveControlCommit = (args: readonly string[], controlWorktree: string): string => {
  const requested = readArgument(args, "--commit");
  const commit = runGit(["rev-parse", requested ?? CONTROL_BRANCH]);
  runGit(["cat-file", "-e", `${commit}^{commit}`]);
  if (requested === undefined && runGit(["-C", controlWorktree, "rev-parse", "HEAD"]) !== commit) {
    throw new Error(`The control worktree HEAD does not match ${CONTROL_BRANCH}.`);
  }
  return commit;
};

export const buildBaselineFingerprint = (
  commit: string,
): {
  readonly arch: string;
  readonly fingerprint: string;
  readonly locale: string;
  readonly node: string | null;
  readonly packageManager: string | null;
  readonly platform: NodeJS.Platform;
  readonly timeZone: string;
} => {
  const packageJsonText = runGit(["show", `${commit}:package.json`]);
  const lockfileText = runGit(["show", `${commit}:pnpm-lock.yaml`]);
  const packageJson = JSON.parse(packageJsonText) as {
    readonly engines?: { readonly node?: string };
    readonly packageManager?: string;
  };
  const resolvedLocale = Intl.DateTimeFormat().resolvedOptions();
  const environment = {
    arch: NodeProcess.arch,
    locale: resolvedLocale.locale,
    platform: NodeProcess.platform,
    timeZone: resolvedLocale.timeZone,
  } as const;
  const payload = JSON.stringify({
    commit,
    ...environment,
    lockfileHash: NodeCrypto.createHash("sha256").update(lockfileText).digest("hex"),
    node: {
      actual: NodeProcess.version,
      expected: packageJson.engines?.node ?? null,
    },
    packageManager: packageJson.packageManager ?? null,
    schemaVersion: BASELINE_SCHEMA_VERSION,
  });
  return {
    ...environment,
    fingerprint: NodeCrypto.createHash("sha256").update(payload).digest("hex").slice(0, 16),
    node: packageJson.engines?.node ?? null,
    packageManager: packageJson.packageManager ?? null,
  };
};

const runCommand = async (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly logPath?: string;
    readonly tee?: boolean;
  } = {},
): Promise<CommandResult> => {
  const startedAt = Date.now();
  const output: Buffer[] = [];
  const logStream =
    options.logPath === undefined
      ? undefined
      : NodeFS.createWriteStream(options.logPath, { encoding: "utf8", flags: "w", mode: 0o600 });
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd: options.cwd,
    env: NodeProcess.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) return;
    interruptedBy = signal;
    if (child.pid === undefined) return;
    if (NodeProcess.platform === "win32") {
      NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  };
  const signalHandlers = {
    SIGINT: () => interrupt("SIGINT"),
    SIGTERM: () => interrupt("SIGTERM"),
  } as const;
  process.once("SIGINT", signalHandlers.SIGINT);
  process.once("SIGTERM", signalHandlers.SIGTERM);
  const consume = (chunk: Buffer): void => {
    output.push(chunk);
    logStream?.write(chunk);
    if (options.tee === true) NodeProcess.stderr.write(chunk);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  let exitCode: number;
  let commandError: unknown;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    });
  } catch (error) {
    commandError = error;
    exitCode = 1;
  } finally {
    process.off("SIGINT", signalHandlers.SIGINT);
    process.off("SIGTERM", signalHandlers.SIGTERM);
  }
  await new Promise<void>((resolve, reject) => {
    if (logStream === undefined) {
      resolve();
      return;
    }
    logStream.once("error", reject);
    logStream.end(resolve);
  });
  if (commandError !== undefined) throw commandError;
  if (interruptedBy !== undefined) {
    throw new Error(`Interrupted ${command} by ${interruptedBy}; result was not cached.`);
  }
  return {
    durationMs: Date.now() - startedAt,
    exitCode,
    output: Buffer.concat(output).toString("utf8"),
  };
};

const runCapture = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<string> => {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.exitCode)}: ${result.output.trim()}`,
    );
  }
  return result.output.trim();
};

export const extractFailureSignatures = (output: string): readonly string[] => {
  const signatures = new Set<string>();
  for (const line of output.replace(ANSI_PATTERN, "").split(/\r?\n/u)) {
    const normalized = line.trim().replace(/\s+/gu, " ");
    if (
      normalized !== "" &&
      (/\bFAIL\b/u.test(normalized) ||
        /AssertionError/u.test(normalized) ||
        /timed out/iu.test(normalized) ||
        /Test Files .*failed/iu.test(normalized) ||
        /vp run: .*failed/iu.test(normalized))
    ) {
      signatures.add(normalized);
    }
    if (signatures.size >= 200) break;
  }
  return [...signatures];
};

const isInfrastructureFailure = (result: CommandResult): boolean =>
  result.exitCode === 137 ||
  INFRASTRUCTURE_FAILURE_PATTERNS.some((pattern) => pattern.test(result.output));

const toManifestCommand = (
  command: readonly string[],
  logPath: string,
  result: CommandResult,
): BaselineCommandResult => ({
  command,
  durationMs: result.durationMs,
  exitCode: result.exitCode,
  failureSignatures: extractFailureSignatures(result.output),
  logPath,
});

const computeBaseline = async (
  commit: string,
  fingerprint: ReturnType<typeof buildBaselineFingerprint>,
  cacheDirectory: string,
  controlWorktree: string,
): Promise<BaselineManifest> => {
  if (runGit(["-C", controlWorktree, "rev-parse", "HEAD"]) !== commit) {
    throw new Error(`Control worktree HEAD does not equal requested baseline commit ${commit}.`);
  }
  if (runGit(["-C", controlWorktree, "status", "--porcelain"]) !== "") {
    throw new Error("The upstream control worktree must be clean before computing a baseline.");
  }

  const canonicalControlWorktree = await NodeFSP.realpath(controlWorktree);
  const runInControl = async (
    name: string,
    args: readonly string[],
  ): Promise<{ readonly manifest: BaselineCommandResult; readonly result: CommandResult }> => {
    const logPath = NodePath.join(cacheDirectory, `${name}.log`);
    const invocation = buildPnpmInvocation(NodeProcess.platform, args);
    NodeProcess.stderr.write(
      `Running native ${NodeProcess.platform} baseline ${name} for ${commit}.\n`,
    );
    const result = await runCommand(invocation.command, invocation.args, {
      cwd: canonicalControlWorktree,
      logPath,
      tee: true,
    });
    if (isInfrastructureFailure(result)) {
      throw new Error(
        `Baseline ${name} ended with an infrastructure failure; result was not cached.`,
      );
    }
    return {
      manifest: toManifestCommand(["pnpm", ...args], logPath, result),
      result,
    };
  };

  const pnpmVersion = buildPnpmInvocation(NodeProcess.platform, ["--version"]);
  const pnpm = await runCapture(pnpmVersion.command, pnpmVersion.args, {
    cwd: canonicalControlWorktree,
  });
  const install = await runInControl("install", ["install", "--frozen-lockfile"]);
  if (install.result.exitCode !== 0) {
    throw new Error("Baseline dependency installation failed; incomplete results were not cached.");
  }
  const vpVersion = buildPnpmInvocation(NodeProcess.platform, ["exec", "vp", "--version"]);
  const vp = await runCapture(vpVersion.command, vpVersion.args, { cwd: canonicalControlWorktree });
  const typecheck = (await runInControl("typecheck", ["run", "typecheck"])).manifest;
  const tests = (
    await runInControl("tests", ["exec", "vp", "run", "-r", "--concurrency-limit", "2", "test"])
  ).manifest;

  return {
    commit,
    completedAt: new Date().toISOString(),
    environment: {
      arch: fingerprint.arch,
      locale: fingerprint.locale,
      node: NodeProcess.version,
      platform: fingerprint.platform,
      pnpm,
      timeZone: fingerprint.timeZone,
      vp,
    },
    expectedToolchain: {
      node: fingerprint.node,
      packageManager: fingerprint.packageManager,
    },
    fingerprint: fingerprint.fingerprint,
    install: install.manifest,
    overall: typecheck.exitCode === 0 && tests.exitCode === 0 ? "passed" : "failed",
    schemaVersion: BASELINE_SCHEMA_VERSION,
    tests,
    typecheck,
  };
};

const isBaselineManifest = (
  value: unknown,
  commit: string,
  fingerprint: string,
): value is BaselineManifest => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === BASELINE_SCHEMA_VERSION &&
    record.commit === commit &&
    record.fingerprint === fingerprint &&
    (record.overall === "passed" || record.overall === "failed")
  );
};

export const main = async (args: readonly string[]): Promise<void> => {
  if (args[0] !== "ensure") {
    throw new Error("Usage: node scripts/worktree-baseline.ts ensure [--commit <upstream-sha>]");
  }
  const controlWorktree = findControlWorktree();
  const commit = resolveControlCommit(args, controlWorktree);
  const fingerprint = buildBaselineFingerprint(commit);
  const cacheDirectory = NodePath.join(CACHE_ROOT, commit, fingerprint.fingerprint);
  const cacheFilePath = NodePath.join(cacheDirectory, "manifest.json");
  const manifest = await ensureSingleFlightCache({
    cacheFilePath,
    create: async () => await computeBaseline(commit, fingerprint, cacheDirectory, controlWorktree),
    isCachedValue: (value): value is BaselineManifest =>
      isBaselineManifest(value, commit, fingerprint.fingerprint),
    logger: { log: (message) => NodeProcess.stderr.write(`${message}\n`) },
  });
  NodeProcess.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
};

const isDirectRun =
  NodeProcess.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(NodeProcess.argv[1])).href;

if (isDirectRun) {
  main(NodeProcess.argv.slice(2)).catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(1);
  });
}

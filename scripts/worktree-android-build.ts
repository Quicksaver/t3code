// @effect-diagnostics nodeBuiltinImport:off - This standalone host utility owns the Windows Android native-build sequence.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import {
  assertShortAndroidNativePaths,
  canonicalAndroidWorktree,
  prepareAndroidDependencies,
  REQUIRED_ANDROID_NATIVE_PACKAGES,
  resolveAndroidNativePackageFromMobile,
} from "./worktree-android-dependencies.ts";

const OUTPUT_TAIL_LIMIT = 64 * 1024;
const NINJA_DIRTY_PATTERN = /build\.ninja still dirty after 100 tries/iu;
const CMAKE_STAGING_MARKER = "t3code-worktree.json";
const GRADLE_STAGING_BEGIN = "    // T3 Code worktree CMake staging: begin";
const GRADLE_STAGING_END = "    // T3 Code worktree CMake staging: end";

export const isNinjaDirtyManifestFailure = (output: string): boolean =>
  NINJA_DIRTY_PATTERN.test(output);

interface CommandResult {
  readonly exitCode: number;
  readonly ninjaManifestDirty: boolean;
  readonly outputTail: string;
}

export interface AndroidBuildOperations {
  readonly install: () => Promise<void>;
  readonly prebuild: () => Promise<void>;
  readonly configureNativeStaging: () => Promise<void>;
  readonly prepareDependencies: () => Promise<void>;
  readonly verifyDependencies: () => Promise<void>;
  readonly build: () => Promise<CommandResult>;
  readonly cleanCmakeState: () => Promise<void>;
}

const buildFailure = (result: CommandResult, attempts: number): Error => {
  const suffix = result.outputTail.trim() === "" ? "" : `\n\n${result.outputTail.trim()}`;
  return new Error(
    `Android native build failed with exit code ${String(result.exitCode)} after ${String(attempts)} attempt${attempts === 1 ? "" : "s"}.${suffix}`,
  );
};

export const executeAndroidBuild = async (
  operations: AndroidBuildOperations,
): Promise<{ readonly attempts: number }> => {
  await operations.install();
  await operations.prebuild();
  await operations.configureNativeStaging();
  await operations.prepareDependencies();
  await operations.verifyDependencies();

  const firstAttempt = await operations.build();
  if (firstAttempt.exitCode === 0) return { attempts: 1 };
  if (!firstAttempt.ninjaManifestDirty) throw buildFailure(firstAttempt, 1);

  await operations.cleanCmakeState();
  await operations.verifyDependencies();
  const secondAttempt = await operations.build();
  if (secondAttempt.exitCode === 0) return { attempts: 2 };
  throw buildFailure(secondAttempt, 2);
};

const pnpmInvocation = (args: readonly string[]): { command: string; args: readonly string[] } => ({
  command: NodeProcess.env.ComSpec ?? "cmd.exe",
  args: ["/d", "/s", "/c", "corepack", "pnpm", ...args],
});

export const resolveExpoCliFromMobile = async (worktree: string): Promise<string> => {
  const mobileRequire = NodeModule.createRequire(
    NodePath.join(worktree, "apps", "mobile", "package.json"),
  );
  const expoRoot = NodePath.dirname(mobileRequire.resolve("expo/package.json"));
  return NodeFSP.realpath(NodePath.join(expoRoot, "bin", "cli"));
};

const normalizedWorktreeIdentity = (worktree: string): string => {
  const normalized = NodePath.resolve(worktree).replaceAll("\\", "/");
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const androidCmakeStagingPath = (
  worktree: string,
  stagingRoot = NodePath.join(
    NodePath.parse(NodePath.resolve(worktree)).root,
    ".t3code-android-cxx",
  ),
): string => {
  const digest = NodeCrypto.createHash("sha256")
    .update(normalizedWorktreeIdentity(worktree))
    .digest("hex")
    .slice(0, 10);
  return NodePath.join(stagingRoot, digest);
};

interface CmakeStagingMarker {
  readonly version: 1;
  readonly worktree: string;
}

const stagingMarkerPath = (stagingPath: string): string =>
  NodePath.join(stagingPath, CMAKE_STAGING_MARKER);

const readStagingMarker = async (stagingPath: string): Promise<CmakeStagingMarker | undefined> => {
  try {
    return JSON.parse(
      await NodeFSP.readFile(stagingMarkerPath(stagingPath), "utf8"),
    ) as CmakeStagingMarker;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const ensureOwnedStagingPath = async (worktree: string, stagingPath: string): Promise<void> => {
  await NodeFSP.mkdir(stagingPath, { recursive: true });
  const marker = await readStagingMarker(stagingPath);
  if (marker !== undefined) {
    if (marker.version !== 1 || marker.worktree !== worktree) {
      throw new Error(
        `Refusing to use ${stagingPath}; its ownership marker does not identify ${worktree}.`,
      );
    }
    return;
  }

  const contents = await NodeFSP.readdir(stagingPath);
  if (contents.length !== 0) {
    throw new Error(`Refusing to claim non-empty unowned CMake staging path ${stagingPath}.`);
  }
  await NodeFSP.writeFile(
    stagingMarkerPath(stagingPath),
    `${JSON.stringify({ version: 1, worktree } satisfies CmakeStagingMarker, undefined, 2)}\n`,
    { flag: "wx" },
  );
};

export const configureAndroidCmakeStaging = async (
  worktree: string,
  stagingRoot?: string,
): Promise<string> => {
  const canonicalWorktree = await NodeFSP.realpath(worktree);
  const stagingPath = androidCmakeStagingPath(canonicalWorktree, stagingRoot);
  await ensureOwnedStagingPath(canonicalWorktree, stagingPath);

  const buildGradlePath = NodePath.join(
    canonicalWorktree,
    "apps",
    "mobile",
    "android",
    "app",
    "build.gradle",
  );
  const source = await NodeFSP.readFile(buildGradlePath, "utf8");
  const gradlePath = stagingPath.replaceAll("\\", "/").replaceAll('"', '\\"');
  const block = `${GRADLE_STAGING_BEGIN}\n    externalNativeBuild {\n        cmake {\n            buildStagingDirectory "${gradlePath}"\n        }\n    }\n    ${GRADLE_STAGING_END}`;
  const existingStart = source.indexOf(GRADLE_STAGING_BEGIN);
  const existingEnd = source.indexOf(GRADLE_STAGING_END);
  let rewritten: string;
  if (existingStart !== -1 && existingEnd > existingStart) {
    rewritten = `${source.slice(0, existingStart)}${block}${source.slice(existingEnd + GRADLE_STAGING_END.length)}`;
  } else {
    const anchor = "    compileSdk rootProject.ext.compileSdkVersion";
    if (source.split(anchor).length !== 2) {
      throw new Error(`Expected exactly one Android compileSdk anchor in ${buildGradlePath}.`);
    }
    rewritten = source.replace(anchor, `${anchor}\n\n${block}`);
  }
  await NodeFSP.writeFile(buildGradlePath, rewritten);
  NodeProcess.stdout.write(`Configured worktree CMake staging at ${stagingPath}.\n`);
  return stagingPath;
};

const runCommand = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<CommandResult> => {
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...NodeProcess.env, ...options.env },
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  let interruptedBy: NodeJS.Signals | undefined;
  let outputTail = "";
  let ninjaManifestDirty = false;
  const consume = (chunk: Buffer, destination: NodeJS.WriteStream): void => {
    destination.write(chunk);
    outputTail = `${outputTail}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_LIMIT);
    if (isNinjaDirtyManifestFailure(outputTail)) ninjaManifestDirty = true;
  };
  child.stdout.on("data", (chunk: Buffer) => consume(chunk, NodeProcess.stdout));
  child.stderr.on("data", (chunk: Buffer) => consume(chunk, NodeProcess.stderr));

  const interrupt = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) return;
    interruptedBy = signal;
    if (child.pid === undefined) return;
    NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  };
  const signalHandlers = {
    SIGINT: () => interrupt("SIGINT"),
    SIGTERM: () => interrupt("SIGTERM"),
  } as const;
  process.once("SIGINT", signalHandlers.SIGINT);
  process.once("SIGTERM", signalHandlers.SIGTERM);

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    });
  } finally {
    process.off("SIGINT", signalHandlers.SIGINT);
    process.off("SIGTERM", signalHandlers.SIGTERM);
  }
  if (interruptedBy !== undefined)
    throw new Error(`Android build interrupted by ${interruptedBy}.`);
  return { exitCode, ninjaManifestDirty, outputTail };
};

const runChecked = async (
  label: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<void> => {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    const suffix = result.outputTail.trim() === "" ? "" : `\n\n${result.outputTail.trim()}`;
    throw new Error(`${label} failed with exit code ${String(result.exitCode)}.${suffix}`);
  }
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const removeScopedAndroidCmakeState = async (worktree: string): Promise<void> => {
  const canonicalWorktree = await NodeFSP.realpath(worktree);
  const mobileRoot = NodePath.join(canonicalWorktree, "apps", "mobile");
  const packagePaths = new Set<string>();
  for (const packageName of REQUIRED_ANDROID_NATIVE_PACKAGES) {
    packagePaths.add(
      await NodeFSP.realpath(NodePath.join(canonicalWorktree, "node_modules", packageName)),
    );
    packagePaths.add(await resolveAndroidNativePackageFromMobile(canonicalWorktree, packageName));
  }

  const candidates = new Set([
    NodePath.join(mobileRoot, "android", ".cxx"),
    NodePath.join(mobileRoot, "android", "app", ".cxx"),
    NodePath.join(mobileRoot, "android", "app", "build", "intermediates", "cxx"),
  ]);
  for (const packagePath of packagePaths) {
    candidates.add(NodePath.join(packagePath, "android", ".cxx"));
    candidates.add(NodePath.join(packagePath, "android", "build", "intermediates", "cxx"));
  }

  for (const target of candidates) {
    const relative = NodePath.relative(canonicalWorktree, target);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative) || relative === "") {
      throw new Error(`Refusing to remove CMake state outside ${canonicalWorktree}: ${target}`);
    }
    try {
      await NodeFSP.access(target);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    await NodeFSP.rm(target, { force: true, recursive: true });
    NodeProcess.stdout.write(`Removed generated CMake state ${target}.\n`);
  }

  const stagingPath = androidCmakeStagingPath(canonicalWorktree);
  const marker = await readStagingMarker(stagingPath);
  if (marker !== undefined) {
    if (marker.version !== 1 || marker.worktree !== canonicalWorktree) {
      throw new Error(
        `Refusing to clean ${stagingPath}; its ownership marker does not identify ${canonicalWorktree}.`,
      );
    }
    for (const entry of await NodeFSP.readdir(stagingPath)) {
      if (entry === CMAKE_STAGING_MARKER) continue;
      await NodeFSP.rm(NodePath.join(stagingPath, entry), { force: true, recursive: true });
    }
    NodeProcess.stdout.write(`Removed generated CMake state ${stagingPath}.\n`);
  }
};

const createOperations = (worktree: string, device: string): AndroidBuildOperations => {
  const mobileRoot = NodePath.join(worktree, "apps", "mobile");
  const install = pnpmInvocation([
    "install",
    "--prefer-offline",
    "--frozen-lockfile",
    "--config.confirm-modules-purge=false",
  ]);
  const expoEnvironment = {
    APP_VARIANT: "development",
    EXPO_NO_GIT_STATUS: "1",
    REACT_NATIVE_PACKAGER_HOSTNAME: "localhost",
  };
  return {
    install: async () =>
      runChecked("Workspace install", install.command, install.args, { cwd: worktree }),
    prebuild: async () =>
      runChecked(
        "Expo clean prebuild",
        NodeProcess.execPath,
        [
          await resolveExpoCliFromMobile(worktree),
          "prebuild",
          "--clean",
          "--platform",
          "android",
          "--no-install",
        ],
        { cwd: mobileRoot, env: expoEnvironment },
      ),
    configureNativeStaging: async () => {
      await configureAndroidCmakeStaging(worktree);
    },
    prepareDependencies: async () => {
      await prepareAndroidDependencies(worktree);
    },
    verifyDependencies: async () => assertShortAndroidNativePaths(worktree),
    build: async () =>
      runCommand(
        NodeProcess.execPath,
        [
          await resolveExpoCliFromMobile(worktree),
          "run:android",
          "--no-bundler",
          "--device",
          device,
        ],
        { cwd: mobileRoot, env: expoEnvironment },
      ),
    cleanCmakeState: async () => removeScopedAndroidCmakeState(worktree),
  };
};

const readOption = (args: readonly string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === "") throw new Error(`Expected ${name} <value>.`);
  return value;
};

const usage =
  "Usage: node scripts/worktree-android-build.ts build --worktree <path> --device <avd-name>";

export const main = async (args: readonly string[]): Promise<void> => {
  if (NodeProcess.platform !== "win32") {
    throw new Error("The isolated Android native-build wrapper runs on Windows.");
  }
  const [command] = args;
  if (command !== "build") throw new Error(usage);
  const worktree = await canonicalAndroidWorktree(readOption(args, "--worktree"));
  const device = readOption(args, "--device");
  const result = await executeAndroidBuild(createOperations(worktree, device));
  NodeProcess.stdout.write(
    `Android native build completed in ${worktree} after ${String(result.attempts)} attempt${result.attempts === 1 ? "" : "s"}.\n`,
  );
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

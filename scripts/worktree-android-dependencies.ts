// @effect-diagnostics nodeBuiltinImport:off - This standalone host utility prepares dependencies before Android verification starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const PACKAGE_CONTAINERS = ["apps", "infra", "packages"] as const;
const FIXED_PACKAGES = ["oxlint-plugin-t3code", "scripts"] as const;
// Native dependency preparation must not reinstall hooks in the shared Git config.
export const ANDROID_INSTALL_ENV = { VP_GIT_HOOKS: "0" } as const;

const SCRIPT_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): void => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd,
    env: { ...NodeProcess.env, ...ANDROID_INSTALL_ENV },
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}.`);
  }
};

const runText = (command: string, args: readonly string[]): string => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}.`);
  }
  return result.stdout.trim();
};

export const canonicalAndroidWorktree = async (worktreeInput: string): Promise<string> => {
  const requested = NodePath.resolve(worktreeInput);
  const root = runText("git", ["-C", requested, "rev-parse", "--show-toplevel"]);
  const canonicalRoot = await NodeFSP.realpath(root);
  const activeWorktrees = runText("git", ["-C", SCRIPT_ROOT, "worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => NodePath.resolve(line.slice("worktree ".length)));
  for (const activeWorktree of activeWorktrees) {
    try {
      if ((await NodeFSP.realpath(activeWorktree)) === canonicalRoot) return canonicalRoot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`${canonicalRoot} is not an active Git worktree of ${SCRIPT_ROOT}.`);
};

const hasPackageManifest = async (directory: string): Promise<boolean> => {
  try {
    await NodeFSP.access(NodePath.join(directory, "package.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const workspacePackageDirectories = async (worktree: string): Promise<readonly string[]> => {
  const directories: string[] = [];
  for (const containerName of PACKAGE_CONTAINERS) {
    const container = NodePath.join(worktree, containerName);
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = await NodeFSP.readdir(container, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = NodePath.join(container, entry.name);
      if (await hasPackageManifest(directory)) directories.push(directory);
    }
  }
  for (const packageName of FIXED_PACKAGES) {
    const directory = NodePath.join(worktree, packageName);
    if (await hasPackageManifest(directory)) directories.push(directory);
  }
  return directories.sort((left, right) => left.localeCompare(right));
};

export const androidDependencyInstallArgs = (): readonly string[] => [
  "/d",
  "/s",
  "/c",
  "corepack",
  "pnpm",
  "install",
  "--prefer-offline",
  "--frozen-lockfile",
  "--config.node-linker=hoisted",
  "--config.confirm-modules-purge=false",
];

const removePackageDependencyTrees = async (worktree: string): Promise<void> => {
  for (const packageDirectory of await workspacePackageDirectories(worktree)) {
    const target = NodePath.join(packageDirectory, "node_modules");
    const relative = NodePath.relative(worktree, target);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      throw new Error(`Refusing to remove dependency tree outside ${worktree}: ${target}`);
    }
    await NodeFSP.rm(target, { force: true, recursive: true });
  }
};

export const isSafeAndroidNativeResolution = (worktree: string, actualPath: string): boolean => {
  const relative = NodePath.relative(worktree, actualPath);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return false;
  return !relative.split(NodePath.sep).some((segment) => segment.toLowerCase() === ".pnpm");
};

export const assertShortAndroidNativePaths = async (
  worktree: string,
  discover: (worktree: string) => Promise<readonly string[]> = androidNativeSourceDirectories,
): Promise<void> => {
  for (const packagePath of await discover(worktree)) {
    if (!isSafeAndroidNativeResolution(worktree, packagePath)) {
      throw new Error(`${packagePath}; expected a worktree-local path without a .pnpm segment.`);
    }
  }
};

/** Read the native source directories selected by the target checkout's own Expo autolinker. */
export const androidNativeSourceDirectories = async (
  worktree: string,
  readConfig: (command: "react-native-config" | "resolve") => string = (command) => {
    const mobile = NodePath.join(worktree, "apps", "mobile");
    const mobileRequire = NodeModule.createRequire(NodePath.join(mobile, "package.json"));
    const expoRequire = NodeModule.createRequire(mobileRequire.resolve("expo/package.json"));
    const autolinking = NodePath.join(
      NodePath.dirname(expoRequire.resolve("expo-modules-autolinking/package.json")),
      "bin",
      "expo-modules-autolinking.js",
    );
    const result = NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [autolinking, command, "--platform", "android", "--json"],
      { cwd: mobile, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Expo ${command} failed: ${result.stderr}`);
    return result.stdout;
  },
): Promise<readonly string[]> => {
  const reactNative = JSON.parse(readConfig("react-native-config")) as {
    dependencies: Record<string, { platforms: { android?: { sourceDir: string } | null } }>;
  };
  const expo = JSON.parse(readConfig("resolve")) as {
    modules: { projects?: { sourceDir: string }[] }[];
  };
  const paths = new Set<string>();
  for (const dependency of Object.values(reactNative.dependencies)) {
    if (dependency.platforms.android) paths.add(dependency.platforms.android.sourceDir);
  }
  for (const module of expo.modules) {
    for (const project of module.projects ?? []) paths.add(project.sourceDir);
  }
  return [...new Set(await Promise.all([...paths].map((path) => NodeFSP.realpath(path))))].sort();
};

export const prepareAndroidDependencies = async (worktreeInput: string): Promise<string> => {
  if (NodeProcess.platform !== "win32") {
    throw new Error("The short Android dependency layout is only required on Windows.");
  }
  const worktree = await canonicalAndroidWorktree(worktreeInput);
  await removePackageDependencyTrees(worktree);
  run(NodeProcess.env.ComSpec ?? "cmd.exe", androidDependencyInstallArgs(), { cwd: worktree });
  await assertShortAndroidNativePaths(worktree);
  return worktree;
};

const readWorktree = (args: readonly string[]): string => {
  const index = args.indexOf("--worktree");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === "") throw new Error("Expected --worktree <path>.");
  return value;
};

/** Reuse an already prepared layout so compatible-client checks do not reinstall dependencies. */
export const ensureAndroidDependencies = async (
  worktree: string,
  check: (worktree: string) => Promise<void> = assertShortAndroidNativePaths,
  prepare: (worktree: string) => Promise<string> = prepareAndroidDependencies,
): Promise<string> => {
  try {
    await check(worktree);
    return worktree;
  } catch {
    return prepare(worktree);
  }
};

const usage =
  "Usage: node scripts/worktree-android-dependencies.ts <prepare|ensure> --worktree <path>";

export const main = async (args: readonly string[]): Promise<void> => {
  const [command] = args;
  if (command !== "prepare" && command !== "ensure") throw new Error(usage);
  const worktree = await (
    command === "ensure" ? ensureAndroidDependencies : prepareAndroidDependencies
  )(readWorktree(args));
  NodeProcess.stdout.write(`Short Android dependency paths ready in ${worktree}.\n`);
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

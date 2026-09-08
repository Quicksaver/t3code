// @effect-diagnostics nodeBuiltinImport:off - This standalone host utility prepares dependencies before Android verification starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const PACKAGE_CONTAINERS = ["apps", "infra", "packages"] as const;
const FIXED_PACKAGES = ["oxlint-plugin-t3code", "scripts"] as const;
export const REQUIRED_ANDROID_NATIVE_PACKAGES = [
  "expo-updates",
  "react-native-nitro-modules",
  "react-native-screens",
  "react-native-worklets",
] as const;

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

export const resolveAndroidNativePackageFromMobile = async (
  worktree: string,
  packageName: string,
): Promise<string> => {
  const mobileRequire = NodeModule.createRequire(
    NodePath.join(worktree, "apps", "mobile", "package.json"),
  );
  const packageJsonPath = mobileRequire.resolve(`${packageName}/package.json`);
  return NodeFSP.realpath(NodePath.dirname(packageJsonPath));
};

export const assertShortAndroidNativePaths = async (
  worktree: string,
  resolvePath: (path: string) => Promise<string> = NodeFSP.realpath,
  resolveMobilePackage: (packageName: string) => Promise<string> = (packageName) =>
    resolveAndroidNativePackageFromMobile(worktree, packageName),
): Promise<void> => {
  const dependencyRoot = NodePath.join(worktree, "node_modules");
  for (const packageName of REQUIRED_ANDROID_NATIVE_PACKAGES) {
    const packagePath = NodePath.join(dependencyRoot, packageName);
    const rootActualPath = await resolvePath(packagePath);
    if (!isSafeAndroidNativeResolution(worktree, rootActualPath)) {
      throw new Error(
        `${packagePath} resolved to ${rootActualPath}; expected a worktree-local path without a .pnpm segment.`,
      );
    }
    if (
      NodePath.relative(dependencyRoot, rootActualPath).toLowerCase() !== packageName.toLowerCase()
    ) {
      throw new Error(
        `${packageName} resolved to ${rootActualPath}; expected a direct worktree-local dependency under ${dependencyRoot}.`,
      );
    }

    const mobileActualPath = await resolveMobilePackage(packageName);
    if (!isSafeAndroidNativeResolution(worktree, mobileActualPath)) {
      throw new Error(
        `${packageName} resolved from apps/mobile to ${mobileActualPath}; expected a worktree-local path without a .pnpm segment.`,
      );
    }
  }
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

const usage = "Usage: node scripts/worktree-android-dependencies.ts prepare --worktree <path>";

export const main = async (args: readonly string[]): Promise<void> => {
  const [command] = args;
  if (command !== "prepare") throw new Error(usage);
  const worktree = await prepareAndroidDependencies(readWorktree(args));
  NodeProcess.stdout.write(`Prepared short Android dependency paths in ${worktree}.\n`);
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

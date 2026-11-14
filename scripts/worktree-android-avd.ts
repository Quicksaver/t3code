// @effect-diagnostics nodeBuiltinImport:off - This standalone host utility must run before Android verification starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const DEFAULT_DEVICE = "pixel_8_pro";
const DEFAULT_PACKAGE = "system-images;android-36;google_apis;x86_64";
const MARKER_FILE = "t3code-worktree.json";

interface AvdMarker {
  readonly avdName: string;
  readonly worktree: string;
}

interface CommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

const SCRIPT_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

export const resolveCommandInvocation = (
  command: string,
  args: readonly string[],
  platform = NodeProcess.platform,
  commandShell = NodeProcess.env.ComSpec ?? "cmd.exe",
): CommandInvocation =>
  platform === "win32" && /\.(?:bat|cmd)$/iu.test(command)
    ? { args: ["/d", "/s", "/c", command, ...args], command: commandShell }
    : { args, command };

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly input?: string } = {},
): string => {
  const invocation = resolveCommandInvocation(command, args);
  const result = NodeChildProcess.spawnSync(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout]
      .filter((value): value is string => value !== undefined && value.trim() !== "")
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}: ${output}`,
    );
  }
  return result.stdout.trim();
};

const canonicalWorktree = async (worktree: string): Promise<string> => {
  const root = run("git", ["-C", NodePath.resolve(worktree), "rev-parse", "--show-toplevel"]);
  const canonicalRoot = await NodeFSP.realpath(root);
  const activeWorktrees = run("git", ["-C", SCRIPT_ROOT, "worktree", "list", "--porcelain"])
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

export const worktreeAvdName = (worktree: string): string => {
  const normalized = NodePath.resolve(worktree).replaceAll("\\", "/");
  const identity = /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  const basename = NodePath.basename(worktree)
    .replaceAll(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 24);
  const digest = NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `T3_${basename || "worktree"}_${digest}`;
};

const androidSdkRoot = (): string => {
  const configured = NodeProcess.env.ANDROID_HOME ?? NodeProcess.env.ANDROID_SDK_ROOT;
  if (configured !== undefined && configured !== "") return NodePath.resolve(configured);
  if (NodeProcess.platform === "win32" && NodeProcess.env.LOCALAPPDATA !== undefined) {
    return NodePath.join(NodeProcess.env.LOCALAPPDATA, "Android", "Sdk");
  }
  return NodePath.join(NodeOS.homedir(), "Library", "Android", "sdk");
};

const avdRoot = (): string =>
  NodePath.resolve(
    NodeProcess.env.ANDROID_AVD_HOME ??
      NodePath.join(
        NodeProcess.env.ANDROID_USER_HOME ?? NodePath.join(NodeOS.homedir(), ".android"),
        "avd",
      ),
  );

const avdManagerPath = (): string => {
  const executable = NodeProcess.platform === "win32" ? "avdmanager.bat" : "avdmanager";
  return NodePath.join(androidSdkRoot(), "cmdline-tools", "latest", "bin", executable);
};

const systemImageDirectory = (): string =>
  NodePath.join(androidSdkRoot(), "system-images", "android-36", "google_apis", "x86_64");

const assertSystemImageInstalled = async (): Promise<void> => {
  const packageMetadata = NodePath.join(systemImageDirectory(), "package.xml");
  try {
    await NodeFSP.access(packageMetadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `Required Android system image ${DEFAULT_PACKAGE} is not installed at ${systemImageDirectory()}. Install SDK packages only with explicit user authorization.`,
      { cause: error },
    );
  }
};

const avdDirectory = (avdName: string): string => NodePath.join(avdRoot(), `${avdName}.avd`);

const markerPath = (avdName: string): string => NodePath.join(avdDirectory(avdName), MARKER_FILE);

const readMarker = async (avdName: string): Promise<AvdMarker | undefined> => {
  try {
    return JSON.parse(await NodeFSP.readFile(markerPath(avdName), "utf8")) as AvdMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const assertOwned = async (avdName: string, worktree: string): Promise<void> => {
  const marker = await readMarker(avdName);
  if (marker?.avdName !== avdName || marker.worktree !== worktree) {
    throw new Error(
      `Refusing to manage ${avdName}; ${markerPath(avdName)} does not identify ${worktree}.`,
    );
  }
};

export const withoutQuickBoot = (config: string): string => {
  const required = new Map([
    ["fastboot.forceChosenSnapshotBoot", "no"],
    ["fastboot.forceColdBoot", "yes"],
    ["fastboot.forceFastBoot", "no"],
    ["firstboot.bootFromDownloadableSnapshot", "no"],
    ["firstboot.bootFromLocalSnapshot", "no"],
    ["firstboot.saveToLocalSnapshot", "no"],
  ]);
  const lines = config.split(/\r?\n/).filter((line) => line !== "");
  const seen = new Set<string>();
  const rewritten = lines.map((line) => {
    const separator = line.indexOf("=");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = required.get(key);
    if (value === undefined) return line;
    seen.add(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of required) {
    if (!seen.has(key)) rewritten.push(`${key}=${value}`);
  }
  return `${rewritten.join("\n")}\n`;
};

const ensure = async (worktreeInput: string): Promise<string> => {
  if (NodeProcess.platform !== "win32") {
    throw new Error("Worktree-owned T3 Android AVDs are provisioned on Windows.");
  }
  const worktree = await canonicalWorktree(worktreeInput);
  const avdName = worktreeAvdName(worktree);
  const directory = avdDirectory(avdName);

  try {
    await NodeFSP.access(directory);
    await assertOwned(avdName, worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await assertSystemImageInstalled();
    run(
      avdManagerPath(),
      [
        "create",
        "avd",
        "--name",
        avdName,
        "--package",
        DEFAULT_PACKAGE,
        "--device",
        DEFAULT_DEVICE,
      ],
      { input: "no\n" },
    );
    await NodeFSP.writeFile(
      markerPath(avdName),
      `${JSON.stringify({ avdName, worktree } satisfies AvdMarker, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  const configPath = NodePath.join(directory, "config.ini");
  await NodeFSP.writeFile(configPath, withoutQuickBoot(await NodeFSP.readFile(configPath, "utf8")));
  return avdName;
};

const remove = async (worktreeInput: string): Promise<string> => {
  if (NodeProcess.platform !== "win32") {
    throw new Error("Worktree-owned T3 Android AVDs are provisioned on Windows.");
  }
  const worktree = await canonicalWorktree(worktreeInput);
  const avdName = worktreeAvdName(worktree);
  await assertOwned(avdName, worktree);
  run(avdManagerPath(), ["delete", "avd", "--name", avdName]);
  return avdName;
};

const readWorktree = (args: readonly string[]): string => {
  const index = args.indexOf("--worktree");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === "") throw new Error("Expected --worktree <path>.");
  return value;
};

const usage = [
  "Usage:",
  "  node scripts/worktree-android-avd.ts ensure --worktree <path>",
  "  node scripts/worktree-android-avd.ts name --worktree <path>",
  "  node scripts/worktree-android-avd.ts remove --worktree <path>",
].join("\n");

export const main = async (args: readonly string[]): Promise<void> => {
  const [command] = args;
  const worktreeInput = readWorktree(args);
  if (command === "ensure") {
    const avdName = await ensure(worktreeInput);
    NodeProcess.stdout.write(`${avdName}\n`);
    return;
  }
  if (command === "name") {
    NodeProcess.stdout.write(`${worktreeAvdName(await canonicalWorktree(worktreeInput))}\n`);
    return;
  }
  if (command === "remove") {
    const avdName = await remove(worktreeInput);
    NodeProcess.stdout.write(`Removed ${avdName}.\n`);
    return;
  }
  throw new Error(usage);
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

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { filterPackagedDependencies } from "./package-dependencies.mjs";

const extensionDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = join(extensionDir, "../..");
const packageJson = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function pruneStagedRuntimeArtifacts(distDir) {
  const stats = {
    directories: 0,
    files: 0,
  };
  const nodeModulesDir = join(distDir, "node_modules");
  const deadRuntimeDirectories = [
    join(nodeModulesDir, ".bin"),
    join(nodeModulesDir, "@types"),
    join(nodeModulesDir, "@pierre", "diffs", "dist", "react"),
    join(nodeModulesDir, "@pierre", "diffs", "dist", "ssr"),
    join(nodeModulesDir, "effect", "src"),
    join(nodeModulesDir, "node-pty", "deps"),
    join(nodeModulesDir, "node-pty", "scripts"),
    join(nodeModulesDir, "node-pty", "src"),
    join(nodeModulesDir, "react"),
    join(nodeModulesDir, "react-dom"),
    join(nodeModulesDir, "scheduler"),
  ];
  const deadRuntimeFiles = [join(nodeModulesDir, "node-pty", "binding.gyp")];
  const deadFileSuffixes = [".map", ".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx", ".pdb"];
  const deadTestFilePattern = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
  const deadTestDirectoryNames = new Set(["test", "tests", "__tests__"]);

  function removeDirectory(path) {
    if (!existsSync(path)) {
      return;
    }

    rmSync(path, { force: true, recursive: true });
    stats.directories += 1;
  }

  function removeFile(path) {
    if (!existsSync(path)) {
      return;
    }

    rmSync(path, { force: true });
    stats.files += 1;
  }

  function shouldRemoveFile(fileName) {
    return (
      deadFileSuffixes.some((suffix) => fileName.endsWith(suffix)) ||
      deadTestFilePattern.test(fileName)
    );
  }

  function pruneDirectory(path) {
    if (!existsSync(path)) {
      return;
    }

    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);

      if (entry.isDirectory()) {
        if (deadTestDirectoryNames.has(entry.name)) {
          removeDirectory(entryPath);
          continue;
        }

        pruneDirectory(entryPath);
        continue;
      }

      if (entry.isFile() && shouldRemoveFile(entry.name)) {
        removeFile(entryPath);
      }
    }
  }

  for (const path of deadRuntimeDirectories) {
    removeDirectory(path);
  }

  const anthropicPackagesDir = join(nodeModulesDir, "@anthropic-ai");
  if (existsSync(anthropicPackagesDir)) {
    for (const entry of readdirSync(anthropicPackagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("claude-agent-sdk-")) {
        removeDirectory(join(anthropicPackagesDir, entry.name));
      }
    }
  }

  for (const path of deadRuntimeFiles) {
    removeFile(path);
  }

  pruneDirectory(distDir);

  console.log(
    `Pruned staged runtime artifacts: ${stats.files} files, ${stats.directories} directories removed`,
  );
}

const distDir = join(extensionDir, "dist");
rmSync(join(distDir, "webview"), { force: true, recursive: true });
rmSync(join(distDir, "server"), { force: true, recursive: true });
rmSync(join(distDir, "node_modules"), { force: true, recursive: true });

run("bun", ["run", "build"], {
  cwd: join(repoRoot, "apps/web"),
  env: { VITE_BASE_URL: "./" },
});
run("bun", ["run", "build"], {
  cwd: join(repoRoot, "apps/server"),
});
run("bun", ["run", "build:extension"], {
  cwd: extensionDir,
});

cpSync(join(repoRoot, "apps/web/dist"), join(distDir, "webview"), { recursive: true });
cpSync(join(repoRoot, "apps/server/dist"), join(distDir, "server"), { recursive: true });
rmSync(join(distDir, "server", "client"), { force: true, recursive: true });

writeFileSync(
  join(distDir, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: filterPackagedDependencies(packageJson.dependencies),
      trustedDependencies: ["node-pty"],
    },
    null,
    2,
  )}\n`,
);
run("bun", ["install", "--production"], { cwd: distDir });
pruneStagedRuntimeArtifacts(distDir);

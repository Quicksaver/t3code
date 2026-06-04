import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const distDir = join(extensionDir, "dist");
rmSync(join(distDir, "webview"), { force: true, recursive: true });
rmSync(join(distDir, "server"), { force: true, recursive: true });
rmSync(join(distDir, "node_modules"), { force: true, recursive: true });

run("pnpm", ["run", "build"], {
  cwd: join(repoRoot, "apps/web"),
  env: { VITE_BASE_URL: "./" },
});
run("pnpm", ["run", "build:extension"], {
  cwd: extensionDir,
});

cpSync(join(repoRoot, "apps/web/dist"), join(distDir, "webview"), { recursive: true });

writeFileSync(
  join(distDir, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: filterPackagedDependencies(packageJson.dependencies),
    },
    null,
    2,
  )}\n`,
);
run("pnpm", ["install", "--prod", "--config.node-linker=hoisted", "--ignore-workspace"], {
  cwd: distDir,
});

// @effect-diagnostics nodeBuiltinImport:off - This host-utility test exercises filesystem discovery directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  androidDependencyInstallArgs,
  assertShortAndroidNativePaths,
  ensureAndroidDependencies,
  androidNativeSourceDirectories,
  workspacePackageDirectories,
} from "./worktree-android-dependencies.ts";

describe("worktree-android-dependencies", () => {
  it("rediscovers Expo autolinking after the dependency layout changes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-autolinking-layout-"));
    const mobile = NodePath.join(root, "apps", "mobile");
    const original = NodePath.join(mobile, "node_modules", "expo");
    const hoisted = NodePath.join(root, "node_modules", "expo");
    const autolinking = NodePath.join(original, "node_modules", "expo-modules-autolinking");
    try {
      await NodeFSP.mkdir(NodePath.join(autolinking, "bin"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(mobile, "package.json"), "{}");
      await NodeFSP.writeFile(NodePath.join(original, "package.json"), '{"name":"expo"}');
      await NodeFSP.writeFile(NodePath.join(autolinking, "package.json"), "{}");
      await NodeFSP.writeFile(
        NodePath.join(autolinking, "bin", "expo-modules-autolinking.js"),
        'console.log(JSON.stringify(process.argv[2] === "resolve" ? { modules: [] } : { dependencies: {} }));',
      );
      await expect(androidNativeSourceDirectories(root)).resolves.toEqual([]);
      await NodeFSP.mkdir(NodePath.dirname(hoisted), { recursive: true });
      await NodeFSP.rename(original, hoisted);
      await expect(androidNativeSourceDirectories(root)).resolves.toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("prepares an isolated layout once and reuses it on subsequent ensures", async () => {
    let layout = "isolated";
    let installs = 0;
    const check = async () => {
      if (layout !== "hoisted") throw new Error("unsafe .pnpm path");
    };
    const prepare = async (worktree: string) => {
      installs++;
      layout = "hoisted";
      return worktree;
    };
    await ensureAndroidDependencies("worktree", check, prepare);
    await ensureAndroidDependencies("worktree", check, prepare);
    expect(installs).toBe(1);
  });

  it("uses a worktree-local hoisted dependency layout", () => {
    expect(androidDependencyInstallArgs()).toEqual([
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
    ]);
  });

  it("discovers only package roots declared by the workspace layout", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-deps-"));
    try {
      await Promise.all([
        NodeFSP.mkdir(NodePath.join(root, "apps", "mobile"), { recursive: true }),
        NodeFSP.mkdir(NodePath.join(root, "apps", "not-a-package"), { recursive: true }),
        NodeFSP.mkdir(NodePath.join(root, "packages", "shared"), { recursive: true }),
        NodeFSP.mkdir(NodePath.join(root, "scripts"), { recursive: true }),
        NodeFSP.mkdir(NodePath.join(root, "unrelated"), { recursive: true }),
      ]);
      await Promise.all([
        NodeFSP.writeFile(NodePath.join(root, "apps", "mobile", "package.json"), "{}"),
        NodeFSP.writeFile(NodePath.join(root, "packages", "shared", "package.json"), "{}"),
        NodeFSP.writeFile(NodePath.join(root, "scripts", "package.json"), "{}"),
        NodeFSP.writeFile(NodePath.join(root, "unrelated", "package.json"), "{}"),
      ]);

      expect(await workspacePackageDirectories(root)).toEqual(
        [
          NodePath.join(root, "apps", "mobile"),
          NodePath.join(root, "packages", "shared"),
          NodePath.join(root, "scripts"),
        ].sort((left, right) => left.localeCompare(right)),
      );
    } finally {
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  });

  it("uses both Expo and React Native autolinking, including nested packages and disabled modules", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-discovery-")),
    );
    const native = NodePath.join(root, "apps", "mobile", "node_modules", "new-native", "android");
    const expo = NodePath.join(root, "node_modules", "new-expo", "native-android");
    try {
      await NodeFSP.mkdir(native, { recursive: true });
      await NodeFSP.mkdir(expo, { recursive: true });
      const read = (command: string) =>
        JSON.stringify(
          command === "resolve"
            ? {
                modules: [
                  { plugins: [{ id: "plugin-only" }] },
                  { projects: [{ sourceDir: expo }, { sourceDir: native }] },
                ],
              }
            : {
                dependencies: {
                  native: { platforms: { android: { sourceDir: native } } },
                  disabled: { platforms: { android: null } },
                },
              },
        );
      const paths = await androidNativeSourceDirectories(root, read);
      expect(paths).toEqual([await NodeFSP.realpath(native), await NodeFSP.realpath(expo)].sort());
      await expect(assertShortAndroidNativePaths(root, async () => paths)).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  });

  it("rejects native virtual-store and external paths", async () => {
    const root = NodePath.join(NodeOS.tmpdir(), "t3-native-validation");
    for (const path of [
      NodePath.join(root, "node_modules", ".pnpm", "native@2", "node_modules", "native"),
      NodePath.join(root, "..", "other", "native"),
    ]) {
      await expect(assertShortAndroidNativePaths(root, async () => [path])).rejects.toThrow(
        "expected a worktree-local path without a .pnpm segment",
      );
    }
  });
});

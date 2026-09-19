// @effect-diagnostics nodeBuiltinImport:off - This host-utility test exercises filesystem discovery directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  androidDependencyInstallArgs,
  assertShortAndroidNativePaths,
  ensureAndroidDependencies,
  REQUIRED_ANDROID_NATIVE_PACKAGES,
  resolveAndroidNativePackageFromMobile,
  workspacePackageDirectories,
} from "./worktree-android-dependencies.ts";

describe("worktree-android-dependencies", () => {
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

  it("finds the mobile dependency when its exports hide package.json", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-exports-"));
    const mobileRoot = NodePath.join(root, "apps", "mobile");
    const packageRoot = NodePath.join(mobileRoot, "node_modules", "react-native-nitro-markdown");
    try {
      for (const dependencyRoot of [
        packageRoot,
        NodePath.join(root, "node_modules", "react-native-nitro-markdown"),
      ]) {
        await NodeFSP.mkdir(dependencyRoot, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(dependencyRoot, "package.json"),
          JSON.stringify({
            name: "react-native-nitro-markdown",
            exports: { ".": "./index.js" },
          }),
        );
        await NodeFSP.writeFile(NodePath.join(dependencyRoot, "index.js"), "");
      }
      await NodeFSP.writeFile(NodePath.join(mobileRoot, "package.json"), "{}");
      await expect(
        resolveAndroidNativePackageFromMobile(root, "react-native-nitro-markdown"),
      ).resolves.toBe(await NodeFSP.realpath(packageRoot));
    } finally {
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
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

  it("validates native resolution from both the workspace root and mobile package", async () => {
    const worktree = NodePath.join(NodeOS.tmpdir(), "t3code.worktrees", "feature");
    const requestedPaths: string[] = [];
    const mobilePackages: string[] = [];

    await assertShortAndroidNativePaths(
      worktree,
      async (requestedPath) => {
        requestedPaths.push(requestedPath);
        const packageName = NodePath.basename(requestedPath);
        return NodePath.join(worktree, "node_modules", packageName);
      },
      async (packageName) => {
        mobilePackages.push(packageName);
        return NodePath.join(worktree, "node_modules", packageName);
      },
    );

    expect(requestedPaths).toHaveLength(REQUIRED_ANDROID_NATIVE_PACKAGES.length);
    expect(mobilePackages).toEqual(REQUIRED_ANDROID_NATIVE_PACKAGES);
  });

  it("rejects a mobile package that resolves through pnpm's long virtual-store path", async () => {
    const worktree = NodePath.join(NodeOS.tmpdir(), "t3code.worktrees", "feature");

    await expect(
      assertShortAndroidNativePaths(
        worktree,
        async (requestedPath) =>
          NodePath.join(worktree, "node_modules", NodePath.basename(requestedPath)),
        async (packageName) =>
          NodePath.join(
            worktree,
            "node_modules",
            ".pnpm",
            `${packageName}@1.0.0_react-native@0.85.3`,
            "node_modules",
            packageName,
          ),
      ),
    ).rejects.toThrow("expected a worktree-local path without a .pnpm segment");
  });
});

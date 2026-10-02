// @effect-diagnostics nodeBuiltinImport:off - This host-utility test verifies scoped Windows filesystem cleanup directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AndroidBuildOperations,
  androidCmakeStagingPath,
  configureAndroidCmakeStaging,
  configureAndroidNativeAbi,
  executeAndroidBuild,
  isNinjaDirtyManifestFailure,
  removeScopedAndroidCmakeState,
  resolveExpoCliFromMobile,
} from "./worktree-android-build.ts";

const result = (exitCode: number, ninjaManifestDirty = false) => ({
  exitCode,
  ninjaManifestDirty,
  outputTail: exitCode === 0 ? "" : "native build failed",
});

const operations = (
  buildResults: readonly ReturnType<typeof result>[],
): { readonly calls: string[]; readonly operations: AndroidBuildOperations } => {
  const calls: string[] = [];
  let buildIndex = 0;
  const operation = (name: string) => async (): Promise<void> => {
    calls.push(name);
  };
  return {
    calls,
    operations: {
      install: operation("install"),
      prebuild: operation("prebuild"),
      configureNativeStaging: operation("configure-staging"),
      prepareDependencies: operation("prepare"),
      verifyDependencies: operation("verify"),
      build: vi.fn(async () => {
        calls.push("build");
        const buildResult = buildResults[buildIndex];
        buildIndex += 1;
        if (buildResult === undefined) throw new Error("Missing test build result.");
        return buildResult;
      }),
      cleanCmakeState: operation("clean-cmake"),
    },
  };
};

describe("worktree-android-build", () => {
  it("resolves Expo again after dependencies move from mobile to the hoisted root", async () => {
    const worktree = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-expo-layout-"));
    const mobile = NodePath.join(worktree, "apps", "mobile");
    const original = NodePath.join(mobile, "node_modules", "expo");
    const hoisted = NodePath.join(worktree, "node_modules", "expo");
    try {
      await NodeFSP.mkdir(NodePath.join(original, "bin"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(mobile, "package.json"), "{}");
      await NodeFSP.writeFile(NodePath.join(original, "package.json"), '{"name":"expo"}');
      await NodeFSP.writeFile(NodePath.join(original, "bin", "cli"), "// Expo CLI fixture");
      expect(await resolveExpoCliFromMobile(worktree)).toBe(
        await NodeFSP.realpath(NodePath.join(original, "bin", "cli")),
      );
      await NodeFSP.mkdir(NodePath.dirname(hoisted), { recursive: true });
      await NodeFSP.rename(original, hoisted);
      expect(await resolveExpoCliFromMobile(worktree)).toBe(
        await NodeFSP.realpath(NodePath.join(hoisted, "bin", "cli")),
      );
    } finally {
      await NodeFSP.rm(worktree, { recursive: true, force: true });
    }
  });

  it("refreshes the shared ABI policy without duplicating Gradle setup or editing source files", async () => {
    const worktree = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-abi-"));
    const android = NodePath.join(worktree, "apps", "mobile", "android");
    const rootGradle = NodePath.join(android, "build.gradle");
    const policy = NodePath.join(android, "t3-react-native-abi.gradle");
    try {
      await NodeFSP.mkdir(android, { recursive: true });
      await NodeFSP.writeFile(rootGradle, "// existing project configuration\n");
      await NodeFSP.writeFile(policy, "// obsolete policy");
      await configureAndroidNativeAbi(worktree);
      const configured = await NodeFSP.readFile(rootGradle, "utf8");
      await configureAndroidNativeAbi(worktree);
      expect(await NodeFSP.readFile(rootGradle, "utf8")).toBe(configured);
      expect(configured).toContain("// existing project configuration");
      expect(await NodeFSP.readFile(policy, "utf8")).toBe(
        await NodeFSP.readFile(
          new URL("../apps/mobile/plugins/react-native-abi.gradle", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await NodeFSP.rm(worktree, { recursive: true, force: true });
    }
  });

  it("recognizes only Ninja's exhausted dirty-manifest failure", () => {
    expect(
      isNinjaDirtyManifestFailure("ninja: error: build.ninja still dirty after 100 tries"),
    ).toBe(true);
    expect(
      isNinjaDirtyManifestFailure(
        "ninja: error: manifest 'build.ninja' still dirty after 100 tries",
      ),
    ).toBe(true);
    expect(isNinjaDirtyManifestFailure("build.ninja still dirty after 99 tries")).toBe(false);
    expect(isNinjaDirtyManifestFailure("manifest 'build.ninja' still dirty after 1000 tries")).toBe(
      false,
    );
  });

  it("keeps dependency preparation immediately before the direct native build", async () => {
    const test = operations([result(0)]);

    await expect(executeAndroidBuild(test.operations)).resolves.toEqual({ attempts: 1 });
    expect(test.calls).toEqual([
      "install",
      "prebuild",
      "configure-staging",
      "prepare",
      "verify",
      "build",
    ]);
  });

  it("cleans generated CMake state and retries once for the exact Ninja failure", async () => {
    const test = operations([result(1, true), result(0)]);

    await expect(executeAndroidBuild(test.operations)).resolves.toEqual({ attempts: 2 });
    expect(test.calls).toEqual([
      "install",
      "prebuild",
      "configure-staging",
      "prepare",
      "verify",
      "build",
      "clean-cmake",
      "verify",
      "build",
    ]);
  });

  it("does not clean or retry unrelated native-build failures", async () => {
    const test = operations([result(1)]);

    await expect(executeAndroidBuild(test.operations)).rejects.toThrow(
      "Android native build failed with exit code 1 after 1 attempt",
    );
    expect(test.calls).toEqual([
      "install",
      "prebuild",
      "configure-staging",
      "prepare",
      "verify",
      "build",
    ]);
  });

  it("stops after one recovery attempt", async () => {
    const test = operations([result(1, true), result(1, true)]);

    await expect(executeAndroidBuild(test.operations)).rejects.toThrow(
      "Android native build failed with exit code 1 after 2 attempts",
    );
    expect(test.calls.filter((call) => call === "clean-cmake")).toHaveLength(1);
    expect(test.calls.filter((call) => call === "build")).toHaveLength(2);
  });

  it("removes only generated CMake state from the selected worktree", async () => {
    const worktree = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-build-")),
    );
    const removedState = NodePath.join(worktree, "apps", "mobile", "android", "app", ".cxx");
    const markdownRoot = NodePath.join(worktree, "node_modules", "react-native-nitro-markdown");
    const markdownState = NodePath.join(markdownRoot, "android", ".cxx");
    const preservedState = NodePath.join(worktree, "apps", "mobile", "android", "app", "src");
    try {
      await Promise.all([
        NodeFSP.mkdir(removedState, { recursive: true }),
        NodeFSP.mkdir(preservedState, { recursive: true }),
        NodeFSP.mkdir(markdownState, { recursive: true }),
      ]);
      await Promise.all([
        NodeFSP.writeFile(NodePath.join(removedState, "build.ninja"), "generated"),
        NodeFSP.writeFile(NodePath.join(markdownState, "build.ninja"), "stale markdown manifest"),
        NodeFSP.writeFile(NodePath.join(markdownRoot, "android", "CMakeLists.txt"), "preserved"),
        NodeFSP.writeFile(NodePath.join(preservedState, "MainApplication.kt"), "preserved"),
      ]);

      await removeScopedAndroidCmakeState(worktree, async () => [
        NodePath.join(markdownRoot, "android"),
      ]);

      await expect(NodeFSP.access(removedState)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(markdownState)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        NodeFSP.readFile(NodePath.join(markdownRoot, "android", "CMakeLists.txt"), "utf8"),
      ).resolves.toBe("preserved");
      await expect(
        NodeFSP.readFile(NodePath.join(preservedState, "MainApplication.kt"), "utf8"),
      ).resolves.toBe("preserved");
    } finally {
      await NodeFSP.rm(worktree, { force: true, recursive: true });
    }
  });

  it("injects a stable, owned short CMake staging path into generated Gradle", async () => {
    const worktree = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-stage-"));
    const stagingRoot = NodePath.join(worktree, "short");
    const buildGradle = NodePath.join(worktree, "apps", "mobile", "android", "app", "build.gradle");
    const rootGradle = NodePath.join(worktree, "apps", "mobile", "android", "build.gradle");
    try {
      await NodeFSP.mkdir(NodePath.dirname(buildGradle), { recursive: true });
      await NodeFSP.writeFile(
        buildGradle,
        "android {\n    compileSdk rootProject.ext.compileSdkVersion\n}\n",
      );
      await NodeFSP.writeFile(rootGradle, "// Existing root project configuration\n");

      const firstPath = await configureAndroidCmakeStaging(worktree, stagingRoot);
      const secondPath = await configureAndroidCmakeStaging(worktree, stagingRoot);
      const source = await NodeFSP.readFile(buildGradle, "utf8");
      const rootSource = await NodeFSP.readFile(rootGradle, "utf8");
      const marker = JSON.parse(
        await NodeFSP.readFile(NodePath.join(firstPath, "t3code-worktree.json"), "utf8"),
      ) as { readonly worktree: string };

      expect(firstPath).toBe(secondPath);
      expect(firstPath).toBe(
        androidCmakeStagingPath(await NodeFSP.realpath(worktree), stagingRoot),
      );
      expect(source.match(/T3 Code worktree CMake staging: begin/gu)).toHaveLength(1);
      expect(source).toContain(`buildStagingDirectory "${firstPath.replaceAll("\\", "/")}"`);
      expect(rootSource.match(/T3 Code library CMake staging: begin/gu)).toHaveLength(1);
      expect(rootSource).toContain("// Existing root project configuration");
      expect(rootSource).toContain(`${firstPath.replaceAll("\\", "/")}/libraries`);
      expect(rootSource).toContain('plugins.withId("com.android.library")');
      expect(marker.worktree).toBe(await NodeFSP.realpath(worktree));
    } finally {
      await NodeFSP.rm(worktree, { force: true, recursive: true });
    }
  });
});

// @effect-diagnostics nodeBuiltinImport:off - This host-utility test verifies scoped Windows filesystem cleanup directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AndroidBuildOperations,
  androidCmakeStagingPath,
  configureAndroidCmakeStaging,
  executeAndroidBuild,
  isNinjaDirtyManifestFailure,
  removeScopedAndroidCmakeState,
} from "./worktree-android-build.ts";
import { REQUIRED_ANDROID_NATIVE_PACKAGES } from "./worktree-android-dependencies.ts";

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
  it("recognizes only Ninja's exhausted dirty-manifest failure", () => {
    expect(
      isNinjaDirtyManifestFailure("ninja: error: build.ninja still dirty after 100 tries"),
    ).toBe(true);
    expect(isNinjaDirtyManifestFailure("build.ninja still dirty after 99 tries")).toBe(false);
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
    const worktree = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-android-build-"));
    const removedState = NodePath.join(worktree, "apps", "mobile", "android", "app", ".cxx");
    const preservedState = NodePath.join(worktree, "apps", "mobile", "android", "app", "src");
    try {
      await Promise.all([
        NodeFSP.mkdir(removedState, { recursive: true }),
        NodeFSP.mkdir(preservedState, { recursive: true }),
        ...["node_modules", NodePath.join("apps", "mobile", "node_modules")].flatMap(
          (resolutionRoot) =>
            REQUIRED_ANDROID_NATIVE_PACKAGES.map((packageName) =>
              NodeFSP.mkdir(NodePath.join(worktree, resolutionRoot, packageName), {
                recursive: true,
              }).then(() =>
                NodeFSP.writeFile(
                  NodePath.join(worktree, resolutionRoot, packageName, "package.json"),
                  "{}",
                ),
              ),
            ),
        ),
      ]);
      await Promise.all([
        NodeFSP.writeFile(NodePath.join(removedState, "build.ninja"), "generated"),
        NodeFSP.writeFile(NodePath.join(preservedState, "MainApplication.kt"), "preserved"),
      ]);

      await removeScopedAndroidCmakeState(worktree);

      await expect(NodeFSP.access(removedState)).rejects.toMatchObject({ code: "ENOENT" });
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
    try {
      await NodeFSP.mkdir(NodePath.dirname(buildGradle), { recursive: true });
      await NodeFSP.writeFile(
        buildGradle,
        "android {\n    compileSdk rootProject.ext.compileSdkVersion\n}\n",
      );

      const firstPath = await configureAndroidCmakeStaging(worktree, stagingRoot);
      const secondPath = await configureAndroidCmakeStaging(worktree, stagingRoot);
      const source = await NodeFSP.readFile(buildGradle, "utf8");
      const marker = JSON.parse(
        await NodeFSP.readFile(NodePath.join(firstPath, "t3code-worktree.json"), "utf8"),
      ) as { readonly worktree: string };

      expect(firstPath).toBe(secondPath);
      expect(firstPath).toBe(
        androidCmakeStagingPath(await NodeFSP.realpath(worktree), stagingRoot),
      );
      expect(source.match(/T3 Code worktree CMake staging: begin/gu)).toHaveLength(1);
      expect(source).toContain(`buildStagingDirectory "${firstPath.replaceAll("\\", "/")}"`);
      expect(marker.worktree).toBe(await NodeFSP.realpath(worktree));
    } finally {
      await NodeFSP.rm(worktree, { force: true, recursive: true });
    }
  });
});

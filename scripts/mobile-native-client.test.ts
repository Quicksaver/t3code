import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import {
  NativeClientError,
  prebuildAndroid,
  buildNativeClient,
  ensureClient,
  NativeClientWorktree,
  prepareNativeClient,
  resolveArtifact,
  installIntoSession,
  type NativeClientRecord,
} from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];
const httpClient = HttpClient.make(() => Effect.die("Unexpected native cache HTTP request"));

const processResult = (stdout = "", exitCode = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.live("keeps cached simulator clients independent of local Personal Team mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-simulator-" });
    const fingerprint = "f".repeat(40);
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const node = yield* HostProcess.ExecutablePath;
    let bundle = "";
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
        if (command.args[0] === "ls-files" || command.args[0] === "--find") return processResult();
        if (command.args[0] === "--eval")
          return processResult(`T3_NATIVE_FINGERPRINT=${fingerprint}`);
        if (command.args.includes("prebuild")) {
          const config = new URL("../apps/mobile/app.config.ts", import.meta.url).href;
          const child = yield* nativeSpawner.spawn(
            ChildProcess.make(
              node,
              [
                "--input-type=module",
                "--eval",
                `const {default: config} = await import(${JSON.stringify(config)});
console.log(JSON.stringify({bundleId: config.ios.bundleIdentifier, widgets: config.plugins.some(plugin => Array.isArray(plugin) && plugin[0] === "expo-widgets")}));`,
              ],
              { env: command.options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
            ),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(Number(code), 0, stderr);
          bundle = stdout.trim();
          return processResult();
        }
        if (command.args[0] === "install") return processResult();
        if (command.args[0] === "xcodebuild") {
          const output = command.args[command.args.indexOf("-derivedDataPath") + 1]!;
          const app = path.join(output, "Build/Products/Debug-iphonesimulator/T3CodeDev.app");
          yield* fs.makeDirectory(app, { recursive: true });
          yield* fs.writeFileString(path.join(app, "Info.plist"), bundle);
          return processResult();
        }
        if (command.args.length === 2 && command.args[0]?.endsWith("T3CodeDev.app")) {
          yield* fs.copy(command.args[0], command.args[1]!);
          return processResult();
        }
        throw new Error(`Unexpected native command: ${command.command}`);
      }),
    );
    const artifact = yield* resolveArtifact(home, "ios", null, fingerprint).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(NativeClientWorktree, path.join(home, "target-worktree")),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {
        T3_NATIVE_CLIENT_CACHE: "off",
        T3CODE_IOS_PERSONAL_TEAM: "1",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.quicksaver.t3code.dev",
      }),
      Effect.provideService(SpawnExecutableResolution, (program) => program),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    assert.equal(artifact.source, "build");
    assert.equal(
      yield* fs.readFileString(path.join(artifact.file, "Info.plist")),
      JSON.stringify({
        bundleId: "com.t3tools.t3code.dev",
        widgets: true,
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

describe("Windows native client builds", () => {
  it.effect("reports both agent-device entrypoints when neither is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-missing-cli-" });
      const worktree = path.join(home, "target-worktree");
      const spawner = ChildProcessSpawner.make((command) => {
        if (
          command._tag === "StandardCommand" &&
          command.args[0]?.endsWith("worktree-android-dependencies.ts")
        )
          return Effect.succeed(processResult());
        throw new Error("Session commands must not start without an agent-device entrypoint");
      });
      const error = yield* installIntoSession(
        home,
        "android",
        "owned-session",
        "x86_64",
        undefined,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(NativeClientWorktree, worktree),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (program) => program),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.flip,
      );
      assert.instanceOf(error, NativeClientError);
      assert.include(
        error.message,
        path.join(worktree, "scripts/node_modules/agent-device/bin/agent-device.mjs"),
      );
      assert.include(
        error.message,
        path.join(worktree, "node_modules/agent-device/bin/agent-device.mjs"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("installs and opens a cached client from the session workspace after hoisting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-session-" });
      const worktree = path.join(home, "target-worktree");
      const workspace = path.join(home, "session-owner");
      const isolated = path.join(
        worktree,
        "scripts/node_modules/agent-device/bin/agent-device.mjs",
      );
      const hoisted = path.join(worktree, "node_modules/agent-device/bin/agent-device.mjs");
      const fingerprint = "f".repeat(40);
      const apk = path.join(
        home,
        ".cache/t3code/native-clients/artifacts/android",
        "development-x86_64",
        fingerprint,
        "app-debug.apk",
      );
      const session = "owned-session";
      const metro = "http://127.0.0.1:8081";
      yield* fs.makeDirectory(workspace);
      yield* fs.makeDirectory(path.dirname(isolated), { recursive: true });
      yield* fs.writeFileString(isolated, "throw new Error('stale entrypoint');");
      yield* fs.makeDirectory(path.dirname(apk), { recursive: true });
      yield* fs.writeFileString(apk, "cached APK");
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
          if (command.args[0]?.endsWith("worktree-android-dependencies.ts")) {
            yield* fs.remove(path.join(worktree, "scripts/node_modules"), { recursive: true });
            yield* fs.makeDirectory(path.dirname(hoisted), { recursive: true });
            yield* fs.writeFileString(
              hoisted,
              `import { appendFile } from "node:fs/promises";
await appendFile("session-commands.ndjson", JSON.stringify(process.argv.slice(2)) + "\\n");`,
            );
            return processResult();
          }
          if (command.args[0] === "--eval")
            return processResult(`T3_NATIVE_FINGERPRINT=${fingerprint}`);
          if (command.args[0]?.endsWith("agent-device.mjs"))
            return yield* nativeSpawner.spawn(command);
          throw new Error(`Unexpected native command: ${command.command}`);
        }),
      );
      yield* installIntoSession(home, "android", session, "x86_64", metro).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(NativeClientWorktree, worktree),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.WorkingDirectory, workspace),
        Effect.provideService(HostProcess.Environment, { T3_NATIVE_CLIENT_CACHE: "off" }),
        Effect.provideService(SpawnExecutableResolution, (program) => program),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      assert.equal(
        yield* fs.readFileString(path.join(workspace, "session-commands.ndjson")),
        [
          JSON.stringify(["install", "com.t3tools.t3code.dev", apk, "--session", session]),
          JSON.stringify([
            "open",
            "com.t3tools.t3code.dev",
            `t3code-dev://expo-development-client/?url=${encodeURIComponent(metro)}&disableOnboarding=1&disableFab=1&disableAutoLaunch=1`,
            "--session",
            session,
          ]),
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caches each ABI from the target worktree without rebuilding a cache hit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-artifacts-" });
      const worktree = path.join(home, "target-worktree");
      const apk = path.join(
        worktree,
        "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
      );
      const fingerprint = "f".repeat(40);
      const builds: string[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
          assert.equal(
            command.options.cwd,
            command.args[0] === "--eval" ? path.join(worktree, "apps/mobile") : worktree,
          );
          if (command.args[0] === "ls-files") return processResult();
          if (command.args[0] === "--eval")
            return processResult(`T3_NATIVE_FINGERPRINT=${fingerprint}`);
          if (command.args[0]?.endsWith("worktree-android-build.ts")) {
            assert.equal(command.args[1], "assemble");
            assert.equal(command.args[3], worktree);
            const abi = command.args[5]!;
            builds.push(abi);
            yield* fs.makeDirectory(path.dirname(apk), { recursive: true });
            yield* fs.writeFileString(apk, `APK:${abi}`);
            return processResult();
          }
          throw new Error(`Unexpected native command: ${command.command}`);
        }),
      );
      yield* Effect.gen(function* () {
        for (const abi of ["x86_64", "arm64-v8a"]) {
          const artifact = yield* resolveArtifact(home, "android", abi, fingerprint);
          assert.equal(artifact.source, "build");
          assert.equal(yield* fs.readFileString(artifact.file), `APK:${abi}`);
        }
        yield* fs.remove(path.join(worktree, "apps/mobile/android"), { recursive: true });
        for (const abi of ["x86_64", "arm64-v8a"]) {
          const artifact = yield* resolveArtifact(home, "android", abi, fingerprint);
          assert.equal(artifact.source, "local");
          assert.equal(yield* fs.readFileString(artifact.file), `APK:${abi}`);
        }
        assert.deepEqual(builds, ["x86_64", "arm64-v8a"]);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(NativeClientWorktree, worktree),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { T3_NATIVE_CLIENT_CACHE: "off" }),
        Effect.provideService(SpawnExecutableResolution, (program) => program),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["x86_64", "arm64-v8a"])("does not cache a failed Windows %s assembly", (abi) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-failed-" });
      const worktree = path.join(home, "target-worktree");
      const apk = path.join(
        worktree,
        "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
      );
      yield* fs.makeDirectory(path.dirname(apk), { recursive: true });
      yield* fs.writeFileString(apk, "stale APK from an earlier build");
      const fingerprint = "f".repeat(40);
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
        if (command.args[0] === "ls-files") return Effect.succeed(processResult());
        if (command.args[0]?.endsWith("worktree-android-build.ts"))
          return Effect.succeed(processResult("", 1));
        throw new Error(`Unexpected native command: ${command.command}`);
      });
      const error = yield* resolveArtifact(home, "android", abi, fingerprint).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(NativeClientWorktree, worktree),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { T3_NATIVE_CLIENT_CACHE: "off" }),
        Effect.provideService(SpawnExecutableResolution, (program) => program),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.flip,
      );
      assert.instanceOf(error, NativeClientError);
      assert.isFalse(
        yield* fs.exists(
          path.join(
            home,
            ".cache/t3code/native-clients/artifacts/android",
            `development-${abi}`,
            fingerprint,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses current orchestration helpers against a separate target checkout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const target = path.resolve("target-worktree");
      const commands: { args: readonly string[]; cwd: string | undefined }[] = [];
      yield* prepareNativeClient("android", (_program, args, _inherit, cwd) => {
        commands.push({ args, cwd });
        return Effect.succeed("");
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(NativeClientWorktree, target),
      );
      assert.equal(commands[0]!.cwd, target);
      assert.equal(commands[0]!.args.at(-1), target);
      assert.notInclude(commands[0]!.args[0]!, "target-worktree");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("fingerprints the prepared layout and records the installed binary", () =>
    Effect.gen(function* () {
      let layout = "isolated";
      let installed = false;
      let saved: NativeClientRecord | null = null;
      const result = yield* ensureClient({
        prepare: prepareNativeClient("android", () => {
          layout = "hoisted";
          return Effect.succeed("");
        }),
        fingerprint: Effect.sync(() => layout),
        installedBinary: Effect.sync(() => (installed ? "built-apk" : null)),
        readRecord: Effect.succeed(null),
        install: () =>
          Effect.sync(() => {
            installed = true;
            return "build" as const;
          }),
        saveRecord: (record) =>
          Effect.sync(() => {
            saved = record;
          }),
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.isTrue(result.installed);
      assert.deepEqual(saved, { fingerprint: "hoisted", binary: "built-apk" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("assembles a cacheable APK through the Windows wrapper without a device", () =>
    Effect.gen(function* () {
      const commands: string[][] = [];
      yield* buildNativeClient("arm64-v8a", (program, args) => {
        commands.push([program, ...args]);
        return Effect.succeed("");
      });
      assert.lengthOf(commands, 2);
      const build = commands[1]!;
      assert.equal((yield* Path.Path).basename(build[1]!), "worktree-android-build.ts");
      assert.deepEqual(build.slice(-2), ["--abi", "arm64-v8a"]);
      assert.equal(build[2], "assemble");
      assert.equal(build[3], "--worktree");
      assert.notInclude(build, "--device");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the tracked-native-files guard before invoking the Windows wrapper", () =>
    Effect.gen(function* () {
      const programs: string[] = [];
      const error = yield* buildNativeClient("x86_64", (program) => {
        programs.push(program);
        return Effect.succeed("apps/mobile/android/app/build.gradle");
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.flip);
      assert.instanceOf(error, NativeClientError);
      assert.deepEqual(programs, ["git"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

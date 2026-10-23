import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  NativeClientError,
  prebuildAndroid,
  buildNativeClient,
  ensureClient,
  NativeClientWorktree,
  prepareNativeClient,
  type NativeClientRecord,
} from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

// A generated Android project with Gradle and native outputs, and a stand-in for
// `expo prebuild --clean`, which deletes the directory and writes fresh sources.
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
  it.effect.each([
    { sourceChanges: false, outcome: "and records one build" },
    { sourceChanges: true, outcome: "and rejects source edits" },
  ])("prepares isolated dependencies before fingerprinting $outcome", ({ sourceChanges }) =>
    Effect.gen(function* () {
      let layout = "isolated";
      let source = "original";
      let builds = 0;
      let saved: NativeClientRecord | null = null;
      const result = yield* ensureClient({
        prepare: prepareNativeClient("android", (_program, args) => {
          assert.equal(args[1], "ensure");
          layout = "hoisted";
          return Effect.succeed("");
        }),
        fingerprint: Effect.sync(() => `${layout}:${source}`),
        installedBinary: Effect.sync(() => (builds ? "built-apk" : null)),
        readRecord: Effect.succeed(null),
        build: Effect.sync(() => {
          builds++;
          layout = "hoisted";
          if (sourceChanges) source = "edited";
        }),
        saveRecord: (record) =>
          Effect.sync(() => {
            saved = record;
          }),
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.result);
      assert.equal(builds, 1);
      if (sourceChanges) {
        assert.equal(result._tag, "Failure");
        assert.isNull(saved);
      } else {
        assert.equal(result._tag, "Success");
        assert.deepEqual(saved, { fingerprint: "hoisted:original", binary: "built-apk" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the selected emulator and gives the wrapper exclusive build ownership", () =>
    Effect.gen(function* () {
      const commands: string[][] = [];
      yield* buildNativeClient("android", "emulator-5562", (program, args) => {
        commands.push([program, ...args]);
        return Effect.succeed(program === "adb" ? "t3_worktree_test\r\nOK" : "");
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.lengthOf(commands, 3);
      assert.deepEqual(commands[1], ["adb", "-s", "emulator-5562", "emu", "avd", "name"]);
      const build = commands[2]!;
      assert.equal((yield* Path.Path).basename(build[1]!), "worktree-android-build.ts");
      assert.deepEqual(build.slice(-2), ["--device", "t3_worktree_test"]);
      assert.equal(build[2], "build");
      assert.equal(build[3], "--worktree");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects ambiguous emulator identity before installing or cleaning native files", () =>
    Effect.gen(function* () {
      const programs: string[] = [];
      const error = yield* buildNativeClient("android", "emulator-5562", (program) => {
        programs.push(program);
        return Effect.succeed(program === "adb" ? "first\nsecond\nOK" : "");
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.flip);
      assert.instanceOf(error, NativeClientError);
      assert.deepEqual(programs, ["git", "adb"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the tracked-native-files guard before invoking the Windows wrapper", () =>
    Effect.gen(function* () {
      const programs: string[] = [];
      const error = yield* buildNativeClient("android", "emulator-5562", (program) => {
        programs.push(program);
        return Effect.succeed("apps/mobile/android/app/build.gradle");
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.flip);
      assert.instanceOf(error, NativeClientError);
      assert.deepEqual(programs, ["git"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

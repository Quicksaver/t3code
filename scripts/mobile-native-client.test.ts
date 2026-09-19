import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  buildNativeClient,
  ensureClient,
  NativeClientError,
  prepareNativeClient,
  type NativeClientRecord,
} from "./mobile-native-client.ts";

describe("Windows native client builds", () => {
  for (const sourceChanges of [false, true]) {
    it.effect(
      `prepares isolated dependencies before fingerprinting${sourceChanges ? " and rejects source edits" : " and records one build"}`,
      () =>
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
          }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.result);
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
  }

  it.effect("resolves the selected emulator and gives the wrapper exclusive build ownership", () =>
    Effect.gen(function* () {
      const commands: string[][] = [];
      yield* buildNativeClient("android", "emulator-5562", (program, args) => {
        commands.push([program, ...args]);
        return Effect.succeed(program === "adb" ? "t3_worktree_test\r\nOK" : "");
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));
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
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.flip);
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
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.flip);
      assert.instanceOf(error, NativeClientError);
      assert.deepEqual(programs, ["git"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

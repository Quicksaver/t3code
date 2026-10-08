import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";

import * as PowerProtection from "./PowerProtection.ts";

vi.mock("electron", () => ({ powerSaveBlocker: {} }));

const nativeBlocker = () => ({
  start: vi.fn(() => 17),
  stop: vi.fn(() => true),
  isStarted: vi.fn(() => true),
});

describe("preview power protection", () => {
  it.effect.each(["win32", "darwin"] as const)(
    "shares suspension protection across activities on %s and releases the final activity",
    (platform) => {
      const native = nativeBlocker();
      return Effect.gen(function* () {
        const power = yield* PowerProtection.make(platform, native);
        expect(native.start).not.toHaveBeenCalled();
        const releaseFirst = yield* power.acquire;
        const releaseSecond = yield* power.acquire;
        expect(native.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
        yield* releaseFirst;
        yield* releaseFirst;
        expect(native.stop).not.toHaveBeenCalled();
        yield* releaseSecond;
        expect(native.stop).toHaveBeenCalledExactlyOnceWith(17);
        yield* releaseSecond;
        expect(native.stop).toHaveBeenCalledTimes(1);
        const releaseNext = yield* power.acquire;
        expect(native.start).toHaveBeenCalledTimes(2);
        yield* releaseNext;
        expect(native.stop).toHaveBeenCalledTimes(2);
      }).pipe(Effect.scoped);
    },
  );

  it.effect(
    "releases failed and interrupted automation without releasing a concurrent recording",
    () => {
      const native = nativeBlocker();
      return Effect.gen(function* () {
        const power = yield* PowerProtection.make("win32", native);
        const releaseRecording = yield* power.acquire;
        const failure = yield* power.withActivity(Effect.fail("failed action")).pipe(Effect.exit);
        expect(Exit.isFailure(failure)).toBe(true);
        const started = yield* Deferred.make<void>();
        const action = yield* Effect.forkChild(
          power.withActivity(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(action);
        expect(native.stop).not.toHaveBeenCalled();
        yield* releaseRecording;
        expect(native.stop).toHaveBeenCalledExactlyOnceWith(17);
      }).pipe(Effect.scoped);
    },
  );

  it.effect(
    "releases outstanding recording protection at shutdown and rejects late acquisitions",
    () => {
      const native = nativeBlocker();
      return Effect.gen(function* () {
        const scope = yield* Scope.make();
        const power = yield* PowerProtection.make("darwin", native).pipe(Scope.provide(scope));
        const release = yield* power.acquire;
        yield* Scope.close(scope, Exit.void);
        yield* release;
        const releaseLate = yield* power.acquire;
        yield* releaseLate;
        expect(native.start).toHaveBeenCalledTimes(1);
        expect(native.stop).toHaveBeenCalledExactlyOnceWith(17);
      });
    },
  );

  it.effect("does not request native protection on unsupported platforms", () => {
    const native = nativeBlocker();
    return Effect.gen(function* () {
      const power = yield* PowerProtection.make("linux", native);
      yield* power.withActivity(Effect.void);
      expect(native.start).not.toHaveBeenCalled();
      expect(native.stop).not.toHaveBeenCalled();
    }).pipe(Effect.scoped);
  });
});

import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { resolveMagiInvocation, magiInvocationCaller, magiCallerKey } from "./MagiInvocation.ts";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("root"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "credential",
  capabilities: new Set(["magi-control"]),
  issuedAt: 1,
};
const dependencies = {
  getBinding: () =>
    Effect.succeedSome({
      threadId: scope.threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: scope.providerInstanceId,
      resumeCursor: { threadId: "native-root" },
    }),
  verifyNativeCaller: (_threadId: ThreadId, id: string) =>
    ["child-a", "child-b", "nested"].includes(id) ? Effect.void : Effect.fail("foreign"),
};
it.effect("isolates concurrent native callers without creating T3 conversations", () =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      [undefined, "native-root", "child-a", "child-b", "nested"],
      (nativeThreadId) => resolveMagiInvocation({ ...scope, nativeThreadId }, dependencies),
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result.threadId)).toEqual(Array(5).fill("root"));
    const keys = results.map((result) => magiCallerKey(magiInvocationCaller(result)));
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(4);
  }),
);
it.effect("rejects foreign, invalid, unavailable and wrong-instance callers", () =>
  Effect.gen(function* () {
    for (const nativeThreadId of ["foreign", "", 42, null]) {
      const error = yield* resolveMagiInvocation({ ...scope, nativeThreadId }, dependencies).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("MagiValidationError");
      expect(error.message).not.toContain("registered");
    }
    for (const getBinding of [
      () => Effect.fail("storage unavailable"),
      () => Effect.succeed(Option.none()),
      () =>
        Effect.succeedSome({
          threadId: scope.threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("other"),
          resumeCursor: {},
        }),
      () =>
        Effect.succeedSome({
          threadId: scope.threadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: scope.providerInstanceId,
          resumeCursor: {},
        }),
    ]) {
      expect(
        (yield* resolveMagiInvocation(
          { ...scope, nativeThreadId: "child-a" },
          { ...dependencies, getBinding },
        ).pipe(Effect.flip))._tag,
      ).toBe("MagiValidationError");
    }
  }),
);

it.effect("bounds stalled native verification and rejects the caller", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const verification = yield* resolveMagiInvocation(
      { ...scope, nativeThreadId: "child-a" },
      {
        ...dependencies,
        verifyNativeCaller: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      },
    ).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(verification))._tag).toBe("MagiValidationError");
  }),
);

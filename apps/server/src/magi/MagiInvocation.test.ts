import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { resolveMagiInvocation } from "./MagiInvocation.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("root"),
  providerInstanceId: ProviderInstanceId.make("codex-custom"),
  providerSessionId: "credential-session",
  capabilities: new Set(["magi-control"]),
  issuedAt: 1,
};
const child = (id: string, parent = "root", kind = "subagent", instanceId = "codex-custom") => ({
  id: ThreadId.make(id),
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId) },
  parentRelation: { kind, parentThreadId: ThreadId.make(parent), providerThreadId: `native-${id}` },
});
const dependencies = (threads: ReadonlyArray<unknown>) => ({
  getBinding: () =>
    Effect.succeed(
      Option.some({
        threadId: scope.threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: scope.providerInstanceId,
        resumeCursor: { threadId: "native-root" },
      }),
    ),
  getThreads: () => Effect.succeed(threads),
});

it.effect("keeps legacy calls and native root calls on their owner without listing threads", () =>
  Effect.gen(function* () {
    const deps = { ...dependencies([]), getThreads: () => Effect.die("must not list") };
    expect(yield* resolveMagiInvocation(scope, deps)).toEqual(scope);
    expect(
      (yield* resolveMagiInvocation({ ...scope, nativeThreadId: "native-root" }, deps)).threadId,
    ).toBe(scope.threadId);
  }),
);

it.effect(
  "routes concurrent siblings and nested children independently under an inherited credential",
  () =>
    Effect.gen(function* () {
      const deps = dependencies([child("a"), child("b"), child("nested", "a")]);
      const results = yield* Effect.all(
        ["a", "b", "nested"].map((id) =>
          resolveMagiInvocation({ ...scope, nativeThreadId: `native-${id}` }, deps),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.threadId)).toEqual(["a", "b", "nested"]);
      for (const result of results) {
        expect(result.providerSessionId).toBe(scope.providerSessionId);
        expect(result.capabilities).toBe(scope.capabilities);
      }
    }),
);

it.effect("rejects unknown, foreign, participant, cross-instance and cyclic callers", () =>
  Effect.gen(function* () {
    const deps = dependencies([
      child("foreign", "another-root"),
      child("participant", "root", "magi"),
      child("other-instance", "root", "subagent", "codex-other"),
      child("cycle-a", "cycle-b"),
      child("cycle-b", "cycle-a"),
      child("under-participant", "participant"),
    ]);
    for (const nativeThreadId of [
      "native-missing",
      "native-foreign",
      "native-participant",
      "native-other-instance",
      "native-cycle-a",
      "native-under-participant",
      "",
      42,
      null,
    ]) {
      const result = yield* resolveMagiInvocation({ ...scope, nativeThreadId }, deps).pipe(
        Effect.flip,
      );
      expect(result._tag).toBe("MagiValidationError");
    }
  }),
);

it.effect("does not let a child's own credential target its parent or siblings", () =>
  Effect.gen(function* () {
    const deps = dependencies([child("a"), child("b")]);
    for (const nativeThreadId of ["native-root", "native-b"]) {
      const result = yield* resolveMagiInvocation(
        { ...scope, threadId: ThreadId.make("a"), nativeThreadId },
        {
          ...deps,
          getBinding: () =>
            Effect.succeed(
              Option.some({
                threadId: ThreadId.make("a"),
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: scope.providerInstanceId,
                resumeCursor: { threadId: "native-a" },
              }),
            ),
        },
      ).pipe(Effect.flip);
      expect(result._tag).toBe("MagiValidationError");
    }
  }),
);

it.effect("fails when routing storage is unavailable instead of falling back to the parent", () =>
  Effect.gen(function* () {
    const result = yield* resolveMagiInvocation(
      { ...scope, nativeThreadId: "native-child" },
      {
        ...dependencies([]),
        getBinding: () => Effect.fail("database unavailable"),
      },
    ).pipe(Effect.flip);
    expect(result._tag).toBe("MagiValidationError");
  }),
);

it.effect("bounds a stalled routing lookup", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const pending = yield* resolveMagiInvocation(
      { ...scope, nativeThreadId: "native-child" },
      {
        ...dependencies([]),
        getBinding: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      },
    ).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("5 seconds");
    expect((yield* Fiber.join(pending))._tag).toBe("MagiValidationError");
  }),
);

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { AtomRegistry } from "effect/reactivity";

import {
  vcsCommandConcurrency,
  vcsCommandScheduler,
  vcsRemoteRefreshCommandScheduler,
  vcsStatusRefreshCommandConcurrency,
  vcsStatusRefreshCommandScheduler,
} from "./vcsCommandScheduler.ts";

const target = {
  environmentId: EnvironmentId.make("environment-1"),
  input: { cwd: "/repo" },
};

describe("vcs command scheduling", () => {
  it.effect.each([
    {
      operation: "background remote refresh",
      scheduler: vcsRemoteRefreshCommandScheduler,
      concurrency: vcsCommandConcurrency,
    },
    {
      operation: "status polling",
      scheduler: vcsStatusRefreshCommandScheduler,
      concurrency: vcsStatusRefreshCommandConcurrency,
    },
  ])("does not let $operation delay a repository mutation", ({ scheduler, concurrency }) =>
    Effect.gen(function* () {
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const refresh = yield* scheduler
        .schedule(
          registry,
          concurrency,
          target,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      const mutation = yield* vcsCommandScheduler.schedule(
        registry,
        vcsCommandConcurrency,
        target,
        Effect.succeed("committed"),
      );

      expect(mutation).toBe("committed");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(refresh);
    }),
  );
});

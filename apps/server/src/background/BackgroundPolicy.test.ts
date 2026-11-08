import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type HostPowerSnapshot,
  type ClientActivityReportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: TEST_NOW,
};

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "client-1",
    clientKind: "web",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "vcs-status", cwd: "/repo" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function layerFor(
  hostPower: HostPowerSnapshot,
  settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0] = {},
  beforeSnapshot: Effect.Effect<void> = Effect.void,
) {
  const layerHost = Layer.effect(
    HostPowerMonitor.HostPowerMonitor,
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);
      let snapshot = hostPower;
      return HostPowerMonitor.HostPowerMonitor.of({
        snapshot: beforeSnapshot.pipe(Effect.andThen(Effect.sync(() => snapshot))),
        report: (next) =>
          Effect.sync(() => {
            snapshot = next;
          }).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  );
  return BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(layerHost, ServerSettings.layerTest(settingsOverrides))),
  );
}

describe("BackgroundPolicy", () => {
  it.effect("publishes panel demand acquisition and release to existing subscribers", () =>
    Effect.gen(function* () {
      const publicationStarted = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      let pauseNextSnapshot = false;
      const beforeSnapshot = Effect.suspend(() => {
        if (!pauseNextSnapshot) return Effect.void;
        pauseNextSnapshot = false;
        return Deferred.succeed(publicationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePublication)),
        );
      });

      yield* Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const sessionId = AuthSessionId.make("panel-session");
        const rpcClientId = RpcClientId.make(1);
        const scope = { type: "git-refs", cwd: "/repo" } as const;
        const subscription = yield* policy.subscribe;
        assert.deepStrictEqual(subscription.latest.activeScopeKeys, []);

        yield* policy.reportClientActivity(sessionId, rpcClientId, makeReport({ scopes: [scope] }));
        const acquired = Option.getOrThrow(yield* Stream.runHead(subscription.changes));
        assert.deepStrictEqual(acquired.activeScopeKeys, ["git-refs:/repo"]);
        assert.equal(yield* policy.hasDemand(scope), true);

        yield* policy.removeRpcClient(sessionId, rpcClientId);
        const released = Option.getOrThrow(yield* Stream.runHead(subscription.changes));
        assert.deepStrictEqual(released.activeScopeKeys, []);
        assert.equal(yield* policy.hasDemand(scope), false);

        pauseNextSnapshot = true;
        const reportFiber = yield* policy
          .reportClientActivity(sessionId, rpcClientId, makeReport({ scopes: [scope] }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(publicationStarted);
        const removeFiber = yield* policy
          .removeRpcClient(sessionId, rpcClientId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isUndefined(removeFiber.pollUnsafe());

        yield* Deferred.succeed(releasePublication, undefined);
        yield* Fiber.join(reportFiber);
        yield* Fiber.join(removeFiber);
        const last = Option.getOrThrow(yield* Stream.runHead(subscription.changes));
        assert.deepStrictEqual(last.activeScopeKeys, []);
        assert.equal(last.activeForegroundLeaseCount, 0);
        assert.equal(yield* policy.hasDemand(scope), false);
      }).pipe(Effect.provide(layerFor(nominalHostPower, {}, beforeSnapshot)));
    }).pipe(Effect.scoped),
  );

  it.effect("removes all leases for a disconnected websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );
      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1));

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, []);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps leases from another session when rpc client ids are reused", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientId = RpcClientId.make(1);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        rpcClientId,
        makeReport({ clientId: "client-1" }),
      );
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        rpcClientId,
        makeReport({ clientId: "client-2" }),
      );

      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), rpcClientId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.leases[0]?.sessionId, AuthSessionId.make("session-2"));
      assert.equal(snapshot.leases[0]?.clientId, "client-2");
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("bounds client-id churn for one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("session-1");
      const rpcClientId = RpcClientId.make(1);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `client-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `client-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("host suspension disables scoped and opportunistic work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor({
          ...nominalHostPower,
          suspended: true,
          stale: false,
        }),
      ),
    ),
  );

  it.effect("keeps background demand visible while preventing scoped work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, visible: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps scoped work active after a recently used visible window loses focus", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: true }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("battery saver profile pauses scoped work on battery", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            onBattery: "true",
            stale: false,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );

  it.effect("does not gate work on stale host power values", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            locked: "true",
            onBattery: "true",
            lowPowerMode: "true",
            thermalState: "critical",
            stale: true,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );
});

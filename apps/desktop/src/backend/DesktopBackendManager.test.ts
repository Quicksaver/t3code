// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readDesktopBackendAdvertisements } from "@t3tools/shared/desktopBackendAdvertisement";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function healthyResponseForRequest(
  request: HttpClientRequest.HttpClientRequest,
): HttpClientResponse.HttpClientResponse {
  return responseForRequest(request, 200);
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(healthyResponseForRequest(request)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

interface MakeInstanceInput {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<DesktopBackendManager.DesktopBackendStartConfig>;
  readonly advertiseDesktopBackend?: boolean;
}

// Helper that constructs a primary backend instance using the factory
// directly. The factory's deps (FileSystem, ChildProcessSpawner,
// HttpClient, DesktopBackendOutputLogFactory) are provided per-test via
// a scoped layer; tests yield the returned Effect inside `Effect.scoped`
// to drive the instance's lifecycle.
function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    writeSessionBoundary: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    ...input.backendOutputLog,
  };
  const servicesLayer = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? healthyHttpClientLayer,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.advertiseDesktopBackend !== undefined
      ? { advertiseDesktopBackend: input.advertiseDesktopBackend }
      : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
  });

  return instance.pipe(Effect.provide(servicesLayer));
}

describe("DesktopBackendManager", () => {
  it("preserves desktop backend advertisement failure context without deriving the message from the cause", () => {
    const cause = new Error("private advertisement failure detail");
    const error = new DesktopBackendManager.DesktopBackendAdvertisementError({
      operation: "write",
      t3Home: "/tmp/t3-home",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.operation, "write");
    assert.equal(error.t3Home, "/tmp/t3-home");
    assert.equal(
      error.message,
      "Failed to write the desktop backend advertisement in /tmp/t3-home.",
    );
    assert.notInclude(error.message, cause.message);
    assert.notInclude(JSON.stringify(error), cause.message);
  });

  it("describes advertisement causes without throwing", () => {
    const plain = new Error("plain failure");
    assert.include(
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(plain),
      "plain failure",
    );

    const nested = new Error("nested https://user:secret@example.com/path?token=hidden#fragment");
    const withCause = new Error("outer failure");
    Object.defineProperty(withCause, "cause", { value: nested });
    const withCauseDescription =
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(withCause);
    assert.include(withCauseDescription, "outer failure");
    assert.include(withCauseDescription, "nested");
    assert.include(withCauseDescription, "https://example.com/path");
    assert.notInclude(withCauseDescription, "secret");
    assert.notInclude(withCauseDescription, "token=hidden");

    const malformedUrl = new Error(
      "bad https://user:secret@example.com:bad/path?token=hidden#fragment",
    );
    const malformedUrlDescription =
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(malformedUrl);
    assert.include(malformedUrlDescription, "https://example.com:bad/path");
    assert.notInclude(malformedUrlDescription, "secret");
    assert.notInclude(malformedUrlDescription, "token=hidden");
    assert.notInclude(malformedUrlDescription, "#fragment");

    const pojo = { code: "EWRITE", path: "/tmp/t3/backend.json" };
    assert.equal(
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(pojo),
      '{"code":"EWRITE","path":"/tmp/t3/backend.json"}',
    );

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.code = "ENOENT";
    assert.equal(
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(nullPrototype),
      '{"code":"ENOENT"}',
    );

    const advertisementError = new DesktopBackendManager.DesktopBackendAdvertisementError({
      operation: "write",
      t3Home: "/tmp/t3-home",
      cause: pojo,
    });
    assert.strictEqual(advertisementError.cause, pojo);
    assert.include(
      DesktopBackendManager.describeDesktopBackendAdvertisementCause(advertisementError),
      '"code":"EWRITE"',
    );
  });

  it.effect("spawns the backend with fd3 bootstrap JSON and reports HTTP readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer,
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            writeSessionBoundary: ({ phase }) =>
              phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
      }),
    ),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestUrls: Array<string> = [];
        const statuses = [503, 200];
        let readyCount = 0;
        const firstRequest = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer((request) =>
            Effect.gen(function* () {
              const status = statuses.shift();
              assert.isDefined(status);
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstRequest, void 0);
              return responseForRequest(request, status);
            }),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            writeSessionBoundary: ({ phase }) =>
              phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
          },
        });

        yield* instance.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/t3/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/t3/environment",
          "http://127.0.0.1:3773/.well-known/t3/environment",
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        let closedCount = 0;
        const closed = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const backendReadyFlag = yield* Ref.make(false);

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              startCount += 1;
              yield* Queue.offer(startedPids, 123);
              const close = Effect.sync(() => {
                closedCount += 1;
              }).pipe(Effect.andThen(Deferred.succeed(closed, void 0)), Effect.asVoid);

              yield* Scope.addFinalizer(scope, close);

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          onReady: Ref.set(backendReadyFlag, true).pipe(
            Effect.andThen(Deferred.succeed(ready, void 0)),
            Effect.asVoid,
          ),
          onShutdown: Ref.set(backendReadyFlag, false),
        });
        assert.isTrue(Option.isNone(yield* instance.currentConfig));

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReadyFlag));
        assert.deepEqual(yield* instance.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* instance.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        yield* instance.stop();
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);

        const stoppedSnapshot = yield* instance.snapshot;
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }),
    ),
  );

  it.effect("does not notify shutdown before the first start has prior state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;
        const closed = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        assert.equal(shutdownCount, 0);
      }),
    ),
  );

  it.effect("removes the backend advertisement after closing the run scope", () =>
    Effect.gen(function* () {
      const t3Home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-stop-order-"));
      const closeObservedAdvertisement = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const close = Effect.sync(() => {
              const readResult = readDesktopBackendAdvertisements({ t3Home });
              assert.lengthOf(readResult.advertisements, 1);
            }).pipe(
              Effect.andThen(Deferred.succeed(closeObservedAdvertisement, void 0)),
              Effect.andThen(Deferred.succeed(closed, void 0)),
              Effect.asVoid,
            );
            yield* Scope.addFinalizer(scope, close);
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          bootstrap: {
            ...baseConfig.bootstrap,
            t3Home,
          },
        },
        spawnerLayer,
        desktopWindow: {
          handleBackendReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
        },
      });

      try {
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          yield* Deferred.await(ready);

          yield* manager.stop();
          yield* Deferred.await(closeObservedAdvertisement);

          assert.lengthOf(readDesktopBackendAdvertisements({ t3Home }).advertisements, 0);
        }).pipe(Effect.provide(managerLayer));
      } finally {
        NodeFS.rmSync(t3Home, { force: true, recursive: true });
      }
    }),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown when a scheduled restart starts from non-ready state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "preflight failed", fatal: false }),
          },
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(shutdownCount, 0);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(shutdownCount, 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a fatal preflight failure once and stops looping after the cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "Node.js not found", fatal: true }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        assert.deepEqual(failures, []);

        // Five fatal attempts with exponential backoff (500ms, 1s, 2s, 4s) reach
        // the cap, at which point the failure is surfaced exactly once.
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        assert.deepEqual(failures, ["Node.js not found"]);

        // Past the cap the loop stops and nothing else is surfaced.
        yield* TestClock.adjust(Duration.seconds(8));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.deepEqual(failures, ["Node.js not found"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("can be started again after a fatal preflight cap once config recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = yield* Ref.make(true);
        const starts = yield* Queue.unbounded<number>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Queue.offer(starts, 123).pipe(
              Effect.as(
                makeProcess({
                  exitCode: Effect.never,
                }),
              ),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          configResolve: Ref.get(failing).pipe(
            Effect.map((isFailing) =>
              isFailing
                ? {
                    ...baseConfig,
                    preflightFailure: Option.some({
                      reason: "Node.js not found",
                      fatal: true,
                    }),
                  }
                : baseConfig,
            ),
          ),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        yield* TestClock.adjust(Duration.seconds(8));

        const parked = yield* instance.snapshot;
        assert.equal(parked.desiredRunning, false);
        assert.equal(parked.ready, false);
        assert.isTrue(Option.isNone(parked.activePid));
        assert.equal(parked.restartScheduled, false);
        assert.equal(yield* Queue.size(starts), 0);

        yield* Ref.set(failing, false);
        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 123);
        const running = yield* instance.snapshot;
        assert.equal(running.desiredRunning, true);
        assert.deepEqual(running.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps retrying a transient (non-fatal) preflight failure without surfacing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "wslpath conversion failed", fatal: false }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        // Well beyond the fatal cap's worth of time: a transient failure must
        // keep retrying (self-heal) and never surface.
        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepEqual(failures, []);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a bounded transient preflight failure after its retry limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({
              reason: "WSL toolchain probe timed out",
              fatal: false,
              retryLimit: 3,
            }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        assert.deepEqual(failures, []);

        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepEqual(failures, ["WSL toolchain probe timed out"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const secondClosed = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              if (startCount === 1) {
                return makeProcess({
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                });
              }

              const scope = yield* Scope.Scope;
              const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
              yield* Scope.addFinalizer(scope, close);
              return makeProcess({
                exitCode: Deferred.await(secondClosed).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* instance.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});

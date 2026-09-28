import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const makeNativeProcess = () => {
  const events = new NodeEvents.EventEmitter();
  return {
    pid: 42,
    events,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    removeListener: vi.fn((event: string, listener: () => void) =>
      events.removeListener(event, listener),
    ),
    onData: vi.fn((listener: (data: string) => void) => {
      events.on("data", listener);
      return { dispose: vi.fn(() => events.removeListener("data", listener)) };
    }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      events.on("exit", listener);
      return { dispose: vi.fn(() => events.removeListener("exit", listener)) };
    }),
  };
};

const spawn = vi.fn(makeNativeProcess);

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const makeTestLayer = (platform: NodeJS.Platform = "win32") =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessArchitecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
      ),
    ),
  );

const testLayer = makeTestLayer();

const startPendingSpawn = Effect.gen(function* () {
  const listening = yield* Deferred.make<void>();
  const nativeProcess = makeNativeProcess();
  nativeProcess.pid = 0;
  nativeProcess.on.mockImplementation((event, listener) => {
    nativeProcess.events.on(event, listener);
    Deferred.doneUnsafe(listening, Effect.void);
    return nativeProcess.events;
  });
  spawn.mockReturnValueOnce(nativeProcess);
  const adapter = yield* PtyAdapter.PtyAdapter;
  const fiber = yield* adapter
    .spawn({ shell: "powershell.exe", cwd: ".", cols: 80, rows: 24, env: {} })
    .pipe(Effect.forkChild);
  yield* Deferred.await(listening);
  return { nativeProcess, fiber };
});

it.effect("waits for the Windows PID without requiring shell output", () =>
  Effect.gen(function* () {
    const { nativeProcess, fiber } = yield* startPendingSpawn;
    assert.isUndefined(fiber.pollUnsafe());

    nativeProcess.pid = 123;
    nativeProcess.events.emit("ready_datapipe");
    const process = yield* Fiber.join(fiber);
    assert.equal(process.pid, 123);
    assert.equal(nativeProcess.events.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);

    const output: string[] = [];
    const exits: PtyAdapter.PtyExitEvent[] = [];
    const stopData = process.onData((data) => output.push(data));
    const stopExit = process.onExit((event) => exits.push(event));
    nativeProcess.events.emit("data", "first prompt");
    nativeProcess.events.emit("exit", { exitCode: 0 });
    assert.deepEqual(output, ["first prompt"]);
    assert.deepEqual(exits, [{ exitCode: 0, signal: null }]);
    stopData();
    stopExit();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports Windows exit before readiness as a spawn failure", () =>
  Effect.gen(function* () {
    const { nativeProcess, fiber } = yield* startPendingSpawn;
    nativeProcess.events.emit("exit", { exitCode: 2 });
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, PtyAdapter.PtySpawnError);
      assert.match(String(error.cause), /exit code 2/);
    }
    assert.equal(nativeProcess.events.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("cleans up a Windows spawn interrupted before readiness", () =>
  Effect.gen(function* () {
    const { nativeProcess, fiber } = yield* startPendingSpawn;
    yield* Fiber.interrupt(fiber);
    assert.equal(nativeProcess.kill.mock.calls.length, 1);
    assert.equal(nativeProcess.events.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(testLayer)),
);

for (const platform of ["win32", "linux", "darwin"] as const) {
  it.effect(`terminates through node-pty using ${platform} semantics`, () =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      nativeProcess.kill.mockImplementation((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();

      assert.deepEqual(
        nativeProcess.kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    }).pipe(Effect.provide(makeTestLayer(platform))),
  );
}

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.reject(cause)),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

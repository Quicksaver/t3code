import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type {
  BackgroundPolicySnapshot,
  BackgroundScope,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitManagerError } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { canonicalizeExistingPath } from "../utils/CanonicalPath.ts";

// Windows and macOS default to case-insensitive filesystems.
const caseInsensitiveHost = ["win32", "darwin"].includes(HostProcess.Platform.defaultValue());
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/pingdotgg/t3code/pull/2978",
    baseRef: "main",
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  backgroundWorkEnabled?: boolean;
  /** Runs before each remote status read, e.g. to hold a fetch open. */
  beforeRemoteStatus?: Effect.Effect<void>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => state.beforeRemoteStatus ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                state.remoteStatusCalls += 1;
                state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                return state.currentRemoteStatus;
              }),
            ),
          ),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
      }),
    ),
  );
}

const testPolicySnapshot: BackgroundPolicySnapshot = {
  hostPower: {
    source: "unknown",
    idle: "unknown",
    idleSeconds: null,
    locked: "unknown",
    suspended: false,
    onBattery: "unknown",
    lowPowerMode: "unknown",
    thermalState: "unknown",
    stale: true,
    updatedAt: TEST_EPOCH,
  },
  leases: [],
  activeForegroundLeaseCount: 0,
  activeScopeKeys: [],
  shouldRunOpportunisticWork: false,
  updatedAt: TEST_EPOCH,
};

function layerBackgroundPolicy(
  shouldRunScopeWork: (scope: BackgroundScope) => boolean,
  demand: {
    readonly hasDemand?: (scope: BackgroundScope) => boolean;
    readonly changes?: Stream.Stream<BackgroundPolicySnapshot>;
  } = {},
) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed(testPolicySnapshot),
    streamChanges: Stream.empty,
    subscribe: Effect.succeed({
      latest: testPolicySnapshot,
      changes: demand.changes ?? Stream.empty,
    }),
    hasDemand: (scope) => Effect.sync(() => demand.hasDemand?.(scope) ?? true),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it("ignores Git internal watcher paths", () => {
    assert.isTrue(VcsStatusBroadcaster.shouldIgnoreWatchEventPath(".git/FETCH_HEAD"));
    assert.isTrue(VcsStatusBroadcaster.shouldIgnoreWatchEventPath(".git/logs/HEAD"));
    assert.isFalse(VcsStatusBroadcaster.shouldIgnoreWatchEventPath("src/.gitkeep"));
    assert.isFalse(VcsStatusBroadcaster.shouldIgnoreWatchEventPath("src/app.ts"));
  });

  it.effect("batches watcher refresh decisions after ignored roots are filtered", () =>
    Effect.gen(function* () {
      const checkedBatches: string[][] = [];
      const refreshes = Array.from(
        yield* Stream.runCollect(
          VcsStatusBroadcaster.localWatchRefreshSignals(
            Stream.make("src/app.ts", "dist/app.js"),
            (relativePaths) =>
              Effect.sync(() => {
                checkedBatches.push([...relativePaths]);
                return relativePaths.some((relativePath) => relativePath !== "dist/app.js");
              }),
            Duration.millis(1),
          ),
        ),
      );

      assert.deepStrictEqual(checkedBatches, [["src/app.ts", "dist/app.js"]]);
      assert.equal(refreshes.length, 1);
    }),
  );

  it.effect("does not refresh when every debounced watcher path is ignored", () =>
    Effect.gen(function* () {
      const checkedBatches: string[][] = [];
      const refreshes = Array.from(
        yield* Stream.runCollect(
          VcsStatusBroadcaster.localWatchRefreshSignals(
            Stream.make(".git/FETCH_HEAD", "dist/app.js", "dist/app.css"),
            (relativePaths) =>
              Effect.sync(() => {
                checkedBatches.push([...relativePaths]);
                return false;
              }),
            Duration.millis(1),
          ),
        ),
      );

      assert.deepStrictEqual(checkedBatches, [["dist/app.js", "dist/app.css"]]);
      assert.deepStrictEqual(refreshes, []);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("shares sibling watchers and releases each refresh destination independently", () =>
    Effect.gen(function* () {
      const root = "/repo";
      const sibling = "/repo.worktrees/feature";
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const refreshed = yield* Queue.unbounded<string>();
      const watches: string[] = [];
      const closed: string[] = [];
      let ignoreChecks = 0;
      const fs = yield* FileSystem.FileSystem;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(
          Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            realPath: (cwd) => Effect.succeed(cwd),
            watch: (cwd) =>
              Stream.unwrap(
                Effect.sync(() => {
                  watches.push(cwd);
                  return (cwd === sibling ? Stream.fromQueue(events) : Stream.never).pipe(
                    Stream.ensuring(
                      Effect.sync(() => {
                        closed.push(cwd);
                      }),
                    ),
                  );
                }),
              ),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => false)),
        Layer.provide(
          Layer.succeed(VcsProcess.VcsProcess, {
            run: (input) =>
              Effect.sync(() => {
                if (input.operation !== "VcsStatusBroadcaster.worktrees") ignoreChecks++;
                return {
                  exitCode: ChildProcessSpawner.ExitCode(
                    input.operation === "VcsStatusBroadcaster.worktrees" ? 0 : 1,
                  ),
                  stdout:
                    input.operation === "VcsStatusBroadcaster.worktrees"
                      ? `worktree ${root}\n\nworktree ${sibling}\n`
                      : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(baseLocalStatus),
            remoteStatus: () => Effect.succeed(baseRemoteStatus),
            invalidateLocalStatus: (cwd) => Queue.offer(refreshed, cwd).pipe(Effect.asVoid),
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const start = Effect.fnUntraced(function* (cwd: string) {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* broadcaster.streamStatus({ cwd }).pipe(
            Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          return fiber;
        });
        const rootStream = yield* start(root);
        const siblingStream = yield* start(sibling);
        assert.deepStrictEqual(watches.sort(), [root, sibling].sort());
        // Each stream's first remote fetch re-reads its local status once; drain those first.
        assert.deepStrictEqual(
          [yield* Queue.take(refreshed), yield* Queue.take(refreshed)].sort(),
          [root, sibling].sort(),
        );
        yield* Queue.offer(events, { _tag: "Update", path: "file.ts" });
        yield* TestClock.adjust("150 millis");
        assert.deepStrictEqual(
          [yield* Queue.take(refreshed), yield* Queue.take(refreshed)].sort(),
          [root, sibling].sort(),
        );
        assert.equal(ignoreChecks, 1);
        yield* Fiber.interrupt(rootStream);
        assert.deepStrictEqual(closed, []);
        yield* Queue.offer(events, { _tag: "Update", path: "file.ts" });
        yield* TestClock.adjust("150 millis");
        assert.equal(yield* Queue.take(refreshed), sibling);
        assert.equal(yield* Queue.size(refreshed), 0);
        assert.equal(ignoreChecks, 2);
        yield* Fiber.interrupt(siblingStream);
        assert.deepStrictEqual(closed.sort(), [root, sibling].sort());
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes for nested edits in the checkout and its sibling worktrees", () =>
    Effect.gen(function* () {
      const root = "/repo";
      const sibling = "/repo.worktrees/feature";
      const rootEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const siblingEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const refreshed = yield* Queue.unbounded<string>();
      const watchOptions = new Map<string, FileSystem.WatchOptions | undefined>();
      const ignoreCheckInputs: Array<string | undefined> = [];
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(
          Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            realPath: (cwd) => Effect.succeed(cwd),
            watch: (cwd, options) => {
              watchOptions.set(cwd, options);
              return Stream.fromQueue(cwd === sibling ? siblingEvents : rootEvents);
            },
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => false)),
        Layer.provide(
          Layer.succeed(VcsProcess.VcsProcess, {
            run: (input) =>
              Effect.sync(() => {
                const listsWorktrees = input.operation === "VcsStatusBroadcaster.worktrees";
                if (!listsWorktrees) ignoreCheckInputs.push(input.stdin);
                return {
                  exitCode: ChildProcessSpawner.ExitCode(listsWorktrees ? 0 : 1),
                  stdout: listsWorktrees ? `worktree ${root}\n\nworktree ${sibling}\n` : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(baseLocalStatus),
            remoteStatus: () => Effect.succeed(baseRemoteStatus),
            invalidateLocalStatus: (cwd) => Queue.offer(refreshed, cwd).pipe(Effect.asVoid),
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const ready = yield* Deferred.make<void>();
        yield* broadcaster.streamStatus({ cwd: root }).pipe(
          Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        // The stream's first remote fetch re-reads its local status once; drain it first.
        assert.equal(yield* Queue.take(refreshed), root);
        assert.deepStrictEqual(
          [watchOptions.get(root), watchOptions.get(sibling)],
          [{ recursive: true }, { recursive: true }],
        );

        for (const [events, nestedPath] of [
          [rootEvents, ["src", "components", "App.tsx"]],
          [siblingEvents, ["packages", "ui", "Button.tsx"]],
        ] as const) {
          yield* Queue.offer(events, { _tag: "Update", path: nestedPath.join(path.sep) });
          yield* TestClock.adjust("150 millis");
          assert.equal(yield* Queue.take(refreshed), root);
          assert.equal(ignoreCheckInputs.at(-1), `${nestedPath.join("/")}\0`);
        }
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("watches sibling worktrees only while a panel retains the cwd's git-refs demand", () =>
    Effect.gen(function* () {
      const root = "/repo";
      const sibling = "/repo.worktrees/feature";
      const watched = yield* Queue.unbounded<string>();
      const closed = yield* Queue.unbounded<string>();
      const policyChanges = yield* Queue.unbounded<BackgroundPolicySnapshot>();
      const demandScopes: BackgroundScope[] = [];
      let panelDemand = false;
      let worktreeListings = 0;
      const fs = yield* FileSystem.FileSystem;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(
          Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(true),
            realPath: (cwd) => Effect.succeed(cwd),
            watch: (cwd) =>
              Stream.fromEffectDrain(Queue.offer(watched, cwd)).pipe(
                Stream.concat(Stream.never),
                Stream.ensuring(Queue.offer(closed, cwd)),
              ),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          layerBackgroundPolicy(() => false, {
            hasDemand: (scope) => {
              demandScopes.push(scope);
              return panelDemand;
            },
            changes: Stream.fromQueue(policyChanges),
          }),
        ),
        Layer.provide(
          Layer.succeed(VcsProcess.VcsProcess, {
            run: (input) =>
              Effect.sync(() => {
                const listsWorktrees = input.operation === "VcsStatusBroadcaster.worktrees";
                if (listsWorktrees) worktreeListings++;
                return {
                  exitCode: ChildProcessSpawner.ExitCode(listsWorktrees ? 0 : 1),
                  stdout: listsWorktrees ? `worktree ${root}\n\nworktree ${sibling}\n` : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(baseLocalStatus),
            remoteStatus: () => Effect.succeed(baseRemoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const ready = yield* Deferred.make<void>();
        const stream = yield* broadcaster.streamStatus({ cwd: root }).pipe(
          Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        assert.equal(yield* Queue.take(watched), root);
        assert.equal(worktreeListings, 0);
        assert.deepStrictEqual(demandScopes, [{ type: "git-refs", cwd: root }]);

        panelDemand = true;
        yield* Queue.offer(policyChanges, testPolicySnapshot);
        assert.equal(yield* Queue.take(watched), sibling);
        assert.equal(worktreeListings, 1);

        panelDemand = false;
        yield* Queue.offer(policyChanges, testPolicySnapshot);
        assert.equal(yield* Queue.take(closed), sibling);

        yield* Fiber.interrupt(stream);
        assert.equal(yield* Queue.take(closed), root);
        assert.equal(yield* Queue.size(watched), 0);
        assert.equal(worktreeListings, 1);
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!caseInsensitiveHost)(
    "shares one canonical watcher per checkout across casings and sibling registrations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-casing-" });
        const siblingTempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-casing-" });
        const canonicalRoot = yield* canonicalizeExistingPath(fs, tempDir);
        const canonicalSibling = yield* canonicalizeExistingPath(fs, siblingTempDir);
        const differentlyCasedRoot = canonicalRoot.toUpperCase();
        const differentlyCasedSibling = canonicalSibling.toUpperCase();
        const watched: string[] = [];
        const testLayer = VcsStatusBroadcaster.layer.pipe(
          Layer.provide(
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              // A JS realpath keeps the caller's casing on case-insensitive filesystems.
              realPath: (cwd) => Effect.succeed(cwd),
              watch: (cwd) => {
                watched.push(cwd);
                return Stream.never;
              },
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(layerBackgroundPolicy(() => false)),
          Layer.provide(
            Layer.succeed(VcsProcess.VcsProcess, {
              run: (input) =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(
                    input.operation === "VcsStatusBroadcaster.worktrees" ? 0 : 1,
                  ),
                  stdout: [
                    `worktree ${canonicalRoot}`,
                    `worktree ${canonicalSibling}`,
                    `worktree ${differentlyCasedSibling}`,
                  ].join("\n\n"),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GitWorkflowService.GitWorkflowService)({
              localStatus: () => Effect.succeed(baseLocalStatus),
              remoteStatus: () => Effect.succeed(baseRemoteStatus),
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          const start = Effect.fnUntraced(function* (cwd: string) {
            const ready = yield* Deferred.make<void>();
            yield* broadcaster.streamStatus({ cwd }).pipe(
              Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
          });
          yield* start(differentlyCasedRoot);
          yield* start(differentlyCasedSibling);
          assert.deepStrictEqual(watched, [canonicalRoot, canonicalSibling]);
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps panel-demand polling, automatic pull, and sibling-worktree refreshes active together",
    () => {
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const policyScopes: BackgroundScope[] = [];
      const autoPullCwds: string[] = [];
      const watcherCwds: string[] = [];
      let rootDir = "";
      let siblingDir = "";
      let remoteStatusCalls = 0;
      let localInvalidationCalls = 0;
      let pullCalls = 0;
      let periodicRemoteDeferred: Deferred.Deferred<void> | null = null;
      const fakeFileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return {
            ...fs,
            exists: () => Effect.succeed(true),
            realPath: (cwd: string) => Effect.succeed(cwd),
            watch: (cwd: string) =>
              cwd === siblingDir
                ? Stream.make({ _tag: "Update" as const, path: "sibling-change.txt" })
                : Stream.never,
          };
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const vcsProcessLayer = Layer.succeed(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.operation === "VcsStatusBroadcaster.worktrees") {
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: `worktree ${rootDir}\n\nworktree ${siblingDir}\n`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          watcherCwds.push(input.cwd);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      });

      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(fakeFileSystemLayer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(vcsProcessLayer),
        Layer.provide(
          layerBackgroundPolicy((scope) => {
            policyScopes.push(scope);
            return true;
          }),
        ),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) =>
              Effect.sync(() => {
                autoPullCwds.push(cwd);
                return cwd === rootDir;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            remoteStatus: () =>
              Effect.gen(function* () {
                remoteStatusCalls += 1;
                if (remoteStatusCalls >= 3 && periodicRemoteDeferred) {
                  yield* Deferred.succeed(periodicRemoteDeferred, undefined).pipe(Effect.ignore);
                }
                return {
                  ...baseRemoteStatus,
                  behindCount: pullCalls === 0 ? 1 : 0,
                };
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        rootDir = "/repo";
        siblingDir = "/repo.worktrees/feature";
        periodicRemoteDeferred = yield* Deferred.make<void>();
        const pulledSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        const siblingRefreshDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        const streamScope = yield* Scope.make();
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

        yield* Stream.runForEach(
          broadcaster.streamStatus(
            { cwd: rootDir },
            { automaticRemoteRefreshInterval: Effect.succeed(Duration.millis(25)) },
          ),
          (event) => {
            if (event._tag === "snapshot" && event.remote?.behindCount === 0) {
              return Deferred.succeed(pulledSnapshotDeferred, event).pipe(Effect.ignore);
            }
            if (event._tag === "localUpdated") {
              return Deferred.succeed(siblingRefreshDeferred, event).pipe(Effect.ignore);
            }
            return Effect.void;
          },
        ).pipe(Effect.forkIn(streamScope));

        yield* Deferred.await(pulledSnapshotDeferred);
        // The sibling watcher debounces for 150ms; panel demand polls the remote every 25ms.
        yield* TestClock.adjust("150 millis");
        yield* Deferred.await(siblingRefreshDeferred);
        yield* Deferred.await(periodicRemoteDeferred);

        assert.equal(pullCalls, 1);
        assert.isAtLeast(localInvalidationCalls, 2);
        assert.isAtLeast(autoPullCwds.length, 1);
        assert.isTrue(autoPullCwds.every((cwd) => cwd === rootDir));
        assert.includeDeepMembers(policyScopes, [{ type: "vcs-status", cwd: rootDir }]);
        assert.include(watcherCwds, siblingDir);

        yield* Scope.close(streamScope, Exit.void);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      // Nobody loaded this cwd yet: no host request is spent.
      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      // Loaded and no PR known: ask GitManager to retry the missing PR.
      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);

      // The agent switches branches. The previous branch's PR must not block a read.
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                // Hold an older empty response while the turn-end refresh queues.
                yield* Deferred.succeed(firstPollStarted, undefined);
                yield* Deferred.await(releaseFirstPoll);
                return baseRemoteStatus;
              }
              return remoteReads === 1 ? baseRemoteStatus : remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const poll = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(firstPollStarted);
      const refresh = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirstPoll, undefined);
      yield* Fiber.join(poll);
      const refreshed = yield* Fiber.join(refresh);

      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      const final = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(final.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      // Run ready fibers before releasing the delayed first read.
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("turn-end refresh skips a loaded cwd when background policy pauses it", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo", { refreshUpstream: false });
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [undefined, false]);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("keeps the cached snapshot unchanged when a refresh branch fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.deepStrictEqual(cached, baseStatus);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("refreshes only the cached local snapshot when requested", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("passive streams retain cached remote status", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* TestClock.adjust("1 minute");
      assert.equal(state.remoteStatusCalls, 0);
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* broadcaster.refreshPullRequestStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      const cachedSnapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );
      assert.deepStrictEqual(Option.getOrThrow(cachedSnapshot), {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: remoteStatusWithPr,
      });
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("publishes an unchanged local status only when the refresh forces it", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const changedLocalStatus: VcsStatusLocalResult = {
      ...baseLocalStatus,
      hasWorkingTreeChanges: true,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const localUpdates = yield* Queue.unbounded<VcsStatusStreamEvent>();

      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "localUpdated") {
          return Queue.offer(localUpdates, event).pipe(Effect.asVoid);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(snapshotDeferred);
      // Updates arrive in publish order, so the unchanged unforced refresh must not appear.
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* broadcaster.refreshLocalStatus("/repo", { forcePublish: true });
      state.currentLocalStatus = changedLocalStatus;
      yield* broadcaster.refreshLocalStatus("/repo");

      assert.deepStrictEqual([yield* Queue.take(localUpdates), yield* Queue.take(localUpdates)], [
        { _tag: "localUpdated", local: baseLocalStatus },
        { _tag: "localUpdated", local: changedLocalStatus },
      ] satisfies VcsStatusStreamEvent[]);
      assert.isAtLeast(state.localInvalidationCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it("parses worktree paths from porcelain output", () => {
    assert.deepStrictEqual(
      VcsStatusBroadcaster.parseWorktreePaths(
        [
          "worktree /repo",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /repo.worktrees/feature",
          "HEAD def",
          "branch refs/heads/feature/source-control",
          "",
        ].join("\n"),
      ),
      ["/repo", "/repo.worktrees/feature"],
    );
  });

  it.effect("skips missing sibling worktree paths before retaining watchers", () => {
    const rootDir = process.cwd();
    const siblingDir = `${rootDir}/..`;
    const missingDir = `${rootDir}/.missing-worktree-for-vcs-status-test`;
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: rootDir }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 0);
      assert.isFalse(yield* fileSystem.exists(missingDir));
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerTestFor(state),
          Layer.succeed(VcsProcess.VcsProcess, {
            run: () =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: [
                  `worktree ${rootDir}`,
                  "HEAD abc",
                  "branch refs/heads/main",
                  "",
                  `worktree ${siblingDir}`,
                  "HEAD def",
                  "branch refs/heads/feature/live",
                  "",
                  `worktree ${missingDir}`,
                  "HEAD ghi",
                  "branch refs/heads/feature/missing",
                  "",
                ].join("\n"),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          }),
        ),
      ),
    );
  });

  it.effect("loads remote status once when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false]);

      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(layerTestFor(state), TestClock.layer())));
  });

  it.effect("retries the initial remote load when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };
    const privateCwd = "/private/user/workspace/repo";
    const nestedCause = new Error("private nested VCS failure");
    const messages: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message as ReadonlyArray<unknown>);
    });
    let firstRemoteAttemptDeferred: Deferred.Deferred<void> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (_input, options) =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              state.remoteStatusRefreshUpstreamValues.push(options?.refreshUpstream);
              if (state.remoteStatusCalls === 1) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "VcsStatusBroadcaster.test",
                    cwd: privateCwd,
                    detail: "private initial remote status failure",
                    cause: nestedCause,
                  }),
                ).pipe(
                  Effect.ensuring(
                    firstRemoteAttemptDeferred
                      ? Deferred.succeed(firstRemoteAttemptDeferred, undefined).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                );
              }
              return Effect.succeed(remoteStatusWithPr);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      firstRemoteAttemptDeferred = yield* Deferred.make<void>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: privateCwd },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) =>
          event._tag === "remoteUpdated"
            ? Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(firstRemoteAttemptDeferred);
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 1);
      assert.deepStrictEqual(
        messages.find((message) => message[0] === "VCS remote status refresh failed"),
        [
          "VCS remote status refresh failed",
          {
            cwdLength: privateCwd.length,
            reasonCount: 1,
            failureCount: 1,
            failureTags: ["GitManagerError"],
            failureOperations: ["VcsStatusBroadcaster.test"],
            defectCount: 0,
            defectTags: [],
            interruptionCount: 0,
            consecutiveFailures: 1,
            nextDelayMs: 30_000,
          },
        ],
      );

      yield* TestClock.adjust(Duration.seconds(30));
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false, false]);

      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerTest,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("delays automatic refresh when a cached remote snapshot is available", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 1);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(layerTestFor(state), TestClock.layer())));
  });

  // A push from a terminal moves ahead; a PR merged on the host moves ahead-of-default.
  it.effect.each([
    ["a push", { ...baseRemoteStatus, aheadCount: 1, aheadOfDefaultCount: 0 }],
    ["a merged pull request", { ...baseRemoteStatus, aheadOfDefaultCount: 2 }],
  ] as const)("re-reads local status when a fetch reflects %s", ([, initialRemote]) => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: initialRemote as VcsStatusRemoteResult | null,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : event._tag === "localUpdated"
              ? Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore)
              : Effect.void,
      ).pipe(Effect.forkIn(scope));
      yield* Deferred.await(snapshotDeferred);

      // The next fetch moves the base, so the Changes totals shrink.
      const pushedLocal: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
      };
      state.currentLocalStatus = pushedLocal;
      state.currentRemoteStatus = { ...baseRemoteStatus, aheadOfDefaultCount: 0 };
      yield* TestClock.adjust(Duration.minutes(1));

      assert.deepStrictEqual(yield* Deferred.await(localUpdatedDeferred), {
        _tag: "localUpdated",
        local: pushedLocal,
      } satisfies VcsStatusStreamEvent);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(layerTestFor(state), TestClock.layer())));
  });

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);

      // The fetch moves the base while it runs, so totals read before it ends would be stale.
      const fetchedLocal: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
      };
      state.currentLocalStatus = fetchedLocal;
      yield* Deferred.succeed(finishFetch, undefined);

      const status = yield* Fiber.join(refresh);
      assert.deepStrictEqual(status.branchChanges, fetchedLocal.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      30_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      60_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it("summarizes refresh causes without exposing nested failure details", () => {
    const nestedCause = new Error("private nested failure detail");
    const failure = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/private/user/workspace/repo",
      detail: "private Git failure detail",
      cause: nestedCause,
    });
    const cause = Cause.combine(Cause.fail(failure), Cause.die(new TypeError("private defect")));

    assert.deepStrictEqual(VcsStatusBroadcaster.remoteRefreshFailureDiagnostics(cause), {
      reasonCount: 2,
      failureCount: 1,
      failureTags: ["GitManagerError"],
      failureOperations: ["VcsStatusBroadcaster.remoteStatus"],
      defectCount: 1,
      defectTags: ["TypeError"],
      interruptionCount: 0,
    });
  });

  it.effect("does not start automatic remote refreshes without foreground client demand", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => false)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("releases remote demand while passive observers remain", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const passiveSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(passiveSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(passiveSnapshot);
      assert.equal(state.remoteStatusCalls, 0);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(layerTest));
  });
});

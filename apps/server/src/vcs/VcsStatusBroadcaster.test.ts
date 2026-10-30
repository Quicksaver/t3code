import { BackgroundPolicySnapshot } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import type {
  BackgroundScope,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitCommandError, GitManagerError } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
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
    headRef: "upstream-topic",
    state: "open",
  },
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  remoteStatusError?: GitManagerError;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void>;
  beforeLocalStatus?: Effect.Effect<void>;
  fileSystem?: FileSystem.FileSystem;
  pullCurrentBranch?: GitWorkflowService.GitWorkflowService["Service"]["pullCurrentBranch"];
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(
      state.fileSystem
        ? Layer.succeed(FileSystem.FileSystem, state.fileSystem)
        : NodeServices.layer,
    ),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsStatusBroadcaster.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.suspend(() => {
            state.localStatusCalls += 1;
            return (state.beforeLocalStatus ?? Effect.void).pipe(
              Effect.as(state.currentLocalStatus),
            );
          }),
        currentBranch: () => Effect.sync(() => state.currentLocalStatus.refName),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => {
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  return state.currentRemoteStatus;
                }),
              ),
              Effect.tap(() =>
                state.remoteStatusError ? Effect.fail(state.remoteStatusError) : Effect.void,
              ),
            );
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
        ...(state.pullCurrentBranch ? { pullCurrentBranch: state.pullCurrentBranch } : {}),
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
    snapshot: Effect.succeed(testPolicySnapshot),
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
  it.effect("refreshes queued behind a running one share the next git status read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeLocalStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const running = yield* broadcaster
        .refreshLocalStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      // Requested while the first read runs, so that read may predate their change.
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const queued = yield* Effect.all(
        [broadcaster.refreshLocalStatus("/repo"), broadcaster.refreshLocalStatus("/repo")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);

      assert.isFalse((yield* Fiber.join(running)).hasWorkingTreeChanges);
      const [second, third] = yield* Fiber.join(queued);
      assert.isTrue(second.hasWorkingTreeChanges);
      assert.isTrue(third.hasWorkingTreeChanges);
      assert.strictEqual(state.localStatusCalls, 2);

      yield* broadcaster.refreshLocalStatus("/repo");
      assert.strictEqual(state.localStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("publishes a terminal branch switch without reading remote status", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const events = yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
      assert.equal(refreshed.refName, "main");
      assert.isNull(refreshed.pr);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 2);
      assert.deepStrictEqual((yield* Fiber.join(events)).slice(1), [
        { _tag: "remoteUpdated", remote: null },
        { _tag: "localUpdated", local: state.currentLocalStatus },
      ]);
      assert.isNull((yield* broadcaster.getStatus({ cwd: "/repo" })).pr);
      const snapshot = yield* broadcaster
        .streamStatus({ cwd: "/repo", includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(snapshot[0], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "preserves cached remote status when a local-only refresh stays on the same branch",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });
        const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        assert.deepStrictEqual(refreshed, initial);
        assert.deepStrictEqual(yield* broadcaster.getStatus({ cwd: "/repo" }), refreshed);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("clears the previous branch's remote status after an in-flight PR refresh", () => {
    const remoteReadStarted = Deferred.makeUnsafe<void>();
    const releaseRemoteRead = Deferred.makeUnsafe<void>();
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      beforeRemoteStatus: Effect.void,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.beforeRemoteStatus = Deferred.succeed(remoteReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRemoteRead)),
      );
      const remoteRefresh = yield* broadcaster
        .refreshPullRequestStatus("/repo")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(remoteReadStarted);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const localRefresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseRemoteRead, undefined);
      yield* Fiber.join(remoteRefresh);
      yield* Fiber.join(localRefresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(status.refName, "main");
      assert.isNull(status.pr);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

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
            currentBranch: () => Effect.succeed(localStatus.refName),
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

      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 2);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
      const refreshedStatus = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(refreshedStatus.refName, "feature/next");
      assert.isNull(refreshedStatus.pr);
      assert.equal(state.remoteStatusCalls, 3);
      assert.equal(state.remoteInvalidationCalls, 3);
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
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
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
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
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
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
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

  it.effect("keeps the published local snapshot when a refresh remote read fails", () => {
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
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
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
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.isTrue(Option.isSome(snapshot));
      const event = Option.getOrThrow(snapshot);
      assert.equal(event._tag, "snapshot");
      if (event._tag === "snapshot") {
        assert.equal(event.local.refName, "feature/partial-refresh");
        assert.isNull(event.remote);
      }
    }).pipe(Effect.provide(layerTest));
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
            currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
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

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
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
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);

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

  it.effect("publishes local status while an earlier lookup holds the remote lock", () => {
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
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const earlier = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const completed = yield* Deferred.make<void>();
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped);

      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* Deferred.isDone(release));
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(earlier);
      const status = yield* Fiber.join(refresh);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("publishes local changes before a remote error and propagates that error", () => {
    const remoteError = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/repo",
      detail: "The controlled remote lookup failed.",
    });
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      state.remoteStatusError = remoteError;
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(
          Effect.result,
          Effect.ensuring(Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
      yield* Deferred.await(started);
      assert.isFalse(yield* Deferred.isDone(completed));
      const pending = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(pending._tag, "snapshot");
      if (pending._tag === "snapshot") assert.isTrue(pending.local.hasWorkingTreeChanges);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(refresh);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, remoteError);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.isTrue(cached.hasWorkingTreeChanges);
      assert.deepStrictEqual(cached.pr, remoteStatusWithPr.pr);
      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect.each(["getStatus", "refreshStatus", "autoPull", "autoPullFailure"] as const)(
    "%s keeps response parts consistent when local state changes after the remote cache write",
    (operation) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const autoPull = operation === "autoPull" || operation === "autoPullFailure";
      if (autoPull) {
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: true };
        state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 0, behindCount: 5 };
        state.pullCurrentBranch = () =>
          operation === "autoPullFailure"
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.pull",
                  command: "pull",
                  cwd: "/repo",
                  detail: "Pull failed.",
                }),
              )
            : Effect.succeed({
                status: "pulled",
                refName: "feature/status-broadcast",
                upstreamRef: "origin/main",
              });
      }
      const layerTest = layerTestFor(state).pipe(
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: () => Effect.succeed(autoPull),
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        let switched = false;
        let remoteWritten = false;
        const writeCompleted = yield* Deferred.make<void>();
        const localRefresh = yield* Effect.gen(function* () {
          yield* Deferred.await(writeCompleted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
          yield* broadcaster.refreshLocalStatus("/repo");
          switched = true;
        }).pipe(Effect.forkScoped);
        const scheduler = new Scheduler.MixedScheduler();
        const shouldYield = scheduler.shouldYield.bind(scheduler);
        scheduler.shouldYield = (fiber) => (remoteWritten && !switched) || shouldYield(fiber);
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (
                options.name !== "VcsStatusBroadcaster.updateCachedRemoteStatus" ||
                remoteWritten
              ) {
                return;
              }
              // Yield this reader after its write until the local refresh finishes.
              remoteWritten = true;
              Deferred.doneUnsafe(writeCompleted, Effect.void);
            };
            return span;
          },
        });
        const status = yield* (
          operation === "getStatus"
            ? broadcaster.getStatus({ cwd: "/repo" })
            : broadcaster.refreshStatus("/repo")
        ).pipe(Effect.withTracer(tracer), Effect.provideService(Scheduler.Scheduler, scheduler));
        yield* Fiber.join(localRefresh);
        assert.isTrue(switched);
        assert.equal(status.refName, "feature/next-status");
        assert.isNull(status.pr);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest), Effect.scoped);
    },
  );

  it.effect("recovers a discarded branch lookup on the next permitted turn-end refresh", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const lookup = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
      yield* Deferred.succeed(release, undefined);
      const discarded = yield* Fiber.join(lookup);
      assert.equal(discarded.refName, state.currentLocalStatus.refName);
      assert.isNull(discarded.pr);
      assert.equal(discarded.aheadCount, 0);
      assert.equal(discarded.behindCount, 0);
      const snapshot = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(snapshot._tag, "snapshot");
      if (snapshot._tag === "snapshot") assert.isNull(snapshot.remote);

      state.beforeRemoteStatus = Effect.void;
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
        pr: { ...remoteStatusWithPr.pr!, number: 2979, headRef: "feature/next-status" },
      };
      state.backgroundWorkEnabled = false;
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.equal(state.remoteStatusCalls, 1);
      state.backgroundWorkEnabled = true;
      const recovered = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(recovered, state.currentRemoteStatus);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(cached.refName, state.currentLocalStatus.refName);
      assert.deepStrictEqual(cached.pr, state.currentRemoteStatus.pr);
      assert.equal(cached.aheadCount, 2);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
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
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
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
        Layer.provide(
          Layer.succeed(
            VcsStatusBroadcaster.VcsAutomaticFetchInterval,
            Effect.succeed(Duration.millis(25)),
          ),
        ),
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

        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: rootDir }), (event) => {
          if (event._tag === "snapshot" && event.remote?.behindCount === 0) {
            return Deferred.succeed(pulledSnapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(siblingRefreshDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkIn(streamScope));

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
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  GitCommandError,
  SourceControlProviderError,
  type ChangeRequest,
  type ServerSettings,
  type SourceControlProviderKind,
  type VcsRef,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver, type ExecuteGitInput, type ExecuteGitResult } from "../vcs/GitVcsDriver.ts";

const branchRef: VcsRef = {
  name: "feature/source-control",
  current: false,
  isDefault: false,
  worktreePath: null,
};
const isGitCommandError = Schema.is(GitCommandError);

const success = (stdout = ""): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const failure = (stderr: string): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(1),
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const emptyProvider = SourceControlProvider.SourceControlProvider.of({
  kind: "unknown",
  listChangeRequests: () => Effect.succeed([]),
  getChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getChangeRequest",
        cwd: "/repo",
        detail: "get change request not stubbed",
      }),
    ),
  createChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createChangeRequest",
        cwd: "/repo",
        detail: "create change request not stubbed",
      }),
    ),
  getRepositoryCloneUrls: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getRepositoryCloneUrls",
        cwd: "/repo",
        detail: "repository clone URLs not stubbed",
      }),
    ),
  getCommitAvatarUrl: () => Effect.succeed(null),
  createRepository: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createRepository",
        cwd: "/repo",
        detail: "create repository not stubbed",
      }),
    ),
  getDefaultBranch: () => Effect.succeed(null),
  checkoutChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.checkoutChangeRequest",
        cwd: "/repo",
        detail: "checkout change request not stubbed",
      }),
    ),
});

function makeTestLayer(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
  workflow: Partial<GitWorkflowService["Service"]> = {},
  providers: Partial<
    Record<SourceControlProviderKind, SourceControlProvider.SourceControlProvider["Service"]>
  > = {},
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
  settingsChanges: Stream.Stream<ServerSettings> = Stream.empty,
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provide(Layer.mock(GitManager)({ branchPullRequest: () => Effect.succeed(null) })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.effect(
        ServerSettingsService,
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          return { ...service, streamChanges: settingsChanges };
        }),
      ).pipe(Layer.provide(ServerSettingsService.layerTest(settings))),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({ refreshStatus: () => Effect.never }),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(true),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.succeed(GitWorkflowService, {
        status: (input) =>
          workflow.status
            ? workflow.status(input)
            : workflow.localStatus
              ? workflow.localStatus(input).pipe(
                  Effect.map((status) => ({
                    ...status,
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                    aheadOfDefaultCount:
                      (status as { readonly aheadOfDefaultCount?: number }).aheadOfDefaultCount ??
                      0,
                    pr: null,
                  })),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "test.status",
                    command: "git status",
                    cwd: "/repo",
                    detail: "status not stubbed",
                  }),
                ),
        localStatus: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.localStatus",
              command: "git status",
              cwd: "/repo",
              detail: "local status not stubbed",
            }),
          ),
        pullCurrentBranch: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.pullCurrentBranch",
              command: "git pull",
              cwd: "/repo",
              detail: "pull not stubbed",
            }),
          ),
        ...workflow,
      } as GitWorkflowService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver, {
        execute,
        invalidateRefs: () => Effect.void,
      } as unknown as GitVcsDriver["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        SourceControlProviderRegistry,
        SourceControlProviderRegistry.of({
          resolveLink: () => Effect.die("unused resolveLink"),
          get: (kind) => Effect.succeed(providers[kind] ?? emptyProvider),
          resolveHandle: () => Effect.succeed({ provider: emptyProvider, context: null }),
          resolve: () => Effect.succeed(emptyProvider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );
}

const localStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/source-control",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
};

describe("SourceControlPanelService", () => {
  it.effect("rejects option-like branch names before creating a branch", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .createBranchFromCommit({
          cwd: "/repo",
          sha: "abc",
          branchName: "-D",
        })
        .pipe(Effect.flip);

      assert.equal(error.detail, 'Branch name cannot start with "-".');
    }).pipe(
      Effect.provide(
        makeTestLayer(() =>
          Effect.sync(() => {
            throw new Error("git should not run for invalid branch names");
          }),
        ),
      ),
    ),
  );

  it.effect("refreshes only working-tree slices when repository status is unchanged", () => {
    const calls: ExecuteGitInput[] = [];
    const statusOptions: unknown[] = [];
    let dirty = false;
    let aheadCount = 0;
    let refs = "initial refs";
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const initial = yield* service.snapshot({ cwd: "/repo", refresh: "full" });
      assert.deepStrictEqual(
        initial.localBranches.map((branch) => branch.name),
        ["main"],
      );
      calls.length = 0;
      dirty = true;

      const incremental = yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });

      assert.deepStrictEqual(incremental.localBranches, initial.localBranches);
      assert.deepStrictEqual(
        incremental.changeGroups.flatMap((group) => group.files.map((file) => file.path)),
        ["changed.txt"],
      );
      assert.deepStrictEqual(calls.map((call) => call.operation).toSorted(), [
        "vcs.panel.refsFingerprint",
        "vcs.panel.stagedNameStatus",
        "vcs.panel.stagedNumstat",
        "vcs.panel.statusPorcelain",
        "vcs.panel.unstagedNumstat",
        "vcs.panel.workingTreePrefix",
        "vcs.panel.worktrees",
      ]);

      calls.length = 0;
      yield* service.enrichWorkingTreeFiles({ cwd: "/repo", paths: ["changed.txt"] });
      assert.deepStrictEqual(calls, [], "enrichment should reuse the snapshot's Git scans");

      refs = "rewritten refs with the same commit date";
      const rewritten = yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });
      assert.notEqual(rewritten.refsFingerprint, initial.refsFingerprint);
      assert.isTrue(calls.some((call) => call.operation === "vcs.panel.localBranches"));
      calls.length = 0;
      aheadCount = 1;
      const fallback = yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });
      assert.equal(fallback.status.aheadCount, 1);
      assert.isTrue(calls.some((call) => call.operation === "vcs.panel.localBranches"));
      // Snapshots skip the PR lookup and the upstream fetch; the panel fetches on its own policy.
      assert.isTrue(statusOptions.length > 0);
      for (const options of statusOptions) {
        assert.deepStrictEqual(options, { includePullRequest: false, refreshUpstream: false });
      }
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.refsFingerprint":
                  return success(refs);
                case "vcs.panel.localBranches":
                  return success("main\t*\t/repo\t2026-07-20T10:00:00.000Z\torigin/main\t");
                case "vcs.panel.statusPorcelain":
                  return success(
                    dirty
                      ? [
                          "# branch.oid abc",
                          "# branch.head main",
                          "# branch.upstream origin/main",
                          `# branch.ab +${aheadCount} -0`,
                          "1 .M N... 100644 100644 100644 222222 333333 changed.txt",
                        ].join("\n")
                      : [
                          "# branch.oid abc",
                          "# branch.head main",
                          "# branch.upstream origin/main",
                          `# branch.ab +${aheadCount} -0`,
                        ].join("\n"),
                  );
                case "vcs.panel.unstagedNumstat":
                  return success(dirty ? "1\t0\tchanged.txt\0" : "");
                case "vcs.panel.worktrees":
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.stagedNameStatus":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            status: (_input, options) =>
              Effect.sync(() => {
                statusOptions.push(options);
                return {
                  ...localStatus,
                  refName: "main",
                  isDefaultRef: true,
                  hasWorkingTreeChanges: dirty,
                  hasUpstream: true,
                  aheadCount,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                  pr: null,
                };
              }),
          },
        ),
      ),
    );
  });

  it.effect("promotes working-tree refreshes while a full snapshot is in flight", () => {
    let fullSnapshotStarted: Deferred.Deferred<void> | null = null;
    let releaseFullSnapshot: Deferred.Deferred<void> | null = null;
    let localBranchesCalls = 0;
    let fresh = false;
    return Effect.gen(function* () {
      fullSnapshotStarted = yield* Deferred.make<void>();
      releaseFullSnapshot = yield* Deferred.make<void>();
      const service = yield* SourceControlPanelService;

      const initial = yield* service.snapshot({ cwd: "/repo", refresh: "full" });
      assert.equal(initial.stashes[0]?.message, "old stash");
      fresh = true;

      const fullSnapshotFiber = yield* Effect.forkChild(
        service.snapshot({ cwd: "/repo", refresh: "full" }),
      );
      yield* Deferred.await(fullSnapshotStarted);

      const watcherSnapshot = yield* service.snapshot({
        cwd: "/repo",
        refresh: "working-tree",
      });
      assert.equal(watcherSnapshot.stashes[0]?.message, "fresh stash");
      assert.equal(localBranchesCalls, 3);

      yield* Deferred.succeed(releaseFullSnapshot, undefined);
      yield* Fiber.join(fullSnapshotFiber);

      const cachedSnapshot = yield* service.snapshot({
        cwd: "/repo",
        refresh: "working-tree",
      });
      assert.equal(cachedSnapshot.stashes[0]?.message, "fresh stash");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.gen(function* () {
              switch (input.operation) {
                case "vcs.panel.localBranches": {
                  localBranchesCalls += 1;
                  if (localBranchesCalls === 2) {
                    if (!fullSnapshotStarted || !releaseFullSnapshot) {
                      throw new Error("Expected snapshot gates to be initialized");
                    }
                    yield* Deferred.succeed(fullSnapshotStarted, undefined);
                    yield* Deferred.await(releaseFullSnapshot);
                  }
                  return success("main\t*\t/repo\t2026-07-20T10:00:00.000Z\torigin/main\t");
                }
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head main",
                      "# branch.upstream origin/main",
                      "# branch.ab +0 -0",
                    ].join("\n"),
                  );
                case "vcs.panel.stashes":
                  return success(
                    `stash@{0}\tabc123\t2026-07-20T10:00:00.000Z\t${
                      fresh ? "fresh stash" : "old stash"
                    }`,
                  );
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("keeps snapshot generations unique after cwd cache eviction", () => {
    let firstSnapshotStarted: Deferred.Deferred<void> | null = null;
    let releaseFirstSnapshot: Deferred.Deferred<void> | null = null;
    let rootLocalBranchesCalls = 0;
    return Effect.gen(function* () {
      firstSnapshotStarted = yield* Deferred.make<void>();
      releaseFirstSnapshot = yield* Deferred.make<void>();
      const service = yield* SourceControlPanelService;

      const olderSnapshotFiber = yield* Effect.forkChild(
        service.snapshot({ cwd: "/repo", refresh: "full" }),
      );
      yield* Deferred.await(firstSnapshotStarted);

      for (let index = 0; index < 64; index += 1) {
        yield* service.snapshot({ cwd: `/repo-${index}`, refresh: "full" });
      }

      const newerSnapshot = yield* service.snapshot({ cwd: "/repo", refresh: "full" });
      assert.equal(newerSnapshot.localBranches[0]?.name, "newer");

      yield* Deferred.succeed(releaseFirstSnapshot, undefined);
      yield* Fiber.join(olderSnapshotFiber);

      const cachedSnapshot = yield* service.snapshot({
        cwd: "/repo",
        refresh: "working-tree",
      });
      assert.equal(cachedSnapshot.localBranches[0]?.name, "newer");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.gen(function* () {
              switch (input.operation) {
                case "vcs.panel.localBranches": {
                  if (input.cwd !== "/repo") {
                    return success(`main\t*\t${input.cwd}\t2026-07-20T10:00:00.000Z\t\t`);
                  }
                  rootLocalBranchesCalls += 1;
                  if (rootLocalBranchesCalls === 1) {
                    if (!firstSnapshotStarted || !releaseFirstSnapshot) {
                      throw new Error("Expected snapshot gates to be initialized");
                    }
                    yield* Deferred.succeed(firstSnapshotStarted, undefined);
                    yield* Deferred.await(releaseFirstSnapshot);
                    return success("older\t*\t/repo\t2026-07-20T10:00:00.000Z\t\t");
                  }
                  return success("newer\t*\t/repo\t2026-07-20T10:00:00.000Z\t\t");
                }
                case "vcs.panel.statusPorcelain":
                  return success(["# branch.oid abc", "# branch.head main"].join("\n"));
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("allows incremental refreshes after a full snapshot fails", () => {
    let localBranchesCalls = 0;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.snapshot({ cwd: "/repo", refresh: "full" });

      const failedFullExit = yield* Effect.exit(
        service.snapshot({ cwd: "/repo", refresh: "full" }),
      );
      assert.isTrue(Exit.isFailure(failedFullExit));

      yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });
      assert.equal(localBranchesCalls, 2);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              if (input.operation === "vcs.panel.localBranches") {
                localBranchesCalls += 1;
                if (localBranchesCalls === 2) {
                  return failure("failed full snapshot");
                }
                return success("main\t*\t/repo\t2026-07-20T10:00:00.000Z\torigin/main\t");
              }
              if (input.operation === "vcs.panel.statusPorcelain") {
                return success(
                  [
                    "# branch.oid abc",
                    "# branch.head main",
                    "# branch.upstream origin/main",
                    "# branch.ab +0 -0",
                  ].join("\n"),
                );
              }
              return success("");
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("completes full requests that fail or are interrupted reading the refs", () => {
    let fingerprint: "ok" | "fail" | "block" = "ok";
    let fingerprintBlocked: Deferred.Deferred<void> | null = null;
    let localBranchesCalls = 0;
    return Effect.gen(function* () {
      fingerprintBlocked = yield* Deferred.make<void>();
      const service = yield* SourceControlPanelService;

      yield* service.snapshot({ cwd: "/repo", refresh: "full" });

      fingerprint = "fail";
      const failedFullExit = yield* Effect.exit(
        service.snapshot({ cwd: "/repo", refresh: "full" }),
      );
      assert.isTrue(Exit.isFailure(failedFullExit));
      fingerprint = "ok";
      yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });
      assert.equal(localBranchesCalls, 1);

      fingerprint = "block";
      const interruptedFull = yield* Effect.forkChild(
        service.snapshot({ cwd: "/repo", refresh: "full" }),
      );
      yield* Deferred.await(fingerprintBlocked);
      yield* Fiber.interrupt(interruptedFull);
      fingerprint = "ok";
      yield* service.snapshot({ cwd: "/repo", refresh: "working-tree" });
      assert.equal(localBranchesCalls, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.gen(function* () {
              switch (input.operation) {
                case "vcs.panel.refsFingerprint":
                  if (fingerprint === "fail") return failure("cannot read refs");
                  if (fingerprint === "block") {
                    if (!fingerprintBlocked) throw new Error("Expected fingerprint gate");
                    yield* Deferred.succeed(fingerprintBlocked, undefined);
                    return yield* Effect.never;
                  }
                  return success("refs");
                case "vcs.panel.localBranches":
                  localBranchesCalls += 1;
                  return success("main\t*\t/repo\t2026-07-20T10:00:00.000Z\torigin/main\t");
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head main",
                      "# branch.upstream origin/main",
                      "# branch.ab +0 -0",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect(
    "promotes working-tree refreshes when worktree branches move without ref changes",
    () => {
      const rootPath = process.cwd();
      const siblingPath = `${process.cwd()}/..`;
      let siblingBranch = "feature/a";
      let localBranchesCalls = 0;
      const worktreePaths = (snapshot: { readonly localBranches: ReadonlyArray<VcsRef> }) =>
        Object.fromEntries(
          snapshot.localBranches.map((branch) => [branch.name, branch.worktreePath ?? null]),
        );
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;

        const initial = yield* service.snapshot({ cwd: rootPath, refresh: "full" });
        assert.deepStrictEqual(worktreePaths(initial), {
          main: rootPath,
          "feature/a": siblingPath,
          "feature/b": null,
          stale: null,
          locked: null,
        });

        yield* service.snapshot({ cwd: rootPath, refresh: "working-tree" });
        assert.equal(
          localBranchesCalls,
          1,
          "prunable or locked registrations without a directory are not worktree changes",
        );

        siblingBranch = "feature/b";
        const switched = yield* service.snapshot({ cwd: rootPath, refresh: "working-tree" });
        assert.equal(localBranchesCalls, 2);
        assert.deepStrictEqual(worktreePaths(switched), {
          main: rootPath,
          "feature/a": null,
          "feature/b": siblingPath,
          stale: null,
          locked: null,
        });
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.sync(() => {
                switch (input.operation) {
                  case "vcs.panel.refsFingerprint":
                    return success("unchanged refs");
                  case "vcs.panel.localBranches":
                    localBranchesCalls += 1;
                    return success(
                      [
                        "main\t*\t\t2026-07-20T10:00:00.000Z\t\t\t",
                        "feature/a\t\t\t2026-07-19T10:00:00.000Z\t\t\t",
                        "feature/b\t\t\t2026-07-18T10:00:00.000Z\t\t\t",
                        "stale\t\t\t2026-07-17T10:00:00.000Z\t\t\t",
                        "locked\t\t\t2026-07-16T10:00:00.000Z\t\t\t",
                      ].join("\n"),
                    );
                  case "vcs.panel.worktrees":
                    return success(
                      [
                        `worktree ${rootPath}`,
                        "HEAD abc",
                        "branch refs/heads/main",
                        "",
                        `worktree ${siblingPath}`,
                        "HEAD def",
                        `branch refs/heads/${siblingBranch}`,
                        "",
                        `worktree ${rootPath}/missing-worktree`,
                        "HEAD 123",
                        "branch refs/heads/stale",
                        "prunable gitdir file points to non-existent location",
                        "",
                        // Git never marks a locked registration prunable, even when it is missing.
                        `worktree ${rootPath}/missing-locked-worktree`,
                        "HEAD 456",
                        "branch refs/heads/locked",
                        "locked on a removable drive",
                        "",
                      ].join("\n"),
                    );
                  case "vcs.panel.statusPorcelain":
                    return success(["# branch.oid abc", "# branch.head main"].join("\n"));
                  default:
                    return success("");
                }
              }),
            {
              status: () =>
                Effect.succeed({
                  ...localStatus,
                  refName: "main",
                  isDefaultRef: true,
                  hasWorkingTreeChanges: false,
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                  pr: null,
                }),
            },
          ),
        ),
      );
    },
  );

  it.effect("disables fetch maintenance and preserves refresh behavior", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo" }), true);
      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo-linked" }), false);
      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo", force: true }), true);
      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo-linked" }), false);

      const fetchCalls = calls.filter((call) => call.operation === "vcs.panel.fetchAllRemotes");
      assert.equal(fetchCalls.length, 2);
      for (const call of fetchCalls) {
        assert.deepStrictEqual(call.env, {
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          GIT_TERMINAL_PROMPT: "0",
          SSH_ASKPASS: "",
          SSH_ASKPASS_REQUIRE: "never",
        });
        assert.deepStrictEqual(call.args, [
          "--git-dir",
          "/repo/.git",
          "fetch",
          "--all",
          "--no-auto-gc",
        ]);
      }
      assert.equal(fetchCalls[0]?.cwd, "/repo");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.resolveGitCommonDir"
              ? success("/repo/.git\n")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect("keeps fetch-all freshness until the fetch-all interval changes", () =>
    Effect.gen(function* () {
      const calls: ExecuteGitInput[] = [];
      const sendUnrelated = yield* Deferred.make<void>();
      const unrelatedApplied = yield* Deferred.make<void>();
      const sendInterval = yield* Deferred.make<void>();
      const intervalApplied = yield* Deferred.make<void>();
      const settings = yield* Effect.gen(function* () {
        return yield* (yield* ServerSettingsService).getSettings;
      }).pipe(Effect.provide(ServerSettingsService.layerTest()));
      // Each change is fully handled once the stream pulls the next element.
      const settingsChanges = Stream.fromEffect(
        Deferred.await(sendUnrelated).pipe(
          Effect.as({ ...settings, snoozeLimitedThreads: !settings.snoozeLimitedThreads }),
        ),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(unrelatedApplied, undefined).pipe(
              Effect.andThen(Deferred.await(sendInterval)),
              Effect.as({
                ...settings,
                backgroundActivity: {
                  schemaVersion: 1 as const,
                  profile: "custom" as const,
                  baseProfile: "balanced" as const,
                  overrides: { sourceControlAllRemotesFetchInterval: Duration.minutes(1) },
                },
              }),
            ),
          ),
        ),
        Stream.concat(Stream.fromEffectDrain(Deferred.succeed(intervalApplied, undefined))),
        Stream.concat(Stream.never),
      );
      const fetchCount = () =>
        calls.filter((call) => call.operation === "vcs.panel.fetchAllRemotes").length;

      yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;

        assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo" }), true);
        yield* Deferred.succeed(sendUnrelated, undefined);
        yield* Deferred.await(unrelatedApplied);
        assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo" }), false);
        assert.equal(fetchCount(), 1);

        yield* Deferred.succeed(sendInterval, undefined);
        yield* Deferred.await(intervalApplied);
        assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo" }), true);
        assert.equal(fetchCount(), 2);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.sync(() => {
                calls.push(input);
                return input.operation === "vcs.panel.resolveGitCommonDir"
                  ? success("/repo/.git\n")
                  : success();
              }),
            {},
            {},
            {},
            settingsChanges,
          ),
        ),
      );
    }),
  );

  it.effect("disables automatic fetch-all while preserving a forced fetch", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo" }), false);
      assert.equal(yield* service.fetchAllRemotes({ cwd: "/repo", force: true }), true);

      const fetchCalls = calls.filter((call) => call.operation === "vcs.panel.fetchAllRemotes");
      assert.equal(fetchCalls.length, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              return input.operation === "vcs.panel.resolveGitCommonDir"
                ? success("/repo/.git\n")
                : success();
            }),
          {},
          {},
          {
            backgroundActivity: {
              schemaVersion: 1,
              profile: "custom",
              baseProfile: "balanced",
              overrides: {
                sourceControlAllRemotesFetchInterval: Duration.zero,
              },
            },
          },
        ),
      ),
    );
  });
});

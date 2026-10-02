import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GitCommandError,
  GitManagerError,
  SourceControlProviderError,
  type SourceControlProviderKind,
  type VcsRef,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
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
  branchPullRequest: GitManager["Service"]["branchPullRequest"] = () => Effect.succeed(null),
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provide(Layer.mock(GitManager)({ branchPullRequest })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
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
  it.effect("reports a branch whose configured upstream is gone as unpublished", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          upstreamName: branch.upstreamName,
          upstreamRemoteName: branch.upstreamRemoteName,
        })),
        [
          { name: "feature/source-control", upstreamName: null, upstreamRemoteName: undefined },
          { name: "main", upstreamName: "origin/main", upstreamRemoteName: "origin" },
        ],
      );
      assert.strictEqual(snapshot.status.hasUpstream, false);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t\t\t2026-06-20T12:00:00.000Z\torigin/main\t\torigin",
                      "feature/source-control\t*\t\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[gone]\torigin",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head feature/source-control",
                      "# branch.upstream origin/feature/source-control",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("attaches worktree paths from git worktree porcelain output", () => {
    const worktreePath = process.cwd();
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: worktreePath });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath,
          },
          {
            name: "main",
            current: false,
            worktreePath,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${worktreePath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${worktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("drops missing branch worktree paths before building the panel snapshot", () => {
    const missingWorktreePath = `${process.cwd()}/.missing-source-control-worktree-test`;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* SourceControlPanelService;

      assert.isFalse(yield* fileSystem.exists(missingWorktreePath));

      const snapshot = yield* service.snapshot({ cwd: process.cwd() });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath: null,
          },
          {
            name: "main",
            current: false,
            worktreePath: null,
          },
        ],
      );
      assert.deepStrictEqual(snapshot.worktreeChangeSets, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${missingWorktreePath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${missingWorktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("includes dirty non-current worktrees as separate change sets", () => {
    const rootPath = process.cwd();
    const worktreePath = `${process.cwd()}/..`;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: rootPath });

      assert.deepStrictEqual(
        snapshot.worktreeChangeSets.map((changeSet) => ({
          branchName: changeSet.branchName,
          worktreePath: changeSet.worktreePath,
          files: changeSet.changeGroups.flatMap((group) =>
            group.files.map((file) => ({
              group: group.kind,
              path: file.path,
              status: file.status,
              insertions: file.insertions,
              deletions: file.deletions,
            })),
          ),
        })),
        [
          {
            branchName: "feature/source-control",
            worktreePath,
            files: [
              {
                group: "staged",
                path: "src/staged.ts",
                status: "added",
                insertions: 2,
                deletions: 0,
              },
              {
                group: "unstaged",
                path: "src/unstaged.ts",
                status: "modified",
                insertions: 3,
                deletions: 1,
              },
            ],
          },
        ],
      );
      assert.equal(snapshot.changeGroups.flatMap((group) => group.files).length, 0);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      `main\t*\t${rootPath}\t2026-06-20T12:00:00.000Z\torigin/main\t`,
                      `feature/source-control\t\t${worktreePath}\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t`,
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${rootPath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${worktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  if (input.cwd === worktreePath) {
                    return success(
                      [
                        "# branch.oid def",
                        "# branch.head feature/source-control",
                        "1 A. N... 000000 100644 100644 000000 111111 src/staged.ts",
                        "1 .M N... 100644 100644 100644 222222 333333 src/unstaged.ts",
                      ].join("\n"),
                    );
                  }
                  return success("# branch.oid abc\n# branch.head main");
                case "vcs.panel.stagedNumstat":
                  return input.cwd === worktreePath
                    ? success("2\t0\tsrc/staged.ts\0")
                    : success("");
                case "vcs.panel.stagedNameStatus":
                  return input.cwd === worktreePath ? success("A\0src/staged.ts\0") : success("");
                case "vcs.panel.unstagedNumstat":
                  return input.cwd === worktreePath
                    ? success("3\t1\tsrc/unstaged.ts\0")
                    : success("");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("falls back to branch-format worktree paths when worktree porcelain is empty", () => {
    const rootPath = process.cwd();
    const worktreePath = process.cwd();
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: worktreePath });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath,
          },
          {
            name: "main",
            current: false,
            worktreePath: rootPath,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  assert.ok(input.args.join(" ").includes("%(worktreepath)"));
                  return success(
                    [
                      `main\t\t${rootPath}\t2026-06-20T12:00:00.000Z\torigin/main\t`,
                      `feature/source-control\t*\t${worktreePath}\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]`,
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("falls back when git branch does not support worktreepath formatting", () => {
    let localBranchesCalls = 0;

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.equal(localBranchesCalls, 2);
      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
          lastActivityAt: branch.lastActivityAt,
          upstreamName: branch.upstreamName,
          upstreamRemoteName: branch.upstreamRemoteName,
          aheadCount: branch.aheadCount,
          behindCount: branch.behindCount,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath: null,
            lastActivityAt: "2026-06-21T12:00:00.000Z",
            upstreamName: "origin/feature/source-control",
            upstreamRemoteName: "origin",
            aheadCount: 1,
            behindCount: 0,
          },
          {
            name: "main",
            current: false,
            worktreePath: null,
            lastActivityAt: "2026-06-20T12:00:00.000Z",
            upstreamName: "origin/main",
            upstreamRemoteName: ".",
            aheadCount: 0,
            behindCount: 0,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  localBranchesCalls += 1;
                  assert.ok(input.args.join(" ").endsWith("%09%(upstream:remotename)"));
                  if (localBranchesCalls === 1) {
                    assert.ok(input.args.join(" ").includes("%(worktreepath)"));
                    assert.equal(input.allowNonZeroExit, true);
                    return failure("fatal: unknown field name: worktreepath");
                  }
                  assert.ok(!input.args.join(" ").includes("%(worktreepath)"));
                  assert.ok(input.args.join(" ").includes("%09%09"));
                  return success(
                    [
                      "main\t\t\t2026-06-20T12:00:00.000Z\torigin/main\t\t.",
                      "feature/source-control\t*\t\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]\torigin",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  for (const upstreamRemoteName of [".", "origin"]) {
    it.effect(`preserves fork candidates for upstream identity ${upstreamRemoteName}`, () =>
      Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const snapshot = yield* service.snapshot({ cwd: "/repo" });
        assert.equal(snapshot.localBranches[0]?.upstreamRemoteName, upstreamRemoteName);
        assert.deepStrictEqual(
          snapshot.actionableForkBranches.map((fork) => fork.remoteName),
          upstreamRemoteName === "." ? ["origin"] : [],
        );
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.sync(() => {
                switch (input.operation) {
                  case "vcs.panel.localBranches":
                    assert.ok(input.args.join(" ").endsWith("%09%(upstream:remotename)"));
                    return success(
                      `main\t*\t/repo\t2026-06-20T12:00:00Z\torigin/main\t\t${upstreamRemoteName}`,
                    );
                  case "vcs.panel.remotes":
                    return success(
                      "origin\tgit@example.test:one/repo.git\t(fetch)\nother\tgit@example.test:two/repo.git\t(fetch)",
                    );
                  case "vcs.panel.remoteBranches":
                    return success(
                      input.args.includes("origin/*") ? "origin/main\t2026-06-20T12:00:00Z" : "",
                    );
                  case "vcs.panel.branchForkMergeBase":
                    return success("abc\n");
                  case "vcs.panel.branchForkAheadBehind":
                    return success("0\t2\n");
                  case "vcs.panel.statusPorcelain":
                    return success("# branch.oid abc\n# branch.head main");
                  default:
                    return success("");
                }
              }),
            {
              localStatus: () =>
                Effect.succeed({ ...localStatus, refName: "main", hasWorkingTreeChanges: false }),
            },
          ),
        ),
      ),
    );
  }

  it.effect("keeps git-derived actionable forks when branch pull request lookup fails", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.deepStrictEqual(snapshot.actionableForkBranches, [
        {
          localBranchName: "feature",
          remoteName: "upstream",
          remoteBranchName: "feature",
          remoteRefName: "upstream/feature",
          aheadCount: 2,
          behindCount: 3,
          lastActivityAt: "2026-06-17T09:00:00.000Z",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    "feature\t*\t/repo\t2026-06-17T10:00:00.000Z\torigin/feature\t[ahead 1]\torigin",
                  );
                case "vcs.panel.remotes":
                  return success(
                    [
                      "origin\tgit@github.com:fork/repo.git\t(fetch)",
                      "origin\tgit@github.com:fork/repo.git\t(push)",
                      "upstream\tgit@github.com:upstream/repo.git\t(fetch)",
                      "upstream\tgit@github.com:upstream/repo.git\t(push)",
                    ].join("\n"),
                  );
                case "vcs.panel.remoteBranches":
                  return input.args.includes("origin/*")
                    ? success("origin/feature\t2026-06-17T08:00:00.000Z\n")
                    : success("upstream/feature\t2026-06-17T09:00:00.000Z\n");
                case "vcs.panel.branchForkMergeBase":
                  return success("abc123\n");
                case "vcs.panel.branchForkAheadBehind":
                  return success("2\t3\n");
                case "vcs.panel.statusPorcelain":
                  return success(["# branch.oid abc", "# branch.head feature"].join("\n"));
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                case "vcs.panel.stashes":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature",
                hasWorkingTreeChanges: false,
              }),
          },
          {},
          {},
          () =>
            Effect.fail(
              new GitManagerError({
                operation: "branchPullRequest",
                cwd: "/repo",
                detail: "provider unavailable",
              }),
            ),
        ),
      ),
    ),
  );

  it.effect("discovers PR targets for every local branch using the shared branch lookup", () => {
    const lookupInputs: Array<{ cwd: string; branch: string }> = [];
    const names = Array.from({ length: 105 }, (_, i) => `feature-${i}`);
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      // All branches are synced with origin. The old repository-wide page would
      // omit older PRs; target discovery must not depend on that page's contents.
      assert.equal(lookupInputs.length, names.length);
      assert.deepStrictEqual(lookupInputs.map((input) => input.branch).sort(), names.toSorted());
      assert.deepStrictEqual(
        snapshot.actionableForkBranches
          .toSorted((left, right) => left.localBranchName.localeCompare(right.localBranchName))
          .map((fork) => ({
            branch: fork.localBranchName,
            target: fork.remoteRefName,
            ahead: fork.aheadCount,
            behind: fork.behindCount,
            prNumber: fork.pr?.number,
            prUrl: fork.pr?.url,
          })),
        [
          {
            branch: "feature-103",
            target: "upstream/feature-103",
            ahead: 2,
            behind: 17,
            prNumber: 42,
            prUrl: "https://github.com/acme/repo/pull/42",
          },
          {
            branch: "feature-104",
            target: "upstream/main",
            ahead: 2,
            behind: 17,
            prNumber: 42,
            prUrl: "https://github.com/acme/repo/pull/42",
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    names
                      .map((name) => `${name}\t\t\t2026-06-17T10:00:00.000Z\torigin/${name}\t`)
                      .join("\n"),
                  );
                case "vcs.panel.remotes":
                  return success(
                    "origin\tgit@github.com:fork/repo.git\t(fetch)\nupstream\thttps://github.com/acme/repo.git\t(fetch)",
                  );
                case "vcs.panel.remoteBranches":
                  return input.args.includes("origin/*")
                    ? success(["origin/main", ...names.map((name) => `origin/${name}`)].join("\n"))
                    : success(
                        "upstream/main\t2026-06-17T11:00:00.000Z\nupstream/feature-103\t2026-06-17T11:00:00.000Z",
                      );
                case "vcs.panel.branchForkMergeBase":
                  return success("abc123\n");
                case "vcs.panel.branchForkAheadBehind":
                  return input.args.includes("feature-103...upstream/feature-103") ||
                    ["feature-2", "feature-3", "feature-104"].some((branch) =>
                      input.args.includes(`${branch}...upstream/main`),
                    )
                    ? success("2\t17\n")
                    : success("1\t0\n");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
                default:
                  return success("");
              }
            }),
          { localStatus: () => Effect.succeed({ ...localStatus, hasWorkingTreeChanges: false }) },
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              listChangeRequests: () => Effect.die("Panel must not scan repository PR pages"),
            }),
          },
          {},
          (input) => {
            lookupInputs.push(input);
            if (input.branch === "feature-0")
              return Effect.fail(
                new GitManagerError({
                  operation: "branchPullRequest",
                  cwd: input.cwd,
                  detail: "provider unavailable",
                }),
              );
            if (input.branch === "feature-1") return Effect.succeed(null);
            return Effect.succeed({
              number: 42,
              title: "Feature",
              url: "https://github.com/acme/repo/pull/42",
              baseRef: input.branch === "feature-103" ? "feature-103" : "main",
              headRef: input.branch,
              isDraft: false,
              state: input.branch === "feature-2" ? ("closed" as const) : ("open" as const),
              repositoryKey:
                input.branch === "feature-3" ? "github.com/other/repo" : "github.com/acme/repo",
              updatedAt: null,
            });
          },
        ),
      ),
    );
  });
});

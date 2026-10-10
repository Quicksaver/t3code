import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GitCommandError,
  SourceControlProviderError,
  type ChangeRequest,
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
import { resolveGitCommandTimeoutMs } from "../vcs/GitCommandTimeout.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
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
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provide(Layer.mock(GitManager)({ branchPullRequest: () => Effect.succeed(null) })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
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

const localBranchGitOutput = (input: ExecuteGitInput): ExecuteGitResult => {
  switch (input.operation) {
    case "vcs.panel.localBranches":
      return success(
        "feature/source-control\t\t\t2026-06-20T12:00:00.000Z\torigin/feature/source-control\t",
      );
    case "vcs.panel.statusPorcelain":
      return success("# branch.oid abc\n# branch.head main");
    case "vcs.panel.deleteBranch.localBranch":
      return success("abc refs/heads/feature/source-control\n");
    case "vcs.panel.deleteBranch.currentBranch":
      return success("main\n");
    default:
      return success("");
  }
};

// The branch is registered to /repo-pr-66, whose directory no longer exists.
const staleWorktreeGitOutput = (input: ExecuteGitInput): ExecuteGitResult => {
  switch (input.operation) {
    case "vcs.panel.localBranches":
      return success(
        "feature/source-control\t\t/repo-pr-66\t2026-06-20T12:00:00.000Z\torigin/feature/source-control\t",
      );
    case "vcs.panel.worktrees":
    case "vcs.panel.deleteBranch.worktrees":
      return success(
        [
          "worktree /repo",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /repo-pr-66",
          "HEAD def",
          "branch refs/heads/feature/source-control",
          "prunable gitdir file points to non-existent location",
          "",
        ].join("\n"),
      );
    default:
      return localBranchGitOutput(input);
  }
};

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
  it.effect("pulls non-current branches from upstream remotes with slashes in their name", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.pullBranch({
        cwd: "/repo",
        branchName: "main",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.pullBranch.nonCurrent");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "team/upstream",
        "refs/heads/main:refs/heads/main",
      ]);
      assert.strictEqual(
        resolveGitCommandTimeoutMs(fetchCall?.args ?? [], fetchCall?.timeoutMs),
        300_000,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("team/upstream/main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\nteam/upstream\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
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

  it.effect("rejects slashful upstreams that do not match a known remote", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .pullBranch({
          cwd: "/repo",
          branchName: "main",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.pullBranch");
      assert.equal(error.detail, "Branch main has invalid upstream team/upstream/main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.pullBranch.nonCurrent"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("team/upstream/main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
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

  it.effect("rejects slashless local upstreams when pulling non-current branches", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .pullBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.pullBranch");
      assert.equal(error.detail, "Branch feature/source-control has invalid upstream main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.pullBranch.nonCurrent"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\nupstream\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
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

  it.effect("fetches branches from upstream remotes with slashes in their name", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.fetchBranch({
        cwd: "/repo",
        branchName: "team/upstream/main",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.fetchBranch");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "team/upstream",
        "refs/heads/main:refs/remotes/team/upstream/main",
      ]);
      assert.strictEqual(
        resolveGitCommandTimeoutMs(fetchCall?.args ?? [], fetchCall?.timeoutMs),
        300_000,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nteam/upstream\n");
              case "vcs.panel.fetchBranch.remoteBranch":
                return success("abc123 refs/remotes/team/upstream/main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("rejects option-like branch names before pulling or fetching", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const pullError = yield* service
        .pullBranch({ cwd: "/repo", branchName: "--upload-pack=x" })
        .pipe(Effect.flip);
      const fetchError = yield* service
        .fetchBranch({ cwd: "/repo", branchName: "--upload-pack=x" })
        .pipe(Effect.flip);

      for (const error of [pullError, fetchError]) {
        assert.equal(error.detail, 'Git revision or remote cannot start with "-".');
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(makeTestLayer((input) => Effect.sync(() => (calls.push(input), success())))),
    );
  });

  it.effect("passes remote URLs after the option terminator", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.addRemote({ cwd: "/repo", name: "upstream", url: "--mirror=fetch" });

      assert.deepStrictEqual(calls.at(-1)?.args, [
        "remote",
        "add",
        "--",
        "upstream",
        "--mirror=fetch",
      ]);
    }).pipe(
      Effect.provide(makeTestLayer((input) => Effect.sync(() => (calls.push(input), success())))),
    );
  });

  it.effect("fetches without credential prompts and reads status without PR lookup", () => {
    const calls: ExecuteGitInput[] = [];
    const statusOptions: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.pullBranch({ cwd: "/repo", branchName: "main", force: true });
      yield* service.pullBranch({
        cwd: "/repo",
        branchName: "feature/source-control",
        force: true,
      });
      yield* service.fetchBranch({ cwd: "/repo", branchName: "main" });
      yield* service.fetchRemote({ cwd: "/repo", remoteName: "origin" });
      yield* service.commitStaged({ cwd: "/repo", message: "Commit", push: true });

      const fetches = calls.filter((call) => call.args[0] === "fetch");
      assert.deepStrictEqual(
        fetches.map((call) => call.operation),
        [
          "vcs.panel.pullBranch.nonCurrent",
          "vcs.panel.forcePullBranch",
          "vcs.panel.fetchBranch",
          "vcs.panel.fetchRemote",
        ],
      );
      for (const call of fetches) {
        assert.deepInclude(call.env, STATUS_UPSTREAM_REFRESH_ENV);
      }
      assert.deepStrictEqual(statusOptions, [
        { includePullRequest: false },
        { includePullRequest: false },
        { includePullRequest: false },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("origin/main\n");
                case "vcs.panel.pullBranch.remotes":
                case "vcs.panel.fetchBranch.remotes":
                  return success("origin\n");
                case "vcs.panel.forcePullBranch.upstream":
                  return success("origin/feature/source-control\n");
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
                  hasUpstream: true,
                  aheadCount: 0,
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

  it.effect("deletes a merged local branch through the shared Git workflow", () => {
    const deletions: unknown[] = [];
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.deleteBranch({ cwd: "/repo", branchName: "feature/source-control" });

      assert.deepStrictEqual(deletions, [
        { cwd: "/repo", refName: "feature/source-control", force: false },
      ]);
      // Git's -d rule compares with the branch's upstream when it has one.
      assert.include(
        calls.find((call) => call.operation === "vcs.panel.deleteBranch.merged")?.args.join(" ") ??
          "",
        "--merged=origin/feature/source-control",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("origin/feature/source-control\n");
                case "vcs.panel.deleteBranch.merged":
                  return success("refs/heads/feature/source-control\n");
                default:
                  return localBranchGitOutput(input);
              }
            }),
          {
            localStatus: () => Effect.succeed(localStatus),
            deleteLocalBranch: (input) => Effect.sync(() => void deletions.push(input)),
          },
        ),
      ),
    );
  });

  it.effect("refuses an unmerged branch unless the delete is forced", () => {
    const deletions: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .deleteBranch({ cwd: "/repo", branchName: "feature/source-control" })
        .pipe(Effect.flip);
      assert.equal(
        error.detail,
        "Branch feature/source-control has unmerged commits. Force delete it to discard them.",
      );
      assert.deepStrictEqual(deletions, []);

      yield* service.deleteBranch({
        cwd: "/repo",
        branchName: "feature/source-control",
        force: true,
      });
      assert.deepStrictEqual(deletions, [
        { cwd: "/repo", refName: "feature/source-control", force: true },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) => Effect.succeed(localBranchGitOutput(input)), {
          localStatus: () => Effect.succeed(localStatus),
          deleteLocalBranch: (input) => Effect.sync(() => void deletions.push(input)),
        }),
      ),
    );
  });

  it.effect("rejects deletion of the current branch", () => {
    const deletions: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .deleteBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
          force: true,
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.deleteBranch");
      assert.equal(error.detail, "Cannot delete the current branch.");
      assert.deepStrictEqual(deletions, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.succeed(
              input.operation === "vcs.panel.deleteBranch.currentBranch"
                ? success("feature/source-control\n")
                : localBranchGitOutput(input),
            ),
          {
            localStatus: () => Effect.succeed(localStatus),
            deleteLocalBranch: (input) => Effect.sync(() => void deletions.push(input)),
          },
        ),
      ),
    );
  });

  it.effect("prunes a stale worktree registration before deleting its branch", () => {
    const steps: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.deleteBranch({
        cwd: "/repo",
        branchName: "feature/source-control",
        force: true,
      });

      assert.deepStrictEqual(steps, ["prune", "delete"]);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) => Effect.succeed(staleWorktreeGitOutput(input)), {
          localStatus: () => Effect.succeed(localStatus),
          pruneWorktrees: () => Effect.sync(() => void steps.push("prune")),
          deleteLocalBranch: () => Effect.sync(() => void steps.push("delete")),
        }),
      ),
    );
  });

  it.effect("refuses a branch Git still lists in a live worktree, naming its path", () => {
    const steps: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .deleteBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
          force: true,
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "Branch feature/source-control is checked out in the worktree at /repo-pr-66. Remove that worktree before deleting the branch.",
      );
      assert.deepStrictEqual(steps, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.succeed(
              input.operation === "vcs.panel.deleteBranch.worktrees"
                ? success(
                    [
                      "worktree /repo",
                      "branch refs/heads/main",
                      "",
                      "worktree /repo-pr-66",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  )
                : staleWorktreeGitOutput(input),
            ),
          {
            localStatus: () => Effect.succeed(localStatus),
            pruneWorktrees: () => Effect.sync(() => void steps.push("prune")),
            deleteLocalBranch: () => Effect.sync(() => void steps.push("delete")),
          },
        ),
      ),
    );
  });

  it.effect("resolves remote branch deletion from Git refs without a panel snapshot", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.deleteBranch({
        cwd: "/repo",
        branchName: "origin/feature/source-control",
        remoteName: "origin",
      });

      const deleteCall = calls.find((call) => call.operation === "vcs.panel.deleteRemoteBranch");
      assert.deepStrictEqual(deleteCall?.args, [
        "push",
        "origin",
        "--delete",
        "feature/source-control",
      ]);
      assert.isFalse(calls.some((call) => call.operation === "vcs.panel.localBranches"));
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.deleteBranch.remotes":
                  return success("origin\n");
                case "vcs.panel.deleteBranch.remoteBranch":
                  return input.args.includes("refs/remotes/origin/feature/source-control")
                    ? success("abc refs/remotes/origin/feature/source-control\n")
                    : success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () => Effect.succeed(localStatus),
          },
        ),
      ),
    );
  });

  it.effect.each([
    { label: "remote", localPresent: true, remoteName: "origin", expected: "remote" },
    { label: "local", localPresent: true, remoteName: undefined, expected: "local" },
    { label: "missing local", localPresent: false, remoteName: undefined, expected: "missing" },
    { label: "missing remote", localPresent: true, remoteName: "other", expected: "missing" },
  ] as const)("preserves $label deletion identity when branch names collide", (scenario) => {
    const calls: ExecuteGitInput[] = [];
    const localDeletes: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const deletion = service.deleteBranch({
        cwd: "/repo",
        branchName: "origin/main",
        ...(scenario.remoteName ? { remoteName: scenario.remoteName } : {}),
      });
      if (scenario.expected === "missing") {
        const error = yield* deletion.pipe(Effect.flip);
        assert.equal(error.detail, "Branch origin/main was not found.");
      } else {
        yield* deletion;
      }

      const remoteDeletes = calls
        .filter((call) => call.operation === "vcs.panel.deleteRemoteBranch")
        .map((call) => call.args);
      assert.deepStrictEqual(
        [...remoteDeletes, ...localDeletes],
        scenario.expected === "remote"
          ? [["push", "origin", "--delete", "main"]]
          : scenario.expected === "local"
            ? ["origin/main"]
            : [],
      );
      // Snapshot rows keep full local and remote names so clients can send either identity.
      yield* service.snapshot({ cwd: "/repo" });
      const localFormat = calls.find((call) => call.operation === "vcs.panel.localBranches")?.args;
      assert.include(localFormat?.join(" ") ?? "", "%(refname:lstrip=2)");
      assert.include(localFormat?.join(" ") ?? "", "%(upstream:lstrip=2)");
      assert.include(
        calls.find((call) => call.operation === "vcs.panel.remoteBranches")?.args.join(" ") ?? "",
        "%(refname:lstrip=2)",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    scenario.localPresent ? "origin/main\t\t\t2026-06-20T12:00:00.000Z\t\t" : "",
                  );
                case "vcs.panel.remotes":
                  return success("origin\tgit@example.test:fork/repo.git\t(fetch)");
                case "vcs.panel.remoteBranches":
                  return success("origin/main\t2026-06-20T12:00:00.000Z");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
                case "vcs.panel.deleteBranch.merged":
                  return success("refs/heads/origin/main");
                case "vcs.panel.deleteBranch.remotes":
                  return success("origin\n");
                case "vcs.panel.deleteBranch.remoteBranch":
                  return success("abc refs/remotes/origin/main\n");
                case "vcs.panel.deleteBranch.localBranch":
                  return success(scenario.localPresent ? "abc refs/heads/origin/main\n" : "");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () => Effect.succeed(localStatus),
            deleteLocalBranch: (input) => Effect.sync(() => void localDeletes.push(input.refName)),
          },
        ),
      ),
    );
  });

  it.effect("fetches local branches with remote-looking names from their upstream", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.fetchBranch({
        cwd: "/repo",
        branchName: "origin/feature",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.fetchBranch");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "upstream",
        "refs/heads/main:refs/remotes/upstream/main",
      ]);
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.fetchBranch.remoteBranch"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nupstream\n");
              case "vcs.panel.fetchBranch.localBranch":
                return success("abc123 refs/heads/origin/feature\n");
              case "vcs.panel.branchUpstream":
                return success("upstream/main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("rejects slashless local upstreams when fetching local branches", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .fetchBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.fetchBranch");
      assert.equal(error.detail, "Branch feature/source-control has invalid upstream main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.fetchBranch"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nupstream\n");
              case "vcs.panel.fetchBranch.localBranch":
                return success("abc123 refs/heads/feature/source-control\n");
              case "vcs.panel.branchUpstream":
                return success("main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("defers untracked detail loading from the initial snapshot", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });
      const unstagedFiles =
        snapshot.changeGroups.find((group) => group.kind === "unstaged")?.files ?? [];

      assert.equal(unstagedFiles.length, 101);
      assert.deepStrictEqual(unstagedFiles[0], {
        path: "generated/file-000.txt",
        originalPath: null,
        status: "untracked",
        insertions: 0,
        deletions: 0,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              assert.notInclude(
                [
                  "vcs.panel.untrackedNumstat",
                  "vcs.panel.gitIndexPath",
                  "vcs.panel.tempIndexIntentToAdd",
                  "vcs.panel.unstagedNameStatusWithUntracked",
                  "vcs.panel.unstagedNumstatWithUntracked",
                ],
                input.operation,
              );

              switch (input.operation) {
                case "vcs.panel.localBranches":
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head main",
                      ...Array.from(
                        { length: 101 },
                        (_, index) => `? generated/file-${index.toString().padStart(3, "0")}.txt`,
                      ),
                    ].join("\n"),
                  );
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () => Effect.succeed(localStatus),
          },
        ),
      ),
    ),
  );

  it.effect("uses the repository default branch as the default compare ref even when current", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.equal(snapshot.defaultCompareRef, "main");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t*\t/repo\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t\t\t2026-06-19T12:00:00.000Z\t\t",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
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
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("keeps a non-main current default branch as the default compare ref", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.equal(snapshot.defaultCompareRef, "develop");
      assert.deepStrictEqual(
        snapshot.localBranches.map((ref) => ({ name: ref.name, isDefault: ref.isDefault })),
        [
          { name: "develop", isDefault: true },
          { name: "feature/source-control", isDefault: false },
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
                      "develop\t*\t/repo\t2026-06-20T12:00:00.000Z\torigin/develop\t",
                      "feature/source-control\t\t\t2026-06-19T12:00:00.000Z\t\t",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head develop");
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
                refName: "develop",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("surfaces same-name remote forks only when the local branch is behind", () =>
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
                      "origin\tgit@example.test:fork/repo.git\t(fetch)",
                      "origin\tgit@example.test:fork/repo.git\t(push)",
                      "upstream\tgit@example.test:upstream/repo.git\t(fetch)",
                      "upstream\tgit@example.test:upstream/repo.git\t(push)",
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
        ),
      ),
    ),
  );
});

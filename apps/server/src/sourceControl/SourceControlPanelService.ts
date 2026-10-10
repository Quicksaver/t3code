import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL,
  GitCommandError,
  type VcsPanelAddRemoteInput,
  type VcsPanelBranchActionInput,
  type VcsPanelBranchCommitsInput,
  type VcsPanelBranchCommitsResult,
  type VcsPanelBranchDetails,
  type VcsPanelBranchDetailsInput,
  type VcsPanelCommitActionInput,
  type VcsPanelCommitInput,
  type VcsPanelCommitFilesInput,
  type VcsPanelCommitFilesResult,
  type VcsPanelCompareInput,
  type VcsPanelCompareResult,
  type VcsPanelDeleteBranchInput,
  type VcsPanelFileActionInput,
  type VcsPanelFileChange,
  type VcsPanelFileDiffInput,
  type VcsPanelFileDiffResult,
  type VcsPanelFetchAllRemotesInput,
  type VcsPanelRemoteInput,
  type VcsPanelRefActionInput,
  type VcsPanelSnapshotInput,
  type VcsPanelSnapshotResult,
  type VcsPanelStashDetails,
  type VcsPanelStashDetailsInput,
  type VcsPanelStashInput,
  type VcsPanelUndoCommitInput,
  type VcsPanelWorktreeChangeSet,
  type VcsPanelWorkingTreeFileEnrichmentInput,
  type VcsPanelWorkingTreeFileEnrichmentResult,
  type VcsPullResult,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import { canonicalizeExistingPath } from "../utils/CanonicalPath.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  makeSourceControlRepositoryInstructionReader,
  makeSourceControlWritingPolicyResolver,
} from "../textGeneration/SourceControlWriting.ts";
import {
  GitVcsDriver,
  type ExecuteGitProgress,
  type ExecuteGitResult,
} from "../vcs/GitVcsDriver.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { panelFetchOverridesHostLock } from "./SourceControlPanelFetchPolicy.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { makeSourceControlPanelActions } from "./SourceControlPanelActions.ts";
import {
  parseFileChangesFromNumstat,
  parseLocalBranches,
  parseNameStatus,
  parseRemoteBranches,
  parseRemoteVerbose,
  parseStashes,
  parseWorktreeBranchEntries,
  parseWorktreeBranchPaths,
  uniquePaths,
  type WorktreeBranchEntry,
} from "./SourceControlPanelParsers.ts";
import { GitManager } from "../git/GitManager.ts";
import { makeSourceControlPanelReaders } from "./SourceControlPanelReaders.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  mergeNumstats,
  panelStatusFromLocal,
  parseNumstat,
  fileChangesRelativeToCwd,
  untrackedPathsFromPorcelain,
  unstagedFilesFromPorcelainStatus,
} from "./SourceControlPanelStatusParsers.ts";
const isGitCommandError = Schema.is(GitCommandError);
const LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:lstrip=2)%09%(HEAD)%09%(worktreepath)%09%(committerdate:iso-strict)%09%(upstream:lstrip=2)%09%(upstream:track)%09%(upstream:remotename)",
] as const;
const LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:lstrip=2)%09%(HEAD)%09%09%(committerdate:iso-strict)%09%(upstream:lstrip=2)%09%(upstream:track)%09%(upstream:remotename)",
] as const;

interface PanelSnapshotCacheState {
  readonly nextRequestId: number;
  readonly latestRequestByCwd: ReadonlyMap<string, number>;
  readonly latestFullRequestByCwd: ReadonlyMap<string, number>;
  readonly completedFullRequestByCwd: ReadonlyMap<string, number>;
  readonly snapshotsByCwd: ReadonlyMap<string, VcsPanelSnapshotResult>;
}

const PANEL_SNAPSHOT_CACHE_CAPACITY = 64;

function setBoundedMapEntry<K, V>(
  source: ReadonlyMap<K, V>,
  key: K,
  value: V,
  capacity: number,
): ReadonlyMap<K, V> {
  const next = new Map(source);
  next.delete(key);
  next.set(key, value);
  while (next.size > capacity) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }
  return next;
}

export class SourceControlPanelService extends Context.Service<
  SourceControlPanelService,
  {
    readonly snapshot: (
      input: VcsPanelSnapshotInput,
    ) => Effect.Effect<VcsPanelSnapshotResult, GitCommandError>;
    readonly branchDetails: (
      input: VcsPanelBranchDetailsInput,
    ) => Effect.Effect<VcsPanelBranchDetails, GitCommandError>;
    readonly commitFiles: (
      input: VcsPanelCommitFilesInput,
    ) => Effect.Effect<VcsPanelCommitFilesResult, GitCommandError>;
    readonly branchCommits: (
      input: VcsPanelBranchCommitsInput,
    ) => Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError>;
    readonly stashDetails: (
      input: VcsPanelStashDetailsInput,
    ) => Effect.Effect<VcsPanelStashDetails, GitCommandError>;
    readonly stageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly discardFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly enrichWorkingTreeFiles: (
      input: VcsPanelWorkingTreeFileEnrichmentInput,
    ) => Effect.Effect<VcsPanelWorkingTreeFileEnrichmentResult, GitCommandError>;
    readonly readFileDiff: (
      input: VcsPanelFileDiffInput,
    ) => Effect.Effect<VcsPanelFileDiffResult, GitCommandError>;
    readonly commitStaged: (input: VcsPanelCommitInput) => Effect.Effect<void, GitCommandError>;
    readonly pullBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly pushBranch: (input: VcsPanelBranchActionInput) => Effect.Effect<void, GitCommandError>;
    readonly deleteBranch: (
      input: VcsPanelDeleteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly undoLatestCommit: (
      input: VcsPanelUndoCommitInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly revertCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly checkoutCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly createBranchFromCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly mergeBranchIntoCurrent: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly rebaseCurrentOnto: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly fetchAllRemotes: (
      input: VcsPanelFetchAllRemotesInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly addRemote: (input: VcsPanelAddRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly removeRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly createStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly applyStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly popStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly dropStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly compare: (
      input: VcsPanelCompareInput,
    ) => Effect.Effect<VcsPanelCompareResult, GitCommandError>;
  }
>()("t3/sourceControl/SourceControlPanelService") {}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function gitError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
) {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause: sanitizeErrorCause(cause) }),
  });
}

function asGitCommandError(operation: string, cwd: string, args: readonly string[]) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : gitError(operation, cwd, args, "Source control operation failed.", cause);
}

const MAX_GIT_FAILURE_DETAIL_LENGTH = 2_000;
// Userinfo may itself contain `@`; everything up to the last one before the host goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/giu;

/**
 * Builds the user-facing failure for a nonzero Git exit from Git's own explanation. Output can
 * echo credential-bearing remote URLs, and Git explains the outcome last, so keep a redacted tail.
 */
function nonZeroExitError(
  operation: string,
  cwd: string,
  args: readonly string[],
  result: ExecuteGitResult,
) {
  const output = (result.stderr.trim() || result.stdout.trim()).replace(URL_WITH_USERINFO, "$1");
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail:
      output.length === 0
        ? "Git command exited with a non-zero status."
        : output.length <= MAX_GIT_FAILURE_DETAIL_LENGTH
          ? output
          : `…${output.slice(-MAX_GIT_FAILURE_DETAIL_LENGTH)}`,
    exitCode: result.exitCode,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
}

function isUnsupportedWorktreePathFormat(detail: string) {
  detail = detail.toLowerCase();
  return detail.includes("worktreepath") && detail.includes("unknown field");
}

const make = Effect.fn("makeSourceControlPanelService")(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver;
  const path = yield* Path.Path;
  const workflow = yield* GitWorkflowService;
  const gitManager = yield* GitManager;
  const serverSettings = yield* ServerSettingsService;
  const sourceControlProviders = Option.getOrUndefined(
    yield* Effect.serviceOption(SourceControlProviderRegistry),
  );
  const sourceControlRateLimits = Option.getOrUndefined(
    yield* Effect.serviceOption(SourceControlRateLimit.SourceControlRateLimit),
  );
  const textGeneration = Option.getOrUndefined(yield* Effect.serviceOption(TextGeneration));
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projects = Option.getOrUndefined(yield* Effect.serviceOption(ProjectStore.ProjectStoreV2));
  const statusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;

  const runResult = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly progress?: ExecuteGitProgress;
    },
  ) =>
    git
      .execute({
        operation,
        cwd,
        args,
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.progress !== undefined ? { progress: options.progress } : {}),
        allowNonZeroExit: options?.allowNonZeroExit ?? false,
        maxOutputBytes: 8 * 1024 * 1024,
        appendTruncationMarker: true,
      })
      .pipe(Effect.mapError(asGitCommandError(operation, cwd, args)));

  // The driver rejects a nonzero exit without its output, so always request the raw result and
  // apply the caller's failure policy here, where Git's explanation is still available.
  const run = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly progress?: ExecuteGitProgress;
    },
  ) =>
    runResult(operation, cwd, args, { ...options, allowNonZeroExit: true }).pipe(
      Effect.flatMap((result) =>
        options?.allowNonZeroExit === true || result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(nonZeroExitError(operation, cwd, args, result)),
      ),
    );

  const snapshotCacheRef = yield* Ref.make<PanelSnapshotCacheState>({
    nextRequestId: 0,
    latestRequestByCwd: new Map(),
    latestFullRequestByCwd: new Map(),
    completedFullRequestByCwd: new Map(),
    snapshotsByCwd: new Map(),
  });

  const sourceControlAllRemotesFetchInterval = serverSettings.getSettings.pipe(
    Effect.map(
      (settings) =>
        resolveServerBackgroundActivitySettings(settings).sourceControlAllRemotesFetchInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL),
  );

  const fetchAllRemotesCache = yield* Cache.makeWith(
    (gitCommonDir: string) => {
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
      return Effect.gen(function* () {
        const interval = yield* sourceControlAllRemotesFetchInterval;
        yield* run(
          "vcs.panel.fetchAllRemotes",
          fetchCwd,
          [
            "--git-dir",
            gitCommonDir,
            "fetch",
            "--all",
            // Repeated panel refreshes must not restart failed repacks on every fetch.
            "--no-auto-gc",
          ],
          { env: STATUS_UPSTREAM_REFRESH_ENV },
        ).pipe(Effect.ensuring(git.invalidateRefs(fetchCwd)));
        return interval;
      });
    },
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value : Duration.seconds(5)),
    },
  );

  // Cached fetches expire by the interval they ran under, so only a new interval drops them.
  yield* Stream.concat(
    Stream.fromEffect(sourceControlAllRemotesFetchInterval),
    serverSettings.streamChanges.pipe(
      Stream.map(
        (settings) =>
          resolveServerBackgroundActivitySettings(settings).sourceControlAllRemotesFetchInterval,
      ),
    ),
  ).pipe(
    Stream.changes,
    Stream.drop(1),
    Stream.runForEach(() => Cache.invalidateAll(fetchAllRemotesCache)),
    Effect.forkScoped,
  );

  const resolveGitCommonDir = Effect.fn("SourceControlPanelService.resolveGitCommonDir")(function* (
    cwd: string,
  ) {
    const commonDir = (yield* run("vcs.panel.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ])).trim();
    return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
  });

  const stashLocks = yield* KeyedLock.make<string>();
  const withStashMutation = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const commonDir = yield* canonicalizeExistingPath(
        fileSystem,
        yield* resolveGitCommonDir(cwd),
      );
      return yield* stashLocks.withLock(commonDir, effect);
    });

  const fetchAllRemotes: SourceControlPanelService["Service"]["fetchAllRemotes"] = Effect.fn(
    "fetchAllRemotes",
  )(function* (input) {
    if (input.force !== true) {
      const interval = yield* sourceControlAllRemotesFetchInterval;
      if (Duration.isZero(interval)) return false;
    }
    const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
    if (input.force === true) {
      yield* Cache.invalidate(fetchAllRemotesCache, gitCommonDir);
    } else if (Option.isSome(yield* Cache.getOption(fetchAllRemotesCache, gitCommonDir))) {
      return false;
    }
    yield* Cache.get(fetchAllRemotesCache, gitCommonDir);
    return true;
  });

  const withTemporaryIntentToAddIndex = <A, E>(
    input: {
      readonly cwd: string;
      readonly paths: readonly string[];
      readonly operations: {
        readonly gitIndexPath: string;
        readonly tempIndexReadTree: string;
        readonly tempIndexIntentToAdd: string;
      };
    },
    body: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const gitIndexPath = (yield* run(input.operations.gitIndexPath, input.cwd, [
        "rev-parse",
        "--git-path",
        "index",
      ])).trim();
      const sourceIndexPath = path.isAbsolute(gitIndexPath)
        ? gitIndexPath
        : path.resolve(input.cwd, gitIndexPath);
      const tempDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-vcs-index-" });
      return yield* Effect.gen(function* () {
        const tempIndexPath = path.join(tempDir, "index");
        const env = { ...globalThis.process.env, GIT_INDEX_FILE: tempIndexPath };
        yield* fileSystem.copyFile(sourceIndexPath, tempIndexPath).pipe(
          Effect.catch(() =>
            run(input.operations.tempIndexReadTree, input.cwd, ["read-tree", "HEAD"], {
              env,
            }).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          ),
        );
        yield* run(
          input.operations.tempIndexIntentToAdd,
          input.cwd,
          ["--literal-pathspecs", "add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"],
          // A deleted row can compare against thousands of untracked rename candidates.
          // Keep those literal paths off the platform-limited process command line.
          { env, stdin: `${input.paths.join("\0")}\0` },
        ).pipe(Effect.asVoid);
        return yield* body(env);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    });

  const withTemporarySelectedIndex = <A, E>(
    cwd: string,
    paths: readonly string[],
    body: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const tempDir = yield* fileSystem
        .makeTempDirectory({ prefix: "t3-vcs-selected-index-" })
        .pipe(
          Effect.mapError(asGitCommandError("vcs.panel.commitStaged.tempIndex", cwd, ["commit"])),
        );
      return yield* Effect.gen(function* () {
        const env = {
          ...globalThis.process.env,
          GIT_INDEX_FILE: path.join(tempDir, "index"),
        };
        const headResult = yield* runResult(
          "vcs.panel.commitStaged.tempIndexResolveHead",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true, env },
        );
        yield* run(
          "vcs.panel.commitStaged.tempIndexReadTree",
          cwd,
          headResult.exitCode === 0 ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
          { env },
        ).pipe(Effect.asVoid);
        // A staged deletion can still exist on disk (git rm --cached), often newly ignored.
        // Preserve that intent instead of adding the file back from the working tree.
        const deletedRepositoryPaths = (yield* run(
          "vcs.panel.commitStaged.selectedDeletions",
          cwd,
          ["diff", "--cached", "--no-relative", "--name-only", "--diff-filter=D", "-z"],
        ))
          .split("\0")
          .filter((file) => file.length > 0);
        // Git lists deletions from the repository root; selections are relative to the panel cwd.
        const prefix =
          deletedRepositoryPaths.length === 0
            ? ""
            : (yield* run("vcs.panel.commitStaged.selectedDeletionsPrefix", cwd, [
                "rev-parse",
                "--show-prefix",
              ])).replace(/\r?\n$/u, "");
        const deleted = new Set(
          fileChangesRelativeToCwd(
            deletedRepositoryPaths.map((file) => ({
              path: file,
              originalPath: null,
              status: "deleted",
              insertions: 0,
              deletions: 0,
            })),
            prefix,
          ).map((file) => file.path),
        );
        const selectedDeletions = paths.filter((file) => deleted.has(file));
        const selectedFiles = paths.filter((file) => !deleted.has(file));
        if (selectedDeletions.length > 0) {
          yield* run(
            "vcs.panel.commitStaged.tempIndexRemoveSelected",
            cwd,
            ["update-index", "--force-remove", "-z", "--stdin"],
            { env, stdin: `${selectedDeletions.join("\0")}\0` },
          );
        }
        if (selectedFiles.length > 0) {
          yield* run(
            "vcs.panel.commitStaged.tempIndexAddSelected",
            cwd,
            ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            { env, stdin: `${selectedFiles.join("\0")}\0` },
          );
        }
        return yield* body(env);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    });

  const branchWithExistingWorktreePath = (branch: VcsRef) => {
    if (!branch.worktreePath) return Effect.succeed(branch);
    return fileSystem.exists(branch.worktreePath).pipe(
      Effect.map((exists) => (exists ? branch : { ...branch, worktreePath: null })),
      Effect.orElseSucceed(() => ({ ...branch, worktreePath: null })),
    );
  };

  const resolveWritingPolicy = makeSourceControlWritingPolicyResolver({
    runGit: (cwd, args) => run("vcs.panel.writingStyleRecentCommitSubjects", cwd, args),
    readRepositoryInstructions: makeSourceControlRepositoryInstructionReader(fileSystem, path),
  });

  const {
    actionableForkBranches,
    commitFiles,
    branchCommits,
    branchDetails,
    changeGroupsHaveFiles,
    generatedCommitMessage,
    generatedStashMessage,
    readWorkingTreeChangeGroups: readRawWorkingTreeChangeGroups,
    refExists,
    stashDetails,
    upstreamForRef,
  } = makeSourceControlPanelReaders({
    run,
    branchPullRequest: gitManager.branchPullRequest,
    serverSettings,
    sourceControlProviders,
    sourceControlRateLimits,
    textGeneration,
    getProviders: providerRegistry.getProviders,
    resolveWritingPolicy,
    ...(projects
      ? {
          projectIdForWorkspace: (cwd: string) =>
            projects
              .findActiveByWorkspaceRoot(path.resolve(cwd))
              .pipe(Effect.map((project) => Option.getOrNull(project)?.projectId ?? null)),
        }
      : {}),
  });
  const unstagedFilesWithUntrackedRenames = (
    cwd: string,
    untrackedPaths: readonly string[],
    prefix: string,
  ) =>
    Effect.gen(function* () {
      if (untrackedPaths.length === 0) return null;

      return yield* withTemporaryIntentToAddIndex(
        {
          cwd,
          paths: untrackedPaths,
          operations: {
            gitIndexPath: "vcs.panel.gitIndexPath",
            tempIndexReadTree: "vcs.panel.tempIndexReadTree",
            tempIndexIntentToAdd: "vcs.panel.tempIndexIntentToAdd",
          },
        },
        (env) =>
          Effect.gen(function* () {
            const [nameStatus, numstat] = yield* Effect.all(
              [
                run(
                  "vcs.panel.unstagedNameStatusWithUntracked",
                  cwd,
                  ["diff", "--no-relative", "--name-status", "-z", "--find-renames=20%"],
                  { env },
                ),
                run(
                  "vcs.panel.unstagedNumstatWithUntracked",
                  cwd,
                  ["diff", "--no-relative", "--numstat", "-z", "--find-renames=20%"],
                  { env },
                ),
              ],
              { concurrency: "unbounded" },
            );
            return fileChangesRelativeToCwd(
              parseFileChangesFromNumstat({
                numstat,
                statuses: parseNameStatus(nameStatus),
              }),
              prefix,
            );
          }),
      );
    }).pipe(Effect.orElseSucceed(() => null));

  // Commit objects are immutable. Share reads across pages, panels, and clients.
  const commitFilesCache = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, sha] = JSON.parse(key) as [string, string];
      return commitFiles(cwd, sha);
    },
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    },
  );

  // Scrolling may request several batches before Git finishes one status scan.
  const enrichmentStatusCache = yield* Cache.makeWith(
    (cwd: string) =>
      Effect.all(
        [
          run("vcs.panel.enrichWorkingTreeFiles.statusPorcelain", cwd, [
            "-c",
            "status.relativePaths=true",
            "status",
            "--porcelain=2",
            "--branch",
            "-uall",
          ]),
          run("vcs.panel.enrichWorkingTreeFiles.unstagedNumstat", cwd, [
            "diff",
            "--no-relative",
            "--numstat",
            "-z",
            "--find-renames=20%",
          ]),
          run("vcs.panel.workingTreePrefix", cwd, ["rev-parse", "--show-prefix"]).pipe(
            Effect.map((output) => output.replace(/\r?\n$/u, "")),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(1) : Duration.zero),
    },
  );

  const readWorkingTreeChangeGroups = (cwd: string) =>
    readRawWorkingTreeChangeGroups(cwd).pipe(
      Effect.tap((result) =>
        Cache.set(enrichmentStatusCache, path.resolve(cwd), [
          result.porcelain,
          result.unstagedNumstat,
          result.prefix,
        ] satisfies [string, string, string]),
      ),
    );

  const enrichWorkingTreeFiles: SourceControlPanelService["Service"]["enrichWorkingTreeFiles"] =
    Effect.fn("enrichWorkingTreeFiles")(function* (input) {
      const requestedPaths = uniquePaths(input.paths);
      const [porcelain, unstagedNumstat, prefix] = yield* Cache.get(
        enrichmentStatusCache,
        path.resolve(input.cwd),
      );

      const requestedPathSet = new Set(requestedPaths);
      const untrackedPaths = untrackedPathsFromPorcelain(porcelain);
      const untrackedPathSet = new Set(untrackedPaths);
      const unstagedFiles = unstagedFilesFromPorcelainStatus({
        status: porcelain,
        unstagedStats: parseNumstat(unstagedNumstat, prefix),
      });
      const deletedPathSet = new Set(
        unstagedFiles.filter((file) => file.status === "deleted").map((file) => file.path),
      );
      const requestedUntrackedPaths = requestedPaths.filter((path) => untrackedPathSet.has(path));
      const requestedDeletedPaths = requestedPaths.filter((path) => deletedPathSet.has(path));
      const renameCandidateUntrackedPaths =
        requestedDeletedPaths.length > 0 ? untrackedPaths : requestedUntrackedPaths;

      const [untrackedStats, renameCandidates] = yield* Effect.all(
        [
          Effect.forEach(
            requestedUntrackedPaths,
            (path) =>
              run(
                "vcs.panel.enrichWorkingTreeFiles.untrackedNumstat",
                input.cwd,
                ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path],
                { allowNonZeroExit: true },
              ).pipe(
                Effect.map(parseNumstat),
                Effect.orElseSucceed(() => new Map()),
              ),
            { concurrency: 4 },
          ).pipe(Effect.map((stats) => mergeNumstats(stats))),
          unstagedFilesWithUntrackedRenames(input.cwd, renameCandidateUntrackedPaths, prefix),
        ],
        { concurrency: "unbounded" },
      );

      const filesByPath = new Map<string, VcsPanelFileChange>();
      const hiddenPaths = new Set<string>();
      for (const file of renameCandidates ?? []) {
        if (file.status !== "renamed" || !file.originalPath) continue;
        if (!requestedPathSet.has(file.path) && !requestedPathSet.has(file.originalPath)) continue;
        filesByPath.set(file.path, file);
        hiddenPaths.add(file.originalPath);
      }

      for (const path of requestedUntrackedPaths) {
        if (filesByPath.has(path)) continue;
        const stats = untrackedStats.get(path);
        filesByPath.set(path, {
          path,
          originalPath: null,
          status: "untracked",
          insertions: stats?.insertions ?? 0,
          deletions: stats?.deletions ?? 0,
        });
      }
      for (const file of unstagedFiles) {
        if (file.status !== "deleted") continue;
        if (
          !requestedPathSet.has(file.path) ||
          hiddenPaths.has(file.path) ||
          filesByPath.has(file.path)
        ) {
          continue;
        }
        filesByPath.set(file.path, file);
      }

      return {
        files: [...filesByPath.values()].toSorted((left, right) =>
          left.path.localeCompare(right.path),
        ),
        hiddenPaths: [...hiddenPaths].toSorted((left, right) => left.localeCompare(right)),
      };
    });

  const readWorktreeChangeSets = Effect.fn("readWorktreeChangeSets")(function* (
    cwd: string,
    localBranches: ReadonlyArray<VcsRef>,
    worktreeBranchEntries: ReadonlyArray<WorktreeBranchEntry> | null,
  ) {
    return yield* Effect.forEach(
      localBranches.filter((branch) => {
        if (branch.current || !branch.worktreePath) return false;
        if (path.resolve(branch.worktreePath) === path.resolve(cwd)) return false;
        return (
          worktreeBranchEntries === null ||
          worktreeBranchEntries.some(
            (entry) =>
              entry.branchName === branch.name && entry.worktreePath === branch.worktreePath,
          )
        );
      }),
      (branch) =>
        readWorkingTreeChangeGroups(branch.worktreePath!).pipe(
          Effect.map((result): VcsPanelWorktreeChangeSet | null =>
            changeGroupsHaveFiles(result.changeGroups)
              ? {
                  branchName: branch.name,
                  worktreePath: branch.worktreePath!,
                  current: false,
                  lastActivityAt: branch.lastActivityAt ?? null,
                  changeGroups: result.changeGroups,
                }
              : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((sets) =>
        sets
          .filter((set): set is VcsPanelWorktreeChangeSet => set !== null)
          .toSorted((left, right) => {
            const leftTime = Date.parse(left.lastActivityAt ?? "");
            const rightTime = Date.parse(right.lastActivityAt ?? "");
            const activity =
              (Number.isFinite(rightTime) ? rightTime : 0) -
              (Number.isFinite(leftTime) ? leftTime : 0);
            return activity !== 0 ? activity : left.branchName.localeCompare(right.branchName);
          }),
      ),
    );
  });

  const readFullSnapshot = Effect.fn("readFullSnapshot")(function* (cwd: string) {
    const [
      localStatus,
      localBranchesOutput,
      worktreeListOutput,
      workingTree,
      remotesOutput,
      stashes,
    ] = yield* Effect.all(
      [
        workflow
          .status({ cwd }, { includePullRequest: false, refreshUpstream: false })
          .pipe(Effect.mapError(asGitCommandError("vcs.panel.status", cwd, ["status"]))),
        runResult("vcs.panel.localBranches", cwd, LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS, {
          allowNonZeroExit: true,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(result.stdout);
            return isUnsupportedWorktreePathFormat(result.stderr.trim() || result.stdout.trim())
              ? run("vcs.panel.localBranches", cwd, LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS)
              : Effect.fail(
                  nonZeroExitError(
                    "vcs.panel.localBranches",
                    cwd,
                    LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS,
                    result,
                  ),
                );
          }),
        ),
        run("vcs.panel.worktrees", cwd, ["worktree", "list", "--porcelain"], {
          allowNonZeroExit: true,
        }),
        readWorkingTreeChangeGroups(cwd),
        run("vcs.panel.remotes", cwd, ["remote", "-v"]),
        run("vcs.panel.stashes", cwd, ["stash", "list", "--format=%gd%x09%H%x09%cI%x09%gs"]),
      ],
      { concurrency: "unbounded" },
    );

    const localBranches = yield* Effect.forEach(
      parseLocalBranches(
        localBranchesOutput,
        parseWorktreeBranchPaths(worktreeListOutput),
        localStatus.isDefaultRef ? localStatus.refName : null,
      ),
      branchWithExistingWorktreePath,
      { concurrency: "unbounded" },
    );
    const remotes = parseRemoteVerbose(remotesOutput);
    const remotesWithBranches = yield* Effect.forEach(
      remotes,
      (remote) =>
        run("vcs.panel.remoteBranches", cwd, [
          "branch",
          "-r",
          "--list",
          `${remote.name}/*`,
          "--format=%(refname:lstrip=2)%09%(committerdate:iso-strict)%09%(objectname)",
        ]).pipe(
          Effect.map((branchesOutput) => ({
            ...remote,
            branches: parseRemoteBranches(branchesOutput, remote.name),
          })),
          Effect.orElseSucceed(() => remote),
        ),
      { concurrency: "unbounded" },
    );
    const defaultCompareRef =
      localBranches.find((ref) => ref.isDefault)?.name ??
      localBranches.find((ref) => !ref.current)?.name ??
      null;
    const forkBranches = yield* actionableForkBranches(cwd, localBranches, remotesWithBranches);
    const worktreeBranchEntries = parseWorktreeBranchEntries(worktreeListOutput);
    const worktreeChangeSets = yield* readWorktreeChangeSets(
      cwd,
      localBranches,
      worktreeBranchEntries,
    );
    return {
      status: panelStatusFromLocal(localStatus, workingTree.porcelain),
      changeGroups: workingTree.changeGroups,
      worktreeChangeSets,
      localBranches,
      branchDetails: [],
      remotes: remotesWithBranches,
      actionableForkBranches: forkBranches,
      stashes: parseStashes(stashes),
      recentCommits: [],
      defaultCompareRef,
    };
  });

  const readWorkingTreeSnapshot = Effect.fn("readWorkingTreeSnapshot")(function* (
    cwd: string,
    cached: VcsPanelSnapshotResult,
  ) {
    const [localStatus, workingTree, worktreeList] = yield* Effect.all(
      [
        workflow
          .status({ cwd }, { includePullRequest: false, refreshUpstream: false })
          .pipe(Effect.mapError(asGitCommandError("vcs.panel.status", cwd, ["status"]))),
        readWorkingTreeChangeGroups(cwd),
        runResult("vcs.panel.worktrees", cwd, ["worktree", "list", "--porcelain"], {
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: "unbounded" },
    );
    // Switching branches in a sibling worktree, or adding one, leaves every ref unchanged, so
    // return null when worktree identity no longer matches the cached branches. Without a
    // worktree list, keep trusting the cached worktree paths. Like the full snapshot, ignore
    // registrations whose directory is missing, including locked ones Git never prunes.
    const worktreeBranchEntries =
      worktreeList.exitCode === 0
        ? yield* Effect.filter(
            parseWorktreeBranchEntries(worktreeList.stdout),
            (entry) =>
              fileSystem.exists(entry.worktreePath).pipe(Effect.orElseSucceed(() => false)),
            { concurrency: "unbounded" },
          )
        : null;
    const cachedWorktreeBranches = cached.localBranches.filter((branch) => branch.worktreePath);
    if (
      worktreeBranchEntries !== null &&
      (worktreeBranchEntries.length !== cachedWorktreeBranches.length ||
        !worktreeBranchEntries.every((entry) =>
          cachedWorktreeBranches.some(
            (branch) =>
              branch.name === entry.branchName && branch.worktreePath === entry.worktreePath,
          ),
        ))
    ) {
      return null;
    }
    const status = panelStatusFromLocal(localStatus, workingTree.porcelain);
    const worktreeChangeSets = yield* readWorktreeChangeSets(
      cwd,
      cached.localBranches,
      worktreeBranchEntries,
    );
    return { status, workingTree, worktreeChangeSets };
  });

  const repositoryStatusChanged = (left: VcsStatusResult, right: VcsStatusResult): boolean =>
    left.isRepo !== right.isRepo ||
    left.hasPrimaryRemote !== right.hasPrimaryRemote ||
    left.isDefaultRef !== right.isDefaultRef ||
    left.refName !== right.refName ||
    left.hasUpstream !== right.hasUpstream ||
    left.aheadCount !== right.aheadCount ||
    left.behindCount !== right.behindCount ||
    left.aheadOfDefaultCount !== right.aheadOfDefaultCount ||
    JSON.stringify(left.sourceControlProvider ?? null) !==
      JSON.stringify(right.sourceControlProvider ?? null) ||
    JSON.stringify(left.pr) !== JSON.stringify(right.pr);

  const snapshot: SourceControlPanelService["Service"]["snapshot"] = Effect.fn("snapshot")(
    function* (input) {
      const cacheKey = path.resolve(input.cwd);
      yield* Cache.invalidate(enrichmentStatusCache, cacheKey);
      // A registered full request must complete however this request ends; a pending one
      // promotes every later working-tree refresh to a full snapshot.
      const registerRequest = Ref.modify(snapshotCacheRef, (state) => {
        const requestId = state.nextRequestId + 1;
        const cached = state.snapshotsByCwd.get(cacheKey) ?? null;
        const latestFullRequest = state.latestFullRequestByCwd.get(cacheKey) ?? 0;
        const completedFullRequest = state.completedFullRequestByCwd.get(cacheKey) ?? 0;
        const full =
          input.refresh !== "working-tree" ||
          cached === null ||
          latestFullRequest > completedFullRequest;
        const latestRequestByCwd = setBoundedMapEntry(
          state.latestRequestByCwd,
          cacheKey,
          requestId,
          PANEL_SNAPSHOT_CACHE_CAPACITY,
        );
        const latestFullRequestByCwd = full
          ? setBoundedMapEntry(
              state.latestFullRequestByCwd,
              cacheKey,
              requestId,
              PANEL_SNAPSHOT_CACHE_CAPACITY,
            )
          : state.latestFullRequestByCwd;
        return [
          {
            requestId,
            cached,
            full,
          },
          { ...state, nextRequestId: requestId, latestRequestByCwd, latestFullRequestByCwd },
        ] as const;
      });
      const request = yield* Effect.acquireRelease(registerRequest, (request) =>
        request.full
          ? Ref.update(snapshotCacheRef, (state) => ({
              ...state,
              completedFullRequestByCwd: setBoundedMapEntry(
                state.completedFullRequestByCwd,
                cacheKey,
                Math.max(state.completedFullRequestByCwd.get(cacheKey) ?? 0, request.requestId),
                PANEL_SNAPSHOT_CACHE_CAPACITY,
              ),
            }))
          : Effect.void,
      );

      const refsFingerprint = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            yield* run("vcs.panel.refsFingerprint", input.cwd, [
              "for-each-ref",
              "--format=%(refname)%09%(objectname)",
            ]),
          ),
        )
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      let nextSnapshot: VcsPanelSnapshotResult;
      if (
        !request.full &&
        request.cached !== null &&
        request.cached.refsFingerprint === refsFingerprint
      ) {
        const incremental = yield* readWorkingTreeSnapshot(input.cwd, request.cached);
        nextSnapshot =
          incremental === null || repositoryStatusChanged(request.cached.status, incremental.status)
            ? yield* readFullSnapshot(input.cwd)
            : {
                ...request.cached,
                status: incremental.status,
                changeGroups: incremental.workingTree.changeGroups,
                worktreeChangeSets: incremental.worktreeChangeSets,
              };
      } else {
        nextSnapshot = yield* readFullSnapshot(input.cwd);
      }

      nextSnapshot = { ...nextSnapshot, refsFingerprint };
      yield* Ref.update(snapshotCacheRef, (state) => {
        if (state.latestRequestByCwd.get(cacheKey) !== request.requestId) {
          return state;
        }
        const snapshotsByCwd = setBoundedMapEntry(
          state.snapshotsByCwd,
          cacheKey,
          nextSnapshot,
          PANEL_SNAPSHOT_CACHE_CAPACITY,
        );
        return { ...state, snapshotsByCwd };
      });
      return nextSnapshot;
    },
    Effect.scoped,
  );

  const actions = makeSourceControlPanelActions({
    generatedCommitMessage,
    generatedStashMessage,
    invalidateRefs: git.invalidateRefs,
    refExists,
    run,
    upstreamForRef,
    withTemporaryIntentToAddIndex,
    withTemporarySelectedIndex,
    withStashMutation,
    workflow,
  });

  // Mutations publish fresh VCS status in the background without delaying their result.
  const refreshStatus = (cwd: string, options?: { readonly refreshUpstream?: boolean }) =>
    statusBroadcaster
      .refreshStatus(cwd, options)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
  const refreshingStatus =
    <I extends { readonly cwd: string }, A, E>(
      mutate: (input: I) => Effect.Effect<A, E>,
      options?: { readonly refreshUpstream?: boolean },
    ) =>
    (input: I) =>
      mutate(input).pipe(Effect.tap(() => refreshStatus(input.cwd, options)));

  // Automatic fetches follow the shared background policy, except that a foreground client
  // retaining this cwd keeps remote refs fresh while the host is locked.
  const automaticFetchAllowed = Effect.fn("automaticFetchAllowed")(function* (cwd: string) {
    const decisions = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "git-refs", cwd }),
      backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd }),
    ]);
    if (decisions.some(Boolean)) return true;
    return panelFetchOverridesHostLock({
      policy: yield* backgroundPolicy.snapshot,
      settings: yield* serverSettings.getSettings.pipe(
        Effect.map(resolveServerBackgroundActivitySettings),
        Effect.orElseSucceed(() => getBackgroundActivityPresetSettings("balanced")),
      ),
      cwd,
    });
  });
  const fetchAllRemotesWhenAllowed: SourceControlPanelService["Service"]["fetchAllRemotes"] =
    Effect.fn("fetchAllRemotesWhenAllowed")(function* (input) {
      if (input.force !== true && !(yield* automaticFetchAllowed(input.cwd))) return false;
      const fetched = yield* fetchAllRemotes(input);
      if (fetched) yield* refreshStatus(input.cwd, { refreshUpstream: false });
      return fetched;
    });

  return SourceControlPanelService.of({
    snapshot,
    branchDetails: (input) =>
      branchDetails(
        input.cwd,
        input.branch,
        input.defaultCompareRef,
        input.compareBaseRef,
        input.deferCommitFiles,
      ),
    commitFiles: (input) =>
      Cache.get(commitFilesCache, JSON.stringify([path.resolve(input.cwd), input.sha])).pipe(
        Effect.map((files) => ({ files })),
      ),
    branchCommits: (input) =>
      branchCommits(
        input.cwd,
        input.branch,
        input.baseRef,
        input.kind,
        input.skip,
        input.limit,
        input.deferCommitFiles,
        input.defaultCompareRef,
      ),
    stashDetails: (input) => stashDetails(input.cwd, input.stashRef),
    enrichWorkingTreeFiles,
    ...actions,
    commitStaged: refreshingStatus(actions.commitStaged),
    stageFiles: refreshingStatus(actions.stageFiles),
    unstageFiles: refreshingStatus(actions.unstageFiles),
    discardFiles: refreshingStatus(actions.discardFiles),
    pullBranch: refreshingStatus(actions.pullBranch),
    pushBranch: refreshingStatus(actions.pushBranch),
    deleteBranch: refreshingStatus(actions.deleteBranch),
    undoLatestCommit: refreshingStatus(actions.undoLatestCommit),
    revertCommit: refreshingStatus(actions.revertCommit),
    checkoutCommit: refreshingStatus(actions.checkoutCommit),
    createBranchFromCommit: refreshingStatus(actions.createBranchFromCommit),
    mergeBranchIntoCurrent: refreshingStatus(actions.mergeBranchIntoCurrent),
    rebaseCurrentOnto: refreshingStatus(actions.rebaseCurrentOnto),
    fetchBranch: refreshingStatus(actions.fetchBranch, { refreshUpstream: false }),
    fetchRemote: refreshingStatus(actions.fetchRemote, { refreshUpstream: false }),
    fetchAllRemotes: fetchAllRemotesWhenAllowed,
    addRemote: refreshingStatus(actions.addRemote),
    removeRemote: refreshingStatus(actions.removeRemote),
    createStash: refreshingStatus(actions.createStash),
    applyStash: refreshingStatus(actions.applyStash),
    popStash: refreshingStatus(actions.popStash),
    dropStash: refreshingStatus(actions.dropStash),
  });
});

export const layer = Layer.effect(SourceControlPanelService, make());

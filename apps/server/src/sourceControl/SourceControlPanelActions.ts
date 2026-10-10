import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import {
  GitCommandError,
  type VcsPanelCompareInput,
  type VcsPanelCompareResult,
  type VcsPanelStashInput,
} from "@t3tools/contracts";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import type { ExecuteGitProgress } from "../vcs/GitVcsDriver.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import {
  chunkPathsForArgv,
  parseNulPaths,
  parseWorktreeBranchEntries,
  uniquePaths,
} from "./SourceControlPanelParsers.ts";
import type { SourceControlPanelService } from "./SourceControlPanelService.ts";

export type SourceControlPanelActionMethodName =
  | "stageFiles"
  | "unstageFiles"
  | "discardFiles"
  | "readFileDiff"
  | "commitStaged"
  | "pullBranch"
  | "pushBranch"
  | "deleteBranch"
  | "undoLatestCommit"
  | "revertCommit"
  | "checkoutCommit"
  | "createBranchFromCommit"
  | "mergeBranchIntoCurrent"
  | "rebaseCurrentOnto"
  | "fetchBranch"
  | "fetchRemote"
  | "addRemote"
  | "removeRemote"
  | "createStash"
  | "applyStash"
  | "popStash"
  | "dropStash"
  | "compare";

export const SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS = [
  "commitStaged",
  "pullBranch",
  "pushBranch",
  "deleteBranch",
  "undoLatestCommit",
  "revertCommit",
  "checkoutCommit",
  "createBranchFromCommit",
  "mergeBranchIntoCurrent",
  "rebaseCurrentOnto",
  "fetchBranch",
  "fetchRemote",
  "addRemote",
  "removeRemote",
] as const satisfies readonly SourceControlPanelActionMethodName[];

interface RunOptions {
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly progress?: ExecuteGitProgress;
}
type Run = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: RunOptions,
) => Effect.Effect<string, GitCommandError>;
type TemporaryIndex = <A, E>(
  input: {
    readonly cwd: string;
    readonly paths: readonly string[];
    readonly operations: {
      readonly gitIndexPath: string;
      readonly tempIndexReadTree: string;
      readonly tempIndexIntentToAdd: string;
    };
  },
  use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | GitCommandError | PlatformError.PlatformError>;
type SelectedIndex = <A, E>(
  cwd: string,
  paths: readonly string[],
  use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | GitCommandError>;

export interface SourceControlPanelActionDependencies {
  readonly invalidateRefs: (cwd: string) => Effect.Effect<void>;
  readonly run: Run;
  readonly withTemporaryIntentToAddIndex: TemporaryIndex;
  readonly withTemporarySelectedIndex: SelectedIndex;
  readonly withStashMutation: <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | GitCommandError>;
  readonly generatedCommitMessage: (
    cwd: string,
    paths?: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<string, GitCommandError>;
  readonly generatedStashMessage: (
    cwd: string,
    mode: "all" | "staged" | "unstaged",
    paths: readonly string[],
  ) => Effect.Effect<string, GitCommandError>;
  readonly upstreamForRef: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly refExists: (
    operation: string,
    cwd: string,
    refName: string,
  ) => Effect.Effect<boolean, GitCommandError>;
  readonly workflow: GitWorkflowService["Service"];
}

const COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL =
  "The Git pre-commit hook could not load a required native dependency. Reinstall the repository dependencies and try again.";
const COMMIT_HOOK_FAILURE_DETAIL =
  "The Git pre-commit hook failed. Run the repository pre-commit hook in a terminal for details.";
const STASH_POP_POSITION_CHANGED_DETAIL =
  "The stash changes were applied, but this operation did not drop the stash because its position changed. Refresh Source Control before dropping it; do not apply it again.";
const REVIEW_DIFF_PATCH_ARGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-relative",
  "--unified=3",
  "--inter-hunk-context=0",
] as const;
const REVIEW_DIFF_MINIMAL_PATCH_ARGS = [...REVIEW_DIFF_PATCH_ARGS, "--minimal"] as const;
type CommitFailureHint = "hook-failed" | "native-dependency";

function commitFailureHintFromOutputLine(line: string): CommitFailureHint | null {
  if (
    line.includes("Cannot find native binding") ||
    line.includes("Cannot find module 'vite-plus/binding'") ||
    line.includes('Cannot find module "vite-plus/binding"')
  )
    return "native-dependency";
  return line.includes("VITE+ - pre-commit script failed") ? "hook-failed" : null;
}

function commitFailureDetail(hint: CommitFailureHint | null): string | null {
  return hint === "native-dependency"
    ? COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL
    : hint === "hook-failed"
      ? COMMIT_HOOK_FAILURE_DETAIL
      : null;
}

/**
 * Decides whether a local branch delete must be refused before Git runs, returning the
 * user-facing detail or null. Git's `-d` refuses a branch not merged into its upstream (or
 * HEAD without one), and every delete refuses a branch still checked out in a worktree.
 */
function localBranchDeleteRefusal(input: {
  readonly branchName: string;
  readonly force: boolean;
  readonly merged: boolean;
  readonly checkedOutWorktreePath: string | null;
}): string | null {
  if (input.checkedOutWorktreePath !== null) {
    return `Branch ${input.branchName} is checked out in the worktree at ${input.checkedOutWorktreePath}. Remove that worktree before deleting the branch.`;
  }
  if (!input.force && !input.merged) {
    return `Branch ${input.branchName} has unmerged commits. Force delete it to discard them.`;
  }
  return null;
}

const RECOVERY_COMMAND_PATH_LIMIT = 20;

/** Builds a copyable, POSIX shell-quoted index reset for the first selected paths. */
function selectedIndexRecoveryCommand(paths: readonly string[]): string {
  const quoted = paths
    .slice(0, RECOVERY_COMMAND_PATH_LIMIT)
    .map((path) => `'${path.replaceAll("'", `'\\''`)}'`);
  const remaining = paths.length - quoted.length;
  return `git --literal-pathspecs reset HEAD -- ${quoted.join(" ")}${
    remaining > 0 ? `, then the remaining ${remaining} selected paths the same way` : ""
  }`;
}

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
    cwd,
    command: commandLabel(args),
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

const isGitCommandError = Schema.is(GitCommandError);

function asGitCommandError(operation: string, cwd: string, args: readonly string[]) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : gitError(operation, cwd, args, "Git command failed.", sanitizeErrorCause(cause));
}

function validateGitPositionalName(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: string;
  readonly value: string;
}): Effect.Effect<string, GitCommandError> {
  const value = input.value.trim();
  if (value.length === 0)
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} is required.`),
    );
  if (value.startsWith("-"))
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} cannot start with "-".`),
    );
  return Effect.succeed(value);
}

/** Rejects caller-supplied revisions or remotes that Git would parse as options. */
export function validateGitOperand(operation: string, cwd: string, value: string) {
  return validateGitPositionalName({
    operation,
    cwd,
    args: [],
    kind: "Git revision or remote",
    value,
  });
}

/** NUL-terminated stdin for `--pathspec-from-file=- --pathspec-file-nul`. */
function pathspecStdin(paths: readonly string[]) {
  return `${paths.join("\0")}\0`;
}

function targetRef(target: VcsPanelCompareInput["left"]): string {
  switch (target.kind) {
    case "working-tree":
      return "";
    case "branch":
      return target.refName;
    case "stash":
      return target.refName;
  }
}

function resolveRemoteBranchRef(refName: string, remoteNamesByLength: readonly string[]) {
  return parseRemoteRefWithRemoteNames(refName, remoteNamesByLength);
}

export function makeSourceControlPanelActions(
  deps: SourceControlPanelActionDependencies,
): Pick<SourceControlPanelService["Service"], SourceControlPanelActionMethodName> {
  const {
    generatedCommitMessage,
    generatedStashMessage,
    invalidateRefs,
    refExists,
    run,
    upstreamForRef,
    withTemporaryIntentToAddIndex,
    withTemporarySelectedIndex,
    withStashMutation,
    workflow,
  } = deps;
  const withRefInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => effect.pipe(Effect.ensuring(invalidateRefs(cwd)));
  // Selected path lists travel on stdin, or in bounded argv batches for commands without
  // `--pathspec-from-file`, so large selections stay under the Windows spawn limit.
  const listPathsInBatches = (
    operation: string,
    cwd: string,
    args: readonly string[],
    paths: readonly string[],
    options?: RunOptions,
  ) =>
    Effect.forEach(chunkPathsForArgv(paths), (chunk) =>
      run(operation, cwd, [...args, "--", ...chunk], options).pipe(Effect.map(parseNulPaths)),
    ).pipe(Effect.map((batches) => batches.flat()));
  const cleanPaths = (operation: string, cwd: string, paths: readonly string[]) =>
    Effect.forEach(
      chunkPathsForArgv(paths),
      (chunk) => run(operation, cwd, ["--literal-pathspecs", "clean", "-fd", "--", ...chunk]),
      { discard: true },
    );

  const stageFiles: SourceControlPanelService["Service"]["stageFiles"] = (input) =>
    run(
      "vcs.panel.stageFiles",
      input.cwd,
      ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { stdin: pathspecStdin(input.paths) },
    ).pipe(Effect.asVoid);

  const unstageFiles: SourceControlPanelService["Service"]["unstageFiles"] = (input) =>
    run(
      "vcs.panel.unstageFiles",
      input.cwd,
      ["--literal-pathspecs", "reset", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { stdin: pathspecStdin(input.paths) },
    ).pipe(Effect.asVoid);

  const discardFiles: SourceControlPanelService["Service"]["discardFiles"] = (input) =>
    Effect.gen(function* () {
      const paths = uniquePaths(input.paths);
      if (paths.length === 0) return;
      if (input.staged) {
        const headPathSet = new Set(
          yield* listPathsInBatches(
            "vcs.panel.discardStagedFiles.listHeadPaths",
            input.cwd,
            ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", "HEAD"],
            paths,
            { allowNonZeroExit: true },
          ),
        );
        const pathsInHead = paths.filter((path) => headPathSet.has(path));
        const pathsOutsideHead = paths.filter((path) => !headPathSet.has(path));

        if (pathsInHead.length > 0) {
          yield* run(
            "vcs.panel.discardStagedFiles",
            input.cwd,
            [
              "--literal-pathspecs",
              "restore",
              "--staged",
              "--worktree",
              "--source=HEAD",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            { stdin: pathspecStdin(pathsInHead) },
          ).pipe(Effect.asVoid);
        }
        if (pathsOutsideHead.length > 0) {
          yield* run(
            "vcs.panel.discardStagedFiles.reset",
            input.cwd,
            ["--literal-pathspecs", "reset", "--pathspec-from-file=-", "--pathspec-file-nul"],
            { stdin: pathspecStdin(pathsOutsideHead) },
          ).pipe(Effect.asVoid);
          yield* cleanPaths("vcs.panel.discardStagedFiles.clean", input.cwd, pathsOutsideHead);
        }
        return;
      }

      const trackedPaths = yield* listPathsInBatches(
        "vcs.panel.discardUnstagedFiles.listIndexPaths",
        input.cwd,
        ["--literal-pathspecs", "ls-files", "--cached", "-z"],
        paths,
      );
      if (trackedPaths.length > 0) {
        yield* run(
          "vcs.panel.discardUnstagedFiles",
          input.cwd,
          [
            "--literal-pathspecs",
            "restore",
            "--worktree",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { stdin: pathspecStdin(trackedPaths) },
        ).pipe(Effect.asVoid);
      }
      yield* cleanPaths("vcs.panel.cleanUntrackedFiles", input.cwd, paths);
    });

  const readFileDiff: SourceControlPanelService["Service"]["readFileDiff"] = Effect.fn(
    "readFileDiff",
  )(function* (input) {
    const source = input.source ?? {
      kind: "working-tree" as const,
      staged: input.staged ?? false,
    };
    const diffPaths = uniquePaths(
      input.originalPath ? [input.originalPath, input.path] : [input.path],
    );
    if (source.kind === "commit") {
      yield* validateGitOperand("vcs.panel.readCommitFileDiff", input.cwd, source.sha);
      const patch = yield* run("vcs.panel.readCommitFileDiff", input.cwd, [
        "--literal-pathspecs",
        "show",
        "--format=",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        source.sha,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "compare") {
      yield* validateGitOperand("vcs.panel.readCompareFileDiff", input.cwd, source.baseRef);
      yield* validateGitOperand("vcs.panel.readCompareFileDiff", input.cwd, source.refName);
      const patch = yield* run("vcs.panel.readCompareFileDiff", input.cwd, [
        "--literal-pathspecs",
        "diff",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        `${source.baseRef}...${source.refName}`,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "stash") {
      yield* validateGitOperand("vcs.panel.readStashFileDiff", input.cwd, source.stashRef);
      let patch = yield* run("vcs.panel.readStashFileDiff", input.cwd, [
        "--literal-pathspecs",
        "diff",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        "--find-renames=20%",
        `${source.stashRef}^1`,
        source.stashRef,
        "--",
        ...diffPaths,
      ]);
      if (patch.trim().length === 0) {
        patch = yield* run(
          "vcs.panel.readStashUntrackedFileDiff",
          input.cwd,
          [
            "--literal-pathspecs",
            "show",
            "--format=",
            ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
            `${source.stashRef}^3`,
            "--",
            ...diffPaths,
          ],
          { allowNonZeroExit: true },
        );
      }
      return { path: input.path, staged: false, patch };
    }

    const args = source.staged
      ? [
          "--literal-pathspecs",
          "diff",
          "--cached",
          ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
          "--find-renames=20%",
          "--",
          ...diffPaths,
        ]
      : [
          "--literal-pathspecs",
          "diff",
          ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
          "--find-renames=20%",
          "--",
          ...diffPaths,
        ];
    let patch =
      !source.staged && input.originalPath
        ? yield* withTemporaryIntentToAddIndex(
            {
              cwd: input.cwd,
              paths: [input.path],
              operations: {
                gitIndexPath: "vcs.panel.readFileDiff.gitIndexPath",
                tempIndexReadTree: "vcs.panel.readFileDiff.tempIndexReadTree",
                tempIndexIntentToAdd: "vcs.panel.readFileDiff.tempIndexIntentToAdd",
              },
            },
            (env) => run("vcs.panel.readFileDiff", input.cwd, args, { env }),
          ).pipe(Effect.catch(() => run("vcs.panel.readFileDiff", input.cwd, args)))
        : yield* run("vcs.panel.readFileDiff", input.cwd, args);
    if (!source.staged && !input.originalPath && patch.trim().length === 0) {
      const untrackedPaths = yield* run("vcs.panel.readFileDiff.untrackedPaths", input.cwd, [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        input.path,
      ]);
      if (untrackedPaths.split("\0").includes(input.path)) {
        patch = yield* run(
          "vcs.panel.readUntrackedFileDiff",
          input.cwd,
          ["diff", "--no-index", ...REVIEW_DIFF_PATCH_ARGS, "--", "/dev/null", input.path],
          { allowNonZeroExit: true },
        );
      }
    }
    return { path: input.path, staged: source.staged, patch };
  });

  const pushBranchDirect = Effect.fn("pushBranchDirect")(function* (
    cwd: string,
    rawBranchName: string,
    force: boolean,
    rawPublishRemoteName?: string,
    expectedRemoteSha?: string,
  ) {
    const branchName = yield* validateGitOperand("vcs.panel.pushBranch", cwd, rawBranchName);
    const publishRemoteName =
      rawPublishRemoteName === undefined
        ? undefined
        : yield* validateGitOperand("vcs.panel.pushBranch", cwd, rawPublishRemoteName);
    // Read the configured upstream remote rather than splitting its short name, so a branch
    // tracking a local branch (remote ".") or a remote-looking local name publishes to origin.
    const upstream = publishRemoteName
      ? undefined
      : (yield* run("vcs.panel.pushBranch.upstream", cwd, [
          "for-each-ref",
          "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${branchName}`,
        ]))
          .split(/\r?\n/u)
          .map((line) => line.split("\0"))
          .find(([refName]) => refName === `refs/heads/${branchName}`);
    const [, upstreamRemoteName = "", upstreamRemoteRef = ""] = upstream ?? [];
    const remoteNames =
      upstreamRemoteName.length > 0 && upstreamRemoteName !== "."
        ? yield* run("vcs.panel.pushBranch.remotes", cwd, ["remote"]).pipe(
            Effect.map(parseRemoteNames),
            Effect.orElseSucceed((): readonly string[] => []),
          )
        : [];
    const hasSameNameUpstream =
      remoteNames.includes(upstreamRemoteName) && upstreamRemoteRef === `refs/heads/${branchName}`;
    const remoteName = publishRemoteName ?? (hasSameNameUpstream ? upstreamRemoteName : "origin");
    // A forced push replaces only the remote tip the user saw when confirming the overwrite.
    // Without that observation (older clients), background fetches keep the remote-tracking
    // ref current, so a bare lease alone would not protect remote commits the local branch
    // never integrated.
    const lease = !force
      ? []
      : expectedRemoteSha
        ? [`--force-with-lease=refs/heads/${branchName}:${expectedRemoteSha}`]
        : ["--force-with-lease", "--force-if-includes"];
    yield* run("vcs.panel.pushBranch", cwd, [
      "push",
      ...lease,
      "-u",
      remoteName,
      `refs/heads/${branchName}:refs/heads/${branchName}`,
    ]).pipe(Effect.asVoid);
  });

  const runCommit = Effect.fn("runCommit")(function* (
    cwd: string,
    message: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const args = ["commit", "-m", message] as const;
    let failureHint: CommitFailureHint | null = null;
    const recordFailureHint = (line: string) =>
      Effect.sync(() => {
        const nextHint = commitFailureHintFromOutputLine(line);
        if (nextHint !== null && (nextHint === "native-dependency" || failureHint === null)) {
          failureHint = nextHint;
        }
      });

    yield* run("vcs.panel.commitStaged", cwd, args, {
      ...(env === undefined ? {} : { env }),
      progress: {
        onStdoutLine: recordFailureHint,
        onStderrLine: recordFailureHint,
      },
    }).pipe(
      Effect.mapError((error) => {
        const detail = commitFailureDetail(failureHint);
        return detail === null
          ? error
          : gitError("vcs.panel.commitStaged", cwd, args, detail, error);
      }),
      Effect.asVoid,
    );
  });

  const commitStaged: SourceControlPanelService["Service"]["commitStaged"] = Effect.fn(
    "commitStaged",
  )(function* (input) {
    const paths = uniquePaths(input.paths ?? []);
    if (paths.length > 0) {
      yield* withTemporarySelectedIndex(input.cwd, paths, (env) =>
        Effect.gen(function* () {
          // The temporary index already contains only the selected changes.
          const message =
            input.message?.trim() || (yield* generatedCommitMessage(input.cwd, undefined, env));
          yield* runCommit(input.cwd, message, env).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.gen(function* () {
                    // Reconcile before temporary-index cleanup can deliver pending cancellation.
                    const indexSyncExit = yield* Effect.exit(
                      run(
                        "vcs.panel.commitStaged.syncIndex",
                        input.cwd,
                        [
                          "--literal-pathspecs",
                          "reset",
                          "HEAD",
                          "--pathspec-from-file=-",
                          "--pathspec-file-nul",
                        ],
                        { stdin: `${paths.join("\0")}\0` },
                      ),
                    );
                    if (Exit.isFailure(indexSyncExit)) {
                      return yield* gitError(
                        "vcs.panel.commitStaged.syncIndex",
                        input.cwd,
                        [
                          "--literal-pathspecs",
                          "reset",
                          "HEAD",
                          "--pathspec-from-file=-",
                          "--pathspec-file-nul",
                        ],
                        `The commit was already created but was not pushed. Do not commit these changes again. Reconcile the index by resetting only the selected paths: ${selectedIndexRecoveryCommand(paths)}. Then push the existing commit if needed.`,
                        sanitizeErrorCause(indexSyncExit.cause),
                      );
                    }
                  })
                : Effect.void,
            ),
          );
        }),
      );
    } else {
      const message = input.message?.trim() || (yield* generatedCommitMessage(input.cwd));
      yield* runCommit(input.cwd, message);
    }
    if (input.push) {
      const status = yield* workflow
        .status({ cwd: input.cwd }, { includePullRequest: false })
        .pipe(
          Effect.mapError(
            asGitCommandError("vcs.panel.commitStaged.status", input.cwd, ["status"]),
          ),
        );
      if (!status.refName) {
        return yield* gitError(
          "vcs.panel.commitStaged.push",
          input.cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }
      yield* pushBranchDirect(input.cwd, status.refName, false);
    }
  });

  const pullBranch: SourceControlPanelService["Service"]["pullBranch"] = Effect.fn("pullBranch")(
    function* (input) {
      yield* validateGitOperand("vcs.panel.pullBranch", input.cwd, input.branchName);
      const status = yield* workflow
        .status({ cwd: input.cwd }, { includePullRequest: false })
        .pipe(
          Effect.mapError(asGitCommandError("vcs.panel.pullBranch.status", input.cwd, ["status"])),
        );
      if (status.refName !== input.branchName) {
        if (input.merge) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull", "--no-rebase"],
            "Merge sync is only available for the current branch.",
          );
        }
        const upstream = yield* upstreamForRef(input.cwd, input.branchName);
        if (!upstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has no upstream.`,
          );
        }
        const remoteOutput = yield* run("vcs.panel.pullBranch.remotes", input.cwd, ["remote"]);
        const resolvedUpstream = resolveRemoteBranchRef(upstream, parseRemoteNames(remoteOutput));
        if (!resolvedUpstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has invalid upstream ${upstream}.`,
          );
        }
        yield* run(
          "vcs.panel.pullBranch.nonCurrent",
          input.cwd,
          [
            "fetch",
            resolvedUpstream.remoteName,
            `${input.force ? "+" : ""}refs/heads/${resolvedUpstream.branchName}:refs/heads/${input.branchName}`,
          ],
          { env: STATUS_UPSTREAM_REFRESH_ENV },
        ).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.force) {
        yield* run("vcs.panel.forcePullBranch", input.cwd, ["fetch"], {
          env: STATUS_UPSTREAM_REFRESH_ENV,
        });
        const upstream = yield* run("vcs.panel.forcePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.forcePullBranch.reset", input.cwd, [
          "reset",
          "--hard",
          upstream,
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.merge) {
        const upstream = yield* run("vcs.panel.mergePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.mergePullBranch", input.cwd, [
          "pull",
          "--no-rebase",
          "--no-edit",
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      return yield* workflow.pullCurrentBranch(input.cwd);
    },
  );

  const pushBranch: SourceControlPanelService["Service"]["pushBranch"] = Effect.fn("pushBranch")(
    function* (input) {
      yield* pushBranchDirect(
        input.cwd,
        input.branchName,
        input.force ?? false,
        input.remoteName,
        input.expectedRemoteSha,
      );
    },
  );

  const fetchBranch: SourceControlPanelService["Service"]["fetchBranch"] = Effect.fn("fetchBranch")(
    function* (input) {
      yield* validateGitOperand("vcs.panel.fetchBranch", input.cwd, input.branchName);
      const remoteOutput = yield* run("vcs.panel.fetchBranch.remotes", input.cwd, ["remote"]);
      const gitOrderRemoteNames = parseRemoteNamesInGitOrder(remoteOutput);
      const sortedRemoteNames = parseRemoteNames(remoteOutput);
      // Local branches intentionally win over same-named remote refs.
      const isLocalBranch = yield* refExists(
        "vcs.panel.fetchBranch.localBranch",
        input.cwd,
        `refs/heads/${input.branchName}`,
      );
      const parsedRemoteBranch = isLocalBranch
        ? null
        : parseRemoteRefWithRemoteNames(input.branchName, sortedRemoteNames);
      const isRemoteBranch = parsedRemoteBranch
        ? yield* refExists(
            "vcs.panel.fetchBranch.remoteBranch",
            input.cwd,
            `refs/remotes/${parsedRemoteBranch.remoteRef}`,
          )
        : false;
      const upstream =
        isRemoteBranch && parsedRemoteBranch
          ? parsedRemoteBranch.remoteRef
          : yield* upstreamForRef(input.cwd, input.branchName);
      const resolvedUpstream = upstream
        ? resolveRemoteBranchRef(upstream, sortedRemoteNames)
        : null;
      if (upstream && !resolvedUpstream) {
        return yield* gitError(
          "vcs.panel.fetchBranch",
          input.cwd,
          ["fetch"],
          `Branch ${input.branchName} has invalid upstream ${upstream}.`,
        );
      }
      const remoteName = resolvedUpstream?.remoteName ?? gitOrderRemoteNames[0] ?? "origin";
      const remoteBranchName = resolvedUpstream?.branchName ?? input.branchName;
      yield* run(
        "vcs.panel.fetchBranch",
        input.cwd,
        [
          "fetch",
          remoteName,
          `refs/heads/${remoteBranchName}:refs/remotes/${remoteName}/${remoteBranchName}`,
        ],
        { env: STATUS_UPSTREAM_REFRESH_ENV },
      ).pipe(Effect.asVoid);
    },
  );

  const deleteBranch: SourceControlPanelService["Service"]["deleteBranch"] = Effect.fn(
    "deleteBranch",
  )(function* (input) {
    const notFound = gitError(
      "vcs.panel.deleteBranch",
      input.cwd,
      ["branch", input.force ? "-D" : "-d", input.branchName],
      `Branch ${input.branchName} was not found.`,
    );
    if (input.remoteName !== undefined) {
      const remoteName = input.remoteName;
      const remoteBranchName = input.branchName.startsWith(`${remoteName}/`)
        ? input.branchName.slice(remoteName.length + 1)
        : "";
      if (remoteBranchName.length === 0 || remoteBranchName === "HEAD") return yield* notFound;
      const [remoteNames, remoteBranchExists] = yield* Effect.all(
        [
          run("vcs.panel.deleteBranch.remotes", input.cwd, ["remote"]).pipe(
            Effect.map(parseRemoteNames),
          ),
          refExists(
            "vcs.panel.deleteBranch.remoteBranch",
            input.cwd,
            `refs/remotes/${input.branchName}`,
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (!remoteNames.includes(remoteName) || !remoteBranchExists) return yield* notFound;
      yield* run("vcs.panel.deleteRemoteBranch", input.cwd, [
        "push",
        remoteName,
        "--delete",
        remoteBranchName,
      ]).pipe(Effect.asVoid);
      return;
    }
    const [localBranchExists, currentBranch] = yield* Effect.all(
      [
        refExists(
          "vcs.panel.deleteBranch.localBranch",
          input.cwd,
          `refs/heads/${input.branchName}`,
        ),
        run("vcs.panel.deleteBranch.currentBranch", input.cwd, ["branch", "--show-current"]).pipe(
          Effect.map((branch) => branch.trim()),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (!localBranchExists) return yield* notFound;
    if (currentBranch === input.branchName) {
      return yield* gitError(
        "vcs.panel.deleteBranch",
        input.cwd,
        ["branch", "-d", input.branchName],
        "Cannot delete the current branch.",
      );
    }
    const force = input.force === true;
    // A worktree whose directory was deleted without `git worktree remove` still owns the
    // branch, so prune Git's stale registration before deciding; any other registration refuses.
    const registrations = parseWorktreeBranchEntries(
      yield* run(
        "vcs.panel.deleteBranch.worktrees",
        input.cwd,
        ["worktree", "list", "--porcelain"],
        {
          allowNonZeroExit: true,
        },
      ),
    ).filter((entry) => entry.branchName === input.branchName);
    if (registrations.some((entry) => entry.prunable)) {
      yield* workflow.pruneWorktrees({ cwd: input.cwd });
    }
    // Git's `-d` compares with the upstream when it resolves, otherwise with HEAD.
    const merged =
      force ||
      (yield* run("vcs.panel.deleteBranch.merged", input.cwd, [
        "for-each-ref",
        `--merged=${(yield* upstreamForRef(input.cwd, input.branchName)) ?? "HEAD"}`,
        "--format=%(refname)",
        `refs/heads/${input.branchName}`,
      ])).trim().length > 0;
    const refusal = localBranchDeleteRefusal({
      branchName: input.branchName,
      force,
      merged,
      checkedOutWorktreePath: registrations.find((entry) => !entry.prunable)?.worktreePath ?? null,
    });
    if (refusal !== null) {
      return yield* gitError(
        "vcs.panel.deleteBranch",
        input.cwd,
        ["branch", force ? "-D" : "-d", input.branchName],
        refusal,
      );
    }
    yield* workflow.deleteLocalBranch({ cwd: input.cwd, refName: input.branchName, force });
  });

  const undoLatestCommit: SourceControlPanelService["Service"]["undoLatestCommit"] = Effect.fn(
    "undoLatestCommit",
  )(function* (input) {
    if (input.sha !== undefined)
      yield* validateGitOperand("vcs.panel.undoLatestCommit", input.cwd, input.sha);
    if (input.branchName !== undefined)
      yield* validateGitOperand("vcs.panel.undoLatestCommit", input.cwd, input.branchName);
    const currentBranch = yield* run("vcs.panel.currentBranch", input.cwd, [
      "branch",
      "--show-current",
    ]).pipe(Effect.map((branch) => branch.trim()));
    const targetBranch = input.branchName ?? currentBranch;
    const resetTarget = input.sha ? `${input.sha}^` : `${targetBranch || "HEAD"}~1`;

    if (!targetBranch || targetBranch === currentBranch) {
      yield* run("vcs.panel.undoLatestCommit", input.cwd, ["reset", "--soft", resetTarget]).pipe(
        Effect.asVoid,
      );
      return;
    }

    yield* run("vcs.panel.undoBranchCommit", input.cwd, [
      "branch",
      "-f",
      targetBranch,
      resetTarget,
    ]).pipe(Effect.asVoid);
  });

  const revertCommit: SourceControlPanelService["Service"]["revertCommit"] = Effect.fn(
    "revertCommit",
  )(function* (input) {
    yield* validateGitOperand("vcs.panel.revertCommit", input.cwd, input.sha);
    yield* run("vcs.panel.revertCommit", input.cwd, ["revert", "--no-edit", input.sha]).pipe(
      Effect.asVoid,
    );
  });

  const checkoutCommit: SourceControlPanelService["Service"]["checkoutCommit"] = Effect.fn(
    "checkoutCommit",
  )(function* (input) {
    yield* validateGitOperand("vcs.panel.checkoutCommit", input.cwd, input.sha);
    yield* run("vcs.panel.checkoutCommit", input.cwd, ["checkout", "--detach", input.sha]).pipe(
      Effect.asVoid,
    );
    return { refName: input.sha };
  });

  const createBranchFromCommit: SourceControlPanelService["Service"]["createBranchFromCommit"] =
    Effect.fn("createBranchFromCommit")(function* (input) {
      const branchName = yield* validateGitPositionalName({
        operation: "vcs.panel.createBranchFromCommit",
        cwd: input.cwd,
        args: ["branch", "<name>", input.sha],
        kind: "Branch name",
        value: input.branchName ?? "",
      });
      yield* withRefInvalidation(
        input.cwd,
        run("vcs.panel.createBranchFromCommit", input.cwd, [
          "branch",
          "--",
          branchName,
          input.sha,
        ]).pipe(Effect.asVoid),
      );
      return { refName: branchName };
    });

  const mergeBranchIntoCurrent: SourceControlPanelService["Service"]["mergeBranchIntoCurrent"] = (
    input,
  ) =>
    run("vcs.panel.mergeBranchIntoCurrent", input.cwd, [
      "merge",
      "--no-edit",
      "--",
      input.refName,
    ]).pipe(Effect.asVoid);

  const rebaseCurrentOnto: SourceControlPanelService["Service"]["rebaseCurrentOnto"] = (input) =>
    run("vcs.panel.rebaseCurrentOnto", input.cwd, ["rebase", "--", input.refName]).pipe(
      Effect.asVoid,
    );

  const refAffectingActions = {
    commitStaged: (input) => withRefInvalidation(input.cwd, commitStaged(input)),
    pullBranch: (input) => withRefInvalidation(input.cwd, pullBranch(input)),
    pushBranch: (input) => withRefInvalidation(input.cwd, pushBranch(input)),
    deleteBranch: (input) => withRefInvalidation(input.cwd, deleteBranch(input)),
    undoLatestCommit: (input) => withRefInvalidation(input.cwd, undoLatestCommit(input)),
    revertCommit: (input) => withRefInvalidation(input.cwd, revertCommit(input)),
    checkoutCommit: (input) => withRefInvalidation(input.cwd, checkoutCommit(input)),
    createBranchFromCommit,
    mergeBranchIntoCurrent: (input) =>
      withRefInvalidation(input.cwd, mergeBranchIntoCurrent(input)),
    rebaseCurrentOnto: (input) => withRefInvalidation(input.cwd, rebaseCurrentOnto(input)),
    fetchBranch: (input) => withRefInvalidation(input.cwd, fetchBranch(input)),
    fetchRemote: (input) =>
      withRefInvalidation(
        input.cwd,
        validateGitOperand("vcs.panel.fetchRemote", input.cwd, input.remoteName).pipe(
          Effect.flatMap((remoteName) =>
            run("vcs.panel.fetchRemote", input.cwd, ["fetch", remoteName], {
              env: STATUS_UPSTREAM_REFRESH_ENV,
            }),
          ),
          Effect.asVoid,
        ),
      ),
    addRemote: Effect.fn("addRemote")(function* (input) {
      const remoteName = yield* validateGitPositionalName({
        operation: "vcs.panel.addRemote",
        cwd: input.cwd,
        args: ["remote", "add", "<name>", input.url],
        kind: "Remote name",
        value: input.name,
      });
      yield* withRefInvalidation(
        input.cwd,
        // `--` keeps a URL that starts with "-" from being parsed as an option.
        run("vcs.panel.addRemote", input.cwd, ["remote", "add", "--", remoteName, input.url]).pipe(
          Effect.asVoid,
        ),
      );
    }),
    removeRemote: Effect.fn("removeRemote")(function* (input) {
      const remoteName = yield* validateGitPositionalName({
        operation: "vcs.panel.removeRemote",
        cwd: input.cwd,
        args: ["remote", "remove", "<name>"],
        kind: "Remote name",
        value: input.remoteName,
      });
      yield* withRefInvalidation(
        input.cwd,
        run("vcs.panel.removeRemote", input.cwd, ["remote", "remove", remoteName]).pipe(
          Effect.asVoid,
        ),
      );
    }),
  } satisfies Pick<
    SourceControlPanelService["Service"],
    (typeof SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS)[number]
  >;

  const mutateStash = Effect.fn("mutateStash")(function* (
    action: "apply" | "pop" | "drop",
    input: VcsPanelStashInput,
  ) {
    const operation = `vcs.panel.${action}Stash`;
    const stashRef = yield* validateGitOperand(operation, input.cwd, input.stashRef ?? "stash@{0}");
    yield* withStashMutation(
      input.cwd,
      Effect.gen(function* () {
        if (!input.expectedSha) {
          yield* run(operation, input.cwd, ["stash", action, stashRef]);
          return;
        }
        const verify = Effect.fnUntraced(function* (applied = false) {
          const sha = (yield* run(
            operation,
            input.cwd,
            ["rev-parse", "--verify", `${stashRef}^{commit}`],
            { allowNonZeroExit: true },
          )).trim();
          if (sha.toLowerCase() !== input.expectedSha?.toLowerCase()) {
            return yield* gitError(
              operation,
              input.cwd,
              ["stash", action, stashRef],
              applied
                ? STASH_POP_POSITION_CHANGED_DETAIL
                : "The selected stash has changed. Refresh Source Control and select the stash again.",
            );
          }
          return sha;
        });
        const sha = yield* verify();
        if (action === "apply" || action === "pop") {
          yield* run(operation, input.cwd, ["stash", "apply", sha]);
        }
        if (action === "apply") return;
        const verifyAndDrop = Effect.gen(function* () {
          if (action === "pop") yield* verify(true);
          yield* run(operation, input.cwd, ["stash", "drop", stashRef]);
        });
        if (action === "drop") return yield* verifyAndDrop;
        // The working tree already holds the stash changes, so any later failure must warn
        // against applying the still-listed stash again.
        yield* verifyAndDrop.pipe(
          Effect.mapError((error) =>
            error.detail === STASH_POP_POSITION_CHANGED_DETAIL
              ? error
              : gitError(
                  operation,
                  input.cwd,
                  ["stash", "drop", stashRef],
                  "The stash changes were applied, but this operation could not drop the stash. Refresh Source Control before dropping it; do not apply it again.",
                  sanitizeErrorCause(error),
                ),
          ),
        );
      }),
    );
  });

  return {
    stageFiles,
    unstageFiles,
    discardFiles,
    readFileDiff,
    ...refAffectingActions,
    createStash: (input) => {
      const mode = input.mode ?? "all";
      const modeArgs =
        mode === "staged"
          ? ["--staged"]
          : mode === "unstaged" || input.includeUntracked
            ? ["--include-untracked", ...(mode === "unstaged" ? ["--keep-index"] : [])]
            : [];
      return Effect.gen(function* () {
        const paths = input.paths ?? [];
        const message =
          input.message?.trim() || (yield* generatedStashMessage(input.cwd, mode, paths));
        yield* run(
          "vcs.panel.createStash",
          input.cwd,
          [
            ...(paths.length > 0 ? ["--literal-pathspecs"] : []),
            "stash",
            "push",
            ...modeArgs,
            "-m",
            message,
            ...(paths.length > 0 ? ["--pathspec-from-file=-", "--pathspec-file-nul"] : []),
          ],
          paths.length > 0 ? { stdin: pathspecStdin(paths) } : undefined,
        ).pipe(Effect.asVoid, (effect) => withStashMutation(input.cwd, effect));
      });
    },
    applyStash: (input) => mutateStash("apply", input),
    popStash: (input) => mutateStash("pop", input),
    dropStash: (input) => mutateStash("drop", input),
    compare: Effect.fn("compare")(function* (input) {
      const left = targetRef(input.left);
      const right = targetRef(input.right);
      if (input.left.kind !== "working-tree")
        yield* validateGitOperand("vcs.panel.compare", input.cwd, left);
      if (input.right.kind !== "working-tree")
        yield* validateGitOperand("vcs.panel.compare", input.cwd, right);
      const range = left && right ? `${left}..${right}` : left || right;
      const reverse = input.left.kind === "working-tree" && input.right.kind !== "working-tree";
      const args = range
        ? ["diff", ...REVIEW_DIFF_MINIMAL_PATCH_ARGS, ...(reverse ? ["-R"] : []), range]
        : ["diff", ...REVIEW_DIFF_PATCH_ARGS];
      return yield* run("vcs.panel.compare", input.cwd, args).pipe(
        Effect.map((patch): VcsPanelCompareResult => ({ patch })),
      );
    }),
  };
}

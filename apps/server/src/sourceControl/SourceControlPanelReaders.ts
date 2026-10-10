import * as Effect from "effect/Effect";
import {
  GitCommandError,
  TextGenerationError,
  type ProjectId,
  type VcsPanelActionableForkBranch,
  type VcsPanelBranchCommitsInput,
  type VcsPanelBranchCommitsResult,
  type VcsPanelBranchDetails,
  type VcsPanelChangeGroup,
  type VcsPanelSnapshotResult,
  type VcsPanelRemote,
  type VcsPanelStashDetails,
  type VcsRef,
  type ServerProvider,
  type SourceControlProviderError,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import type { GitManager, GitBranchPullRequest } from "../git/GitManager.ts";
import * as SharedServerSettings from "@t3tools/shared/serverSettings";

import type { ProjectStoreV2Error } from "../orchestration-v2/ProjectStore.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { SourceControlWritingPolicyResolver } from "../textGeneration/SourceControlWriting.ts";
import type { ExecuteGitProgress } from "../vcs/GitVcsDriver.ts";
import type { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  parseAheadBehindCounts,
  branchActivityTime,
  chunkPathsForArgv,
  parseCommits,
  parseCommitsWithStats,
  parseCreatedFromRef,
  parseFileChangesFromNumstat,
  parseNameStatus,
  parseRemoteVerbose,
  providerContextForRemote,
} from "./SourceControlPanelParsers.ts";
import {
  fileChangesRelativeToCwd,
  parseNumstat,
  parsePorcelainStatus,
} from "./SourceControlPanelStatusParsers.ts";
import { validateGitOperand } from "./SourceControlPanelActions.ts";

type ConfiguredSourceControlProviderKind = Exclude<SourceControlProviderKind, "unknown">;

function isConfiguredSourceControlProviderKind(
  kind: SourceControlProviderKind,
): kind is ConfiguredSourceControlProviderKind {
  return kind !== "unknown";
}

const STASH_MESSAGE_SUMMARY_BUDGET = 8_000;
const STASH_MESSAGE_PATCH_BUDGET = 50_000;

type Run = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: {
    readonly allowNonZeroExit?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly progress?: ExecuteGitProgress;
  },
) => Effect.Effect<string, GitCommandError>;

export interface SourceControlPanelReaderDependencies {
  readonly run: Run;
  readonly branchPullRequest: GitManager["Service"]["branchPullRequest"];
  readonly serverSettings: ServerSettingsService["Service"];
  readonly sourceControlProviders: SourceControlProviderRegistry["Service"] | undefined;
  readonly sourceControlRateLimits:
    | SourceControlRateLimit.SourceControlRateLimit["Service"]
    | undefined;
  readonly textGeneration: TextGeneration["Service"] | undefined;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly projectIdForWorkspace?: (
    cwd: string,
  ) => Effect.Effect<ProjectId | null, ProjectStoreV2Error>;
  readonly resolveWritingPolicy: SourceControlWritingPolicyResolver;
}

export function makeSourceControlPanelReaders(deps: SourceControlPanelReaderDependencies) {
  const {
    run,
    serverSettings,
    sourceControlProviders,
    sourceControlRateLimits,
    textGeneration,
    getProviders,
    resolveWritingPolicy,
  } = deps;
  const COMMIT_PAGE_SIZE = 10;

  // Caller-supplied refs reach Git as positional revisions, where a leading "-" is an option.
  const validateRevisionOperands = (
    operation: string,
    cwd: string,
    refs: ReadonlyArray<string | null | undefined>,
  ) =>
    Effect.forEach(
      refs.filter((ref): ref is string => typeof ref === "string"),
      (ref) => validateGitOperand(operation, cwd, ref),
      { discard: true },
    );

  // A registered linked worktree owns its settings; otherwise use the main checkout's project.
  const writingSettingsFor = Effect.fn("SourceControlPanelReaders.writingSettingsFor")(function* (
    cwd: string,
  ) {
    const settings = yield* serverSettings.getSettings;
    const lookup = deps.projectIdForWorkspace;
    if (!lookup || !hasProjectSettingsOverrides(settings)) return settings;
    const projectId = yield* Effect.gen(function* () {
      const direct = yield* lookup(cwd);
      if (direct !== null) return direct;
      const root = (yield* run("vcs.panel.writingWorkspaceRoot", cwd, [
        "rev-parse",
        "--show-toplevel",
      ])).trim();
      if (root && root !== cwd) {
        const project = yield* lookup(root);
        if (project !== null) return project;
      }
      const worktrees = yield* run("vcs.panel.writingWorktrees", cwd, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      const first = worktrees.split("\0")[0];
      const mainRoot = first?.startsWith("worktree ") ? first.slice(9) : null;
      return mainRoot && mainRoot !== cwd && mainRoot !== root ? yield* lookup(mainRoot) : null;
    }).pipe(Effect.orElseSucceed(() => null));
    return resolveProjectSettings(settings, projectId).settings;
  });

  const protectProviderRequest = <A>(
    context: SourceControlProvider.SourceControlProviderContext,
    effect: Effect.Effect<A, SourceControlProviderError>,
  ) =>
    sourceControlRateLimits === undefined
      ? effect
      : SourceControlRateLimit.protectProviderRequest({
          limits: sourceControlRateLimits,
          provider: context.provider.kind,
          baseUrl: context.provider.baseUrl,
          effect,
        });

  // Git reports commit, stash, and comparison paths from the repository root; the panel keys
  // every file by its cwd-relative path, like working-tree status.
  const workingTreePrefix = (cwd: string) =>
    run("vcs.panel.workingTreePrefix", cwd, ["rev-parse", "--show-prefix"]).pipe(
      Effect.map((output) => output.replace(/\r?\n$/u, "")),
    );

  const readWorkingTreeChangeGroups = (
    cwd: string,
  ): Effect.Effect<
    {
      readonly porcelain: string;
      readonly unstagedNumstat: string;
      readonly prefix: string;
      readonly changeGroups: VcsPanelChangeGroup[];
    },
    GitCommandError
  > =>
    Effect.all(
      [
        run("vcs.panel.statusPorcelain", cwd, [
          "-c",
          "status.relativePaths=true",
          "status",
          "--porcelain=2",
          "--branch",
          "-uall",
        ]),
        run("vcs.panel.unstagedNumstat", cwd, [
          "diff",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.stagedNumstat", cwd, [
          "diff",
          "--cached",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames=20%",
        ]),
        run("vcs.panel.stagedNameStatus", cwd, [
          "diff",
          "--cached",
          "--no-relative",
          "--name-status",
          "-z",
          "--find-renames=20%",
        ]),
        workingTreePrefix(cwd),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([porcelain, unstagedNumstat, stagedNumstat, stagedNameStatus, prefix]) => {
        const stagedFiles = fileChangesRelativeToCwd(
          parseFileChangesFromNumstat({
            numstat: stagedNumstat,
            statuses: parseNameStatus(stagedNameStatus),
          }),
          prefix,
        );
        return {
          porcelain,
          unstagedNumstat,
          prefix,
          changeGroups: parsePorcelainStatus({
            status: porcelain,
            stagedFiles,
            stagedStats: parseNumstat(stagedNumstat, prefix),
            unstagedStats: parseNumstat(unstagedNumstat, prefix),
            untrackedStats: new Map(),
          }),
        };
      }),
    );

  const changeGroupsHaveFiles = (groups: readonly VcsPanelChangeGroup[]) =>
    groups.some((group) => group.files.length > 0);

  const commitFilesRelativeTo = (cwd: string, sha: string, prefix: string) =>
    Effect.all(
      [
        run("vcs.panel.commitNumstat", cwd, [
          "show",
          "--format=",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames",
          sha,
        ]),
        run("vcs.panel.commitNameStatus", cwd, [
          "show",
          "--format=",
          "--no-relative",
          "--name-status",
          "-z",
          "--find-renames",
          sha,
        ]),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus]) =>
        fileChangesRelativeToCwd(
          parseFileChangesFromNumstat({
            numstat,
            statuses: parseNameStatus(nameStatus),
          }),
          prefix,
        ),
      ),
    );

  const commitFiles = (cwd: string, sha: string) =>
    workingTreePrefix(cwd).pipe(
      Effect.flatMap((prefix) => commitFilesRelativeTo(cwd, sha, prefix)),
    );

  type CommitRefs = { readonly headRefs: readonly string[]; readonly tags: readonly string[] };

  // Branch, remote-branch, and tag decorations for every commit a ref points at.
  const readCommitRefs = (cwd: string) =>
    run("vcs.panel.commitRefs", cwd, [
      "for-each-ref",
      "--format=%(objectname)%09%(*objectname)%09%(refname:short)%09%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]).pipe(
      Effect.map((output) => {
        const refs = new Map<string, CommitRefs>();
        for (const line of output.split(/\r?\n/u)) {
          const [objectName, peeledObjectName, shortRefName, fullRefName] = line.split("\t");
          const sha = peeledObjectName || objectName;
          if (!sha || !shortRefName || !fullRefName) continue;
          if (shortRefName.endsWith("/HEAD") || shortRefName.includes(" -> ")) continue;
          if (fullRefName.startsWith("refs/remotes/") && !shortRefName.includes("/")) continue;

          const current = refs.get(sha) ?? { headRefs: [], tags: [] };
          if (fullRefName.startsWith("refs/tags/")) {
            refs.set(sha, {
              headRefs: current.headRefs,
              tags: [...current.tags, shortRefName].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            });
            continue;
          }
          refs.set(sha, {
            headRefs: [...current.headRefs, shortRefName].toSorted((left, right) =>
              left.localeCompare(right),
            ),
            tags: current.tags,
          });
        }
        return refs;
      }),
      Effect.orElseSucceed(() => new Map<string, CommitRefs>()),
    );

  const commitAvatarProviderContexts = (
    cwd: string,
  ): Effect.Effect<ReadonlyArray<SourceControlProvider.SourceControlProviderContext>> =>
    Effect.gen(function* () {
      if (!sourceControlProviders) return [];
      const providerSettings = (yield* serverSettings.getSettings).sourceControl.providers;
      // Avatars are opt-in per provider; skip reading remotes when no provider wants them.
      if (!Object.values(providerSettings).some((provider) => provider.showCommitAuthorAvatar)) {
        return [];
      }
      const remotes = yield* run("vcs.panel.commitAvatarRemotes", cwd, ["remote", "-v"]);
      return parseRemoteVerbose(remotes)
        .map(providerContextForRemote)
        .filter(
          (context): context is SourceControlProvider.SourceControlProviderContext =>
            context !== null,
        )
        .filter(
          (context) =>
            isConfiguredSourceControlProviderKind(context.provider.kind) &&
            context.provider.kind !== "forgejo" &&
            context.provider.kind !== "gitcafe" &&
            providerSettings[context.provider.kind]?.showCommitAuthorAvatar === true,
        );
    }).pipe(Effect.orElseSucceed(() => []));

  /**
   * Memoized reads shared by every commit list in one response, so a branch expansion reads
   * remotes and refs once instead of once per commit range.
   */
  const commitDecorationReads = (cwd: string) =>
    Effect.all({
      avatarContexts: Effect.cached(commitAvatarProviderContexts(cwd)),
      refsBySha: Effect.cached(readCommitRefs(cwd)),
    });
  type CommitDecorationReads = Effect.Success<ReturnType<typeof commitDecorationReads>>;

  const providerAvatarUrlForCommit = (
    cwd: string,
    registry: SourceControlProviderRegistry["Service"],
    contexts: ReadonlyArray<SourceControlProvider.SourceControlProviderContext>,
    commit: VcsPanelSnapshotResult["recentCommits"][number],
  ) =>
    Effect.gen(function* () {
      for (const context of contexts) {
        const provider = yield* registry
          .get(context.provider.kind)
          .pipe(Effect.orElseSucceed(() => null));
        if (!provider) continue;
        const avatarUrl = yield* protectProviderRequest(
          context,
          provider.getCommitAvatarUrl({
            cwd,
            context,
            sha: commit.sha,
            authorEmail: commit.authorEmail,
          }),
        ).pipe(Effect.orElseSucceed(() => null));
        if (avatarUrl) return avatarUrl;
      }
      return null;
    });

  const withCommitAvatars = (
    cwd: string,
    commits: VcsPanelSnapshotResult["recentCommits"],
    avatarContexts: CommitDecorationReads["avatarContexts"],
  ) => {
    if (commits.length === 0 || !sourceControlProviders) {
      return Effect.succeed(commits);
    }

    const registry = sourceControlProviders;
    return avatarContexts.pipe(
      Effect.flatMap((contexts) => {
        if (contexts.length === 0) {
          return Effect.succeed(commits);
        }

        // Required and intended behavior: commit rows should show the source-control
        // provider account avatar image when the provider exposes one. `null` is only
        // the initials fallback path; do not replace this with generated avatars.
        return Effect.forEach(
          commits,
          (commit) =>
            providerAvatarUrlForCommit(cwd, registry, contexts, commit).pipe(
              Effect.map((authorAvatarUrl) =>
                authorAvatarUrl ? { ...commit, authorAvatarUrl } : commit,
              ),
            ),
          { concurrency: 4 },
        );
      }),
      Effect.orElseSucceed(() => commits),
    );
  };

  const withCommitDetails = (
    cwd: string,
    commits: VcsPanelSnapshotResult["recentCommits"],
    deferFiles = false,
    decorations?: CommitDecorationReads,
  ) =>
    Effect.gen(function* () {
      if (commits.length === 0) return [];
      const { avatarContexts, refsBySha } = decorations ?? (yield* commitDecorationReads(cwd));
      const [withAvatars, refs, prefix] = yield* Effect.all(
        [
          withCommitAvatars(cwd, commits, avatarContexts),
          refsBySha,
          deferFiles
            ? Effect.succeed(null)
            : workingTreePrefix(cwd).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(
        withAvatars,
        (commit) => {
          const summary = {
            ...commit,
            ...(refs.get(commit.sha) ?? { headRefs: [], tags: [] }),
          };
          // Older clients expect files inline and do not know the detail endpoint.
          if (deferFiles) {
            return Effect.succeed({ ...summary, files: [], filesDeferred: true });
          }
          return prefix === null
            ? Effect.succeed({ ...summary, files: [] })
            : commitFilesRelativeTo(cwd, commit.sha, prefix).pipe(
                Effect.orElseSucceed(() => []),
                Effect.map((files) => ({ ...summary, files })),
              );
        },
        { concurrency: 2 },
      );
    });

  const parseCount = (value: string) => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const countCommitsForRange = (cwd: string, range: string) =>
    run("vcs.panel.branchCommitCount", cwd, ["rev-list", "--count", range]).pipe(
      Effect.map(parseCount),
      Effect.orElseSucceed(() => 0),
    );

  const countAheadBehindForRefs = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkAheadBehind", cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${leftRef}...${rightRef}`,
    ]).pipe(
      Effect.map(parseAheadBehindCounts),
      Effect.orElseSucceed(() => ({ aheadCount: 0, behindCount: 0 })),
    );

  const refsShareAncestry = (cwd: string, leftRef: string, rightRef: string) =>
    run("vcs.panel.branchForkMergeBase", cwd, ["merge-base", leftRef, rightRef], {
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const actionableForkBranches = (
    cwd: string,
    localBranches: readonly VcsRef[],
    remotes: readonly VcsPanelRemote[],
  ): Effect.Effect<readonly VcsPanelActionableForkBranch[], never> => {
    const uniqueForks = (
      forks: readonly VcsPanelActionableForkBranch[],
    ): readonly VcsPanelActionableForkBranch[] => {
      const byKey = new Map<string, VcsPanelActionableForkBranch>();
      for (const fork of forks) {
        const key = `${fork.localBranchName}\0${fork.remoteRefName}`;
        const existing = byKey.get(key);
        if (!existing || fork.pr || fork.behindCount > existing.behindCount) {
          byKey.set(key, fork);
        }
      }
      return [...byKey.values()].toSorted((left, right) => {
        const activity = branchActivityTime(right) - branchActivityTime(left);
        return activity !== 0
          ? activity
          : `${left.remoteName}/${left.remoteBranchName}`.localeCompare(
              `${right.remoteName}/${right.remoteBranchName}`,
            );
      });
    };

    const candidates =
      remotes.length < 2
        ? []
        : localBranches.flatMap((localBranch) =>
            remotes.flatMap((remote) =>
              remote.branches
                .filter((remoteBranch) => remoteBranch.name === localBranch.name)
                .filter(
                  (remoteBranch) =>
                    localBranch.upstreamRemoteName !== remote.name ||
                    localBranch.upstreamName !== remoteBranch.fullRefName,
                )
                .map((remoteBranch) => ({ localBranch, remote, remoteBranch })),
            ),
          );
    const sameNameForks = Effect.forEach(
      candidates,
      ({ localBranch, remote, remoteBranch }) =>
        Effect.gen(function* () {
          const shareAncestry = yield* refsShareAncestry(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (!shareAncestry) return null;
          const counts = yield* countAheadBehindForRefs(
            cwd,
            localBranch.name,
            remoteBranch.fullRefName,
          );
          if (counts.behindCount <= 0) return null;
          const fork = {
            localBranchName: localBranch.name,
            remoteName: remote.name,
            remoteBranchName: remoteBranch.name,
            remoteRefName: remoteBranch.fullRefName,
            aheadCount: counts.aheadCount,
            behindCount: counts.behindCount,
          };
          return {
            ...fork,
            ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
          } satisfies VcsPanelActionableForkBranch;
        }),
      { concurrency: 4 },
    ).pipe(Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))));

    // Each lookup spawns several Git processes even on a cache hit, so only branches published
    // to a remote can have a PR worth discovering on every full snapshot. A remote-tracking ref is
    // the evidence: the upstream's (a gone upstream is cleared when parsed) or a same-named branch
    // on any remote, which covers a push without -u and an upstream unset after publishing.
    const remoteBranchNames = new Set(
      remotes.flatMap((remote) => remote.branches.map((remoteBranch) => remoteBranch.name)),
    );
    const pullRequestForks = Effect.forEach(
      localBranches.filter(
        (localBranch) =>
          (localBranch.upstreamName && localBranch.upstreamRemoteName !== ".") ||
          remoteBranchNames.has(localBranch.name),
      ),
      (localBranch) =>
        deps
          .branchPullRequest({ cwd: localBranch.worktreePath ?? cwd, branch: localBranch.name })
          .pipe(
            Effect.flatMap((pullRequest) => {
              if (pullRequest?.state !== "open" || !pullRequest.repositoryKey) {
                return Effect.succeed(null);
              }
              const repositoryKey = canonicalRepositoryKey(pullRequest.repositoryKey);
              const remote = remotes.find(
                (candidate) =>
                  candidate.fetchUrl !== null &&
                  candidate.branches.some((branch) => branch.name === pullRequest.baseRef) &&
                  canonicalRepositoryKey(normalizeGitRemoteUrl(candidate.fetchUrl)) ===
                    repositoryKey,
              );
              return remote
                ? actionableForkForChangeRequest(cwd, localBranch, remote, pullRequest)
                : Effect.succeed(null);
            }),
            Effect.orElseSucceed(() => null),
          ),
      { concurrency: 4 },
    ).pipe(Effect.map((forks) => forks.flatMap((fork) => (fork ? [fork] : []))));

    return Effect.all([sameNameForks, pullRequestForks], { concurrency: "unbounded" }).pipe(
      Effect.map(([forks, prForks]) => uniqueForks([...forks, ...prForks])),
      Effect.orElseSucceed(() => []),
    );
  };

  const actionableForkForChangeRequest = (
    cwd: string,
    localBranch: VcsRef,
    remote: VcsPanelRemote,
    changeRequest: GitBranchPullRequest,
  ): Effect.Effect<VcsPanelActionableForkBranch | null, never> => {
    const remoteBranch = remote.branches.find((branch) => branch.name === changeRequest.baseRef);
    if (!remoteBranch) return Effect.succeed(null);

    return Effect.gen(function* () {
      const shareAncestry = yield* refsShareAncestry(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (!shareAncestry) return null;
      const counts = yield* countAheadBehindForRefs(
        cwd,
        localBranch.name,
        remoteBranch.fullRefName,
      );
      if (counts.behindCount <= 0) return null;
      const fork = {
        localBranchName: localBranch.name,
        remoteName: remote.name,
        remoteBranchName: remoteBranch.name,
        remoteRefName: remoteBranch.fullRefName,
        aheadCount: counts.aheadCount,
        behindCount: counts.behindCount,
      };
      return {
        ...fork,
        pr: changeRequest,
        ...(remoteBranch.lastActivityAt ? { lastActivityAt: remoteBranch.lastActivityAt } : {}),
      } satisfies VcsPanelActionableForkBranch;
    }).pipe(Effect.orElseSucceed(() => null));
  };

  // Unsynced commits are on the branch but missing from its upstream, or from the default compare
  // ref without one. Only the commits a response returns are classified, each with a query whose
  // output is one line however long the unpublished range is, so every page keeps Undo eligibility
  // while reads and payloads stay page-sized.
  const unsyncedBaseRefFor = (cwd: string, branch: VcsRef, defaultCompareRef: string | null) =>
    branch.isRemote
      ? Effect.succeed(null)
      : upstreamForRef(cwd, branch.name).pipe(
          Effect.map((upstreamRef) => upstreamRef ?? defaultCompareRef),
        );

  // Counting at most one commit of `<sha> ^<ref>` prints 0 exactly when the ref reaches the sha.
  const commitReachableFrom = (cwd: string, sha: string, refName: string) =>
    run("vcs.panel.commitReachable", cwd, [
      "rev-list",
      "--count",
      "--max-count=1",
      sha,
      `^${refName}`,
    ]).pipe(Effect.map((output) => output.trim() === "0"));

  // Callers whose commits may come from outside the branch, like a symmetric compare range, ask to
  // confirm branch membership too.
  const unsyncedShasAmong = (
    cwd: string,
    unsyncedBaseRef: string | null,
    refName: string,
    commits: VcsPanelSnapshotResult["recentCommits"],
    confirmOnBranch = false,
  ): Effect.Effect<ReadonlySet<string>, GitCommandError> =>
    Effect.gen(function* () {
      if (unsyncedBaseRef === null || commits.length === 0) return new Set<string>();
      // Resolving once pins every check to one base commit. A missing base, such as a deleted
      // default compare ref, leaves nothing to be unsynced against.
      const baseSha = (yield* run(
        "vcs.panel.unsyncedBase",
        cwd,
        ["rev-parse", "--verify", "--quiet", `${unsyncedBaseRef}^{commit}`],
        { allowNonZeroExit: true },
      )).trim();
      if (baseSha.length === 0) return new Set<string>();
      const shas = [...new Set(commits.map((commit) => commit.sha))];
      const unsynced = yield* Effect.forEach(
        shas,
        (sha) =>
          Effect.all([
            commitReachableFrom(cwd, sha, baseSha),
            confirmOnBranch ? commitReachableFrom(cwd, sha, refName) : Effect.succeed(true),
          ]).pipe(Effect.map(([inBase, onBranch]) => onBranch && !inBase)),
        { concurrency: 8 },
      );
      return new Set(shas.filter((_, index) => unsynced[index]));
    });

  const flagUnsyncedCommits = (
    commits: VcsPanelSnapshotResult["recentCommits"],
    unsyncedShas: ReadonlySet<string>,
  ) =>
    unsyncedShas.size === 0
      ? commits
      : commits.map((commit) =>
          unsyncedShas.has(commit.sha) ? { ...commit, unsynced: true } : commit,
        );

  const commitsForRange = (
    cwd: string,
    range: string,
    maxCount: number,
    skip = 0,
    deferFiles = false,
    decorations?: CommitDecorationReads,
  ): Effect.Effect<VcsPanelSnapshotResult["recentCommits"], GitCommandError> =>
    run(
      "vcs.panel.branchCommits",
      cwd,
      [
        "log",
        ...(deferFiles ? ["--shortstat"] : []),
        `--skip=${skip}`,
        `--max-count=${maxCount}`,
        "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
        range,
      ],
      { env: { LC_ALL: "C", LANG: "C" } },
    ).pipe(
      Effect.map(deferFiles ? parseCommitsWithStats : parseCommits),
      Effect.flatMap((commits) => withCommitDetails(cwd, commits, deferFiles, decorations)),
    );

  const branchCommits = (
    cwd: string,
    branch: VcsRef,
    baseRef: string | null | undefined,
    kind: VcsPanelBranchCommitsInput["kind"],
    skip: number,
    limit: number,
    deferFiles = false,
    defaultCompareRef: string | null = null,
  ): Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError> =>
    Effect.gen(function* () {
      yield* validateRevisionOperands("vcs.panel.branchCommits", cwd, [
        branch.name,
        baseRef,
        defaultCompareRef,
      ]);
      const refName = branch.name;
      const historyRef = yield* branchCommitRange(baseRef ?? null, refName, kind ?? "history");
      if (!historyRef) {
        return {
          commits: [],
          remaining: 0,
        };
      }
      const [total, commits] = yield* Effect.all(
        [
          countCommitsForRange(cwd, historyRef),
          commitsForRange(cwd, historyRef, limit, skip, deferFiles),
        ],
        { concurrency: "unbounded" },
      );
      // Behind commits are not on the branch, so they are never unsynced.
      const unsyncedShas =
        commits.length === 0 || kind === "behind"
          ? new Set<string>()
          : yield* unsyncedBaseRefFor(cwd, branch, defaultCompareRef).pipe(
              Effect.flatMap((unsyncedBaseRef) =>
                unsyncedShasAmong(
                  cwd,
                  unsyncedBaseRef,
                  refName,
                  commits,
                  kind === "compare-history",
                ),
              ),
            );
      return {
        commits: flagUnsyncedCommits(commits, unsyncedShas),
        remaining: Math.max(0, total - skip - commits.length),
      };
    });

  const stashDetails = (
    cwd: string,
    stashRef: string,
  ): Effect.Effect<VcsPanelStashDetails, GitCommandError> =>
    validateGitOperand("vcs.panel.stashDetails", cwd, stashRef).pipe(
      Effect.flatMap(() => stashFiles(cwd, stashRef)),
      Effect.map((files) => ({
        refName: stashRef,
        files,
      })),
    );

  // Failures propagate so clients can show their detail error and retry state.
  const stashFiles = (cwd: string, stashRef: string) =>
    Effect.all(
      [
        run("vcs.panel.stashNumstat", cwd, [
          "stash",
          "show",
          "--no-relative",
          "--numstat",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
        run("vcs.panel.stashNameStatus", cwd, [
          "stash",
          "show",
          "--no-relative",
          "--name-status",
          "-z",
          "--find-renames",
          "--include-untracked",
          stashRef,
        ]),
        workingTreePrefix(cwd),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus, prefix]) =>
        fileChangesRelativeToCwd(
          parseFileChangesFromNumstat({
            numstat,
            statuses: parseNameStatus(nameStatus),
          }),
          prefix,
        ),
      ),
    );

  // The fallback subject applies only without a writer or without changes; any other failure
  // stops the commit or stash so it never lands with a silent placeholder subject.
  const messageGenerationError =
    (operation: string, cwd: string, command: string, detail: string) => (cause: unknown) =>
      new GitCommandError({ operation, cwd, command, detail, cause: sanitizeErrorCause(cause) });
  const nonEmptySubject = (subject: string) => {
    const trimmed = subject.trim();
    return trimmed.length > 0
      ? Effect.succeed(trimmed)
      : Effect.fail(
          new TextGenerationError({
            operation: "vcs.panel.generatedSubject",
            detail: "Text generation returned an empty subject.",
          }),
        );
  };

  const generatedStashMessage = (
    cwd: string,
    mode: "all" | "staged" | "unstaged",
    paths?: readonly string[],
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const fallback = `T3 Code ${mode} stash`;
      const diffArgs =
        mode === "staged"
          ? (["diff", "--cached", "--stat"] as const)
          : mode === "all"
            ? (["diff", "HEAD", "--stat"] as const)
            : (["diff", "--stat"] as const);
      const patchArgs =
        mode === "staged"
          ? (["diff", "--cached", "--no-ext-diff", "--patch", "--minimal"] as const)
          : mode === "all"
            ? (["diff", "HEAD", "--no-ext-diff", "--patch", "--minimal"] as const)
            : (["diff", "--no-ext-diff", "--patch", "--minimal"] as const);
      // diff and status cannot read pathspecs from stdin, so large selections are batched. Only
      // the prompt prefix is kept, and a field stops reading once its budget is filled.
      const readSelection = (operation: string, args: readonly string[], budget: number) => {
        if (!paths || paths.length === 0) {
          return run(operation, cwd, args).pipe(Effect.map((output) => output.slice(0, budget)));
        }
        const chunks = chunkPathsForArgv(paths);
        const readFrom = (
          index: number,
          collected: string,
        ): Effect.Effect<string, GitCommandError> =>
          index >= chunks.length || collected.length >= budget
            ? Effect.succeed(collected)
            : run(operation, cwd, ["--literal-pathspecs", ...args, "--", ...chunks[index]!]).pipe(
                Effect.flatMap((output) =>
                  readFrom(index + 1, collected + output.slice(0, budget - collected.length)),
                ),
              );
        return readFrom(0, "");
      };
      const [settings, providers, summary, patch, status] = yield* Effect.all(
        [
          writingSettingsFor(cwd),
          getProviders,
          readSelection("vcs.panel.stashMessageSummary", diffArgs, STASH_MESSAGE_SUMMARY_BUDGET),
          readSelection("vcs.panel.stashMessagePatch", patchArgs, STASH_MESSAGE_PATCH_BUDGET),
          readSelection(
            "vcs.panel.stashMessageStatus",
            ["status", "--short"],
            STASH_MESSAGE_SUMMARY_BUDGET,
          ),
        ],
        { concurrency: "unbounded" },
      );
      const stagedSummary = [summary.trim(), status.trim()].filter(Boolean).join("\n");
      if (!textGeneration) return fallback;
      if (stagedSummary.length === 0 && patch.trim().length === 0) return fallback;
      const modelSelection = SharedServerSettings.resolveSourceControlWriterModelSelection(
        settings,
        providers,
      );
      const policy = yield* resolveWritingPolicy(cwd, {
        modelSelection,
        providers,
        style: settings.sourceControlWritingStyle,
      });
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: stagedSummary.slice(0, STASH_MESSAGE_SUMMARY_BUDGET),
        stagedPatch: patch,
        modelSelection,
        policy,
      });
      return yield* nonEmptySubject(generated.subject);
    }).pipe(
      Effect.mapError(
        messageGenerationError(
          "vcs.panel.generateStashMessage",
          cwd,
          "git stash push",
          "Stash message generation failed; enter a message or retry.",
        ),
      ),
    );

  const generatedCommitMessage = (
    cwd: string,
    paths?: readonly string[],
    env?: NodeJS.ProcessEnv,
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const fallback = "T3 Code changes";
      const pathArgs = paths && paths.length > 0 ? (["--", ...paths] as const) : [];
      const literalPathspecArgs = pathArgs.length > 0 ? (["--literal-pathspecs"] as const) : [];
      const commandOptions = env ? { env } : undefined;
      const [settings, providers, summary, patch] = yield* Effect.all(
        [
          writingSettingsFor(cwd),
          getProviders,
          run(
            "vcs.panel.commitMessageSummary",
            cwd,
            [...literalPathspecArgs, "diff", "--cached", "--stat", ...pathArgs],
            commandOptions,
          ),
          run(
            "vcs.panel.commitMessagePatch",
            cwd,
            [
              ...literalPathspecArgs,
              "diff",
              "--cached",
              "--no-ext-diff",
              "--patch",
              "--minimal",
              ...pathArgs,
            ],
            commandOptions,
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (!textGeneration) return fallback;
      if (summary.trim().length === 0 && patch.trim().length === 0) return fallback;
      const modelSelection = SharedServerSettings.resolveSourceControlWriterModelSelection(
        settings,
        providers,
      );
      const policy = yield* resolveWritingPolicy(cwd, {
        modelSelection,
        providers,
        style: settings.sourceControlWritingStyle,
      });
      const generated = yield* textGeneration.generateCommitMessage({
        cwd,
        branch: null,
        stagedSummary: summary.slice(0, 8_000),
        stagedPatch: patch.slice(0, 50_000),
        modelSelection,
        policy,
      });
      return yield* nonEmptySubject(generated.subject);
    }).pipe(
      Effect.mapError(
        messageGenerationError(
          "vcs.panel.generateCommitMessage",
          cwd,
          "git commit",
          "Commit message generation failed; enter a message or retry.",
        ),
      ),
    );

  const compareFiles = (cwd: string, baseRef: string | null, refName: string) => {
    if (!baseRef) return Effect.succeed([]);
    // The C locale keeps Git's "no merge base" message stable for the check below.
    const options = { env: { LC_ALL: "C", LANG: "C" } };
    return Effect.all(
      [
        run(
          "vcs.panel.branchCompareNumstat",
          cwd,
          ["diff", "--no-relative", "--numstat", "-z", "--find-renames", `${baseRef}...${refName}`],
          options,
        ),
        run(
          "vcs.panel.branchCompareNameStatus",
          cwd,
          [
            "diff",
            "--no-relative",
            "--name-status",
            "-z",
            "--find-renames",
            `${baseRef}...${refName}`,
          ],
          options,
        ),
        workingTreePrefix(cwd),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstat, nameStatus, prefix]) =>
        fileChangesRelativeToCwd(
          parseFileChangesFromNumstat({
            numstat,
            statuses: parseNameStatus(nameStatus),
          }),
          prefix,
        ),
      ),
      // Unrelated histories have nothing to compare; other failures reach the client.
      Effect.catchIf(
        (error) => error.detail.endsWith("no merge base"),
        () => Effect.succeed([]),
      ),
    );
  };

  const branchCommitRange = (
    baseRef: string | null,
    refName: string,
    kind: NonNullable<VcsPanelBranchCommitsInput["kind"]>,
  ) => {
    switch (kind) {
      case "ahead":
        return Effect.succeed(baseRef ? `${baseRef}..${refName}` : "");
      case "behind":
        return Effect.succeed(baseRef ? `${refName}..${baseRef}` : "");
      case "compare-history":
        return Effect.succeed(baseRef ? `${baseRef}...${refName}` : refName);
      case "history":
        return Effect.succeed(refName);
    }
  };

  const upstreamForRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchUpstream", cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${refName}@{upstream}`,
    ]).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
      Effect.map((value) => (value.length > 0 ? value : null)),
    );

  const refExists = (operation: string, cwd: string, refName: string) =>
    run(operation, cwd, ["show-ref", "--verify", refName], { allowNonZeroExit: true }).pipe(
      Effect.map((output) => output.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

  const createdFromRef = (cwd: string, refName: string) =>
    run("vcs.panel.branchCreatedFrom", cwd, [
      "reflog",
      "show",
      "--format=%gs",
      "--max-count=20",
      refName,
    ]).pipe(
      Effect.map(parseCreatedFromRef),
      Effect.orElseSucceed(() => null),
    );

  const branchDetails = (
    cwd: string,
    branch: VcsRef,
    defaultCompareRef: string | null,
    compareBaseRef?: string,
    deferFiles = false,
  ): Effect.Effect<VcsPanelBranchDetails, GitCommandError> =>
    Effect.gen(function* () {
      yield* validateRevisionOperands("vcs.panel.branchDetails", cwd, [
        branch.name,
        compareBaseRef,
        defaultCompareRef,
      ]);
      const refName = branch.name;
      const upstreamRef = branch.isRemote ? null : yield* upstreamForRef(cwd, refName);
      const createdBaseRef = upstreamRef ? null : yield* createdFromRef(cwd, refName);
      const baseRef = compareBaseRef ?? upstreamRef ?? createdBaseRef ?? defaultCompareRef;
      const unsyncedBaseRef = branch.isRemote ? null : (upstreamRef ?? defaultCompareRef);
      const decorations = yield* commitDecorationReads(cwd);
      const historyRef = refName;
      const [
        aheadCommits,
        aheadCommitTotal,
        behindCommits,
        behindCommitTotal,
        totalCommits,
        commits,
        files,
      ] = yield* Effect.all(
        [
          baseRef
            ? commitsForRange(
                cwd,
                `${baseRef}..${refName}`,
                COMMIT_PAGE_SIZE,
                0,
                deferFiles,
                decorations,
              )
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${baseRef}..${refName}`) : Effect.succeed(0),
          baseRef
            ? commitsForRange(
                cwd,
                `${refName}..${baseRef}`,
                COMMIT_PAGE_SIZE,
                0,
                deferFiles,
                decorations,
              )
            : Effect.succeed([]),
          baseRef ? countCommitsForRange(cwd, `${refName}..${baseRef}`) : Effect.succeed(0),
          countCommitsForRange(cwd, historyRef),
          commitsForRange(cwd, historyRef, COMMIT_PAGE_SIZE, 0, deferFiles, decorations),
          compareFiles(cwd, baseRef, refName),
        ],
        { concurrency: "unbounded" },
      );
      const unsyncedShas = yield* unsyncedShasAmong(cwd, unsyncedBaseRef, refName, [
        ...aheadCommits,
        ...commits,
      ]);
      const flaggedAheadCommits = flagUnsyncedCommits(aheadCommits, unsyncedShas);
      const flaggedCommits = flagUnsyncedCommits(commits, unsyncedShas);
      const unsyncedCommitShas = [
        ...new Set(
          [...flaggedAheadCommits, ...flaggedCommits]
            .filter((commit) => commit.unsynced === true)
            .map((commit) => commit.sha),
        ),
      ];
      return {
        name: branch.name,
        fullRefName: branch.name,
        isRemote: branch.isRemote === true,
        remoteName: branch.remoteName ?? null,
        current: branch.current,
        isDefault: branch.isDefault,
        worktreePath: branch.worktreePath,
        upstreamRef,
        baseRef,
        unsyncedCommitShas,
        aheadCommits: flaggedAheadCommits,
        aheadCommitsRemaining: Math.max(0, aheadCommitTotal - aheadCommits.length),
        behindCommits,
        behindCommitsRemaining: Math.max(0, behindCommitTotal - behindCommits.length),
        compareCommits: [],
        compareCommitsRemaining: 0,
        commits: flaggedCommits,
        commitsRemaining: Math.max(0, totalCommits - commits.length),
        compareFiles: files,
      };
    });

  return {
    actionableForkBranches,
    commitFiles,
    branchCommits,
    branchDetails,
    changeGroupsHaveFiles,
    generatedCommitMessage,
    generatedStashMessage,
    readWorkingTreeChangeGroups,
    refExists,
    stashDetails,
    upstreamForRef,
  };
}

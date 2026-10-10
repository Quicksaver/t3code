import type {
  ExecutionEnvironmentCapabilities,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
  VcsRef,
} from "@t3tools/contracts";
import {
  mergePanelChangeGroups,
  panelBranchHasUpstream,
  panelBranchSyncCounts,
  type PanelChangedFile,
} from "@t3tools/shared/sourceControl";

import { relativeTime } from "../../lib/time";

export interface VersionControlChangeSet {
  readonly id: string;
  readonly branchName: string;
  readonly cwd: string;
  readonly current: boolean;
  readonly lastActivityAt?: string | null;
  readonly files: readonly PanelChangedFile[];
}

function siblingChangeSet(changeSet: VcsPanelWorktreeChangeSet): VersionControlChangeSet {
  return {
    id: `worktree:${changeSet.worktreePath}`,
    branchName: changeSet.branchName,
    cwd: changeSet.worktreePath,
    current: changeSet.current,
    lastActivityAt: changeSet.lastActivityAt,
    files: mergePanelChangeGroups(changeSet.changeGroups),
  };
}

export function panelChangeSets(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): VersionControlChangeSet[] {
  const currentBranch = snapshot.status.refName ?? "Detached HEAD";
  const current: VersionControlChangeSet = {
    id: `worktree:${cwd}`,
    branchName: currentBranch,
    cwd,
    current: true,
    files: mergePanelChangeGroups(snapshot.changeGroups),
  };

  return [current, ...snapshot.worktreeChangeSets.map(siblingChangeSet)].filter(
    (changeSet, index, all) =>
      changeSet.files.length > 0 &&
      all.findIndex((candidate) => candidate.cwd === changeSet.cwd) === index,
  );
}

export function reconcileSelectedPaths(input: {
  readonly changeSets: readonly VersionControlChangeSet[];
  readonly previousKnownPaths: ReadonlyMap<string, ReadonlySet<string>>;
  readonly selectedByCwd: ReadonlyMap<string, ReadonlySet<string>>;
}): ReadonlyMap<string, ReadonlySet<string>> {
  const next = new Map<string, ReadonlySet<string>>();
  for (const changeSet of input.changeSets) {
    const known = input.previousKnownPaths.get(changeSet.cwd) ?? new Set<string>();
    const visible = new Set(changeSet.files.map((file) => file.path));
    const selected = new Set(input.selectedByCwd.get(changeSet.cwd) ?? []);
    for (const path of visible) {
      if (!known.has(path)) selected.add(path);
    }
    for (const path of selected) {
      if (!visible.has(path)) selected.delete(path);
    }
    next.set(changeSet.cwd, selected);
  }
  return next;
}

export function newlyInitializedCurrentChangeSetCwds(
  changeSets: readonly VersionControlChangeSet[],
  initializedCwds: Set<string>,
): readonly string[] {
  return changeSets.flatMap((changeSet) => {
    if (!changeSet.current || initializedCwds.has(changeSet.cwd)) return [];
    initializedCwds.add(changeSet.cwd);
    return [changeSet.cwd];
  });
}

export function actionableLocalBranches(snapshot: VcsPanelSnapshotResult): VcsRef[] {
  return snapshot.localBranches.filter((branch) => {
    const { aheadCount, behindCount } = panelBranchSyncCounts(branch, snapshot);
    return !panelBranchHasUpstream(branch, snapshot) || aheadCount > 0 || behindCount > 0;
  });
}

export function stashIdentityKey(stash: Pick<VcsPanelStash, "refName" | "sha">): string {
  return stash.sha ? `sha:${stash.sha}` : `ref:${stash.refName}`;
}

// Detail and diff reads target the immutable commit so a renumbered stash list cannot swap
// another stash's content in; mutations keep the positional ref plus expectedSha.
export function stashReadRef(stash: Pick<VcsPanelStash, "refName" | "sha">): string {
  return stash.sha ?? stash.refName;
}

export function branchComparisonTotals(
  details: Pick<
    VcsPanelBranchDetails,
    "aheadCommits" | "aheadCommitsRemaining" | "behindCommits" | "behindCommitsRemaining"
  >,
) {
  return {
    ahead: details.aheadCommits.length + details.aheadCommitsRemaining,
    behind: details.behindCommits.length + details.behindCommitsRemaining,
  };
}

export function relativeLabel(value: string | null | undefined): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return relativeTime(value);
}

function upstreamKey(remoteName: string, upstreamName: string): string {
  return JSON.stringify([remoteName, upstreamName]);
}

// Built once per snapshot so remote rows resolve their local branch without rescanning.
export function localBranchesByUpstream(
  localBranches: readonly VcsRef[],
): ReadonlyMap<string, readonly VcsRef[]> {
  const index = new Map<string, VcsRef[]>();
  for (const localBranch of localBranches) {
    if (!localBranch.upstreamRemoteName || !localBranch.upstreamName) continue;
    const key = upstreamKey(localBranch.upstreamRemoteName, localBranch.upstreamName);
    const matches = index.get(key);
    if (matches) matches.push(localBranch);
    else index.set(key, [localBranch]);
  }
  return index;
}

export function localBranchForRemoteBranch(
  localBranchIndex: ReadonlyMap<string, readonly VcsRef[]>,
  remote: Pick<VcsPanelRemote, "name">,
  branch: VcsPanelRemote["branches"][number],
): VcsRef | null {
  return (
    localBranchIndex.get(upstreamKey(remote.name, branch.fullRefName))?.[0] ??
    localBranchIndex
      .get(upstreamKey(remote.name, `${remote.name}/${branch.name}`))
      ?.find((localBranch) => localBranch.name === branch.name) ??
    null
  );
}

export function visibleRemoteBranches(
  remote: Pick<VcsPanelRemote, "branches">,
  expanded: boolean,
): VcsPanelRemote["branches"] {
  return expanded ? remote.branches : [];
}

export function renameOriginalPathForFile(
  file: Pick<VcsPanelFileChange, "originalPath" | "status">,
): string | undefined {
  return file.status === "renamed" && file.originalPath ? file.originalPath : undefined;
}

export function operationPaths(
  files: readonly Pick<VcsPanelFileChange, "path" | "originalPath" | "status">[],
) {
  return [
    ...new Set(
      files.flatMap((file) => {
        const originalPath = renameOriginalPathForFile(file);
        return originalPath ? [file.path, originalPath] : [file.path];
      }),
    ),
  ];
}

export interface CwdScopedSnapshot {
  readonly cwd: string;
  readonly snapshot: VcsPanelSnapshotResult;
}

export function snapshotForCwd(
  scopedSnapshot: CwdScopedSnapshot | null,
  cwd: string | null | undefined,
): VcsPanelSnapshotResult | null {
  return scopedSnapshot !== null && scopedSnapshot.cwd === cwd ? scopedSnapshot.snapshot : null;
}

export function snapshotIsPendingForCwd(
  snapshot: VcsPanelSnapshotResult | null,
  cwd: string | null | undefined,
  settledSnapshotCwd: string | null,
): boolean {
  return cwd != null && snapshot === null && settledSnapshotCwd !== cwd;
}

export function beginDetailRequest(requestsByKey: Map<string, number>, key: string): number {
  const requestId = (requestsByKey.get(key) ?? 0) + 1;
  requestsByKey.set(key, requestId);
  return requestId;
}

export function detailRequestIsCurrent(
  requestsByKey: ReadonlyMap<string, number>,
  key: string,
  requestId: number,
): boolean {
  return requestsByKey.get(key) === requestId;
}

export function clearResolvedDetailError(
  currentError: string | null,
  resolvedDetailError: string | null,
): string | null {
  return resolvedDetailError !== null && currentError === resolvedDetailError ? null : currentError;
}

export function discardPathGroups(files: readonly PanelChangedFile[]): {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
} {
  return {
    staged: operationPaths(files.filter((file) => file.hasStagedChanges)),
    unstaged: operationPaths(files.filter((file) => file.hasUnstagedChanges)),
  };
}

export function discardableFiles(files: readonly PanelChangedFile[]): readonly PanelChangedFile[] {
  return files.filter((file) => file.hasStagedChanges || file.hasUnstagedChanges);
}

export function workingTreeDiffIsStaged(
  file: Pick<PanelChangedFile, "hasStagedChanges" | "hasUnstagedChanges">,
): boolean {
  return file.hasStagedChanges && !file.hasUnstagedChanges;
}

export function workingTreeEnrichmentRequests(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): ReadonlyArray<{ readonly cwd: string; readonly paths: readonly string[] }> {
  return panelChangeSets(snapshot, cwd).flatMap((changeSet) => {
    const paths = changeSet.files
      .filter(
        (file) =>
          file.hasUnstagedChanges && (file.status === "untracked" || file.status === "deleted"),
      )
      .map((file) => file.path);
    return paths.length > 0 ? [{ cwd: changeSet.cwd, paths }] : [];
  });
}

// Accumulates batched enrichment results per cwd; a hidden path drops any earlier enriched row.
// A batch is authoritative for the paths it requested, so revalidating an unchanged snapshot
// replaces their earlier rows and rename pairings instead of accumulating stale ones. An
// unchanged result keeps the current map so revalidation does not re-render the panel.
export function mergeWorkingTreeEnrichment(
  current: ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult>,
  batch: { readonly cwd: string; readonly paths: readonly string[] },
  result: VcsPanelWorkingTreeFileEnrichmentResult,
): ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult> {
  const previous = current.get(batch.cwd);
  const requested = new Set(batch.paths);
  const hiddenPaths = new Set([
    ...(previous?.hiddenPaths ?? []).filter((path) => !requested.has(path)),
    ...result.hiddenPaths,
  ]);
  const files = new Map(
    (previous?.files ?? [])
      .filter(
        (file) =>
          !requested.has(file.path) && !(file.originalPath && requested.has(file.originalPath)),
      )
      .map((file) => [file.path, file] as const),
  );
  for (const file of result.files) files.set(file.path, file);
  for (const path of hiddenPaths) files.delete(path);
  const next: VcsPanelWorkingTreeFileEnrichmentResult = {
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    hiddenPaths: [...hiddenPaths].sort(),
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return current;
  return new Map(current).set(batch.cwd, next);
}

// Keeps the enrichment rows that pass `keep`. A hidden path is the source of a rename row, so
// hidden paths are derived from the surviving renames and never outlive the row that hides them.
// Returns `enrichment` itself when nothing was dropped.
function filterWorkingTreeEnrichment(
  enrichment: VcsPanelWorkingTreeFileEnrichmentResult,
  keep: (file: VcsPanelFileChange) => boolean,
): VcsPanelWorkingTreeFileEnrichmentResult {
  const files = enrichment.files.filter(keep);
  const hiddenPaths = [
    ...new Set(files.flatMap((file) => renameOriginalPathForFile(file) ?? [])),
  ].sort();
  const unchanged =
    files.length === enrichment.files.length &&
    hiddenPaths.length === enrichment.hiddenPaths.length &&
    hiddenPaths.every((path) => enrichment.hiddenPaths.includes(path));
  return unchanged ? enrichment : { files, hiddenPaths };
}

// Prunes enrichment to the cwds and paths a newer snapshot still requests. Surviving rows, and
// renames whose source and destination both survive, stay visible until their fresh batch
// replaces them, so an unrelated snapshot change does not flash zero totals or split renames.
export function retainWorkingTreeEnrichments(
  current: ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult>,
  requests: ReadonlyArray<{ readonly cwd: string; readonly paths: readonly string[] }>,
): ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult> {
  const requestedByCwd = new Map(requests.map((request) => [request.cwd, new Set(request.paths)]));
  const next = new Map<string, VcsPanelWorkingTreeFileEnrichmentResult>();
  let changed = false;
  for (const [cwd, enrichment] of current) {
    const requested = requestedByCwd.get(cwd);
    const retained = filterWorkingTreeEnrichment(
      enrichment,
      (file) =>
        requested?.has(file.path) === true &&
        (!file.originalPath || requested.has(file.originalPath)),
    );
    changed ||= retained !== enrichment || retained.files.length === 0;
    if (retained.files.length > 0) next.set(cwd, retained);
  }
  return changed ? next : current;
}

// An enrichment read can outlive the snapshot that requested it: a destination created while it
// ran may be staged or removed before the response lands, and an unchanged request set keeps the
// late response current. Each rename must still pair an unstaged untracked destination with an
// unstaged deleted source in the latest accepted snapshot; otherwise its row and hidden source
// are dropped and the next snapshot read revalidates them.
export function validateWorkingTreeEnrichment(
  result: VcsPanelWorkingTreeFileEnrichmentResult,
  latest: CwdScopedSnapshot | null,
  cwd: string,
): VcsPanelWorkingTreeFileEnrichmentResult {
  const groups =
    latest === null
      ? []
      : latest.cwd === cwd
        ? latest.snapshot.changeGroups
        : (latest.snapshot.worktreeChangeSets.find((changeSet) => changeSet.worktreePath === cwd)
            ?.changeGroups ?? []);
  const unstagedStatus = new Map(
    groups
      .filter((group) => group.kind === "unstaged")
      .flatMap((group) => group.files.map((file) => [file.path, file.status] as const)),
  );
  return filterWorkingTreeEnrichment(result, (file) => {
    const originalPath = renameOriginalPathForFile(file);
    return (
      originalPath === undefined ||
      (unstagedStatus.get(file.path) === "untracked" &&
        unstagedStatus.get(originalPath) === "deleted")
    );
  });
}

function applyWorkingTreeEnrichment(
  groups: readonly VcsPanelChangeGroup[],
  enrichment: VcsPanelWorkingTreeFileEnrichmentResult | undefined,
): VcsPanelChangeGroup[] {
  if (!enrichment) return groups.map((group) => ({ ...group, files: [...group.files] }));

  const enrichedByPath = new Map(enrichment.files.map((file) => [file.path, file]));
  const hiddenPaths = new Set(enrichment.hiddenPaths);
  return groups.map((group) => {
    if (group.kind !== "unstaged") return { ...group, files: [...group.files] };
    const seenPaths = new Set<string>();
    const files = group.files.flatMap((file) => {
      if (hiddenPaths.has(file.path)) return [];
      const enriched = enrichedByPath.get(file.path) ?? file;
      seenPaths.add(enriched.path);
      return [enriched];
    });
    for (const file of enrichment.files) {
      if (!seenPaths.has(file.path) && !hiddenPaths.has(file.path)) files.push(file);
    }
    return {
      ...group,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

export function applyWorkingTreeEnrichments(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
  enrichments: ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult>,
): VcsPanelSnapshotResult {
  return {
    ...snapshot,
    changeGroups: applyWorkingTreeEnrichment(snapshot.changeGroups, enrichments.get(cwd)),
    worktreeChangeSets: snapshot.worktreeChangeSets.map((changeSet) => ({
      ...changeSet,
      changeGroups: applyWorkingTreeEnrichment(
        changeSet.changeGroups,
        enrichments.get(changeSet.worktreePath),
      ),
    })),
  };
}

export type VersionControlSupport = "pending" | "supported" | "unsupported";

// Servers from before the Version Control panel reject every vcs.panel.* request, so routes
// issue none until the environment's config confirms the capability.
export function versionControlSupport(
  config: {
    readonly environment: {
      readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "sourceControlPanel">;
    };
  } | null,
): VersionControlSupport {
  if (config === null) return "pending";
  return config.environment.capabilities.sourceControlPanel === true ? "supported" : "unsupported";
}

export function branchOwnsOperationCwd(branch: VcsRef): boolean {
  return branch.current || branch.worktreePath !== null;
}

export function selectedFileStats(
  files: readonly Pick<VcsPanelFileChange, "insertions" | "deletions">[],
) {
  return files.reduce(
    (total, file) => ({
      insertions: total.insertions + file.insertions,
      deletions: total.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

// Stash mutations, including creation under "stash", can renumber every stash ref, so only
// one can run at a time.
const STASH_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  "stash",
  "apply-stash",
  "pop-stash",
  "drop-stash",
]);

export function beginVersionControlAction(
  runningActionKeys: Set<string>,
  actionKey: string,
): boolean {
  if (runningActionKeys.has(actionKey)) return false;
  if (
    STASH_MUTATION_ACTIONS.has(actionKey) &&
    [...runningActionKeys].some((key) => STASH_MUTATION_ACTIONS.has(key))
  ) {
    return false;
  }
  runningActionKeys.add(actionKey);
  return true;
}

// Mirrors web's forced-sync confirmations: each side names exactly what it overwrites.
export function divergedForceSyncMessage(branch: VcsRef): string {
  const pullDiscards = branchOwnsOperationCwd(branch)
    ? "Uncommitted changes and local commits are discarded."
    : "Local commits on it are discarded.";
  return [
    `Force pull resets ${branch.name} to its upstream. ${pullDiscards}`,
    "Force push replaces the remote branch with your local commits.",
  ].join("\n\n");
}

export function fileStatusLetter(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflicted":
      return "!";
    case "modified":
      return "M";
  }
}

export function branchSyncLabel(input: {
  readonly state: "fetch" | "pull" | "push" | "publish" | "diverged";
  readonly busy: boolean;
}): string {
  if (input.busy) return "Working…";
  switch (input.state) {
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    case "publish":
      return "Publish";
    case "diverged":
      return "Sync";
  }
}

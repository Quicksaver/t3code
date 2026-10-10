import type {
  VcsPanelBranchCommitsInput,
  VcsPanelBranchCommitsResult,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { mergePanelChangeGroups, panelBranchHasUpstream } from "@t3tools/shared/sourceControl";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  AttentionKind,
  PanelChangedFile,
  PanelFileDiffLoadState,
} from "./SourceControlPanel.logic";
import { stashIdentityKey, stashReadRef } from "./SourceControlPanel.logic";
import type { SourceControlSectionKey } from "./SourceControlPanelCache";

export type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;
export type FileDiffLoadState = PanelFileDiffLoadState;

export interface WorkingTreeChangeSetView {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly branchName: string | null;
  readonly worktreePath: string | null;
  readonly current: boolean;
  readonly changeGroups: readonly VcsPanelChangeGroup[];
  readonly files: readonly PanelChangedFile[];
  readonly selectedPaths: ReadonlySet<string>;
  readonly activity: number;
}

export type SectionKey = SourceControlSectionKey;

export const SECTION_ORDER: readonly SectionKey[] = ["work", "remotes"];
export const SECTION_TITLES: Record<SectionKey, string> = {
  work: "Actionable",
  remotes: "Remotes",
};
export const DEFAULT_SECTION_WEIGHTS: Record<SectionKey, number> = {
  work: 3,
  remotes: 1.4,
};
export const COLLAPSED_SECTION_HEIGHT = 32;
export const MIN_SECTION_WEIGHT = 0.35;
export const SECTION_RESIZE_KEY_STEP = 24;
export const COMMIT_PAGE_SIZE = 10;
export const WORKING_FILE_PREFETCH_MARGIN = 600;

const ENRICHMENT_KEY_SEPARATOR = "\0";
const readableDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Source control action failed.";
}

/** Web adds its own force gesture to the server's surface-neutral unmerged-branch refusal. */
export function withBranchForceDeleteHint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (!error.message.endsWith("has unmerged commits. Force delete it to discard them."))
    return error;
  return new Error(`${error.message} Shift-click Delete to force delete.`, { cause: error });
}

/** Identifies the parts of a repository status that a working-tree panel refresh reflects. */
export function vcsStatusFingerprint(
  status: Pick<
    VcsStatusResult,
    "refName" | "hasUpstream" | "aheadCount" | "behindCount" | "workingTree"
  >,
): string {
  return JSON.stringify({
    refName: status.refName,
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    workingTree: status.workingTree,
  });
}

/** Moves the divider below `key` by `deltaY` pixels, trading weight with the adjacent open section. */
export function resizeSectionWeights(
  weights: Record<SectionKey, number>,
  collapsed: ReadonlySet<SectionKey>,
  key: SectionKey,
  deltaY: number,
  containerHeight: number,
): Record<SectionKey, number> {
  const openKeys = SECTION_ORDER.filter((sectionKey) => !collapsed.has(sectionKey));
  const index = openKeys.indexOf(key);
  const adjacentKey = openKeys[index + 1] ?? openKeys[index - 1];
  if (index < 0 || !adjacentKey || adjacentKey === key) return weights;
  const direction = openKeys[index + 1] ? 1 : -1;
  const total = weights[key] + weights[adjacentKey];
  const deltaWeight = (deltaY / Math.max(containerHeight, 1)) * total * direction;
  const nextCurrent = Math.min(
    total - MIN_SECTION_WEIGHT,
    Math.max(MIN_SECTION_WEIGHT, weights[key] + deltaWeight),
  );
  return { ...weights, [key]: nextCurrent, [adjacentKey]: total - nextCurrent };
}

export function sourceControlPanelError(
  refreshError: string | null,
  mutationError: string | null,
): string | null {
  return mutationError ?? refreshError;
}

export function applyWorkingTreeFileEnrichment(
  groups: readonly VcsPanelChangeGroup[],
  targetCwd: string,
  enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>,
  hiddenPaths: ReadonlySet<string>,
): VcsPanelChangeGroup[] {
  if (enrichedFilesByPath.size === 0 && hiddenPaths.size === 0) {
    return groups.map((group) => ({ ...group, files: [...group.files] }));
  }
  return groups.map((group) => {
    if (group.kind !== "unstaged") return { ...group, files: [...group.files] };
    const seenPaths = new Set<string>();
    const files = group.files.flatMap((file) => {
      const key = enrichmentFileKey(targetCwd, file.path);
      if (hiddenPaths.has(key)) return [];
      const enrichedFile = enrichedFilesByPath.get(key) ?? file;
      seenPaths.add(enrichedFile.path);
      return [enrichedFile];
    });
    for (const [key, enrichedFile] of enrichedFilesByPath) {
      const parsed = splitEnrichmentFileKey(key);
      if (parsed.cwd !== targetCwd) continue;
      if (seenPaths.has(enrichedFile.path) || hiddenPaths.has(key)) continue;
      files.push(enrichedFile);
    }
    return {
      ...group,
      files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

export function shouldEnrichWorkingTreeFile(file: PanelChangedFile): boolean {
  return file.hasUnstagedChanges && (file.status === "untracked" || file.status === "deleted");
}

export function enrichmentFileKey(cwd: string, path: string): string {
  return `${cwd}${ENRICHMENT_KEY_SEPARATOR}${path}`;
}

export function splitEnrichmentFileKey(key: string): {
  readonly cwd: string;
  readonly path: string;
} {
  const separatorIndex = key.indexOf(ENRICHMENT_KEY_SEPARATOR);
  if (separatorIndex < 0) return { cwd: "", path: key };
  return {
    cwd: key.slice(0, separatorIndex),
    path: key.slice(separatorIndex + ENRICHMENT_KEY_SEPARATOR.length),
  };
}

function workingTreeEntriesByEnrichmentKey(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): Map<string, string> {
  const entries = new Map<string, string>();
  const add = (targetCwd: string, groups: readonly VcsPanelChangeGroup[]) => {
    for (const file of mergePanelChangeGroups(groups)) {
      entries.set(
        enrichmentFileKey(targetCwd, file.path),
        JSON.stringify([
          file.status,
          file.originalPath,
          file.hasStagedChanges,
          file.hasUnstagedChanges,
        ]),
      );
    }
  };
  add(cwd, snapshot.changeGroups);
  for (const changeSet of snapshot.worktreeChangeSets) {
    add(changeSet.worktreePath, changeSet.changeGroups);
  }
  return entries;
}

/**
 * Enrichment keys a new snapshot invalidates: paths that left the working tree or whose status
 * changed, whether their enrichment completed or is still queued or being read. A rename pairs
 * an enriched path with a hidden original, so both go together.
 */
export function staleWorkingTreeEnrichmentKeys(input: {
  readonly previous: VcsPanelSnapshotResult | null;
  readonly next: VcsPanelSnapshotResult;
  readonly cwd: string;
  readonly enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>;
  readonly hiddenPaths: ReadonlySet<string>;
  readonly requestedPaths: ReadonlySet<string>;
}): Set<string> {
  const previousEntries = input.previous
    ? workingTreeEntriesByEnrichmentKey(input.previous, input.cwd)
    : new Map<string, string>();
  const nextEntries = workingTreeEntriesByEnrichmentKey(input.next, input.cwd);
  const stale = new Set<string>();
  for (const key of [
    ...input.enrichedFilesByPath.keys(),
    ...input.hiddenPaths,
    ...input.requestedPaths,
  ]) {
    const entry = nextEntries.get(key);
    if (entry === undefined || entry !== previousEntries.get(key)) stale.add(key);
  }
  for (const [key, file] of input.enrichedFilesByPath) {
    if (!file.originalPath) continue;
    const originalKey = enrichmentFileKey(splitEnrichmentFileKey(key).cwd, file.originalPath);
    if (stale.has(key) || stale.has(originalKey)) {
      stale.add(key);
      if (input.hiddenPaths.has(originalKey)) stale.add(originalKey);
    }
  }
  return stale;
}

/** Enrichment keys of the snapshot files whose totals and renames load separately. */
export function workingTreeEnrichmentCandidateKeys(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): Set<string> {
  const keys = new Set<string>();
  const add = (targetCwd: string, groups: readonly VcsPanelChangeGroup[]) => {
    for (const file of mergePanelChangeGroups(groups)) {
      if (shouldEnrichWorkingTreeFile(file)) keys.add(enrichmentFileKey(targetCwd, file.path));
    }
  };
  add(cwd, snapshot.changeGroups);
  for (const changeSet of snapshot.worktreeChangeSets) {
    add(changeSet.worktreePath, changeSet.changeGroups);
  }
  return keys;
}

/**
 * How a landed snapshot revalidates working-tree enrichment. `staleKeys` lose their enrichment and
 * queued reads; `reread` keeps its displayed values while it reads again; `missing` has nothing
 * loaded, queued, or running, such as a path whose read failed, and is read on every accepted
 * snapshot, identical or not. A running batch may pair any rename candidate in its checkout, so it
 * is dropped when it read a stale path or when that checkout's candidates changed.
 */
export function planWorkingTreeEnrichmentRevalidation(input: {
  readonly previous: VcsPanelSnapshotResult | null;
  readonly next: VcsPanelSnapshotResult;
  readonly cwd: string;
  readonly enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>;
  readonly hiddenPaths: ReadonlySet<string>;
  readonly pendingPaths: ReadonlySet<string>;
  readonly inFlightPaths: ReadonlySet<string>;
}): {
  readonly staleKeys: ReadonlySet<string>;
  readonly reread: readonly string[];
  readonly missing: readonly string[];
  readonly dropRunningBatch: boolean;
} {
  const staleKeys = staleWorkingTreeEnrichmentKeys({
    ...input,
    requestedPaths: new Set([...input.pendingPaths, ...input.inFlightPaths]),
  });
  const reread = [
    ...new Set([...input.enrichedFilesByPath.keys(), ...input.hiddenPaths, ...input.inFlightPaths]),
  ].filter((key) => !staleKeys.has(key));
  const previousCandidates = input.previous
    ? workingTreeEnrichmentCandidateKeys(input.previous, input.cwd)
    : new Set<string>();
  const nextCandidates = workingTreeEnrichmentCandidateKeys(input.next, input.cwd);
  const changedCwds = new Set(
    [
      ...[...previousCandidates].filter((key) => !nextCandidates.has(key)),
      ...[...nextCandidates].filter((key) => !previousCandidates.has(key)),
    ].map((key) => splitEnrichmentFileKey(key).cwd),
  );
  const dropRunningBatch = [...input.inFlightPaths].some(
    (key) => staleKeys.has(key) || changedCwds.has(splitEnrichmentFileKey(key).cwd),
  );
  const rereadKeys = new Set(reread);
  const missing = [...nextCandidates].filter((key) => !rereadKeys.has(key));
  return { staleKeys, reread, missing, dropRunningBatch };
}

/**
 * Drops renames from an enrichment read of `targetCwd` that the latest accepted snapshot
 * contradicts, together with their hidden sources. A read can pair a destination that is staged
 * before it lands without changing the requested candidates, so a rename is kept only while its
 * destination is still untracked and its source is still an unstaged deletion.
 */
export function withoutObsoleteWorkingTreeRenames(
  result: VcsPanelWorkingTreeFileEnrichmentResult,
  snapshot: VcsPanelSnapshotResult | null,
  cwd: string,
  targetCwd: string,
): VcsPanelWorkingTreeFileEnrichmentResult {
  const groups =
    targetCwd === cwd
      ? snapshot?.changeGroups
      : snapshot?.worktreeChangeSets.find((changeSet) => changeSet.worktreePath === targetCwd)
          ?.changeGroups;
  const unstagedStatuses = new Map(
    (groups ?? [])
      .filter((group) => group.kind === "unstaged")
      .flatMap((group) => group.files.map((file) => [file.path, file.status] as const)),
  );
  const files = result.files.filter(
    (file) =>
      file.status !== "renamed" ||
      !file.originalPath ||
      (unstagedStatuses.get(file.path) === "untracked" &&
        unstagedStatuses.get(file.originalPath) === "deleted"),
  );
  if (files.length === result.files.length) return result;
  const renameSources = new Set(files.flatMap((file) => file.originalPath ?? []));
  return {
    files,
    hiddenPaths: result.hiddenPaths.filter((path) => renameSources.has(path)),
  };
}

interface WorkingTreeFileEnrichment {
  readonly enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>;
  readonly hiddenPaths: ReadonlySet<string>;
}

/**
 * Applies an enrichment read of `requestedPaths` in one checkout. The read is authoritative for
 * those paths, so a reread can unpair a rename or drop totals the server no longer reports.
 * Unchanged collections are returned as-is so a reread that changes nothing does not re-render.
 */
export function mergeWorkingTreeFileEnrichment(
  current: WorkingTreeFileEnrichment,
  targetCwd: string,
  requestedPaths: readonly string[],
  result: VcsPanelWorkingTreeFileEnrichmentResult,
): WorkingTreeFileEnrichment {
  const enriched = new Map(current.enrichedFilesByPath);
  const hidden = new Set(current.hiddenPaths);
  const touched = new Set(requestedPaths.map((path) => enrichmentFileKey(targetCwd, path)));
  for (const key of touched) {
    enriched.delete(key);
    hidden.delete(key);
  }
  for (const hiddenPath of result.hiddenPaths) {
    const key = enrichmentFileKey(targetCwd, hiddenPath);
    touched.add(key);
    enriched.delete(key);
    hidden.add(key);
  }
  for (const file of result.files) {
    const key = enrichmentFileKey(targetCwd, file.path);
    touched.add(key);
    enriched.set(key, file);
  }
  const enrichedChanged = [...touched].some((key) => {
    const previous = current.enrichedFilesByPath.get(key);
    const next = enriched.get(key);
    return previous === undefined || next === undefined
      ? previous !== next
      : JSON.stringify(previous) !== JSON.stringify(next);
  });
  const hiddenChanged = [...touched].some(
    (key) => current.hiddenPaths.has(key) !== hidden.has(key),
  );
  return {
    enrichedFilesByPath: enrichedChanged ? enriched : current.enrichedFilesByPath,
    hiddenPaths: hiddenChanged ? hidden : current.hiddenPaths,
  };
}

/**
 * Runs a panel read for the latest status notification, skipping a read whose status an earlier
 * read already covers when `skipCovered` is set. A successful read covers only the status captured
 * before it started: a status that arrives during the read may report a change the read missed,
 * even when its paths and line counts match the snapshot, so it still triggers its own read.
 */
export async function readCoveringStatus<Status, Result>(options: {
  readonly coverage: { current: Status | null };
  readonly latestStatus: () => Status | null;
  readonly skipCovered: boolean;
  readonly read: () => Promise<Result>;
}): Promise<Result | null> {
  const statusAtStart = options.latestStatus();
  if (options.skipCovered && statusAtStart !== null && statusAtStart === options.coverage.current) {
    return null;
  }
  const result = await options.read();
  if (statusAtStart !== null) options.coverage.current = statusAtStart;
  return result;
}

export function isActionForced(event: ReactMouseEvent): boolean {
  return event.shiftKey;
}

export function shouldFetchBeforePull(event: ReactMouseEvent): boolean {
  return event.altKey;
}

export function commitUndoActionKey(branchName: string, sha?: string): string {
  return sha ? `commit-undo:${branchName}:${sha}` : `branch-undo-latest:${branchName}`;
}

export function treeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function formatReadableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return readableDateFormatter.format(new Date(time));
}

export function sumFiles(files: readonly VcsPanelFileChange[]) {
  return files.reduce(
    (total, file) => ({
      insertions: total.insertions + file.insertions,
      deletions: total.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

export function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part) return part;
  }
  return path;
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

export function renameOriginalPathForFile(
  file: Pick<VcsPanelFileChange, "originalPath" | "status">,
): string | undefined {
  return file.status === "renamed" && file.originalPath ? file.originalPath : undefined;
}

export function operationPathsForFile(
  file: Pick<VcsPanelFileChange, "path" | "originalPath" | "status">,
): string[] {
  const originalPath = renameOriginalPathForFile(file);
  return uniquePaths(originalPath ? [file.path, originalPath] : [file.path]);
}

export function worktreeChangeSetId(
  changeSet: Pick<VcsPanelWorktreeChangeSet, "worktreePath">,
): string {
  return `worktree:${changeSet.worktreePath}`;
}

export function changeSetAttention(files: readonly PanelChangedFile[]): AttentionKind {
  return files.some((file) => file.hasConflicts)
    ? "conflicts"
    : files.length > 0
      ? "dirty"
      : "stale";
}

export function commitCountLabel(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

export function stashBranchName(stash: VcsPanelStash): string | null {
  return /^(?:WIP\s+)?on\s+([^:]+):/i.exec(stash.message)?.[1]?.trim() ?? null;
}

export function branchActivityTimestamp(branch: {
  readonly lastActivityAt?: string | null | undefined;
}): number {
  if (!branch.lastActivityAt) return 0;
  const time = Date.parse(branch.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

export function mapBranchDetails(
  details: readonly VcsPanelBranchDetails[],
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const map = new Map<string, VcsPanelBranchDetails>();
  for (const detail of details) {
    map.set(detail.fullRefName, detail);
    map.set(detail.name, detail);
  }
  return map;
}

/** Stores one branch's loaded details. Only the ordinary branch identity owns its name aliases. */
export function withBranchDetails(
  current: ReadonlyMap<string, VcsPanelBranchDetails>,
  request: { readonly branch: VcsRef; readonly detailsKey: string },
  details: VcsPanelBranchDetails,
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const next = new Map(current);
  next.set(request.detailsKey, details);
  if (request.detailsKey === request.branch.name) {
    next.set(details.fullRefName, details);
    next.set(details.name, details);
  }
  return next;
}

/**
 * The details that stay valid when a branch-list change rereads every expanded branch: the
 * snapshot's own details, plus the displayed entries of `rereadKeys` until their reads land.
 * Everything else is obsolete and reloads when its branch is next expanded.
 */
export function retainBranchDetailsForReload(
  current: ReadonlyMap<string, VcsPanelBranchDetails>,
  snapshotDetails: readonly VcsPanelBranchDetails[],
  rereadKeys: readonly string[],
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const next = new Map(mapBranchDetails(snapshotDetails));
  for (const key of rereadKeys) {
    const existing = current.get(key);
    if (!existing) continue;
    for (const alias of [key, existing.fullRefName, existing.name]) {
      if (!next.has(alias) && current.get(alias) === existing) next.set(alias, existing);
    }
  }
  return next;
}

export type BranchCommitListKind = NonNullable<VcsPanelBranchCommitsInput["kind"]>;

// Appends a loaded commit page to one details entry. Only the ordinary branch identity owns the
// branch's name aliases, so a fork comparison's page never replaces the ordinary row's details.
// A page requested under a base the entry no longer uses is dropped.
export function appendBranchCommitPage(
  current: ReadonlyMap<string, VcsPanelBranchDetails>,
  request: {
    readonly branch: VcsRef;
    readonly details: VcsPanelBranchDetails;
    readonly detailsKey: string;
    readonly kind: BranchCommitListKind;
  },
  page: VcsPanelBranchCommitsResult,
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const { branch, details, detailsKey, kind } = request;
  const ordinary = detailsKey === branch.name;
  const existing =
    current.get(detailsKey) ?? (ordinary ? current.get(details.fullRefName) : undefined) ?? details;
  if (existing.baseRef !== details.baseRef) return current;
  const merged =
    kind === "ahead"
      ? {
          ...existing,
          aheadCommits: [...existing.aheadCommits, ...page.commits],
          aheadCommitsRemaining: page.remaining,
        }
      : kind === "behind"
        ? {
            ...existing,
            behindCommits: [...existing.behindCommits, ...page.commits],
            behindCommitsRemaining: page.remaining,
          }
        : kind === "compare-history"
          ? {
              ...existing,
              compareCommits: [...existing.compareCommits, ...page.commits],
              compareCommitsRemaining: page.remaining,
            }
          : {
              ...existing,
              commits: [...existing.commits, ...page.commits],
              commitsRemaining: page.remaining,
            };
  const next = new Map(current);
  next.set(detailsKey, merged);
  if (ordinary) {
    next.set(merged.fullRefName, merged);
    next.set(merged.name, merged);
  }
  return next;
}

export function remoteBranchRef(
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef {
  return {
    name: branch.fullRefName,
    isRemote: true,
    remoteName: remote.name,
    current: false,
    isDefault: branch.isDefaultRemoteHead,
    worktreePath: null,
    lastActivityAt: branch.lastActivityAt,
    upstreamName: null,
  };
}

export function localBranchForRemoteBranch(
  snapshot: VcsPanelSnapshotResult,
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef | null {
  return (
    snapshot.localBranches.find(
      (localBranch) =>
        localBranch.upstreamRemoteName === remote.name &&
        localBranch.upstreamName === branch.fullRefName,
    ) ??
    snapshot.localBranches.find(
      (localBranch) =>
        localBranch.name === branch.name &&
        localBranch.upstreamRemoteName === remote.name &&
        localBranch.upstreamName === `${remote.name}/${branch.name}`,
    ) ??
    null
  );
}

export function localOnlyBranches(snapshot: VcsPanelSnapshotResult): VcsRef[] {
  return snapshot.localBranches
    .filter((branch) => !panelBranchHasUpstream(branch, snapshot))
    .toSorted((left, right) => branchActivityTimestamp(right) - branchActivityTimestamp(left));
}

export function compareBaseRefNames(snapshot: VcsPanelSnapshotResult | null): string[] {
  if (!snapshot) return [];
  const refs = new Set<string>();
  if (snapshot.defaultCompareRef) refs.add(snapshot.defaultCompareRef);
  for (const branch of snapshot.localBranches) {
    refs.add(branch.name);
    if (branch.upstreamName) refs.add(branch.upstreamName);
  }
  for (const remote of snapshot.remotes) {
    for (const branch of remote.branches) refs.add(branch.fullRefName);
  }
  return [...refs].toSorted((left, right) => left.localeCompare(right));
}

interface ExpandedBranchRequest {
  readonly branch: VcsRef;
  readonly detailsKey: string;
  readonly compareBaseRef?: string;
}

export function expandedBranchesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): ExpandedBranchRequest[] {
  const localBranches = snapshot.localBranches
    .filter((branch) => expanded.has(treeKey("branch", branch.name)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const expandedLocalBranches = localOnlyBranches(snapshot)
    .filter((branch) => expanded.has(treeKey("remote-branch", `local:${branch.name}`)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const remoteBranches = snapshot.remotes.flatMap((remote) =>
    remote.branches
      .map((branch) => ({
        displayName: branch.name,
        ref:
          localBranchForRemoteBranch(snapshot, remote, branch) ?? remoteBranchRef(remote, branch),
      }))
      .filter((branch) =>
        expanded.has(
          treeKey("remote-branch", `${branch.ref.remoteName ?? "local"}:${branch.displayName}`),
        ),
      )
      .map((branch) => ({ branch: branch.ref, detailsKey: branch.ref.name })),
  );
  const forkBranches = snapshot.actionableForkBranches.flatMap((fork) => {
    const branch = snapshot.localBranches.find(
      (localBranch) => localBranch.name === fork.localBranchName,
    );
    if (!branch) return [];
    const detailsKey = treeKey("fork-details", `${fork.localBranchName}:${fork.remoteRefName}`);
    return expanded.has(treeKey("fork-branch", `${fork.localBranchName}:${fork.remoteRefName}`))
      ? [{ branch, detailsKey, compareBaseRef: fork.remoteRefName }]
      : [];
  });
  // A branch expanded in several places shares one details entry, so it is requested once.
  const seenDetailsKeys = new Set<string>();
  return [...localBranches, ...expandedLocalBranches, ...remoteBranches, ...forkBranches].filter(
    (request) => {
      if (seenDetailsKeys.has(request.detailsKey)) return false;
      seenDetailsKeys.add(request.detailsKey);
      return true;
    },
  );
}

interface ExpandedStashRequest {
  readonly stashRef: string;
  readonly detailsKey: string;
}

export function expandedStashesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): ExpandedStashRequest[] {
  return snapshot.stashes
    .filter((stash) => expanded.has(treeKey("stash", stashIdentityKey(stash))))
    .map((stash) => ({ stashRef: stashReadRef(stash), detailsKey: stashIdentityKey(stash) }));
}

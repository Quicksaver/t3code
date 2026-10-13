import type {
  EnvironmentId,
  EnvironmentMachineKind,
  LocalApi,
  ProjectId,
  ProjectScript,
  VcsPanelBranchDetails,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelStash,
  VcsPanelSnapshotResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  panelBranchHasUpstream,
  panelBranchOperationCwd,
  panelBranchSyncCounts,
  panelBranchSyncState,
  type BranchAttentionKind,
  type BranchSyncState,
  type PanelChangedFile,
} from "@t3tools/shared/sourceControl";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

export type { BranchSyncState, PanelChangedFile };

export type AttentionKind = BranchAttentionKind;

type PanelRefreshMode = "full" | "working-tree";

export function confirmSourceControlPanelMutation(
  confirm: LocalApi["dialogs"]["confirm"],
  message: string,
): Promise<boolean> {
  return confirm(message, { variant: "destructive" });
}

export interface SourceControlEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly machine: EnvironmentMachineKind;
  readonly cwd: string;
  readonly connected: boolean;
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: readonly ProjectScript[];
    readonly preferredScriptId: string | null;
  };
}

export interface FederatedSourceControlTarget extends SourceControlEnvironmentCandidate {
  readonly active: boolean;
  readonly worktreePath: string | null;
}

export interface SourceControlPeerSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function isFederatedSourceControlTargetExpanded(
  target: Pick<FederatedSourceControlTarget, "active" | "environmentId">,
  expandedEnvironmentIds: ReadonlySet<EnvironmentId>,
): boolean {
  return target.active || expandedEnvironmentIds.has(target.environmentId);
}

export function branchNeedsRepositoryPublish(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): boolean {
  return snapshot.remotes.length === 0 && !panelBranchHasUpstream(branch, snapshot);
}

export function resolveFederatedSourceControlTargets(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly activeCwd: string;
  readonly activeWorktreePath: string | null;
  readonly candidates: readonly SourceControlEnvironmentCandidate[];
}): FederatedSourceControlTarget[] {
  const targetByEnvironmentId = new Map<EnvironmentId, FederatedSourceControlTarget>();
  for (const candidate of input.candidates) {
    if (!candidate.connected || targetByEnvironmentId.has(candidate.environmentId)) continue;
    const active = candidate.environmentId === input.activeEnvironmentId;
    targetByEnvironmentId.set(candidate.environmentId, {
      ...candidate,
      active,
      cwd: active ? input.activeCwd : candidate.cwd,
      worktreePath: active ? input.activeWorktreePath : null,
    });
  }

  return [...targetByEnvironmentId.values()].toSorted((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

interface TrackedBranchRemote {
  readonly branchName: string;
  readonly remoteKey: string;
}

function trackedBranchRemote(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
  direction: "fetch" | "push",
): TrackedBranchRemote | null {
  const upstreamName = branch.upstreamName?.trim();
  if (!upstreamName || !branch.upstreamRemoteName || branch.upstreamRemoteName === ".") return null;

  const remote = snapshot.remotes.find((candidate) => candidate.name === branch.upstreamRemoteName);
  if (!remote || !upstreamName.startsWith(`${remote.name}/`)) return null;

  const remoteUrl =
    direction === "push"
      ? (remote.pushUrl ?? remote.fetchUrl)
      : (remote.fetchUrl ?? remote.pushUrl);
  if (!remoteUrl) return null;

  return {
    branchName: upstreamName.slice(remote.name.length + 1),
    remoteKey: normalizeGitRemoteUrl(remoteUrl),
  };
}

function eligiblePeerBranch(input: {
  readonly snapshot: VcsPanelSnapshotResult;
  readonly branchName: string;
  readonly remote: TrackedBranchRemote;
}): VcsRef | null {
  if (
    !input.snapshot.status.isRepo ||
    input.snapshot.status.refName !== input.branchName ||
    input.snapshot.status.hasWorkingTreeChanges
  ) {
    return null;
  }

  const branch = input.snapshot.localBranches.find(
    (candidate) => candidate.current && candidate.name === input.branchName,
  );
  if (!branch || !panelBranchHasUpstream(branch, input.snapshot)) return null;

  const trackedRemote = trackedBranchRemote(branch, input.snapshot, "fetch");
  if (
    !trackedRemote ||
    trackedRemote.remoteKey !== input.remote.remoteKey ||
    trackedRemote.branchName !== input.remote.branchName
  ) {
    return null;
  }

  const counts = panelBranchSyncCounts(branch, input.snapshot);
  if (counts.aheadCount > 0) return null;
  return branch;
}

/**
 * Push one branch and then fast-forward matching checkouts on other connected environments.
 * A push failure rejects immediately without touching peers. Peer reads and mutations are best-effort because their availability must not turn a successful
 * source push into a reported push failure.
 */
export async function pushBranchAndSyncPeers(options: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceBranch: VcsRef;
  readonly sourceSnapshot: VcsPanelSnapshotResult;
  readonly force: boolean;
  readonly peerTargets: readonly SourceControlPeerSyncTarget[];
  readonly push: () => Promise<void>;
  readonly readPeerSnapshot: (
    target: SourceControlPeerSyncTarget,
  ) => Promise<VcsPanelSnapshotResult>;
  readonly fetchPeerBranch: (
    target: SourceControlPeerSyncTarget,
    branchName: string,
  ) => Promise<void>;
  readonly pullPeerBranch: (
    target: SourceControlPeerSyncTarget,
    branchName: string,
  ) => Promise<void>;
  readonly onPeerError?: (target: SourceControlPeerSyncTarget, error: unknown) => void;
}): Promise<void> {
  const sourceRemote = trackedBranchRemote(options.sourceBranch, options.sourceSnapshot, "push");
  const shouldSyncPeers =
    !options.force &&
    sourceRemote !== null &&
    panelBranchSyncState(options.sourceBranch, options.sourceSnapshot) === "push";

  if (!shouldSyncPeers) {
    await options.push();
    return;
  }

  const peerTargets = options.peerTargets.filter(
    (target) => target.environmentId !== options.sourceEnvironmentId,
  );
  // Peer eligibility reads run beside the push so a slow environment never delays it; peers are
  // only fetched and fast-forwarded once the push has succeeded.
  const pushed = options.push();
  const peerSyncs = peerTargets.map(async (target) => {
    try {
      const eligible = eligiblePeerBranch({
        snapshot: await options.readPeerSnapshot(target),
        branchName: options.sourceBranch.name,
        remote: sourceRemote,
      });
      if (!eligible) return;
    } catch (error) {
      options.onPeerError?.(target, error);
      return;
    }
    try {
      await pushed;
    } catch {
      // The caller reports the push failure itself.
      return;
    }
    try {
      await options.fetchPeerBranch(target, options.sourceBranch.name);
      const snapshot = await options.readPeerSnapshot(target);
      const branch = eligiblePeerBranch({
        snapshot,
        branchName: options.sourceBranch.name,
        remote: sourceRemote,
      });
      if (!branch) return;
      if (panelBranchSyncCounts(branch, snapshot).behindCount > 0) {
        await options.pullPeerBranch(target, options.sourceBranch.name);
      }
    } catch (error) {
      options.onPeerError?.(target, error);
    }
  });

  await pushed;
  await Promise.all(peerSyncs);
}

export interface PanelRefreshRequest {
  readonly mode: PanelRefreshMode;
  // Authoritative reads never join a snapshot request that began before the caller's mutation.
  readonly authoritative: boolean;
}

interface QueuedPanelRefresh extends PanelRefreshRequest {
  readonly settle: readonly (() => void)[];
}

export interface PanelRefreshQueue {
  inFlight: boolean;
  queued: QueuedPanelRefresh | null;
}

/**
 * Queue a refresh behind the running one. The returned promise settles once the queued run that
 * covers this request completes or fails, so callers can hold their busy state until then.
 */
export function enqueuePanelRefresh(
  queue: PanelRefreshQueue,
  request: PanelRefreshRequest,
): Promise<void> {
  return new Promise((resolve) => {
    const current = queue.queued;
    queue.queued = {
      mode: current?.mode === "full" || request.mode === "full" ? "full" : "working-tree",
      authoritative: (current?.authoritative ?? false) || request.authoritative,
      settle: [...(current?.settle ?? []), resolve],
    };
  });
}

/** Run a refresh, then every refresh queued while it ran, merging requests queued together. */
export async function drainPanelRefreshQueue(
  queue: PanelRefreshQueue,
  initial: PanelRefreshRequest,
  options: {
    readonly run: (request: PanelRefreshRequest) => Promise<void>;
    readonly onError: (error: unknown) => void;
  },
): Promise<void> {
  queue.inFlight = true;
  try {
    let request = initial;
    let settle: readonly (() => void)[] = [];
    while (true) {
      try {
        await options.run(request);
      } catch (error) {
        options.onError(error);
      }
      for (const resolve of settle) resolve();
      const queued = queue.queued;
      queue.queued = null;
      if (queued === null) return;
      request = { mode: queued.mode, authoritative: queued.authoritative };
      settle = queued.settle;
    }
  } finally {
    queue.inFlight = false;
  }
}

type PanelActionResult =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly error: unknown };

export async function runPanelActionAndReconcile(options: {
  readonly action: () => Promise<void>;
  readonly reconcile: () => Promise<void>;
}): Promise<PanelActionResult> {
  let result: PanelActionResult;
  try {
    await options.action();
    result = { status: "success" };
  } catch (error) {
    result = { status: "failure", error };
  }
  try {
    await options.reconcile();
  } catch (error) {
    return result.status === "failure" ? result : { status: "failure", error };
  }
  return result;
}

export async function resolveBranchSyncSnapshot(options: {
  readonly snapshot: VcsPanelSnapshotResult;
  readonly fetchFirst: boolean;
  readonly fetch: () => Promise<void>;
  readonly refreshSnapshot: () => Promise<VcsPanelSnapshotResult>;
}): Promise<VcsPanelSnapshotResult> {
  if (!options.fetchFirst) return options.snapshot;
  await options.fetch();
  return options.refreshSnapshot();
}

export function beginPanelAction(runningActionKeys: Set<string>, actionKey: string): boolean {
  if (runningActionKeys.has(actionKey)) return false;
  // Stash mutations can renumber every stash ref, so only one can run at a time.
  if (
    actionKey.startsWith("stash-mutation:") &&
    [...runningActionKeys].some((key) => key.startsWith("stash-mutation:"))
  )
    return false;
  runningActionKeys.add(actionKey);
  return true;
}

export function beginPanelDetailRequest(requestsByKey: Map<string, number>, key: string): number {
  const requestId = (requestsByKey.get(key) ?? 0) + 1;
  requestsByKey.set(key, requestId);
  return requestId;
}

/**
 * Advances every tracked key outside `keptKeys`, so reads still running for them can no longer
 * land. Returns the superseded keys.
 */
export function supersedePanelDetailRequests(
  requestsByKey: Map<string, number>,
  keptKeys: ReadonlySet<string>,
): string[] {
  const superseded = [...requestsByKey.keys()].filter((key) => !keptKeys.has(key));
  for (const key of superseded) beginPanelDetailRequest(requestsByKey, key);
  return superseded;
}

export function isLatestPanelDetailRequest(
  requestsByKey: ReadonlyMap<string, number>,
  key: string,
  requestId: number,
): boolean {
  return requestsByKey.get(key) === requestId;
}

export function branchIsCheckedOut(branch: VcsRef | undefined): boolean {
  return branch?.current === true || branch?.worktreePath != null;
}

export type ForcedBranchSyncSide = "push" | "pull";

export interface ForcedBranchSyncConfirmation {
  readonly side: ForcedBranchSyncSide;
  readonly message: string;
}

// Shift-click sync forces whichever direction the branch needs, so the prompt
// names what will be overwritten; states where force changes nothing skip it.
// Force may only be applied to the confirmed side.
export function forcedBranchSyncConfirmation(
  branch: VcsRef,
  state: BranchSyncState,
  fetchFirst: boolean,
): ForcedBranchSyncConfirmation | null {
  const reset = {
    side: "pull",
    message: branchIsCheckedOut(branch)
      ? `Reset ${branch.name} to its upstream? Uncommitted changes and local commits are discarded.`
      : `Reset ${branch.name} to its upstream? Local commits on it are discarded.`,
  } as const;
  switch (state) {
    case "publish":
    case "push":
      return {
        side: "push",
        message: `Force push ${branch.name}? The remote branch is replaced with your local commits.`,
      };
    case "pull":
      return reset;
    case "fetch":
      return branch.current && fetchFirst ? reset : null;
    case "diverged":
      return null;
  }
}

/**
 * After fetch-first, the branch may need the other direction than the one the user confirmed.
 * Returns the confirmation for the side that would actually be forced, or null when the
 * confirmed side still applies or nothing would be forced.
 */
export function forcedBranchSyncReconfirmation(
  branch: VcsRef,
  confirmedSide: ForcedBranchSyncSide | null,
  stateAfterFetch: BranchSyncState,
): ForcedBranchSyncConfirmation | null {
  if (confirmedSide === null) return null;
  const confirmation = forcedBranchSyncConfirmation(branch, stateAfterFetch, false);
  return confirmation && confirmation.side !== confirmedSide ? confirmation : null;
}

export function namedBranchOperationCwd(
  branches: readonly VcsRef[],
  branchName: string,
  fallbackCwd: string,
): string {
  const branch = branches.find((candidate) => candidate.name === branchName);
  return branch ? panelBranchOperationCwd(branch, fallbackCwd) : fallbackCwd;
}

export type PanelFileDiffLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly patch: string }
  | { readonly status: "error"; readonly message: string };

export function vcsPanelSnapshotFingerprint(cwd: string, snapshot: VcsPanelSnapshotResult): string {
  return `${cwd}\0${JSON.stringify(snapshot)}`;
}

export function stashIdentityKey(stash: VcsPanelStash): string {
  return stash.sha ? `sha:${stash.sha}` : `ref:${stash.refName}`;
}

// Reads target the immutable stash commit; mutations keep the positional ref plus expectedSha.
export function stashReadRef(stash: VcsPanelStash): string {
  return stash.sha ?? stash.refName;
}

type PanelFileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;

// Commit and stash-commit patches never change, so a loaded one can be reused on reopen.
export function isImmutableFileDiffSource(source: PanelFileDiffSource): boolean {
  switch (source.kind) {
    case "commit":
      return true;
    case "stash":
      return !source.stashRef.startsWith("stash@{");
    case "compare":
    case "working-tree":
      return false;
  }
}

/** Compare-diff sources for loaded branch details, which are stored under several alias keys. */
export function branchCompareFileDiffRequests(details: Iterable<VcsPanelBranchDetails>): {
  readonly file: VcsPanelFileChange;
  readonly source: Extract<PanelFileDiffSource, { readonly kind: "compare" }>;
}[] {
  const seen = new Set<string>();
  return [...details].flatMap((detail) => {
    const baseRef = detail.baseRef;
    if (!baseRef) return [];
    const identity = `${baseRef}\0${detail.name}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return detail.compareFiles.map((file) => ({
      file,
      source: { kind: "compare" as const, baseRef, refName: detail.name },
    }));
  });
}

export function beginPanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  options: { readonly preserveLoaded?: boolean } = {},
): PanelFileDiffLoadState {
  if (options.preserveLoaded && current?.status === "loaded") return current;
  return { status: "loading" };
}

export function completePanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  patch: string,
): PanelFileDiffLoadState {
  if (current?.status === "loaded" && current.patch === patch) return current;
  return { status: "loaded", patch };
}

export function failPanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  message: string,
  options: { readonly preserveLoaded?: boolean } = {},
): PanelFileDiffLoadState {
  if (options.preserveLoaded && current?.status === "loaded") return current;
  return { status: "error", message };
}

export function formatRelativeDate(
  value: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const elapsedMs = now - time;
  if (elapsedMs <= 0) return "just now";
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  if (days < 30) return `${weeks} weeks ago`;
  const months = Math.min(11, Math.floor(days / 30));
  if (days < 365) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Match the item being acted on, including operations on its expanded children. */
export function panelItemActivity(
  runningActions: ReadonlyMap<string, string>,
  keys: readonly string[],
  prefixes: readonly string[] = [],
): string | null {
  for (const [key, label] of runningActions) {
    if (keys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix))) return label;
  }
  return null;
}

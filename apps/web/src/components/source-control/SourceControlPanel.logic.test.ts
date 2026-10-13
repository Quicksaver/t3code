import { describe, expect, it } from "@effect/vitest";
import {
  panelBranchAttention,
  panelBranchHasUpstream,
  panelBranchOperationCwd,
  panelBranchSyncState,
} from "@t3tools/shared/sourceControl";
import {
  EnvironmentId,
  type VcsPanelBranchDetails,
  type VcsPanelFileChange,
  type VcsPanelSnapshotResult,
  type VcsRef,
} from "@t3tools/contracts";

import {
  beginPanelFileDiffLoad,
  beginPanelAction,
  panelItemActivity,
  branchCompareFileDiffRequests,
  branchNeedsRepositoryPublish,
  branchIsCheckedOut,
  completePanelFileDiffLoad,
  drainPanelRefreshQueue,
  enqueuePanelRefresh,
  failPanelFileDiffLoad,
  forcedBranchSyncConfirmation,
  forcedBranchSyncReconfirmation,
  formatRelativeDate,
  isFederatedSourceControlTargetExpanded,
  isImmutableFileDiffSource,
  namedBranchOperationCwd,
  pushBranchAndSyncPeers,
  resolveFederatedSourceControlTargets,
  resolveBranchSyncSnapshot,
  runPanelActionAndReconcile,
  stashIdentityKey,
  stashReadRef,
  type PanelRefreshQueue,
  type PanelRefreshRequest,
} from "./SourceControlPanel.logic";
import {
  appendBranchCommitPage,
  applyWorkingTreeFileEnrichment,
  compareBaseRefNames,
  enrichmentFileKey,
  expandedBranchesForSnapshot,
  expandedStashesForSnapshot,
  localBranchForRemoteBranch,
  localOnlyBranches,
  operationPathsForFile,
  renameOriginalPathForFile,
  resizeSectionWeights,
  sourceControlPanelError,
  splitEnrichmentFileKey,
  stashBranchName,
  staleWorkingTreeEnrichmentKeys,
  treeKey,
  withBranchForceDeleteHint,
} from "./SourceControlPanelModel";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-primary");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const DISCONNECTED_ENVIRONMENT_ID = EnvironmentId.make("environment-disconnected");

const baseSnapshot: VcsPanelSnapshotResult = {
  status: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "split/vscode-extension-work",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 7,
    behindCount: 47,
    aheadOfDefaultCount: 0,
    pr: null,
  },
  changeGroups: [],
  worktreeChangeSets: [],
  localBranches: [],
  branchDetails: [],
  remotes: [
    {
      name: "origin",
      fetchUrl: "git@example.test:fork/repo.git",
      pushUrl: "git@example.test:fork/repo.git",
      provider: null,
      branches: [],
    },
    {
      name: "upstream",
      fetchUrl: "git@example.test:upstream/repo.git",
      pushUrl: "git@example.test:upstream/repo.git",
      provider: null,
      branches: [{ name: "main", fullRefName: "upstream/main", isDefaultRemoteHead: true }],
    },
  ],
  actionableForkBranches: [],
  stashes: [],
  recentCommits: [],
  defaultCompareRef: "upstream/main",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function branch(input: Partial<VcsRef>): VcsRef {
  return {
    name: "split/vscode-extension-work",
    current: false,
    isDefault: false,
    worktreePath: null,
    ...input,
  };
}

describe("SourceControlPanel branch sync logic", () => {
  it("refreshes branch sync state after a fetch-before-sync request", async () => {
    const calls: string[] = [];
    const refreshedSnapshot = {
      ...baseSnapshot,
      status: {
        ...baseSnapshot.status,
        aheadCount: 0,
        behindCount: 3,
      },
    };

    const resolved = await resolveBranchSyncSnapshot({
      snapshot: baseSnapshot,
      fetchFirst: true,
      fetch: async () => {
        calls.push("fetch");
      },
      refreshSnapshot: async () => {
        calls.push("snapshot");
        return refreshedSnapshot;
      },
    });

    expect(calls).toEqual(["fetch", "snapshot"]);
    expect(resolved).toBe(refreshedSnapshot);
    expect(
      panelBranchSyncState(
        branch({
          name: "topic",
          current: true,
          upstreamName: "origin/topic",
          upstreamRemoteName: "origin",
        }),
        resolved,
      ),
    ).toBe("pull");
  });

  it("reuses the current branch sync snapshot when no prefetch is requested", async () => {
    let fetched = false;
    const resolved = await resolveBranchSyncSnapshot({
      snapshot: baseSnapshot,
      fetchFirst: false,
      fetch: async () => {
        fetched = true;
      },
      refreshSnapshot: async () => {
        throw new Error("unexpected snapshot refresh");
      },
    });

    expect(fetched).toBe(false);
    expect(resolved).toBe(baseSnapshot);
  });

  it("publishes a local branch whose configured upstream is only its comparison base", () => {
    const localBranch = branch({
      current: true,
      upstreamName: "upstream/main",
      upstreamRemoteName: "upstream",
      aheadCount: 7,
      behindCount: 47,
    });

    expect(panelBranchHasUpstream(localBranch, baseSnapshot)).toBe(false);
    expect(panelBranchSyncState(localBranch, baseSnapshot)).toBe("publish");
    expect(panelBranchAttention(localBranch, baseSnapshot)).toBe("unpushed");
  });

  it("opens repository publishing instead of pushing when no remote exists", () => {
    const unpublishedSnapshot = {
      ...baseSnapshot,
      status: { ...baseSnapshot.status, hasPrimaryRemote: false, hasUpstream: false },
      remotes: [],
    };

    expect(branchNeedsRepositoryPublish(branch({ current: true }), unpublishedSnapshot)).toBe(true);
    expect(branchNeedsRepositoryPublish(branch({ current: true }), baseSnapshot)).toBe(false);
  });

  it("treats a same-name remote tracking branch as the sync upstream", () => {
    const localBranch = branch({
      name: "split/subagent-threading-work",
      upstreamName: "origin/split/subagent-threading-work",
      upstreamRemoteName: "origin",
      aheadCount: 0,
      behindCount: 3,
    });

    expect(panelBranchHasUpstream(localBranch, baseSnapshot)).toBe(true);
    expect(panelBranchSyncState(localBranch, baseSnapshot)).toBe("pull");
    expect(panelBranchAttention(localBranch, baseSnapshot)).toBe("behind");
  });

  it("targets the branch worktree cwd for branch operations when present", () => {
    expect(
      panelBranchOperationCwd(
        branch({
          worktreePath: "/repo.worktrees/feature",
        }),
        "/repo",
      ),
    ).toBe("/repo.worktrees/feature");
    expect(panelBranchOperationCwd(branch({}), "/repo")).toBe("/repo");
  });

  it("resolves named branch actions to the checkout that owns the branch", () => {
    const branches = [
      branch({ name: "main", current: true, worktreePath: "/repo" }),
      branch({ name: "feature", worktreePath: "/repo.worktrees/feature" }),
    ];

    expect(namedBranchOperationCwd(branches, "feature", "/repo")).toBe("/repo.worktrees/feature");
    expect(namedBranchOperationCwd(branches, "missing", "/repo")).toBe("/repo");
  });

  it("treats current and sibling-worktree branches as checked out", () => {
    expect(branchIsCheckedOut(branch({ current: true }))).toBe(true);
    expect(branchIsCheckedOut(branch({ worktreePath: "/repo.worktrees/feature" }))).toBe(true);
    expect(branchIsCheckedOut(branch({}))).toBe(false);
    expect(branchIsCheckedOut(undefined)).toBe(false);
  });

  it("confirms forced syncs that overwrite one side of the branch", () => {
    const current = branch({ name: "feature", current: true });
    const sibling = branch({ name: "feature", worktreePath: "/repo.worktrees/feature" });
    const unchecked = branch({ name: "feature" });

    expect(forcedBranchSyncConfirmation(unchecked, "push", false)).toEqual({
      side: "push",
      message: expect.stringContaining("Force push feature?"),
    });
    expect(forcedBranchSyncConfirmation(unchecked, "publish", false)?.side).toBe("push");
    expect(forcedBranchSyncConfirmation(current, "pull", false)?.message).toContain(
      "Uncommitted changes",
    );
    expect(forcedBranchSyncConfirmation(sibling, "pull", false)?.message).toContain(
      "Uncommitted changes",
    );
    expect(forcedBranchSyncConfirmation(unchecked, "pull", false)).toEqual({
      side: "pull",
      message: "Reset feature to its upstream? Local commits on it are discarded.",
    });
    expect(forcedBranchSyncConfirmation(current, "fetch", true)).toEqual({
      side: "pull",
      message: expect.stringContaining("Reset feature"),
    });
    expect(forcedBranchSyncConfirmation(current, "fetch", false)).toBeNull();
    expect(forcedBranchSyncConfirmation(unchecked, "fetch", true)).toBeNull();
    expect(forcedBranchSyncConfirmation(current, "diverged", false)).toBeNull();
  });

  it("requires a new confirmation when fetch-first flips the forced side", () => {
    const current = branch({ name: "feature", current: true });

    // Confirmed a force push, but the remote advanced past the local commits.
    expect(forcedBranchSyncReconfirmation(current, "push", "pull")).toEqual({
      side: "pull",
      message: expect.stringContaining("Uncommitted changes"),
    });
    // Confirmed a fetch-first reset, but only local commits remain after fetching.
    expect(forcedBranchSyncReconfirmation(current, "pull", "push")).toEqual({
      side: "push",
      message: expect.stringContaining("Force push feature?"),
    });
    expect(forcedBranchSyncReconfirmation(current, "push", "push")).toBeNull();
    expect(forcedBranchSyncReconfirmation(current, "pull", "pull")).toBeNull();
    expect(forcedBranchSyncReconfirmation(current, "pull", "fetch")).toBeNull();
    expect(forcedBranchSyncReconfirmation(current, null, "pull")).toBeNull();
  });
});

describe("SourceControlPanel working-tree presentation logic", () => {
  it.each([".", undefined])(
    "keeps %s upstream identity out of remote pairing and sync",
    (upstreamRemoteName) => {
      const local = branch({
        name: "main",
        upstreamName: "origin/main",
        ...(upstreamRemoteName ? { upstreamRemoteName } : {}),
      });
      const tracker = branch({
        name: "tracker",
        upstreamName: "origin/main",
        upstreamRemoteName: "origin",
      });
      const remote = {
        ...baseSnapshot.remotes[0]!,
        branches: [{ name: "main", fullRefName: "origin/main", isDefaultRemoteHead: false }],
      };
      const snapshot = { ...baseSnapshot, localBranches: [local] };
      expect(localBranchForRemoteBranch(snapshot, remote, remote.branches[0]!)).toBeNull();
      expect(panelBranchHasUpstream(local, snapshot)).toBe(false);
      expect(
        localBranchForRemoteBranch(
          { ...snapshot, localBranches: [local, tracker] },
          remote,
          remote.branches[0]!,
        ),
      ).toBe(tracker);
      expect(panelBranchHasUpstream({ ...local, upstreamRemoteName: "origin" }, snapshot)).toBe(
        true,
      );
    },
  );

  it("formats future timestamps as just now", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const then = new Date(now + 5 * 60 * 1000).toISOString();

    expect(formatRelativeDate(then, now)).toBe("just now");
  });

  it("formats late-month dates before the one-year threshold as months", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const then = new Date(now - 360 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatRelativeDate(then, now)).toBe("11 months ago");
  });

  it("includes the original path for renames but not copies", () => {
    expect(
      operationPathsForFile({
        path: "src/renamed.ts",
        originalPath: "src/original.ts",
        status: "renamed",
      }),
    ).toEqual(["src/renamed.ts", "src/original.ts"]);
    expect(
      operationPathsForFile({
        path: "src/copied.ts",
        originalPath: "src/original.ts",
        status: "copied",
      }),
    ).toEqual(["src/copied.ts"]);
  });

  it("passes an original path to diff requests only for renames", () => {
    expect(
      renameOriginalPathForFile({
        originalPath: "src/original.ts",
        status: "renamed",
      }),
    ).toBe("src/original.ts");
    expect(
      renameOriginalPathForFile({
        originalPath: "src/original.ts",
        status: "copied",
      }),
    ).toBeUndefined();
  });
});

describe("SourceControlPanel stash identity", () => {
  it("uses the stash commit hash instead of the positional ref when available", () => {
    expect(
      stashIdentityKey({
        refName: "stash@{0}",
        sha: "abc123",
        createdAt: "2026-06-30T13:00:00Z",
        message: "WIP on main: abc123 change",
      }),
    ).toBe("sha:abc123");
  });

  it("falls back to the positional ref for stashes without a hash", () => {
    expect(
      stashIdentityKey({
        refName: "stash@{0}",
        sha: null,
        createdAt: null,
        message: "stash@{0}",
      }),
    ).toBe("ref:stash@{0}");
  });

  it("reads expanded stashes by commit hash across renumbering and replacement", () => {
    const viewed = { refName: "stash@{0}", sha: "aaa111", createdAt: null, message: "viewed" };
    const expanded = new Set([treeKey("stash", stashIdentityKey(viewed))]);
    const newer = { refName: "stash@{0}", sha: "bbb222", createdAt: null, message: "newer" };
    const pushedAbove = { ...baseSnapshot, stashes: [newer, { ...viewed, refName: "stash@{1}" }] };

    expect(expandedStashesForSnapshot(pushedAbove, expanded)).toEqual([
      { stashRef: "aaa111", detailsKey: "sha:aaa111" },
    ]);
    // Another stash now sits at the viewed position, so its reads and diffs use its own hash.
    expect(stashReadRef(newer)).toBe("bbb222");
    expect(stashReadRef({ ...viewed, sha: null })).toBe("stash@{0}");
  });
});

describe("SourceControlPanel file diff caching", () => {
  it("reuses loaded patches only for immutable sources", () => {
    expect(isImmutableFileDiffSource({ kind: "commit", sha: "abc123" })).toBe(true);
    expect(isImmutableFileDiffSource({ kind: "stash", stashRef: "abc123" })).toBe(true);
    expect(isImmutableFileDiffSource({ kind: "stash", stashRef: "stash@{0}" })).toBe(false);
    expect(
      isImmutableFileDiffSource({ kind: "compare", baseRef: "origin/main", refName: "feature" }),
    ).toBe(false);
    expect(isImmutableFileDiffSource({ kind: "working-tree", staged: false })).toBe(false);
  });

  it("lists each loaded comparison's files once across alias keys", () => {
    const file = { path: "src/a.ts", status: "M", insertions: 1, deletions: 0 } as const;
    const details = {
      name: "feature",
      fullRefName: "refs/heads/feature",
      baseRef: "origin/main",
      compareFiles: [file],
    } as unknown as VcsPanelBranchDetails;
    const withoutBase = { ...details, name: "other", baseRef: null };

    expect(branchCompareFileDiffRequests([details, details, { ...details }, withoutBase])).toEqual([
      { file, source: { kind: "compare", baseRef: "origin/main", refName: "feature" } },
    ]);
  });
});

describe("SourceControlPanel refresh stability logic", () => {
  it("suppresses a duplicate panel action until the first action releases its key", () => {
    const runningActionKeys = new Set<string>();

    expect(beginPanelAction(runningActionKeys, "commit:/repo")).toBe(true);
    expect(beginPanelAction(runningActionKeys, "commit:/repo")).toBe(false);
    expect(beginPanelAction(runningActionKeys, "push:feature")).toBe(true);

    runningActionKeys.delete("commit:/repo");
    expect(beginPanelAction(runningActionKeys, "commit:/repo")).toBe(true);
  });

  it("reconciles repository state after a failed panel action", async () => {
    const calls: string[] = [];
    const failure = new Error("merge produced conflicts");

    const result = await runPanelActionAndReconcile({
      action: async () => {
        calls.push("action");
        throw failure;
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    });

    expect(calls).toEqual(["action", "reconcile"]);
    expect(result).toEqual({ status: "failure", error: failure });
  });

  it("preserves the mutation error when reconciliation also fails", async () => {
    const mutationError = new Error("merge produced conflicts");
    const reconcileError = new Error("snapshot refresh failed");

    const result = await runPanelActionAndReconcile({
      action: async () => {
        throw mutationError;
      },
      reconcile: async () => {
        throw reconcileError;
      },
    });
    expect(result).toEqual({ status: "failure", error: mutationError });
  });

  it.each([
    { reconcileFails: false, outcome: "succeeds" },
    { reconcileFails: true, outcome: "fails" },
  ])(
    "preserves synchronous action errors when reconciliation $outcome",
    async ({ reconcileFails }) => {
      const mutationError = new Error("action failed before returning a promise");
      let reconciled = false;
      const result = await runPanelActionAndReconcile({
        action: () => {
          throw mutationError;
        },
        reconcile: async () => {
          reconciled = true;
          if (reconcileFails) throw new Error("snapshot refresh failed");
        },
      });
      expect(reconciled).toBe(true);
      expect(result).toEqual({ status: "failure", error: mutationError });
    },
  );

  it("returns the refresh error after a successful mutation", async () => {
    const reconcileError = new Error("snapshot refresh failed");
    const result = await runPanelActionAndReconcile({
      action: async () => {},
      reconcile: async () => {
        throw reconcileError;
      },
    });
    expect(result).toEqual({ status: "failure", error: reconcileError });
  });

  it("returns success after the mutation and reconciliation complete", async () => {
    const calls: string[] = [];
    const result = await runPanelActionAndReconcile({
      action: async () => {
        calls.push("action");
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    });
    expect(calls).toEqual(["action", "reconcile"]);
    expect(result).toEqual({ status: "success" });
  });

  it("keeps a mutation error visible when a later refresh clears its own error", () => {
    expect(sourceControlPanelError(null, "merge produced conflicts")).toBe(
      "merge produced conflicts",
    );
    expect(sourceControlPanelError("snapshot refresh failed", "merge produced conflicts")).toBe(
      "merge produced conflicts",
    );
  });

  it("drains a queued refresh after the active refresh fails", async () => {
    const queue: PanelRefreshQueue = { inFlight: false, queued: null };
    const calls: string[] = [];
    const errors: unknown[] = [];
    let queued: Promise<void> | undefined;

    await drainPanelRefreshQueue(
      queue,
      { mode: "full", authoritative: false },
      {
        run: async ({ mode }) => {
          calls.push(mode);
          if (calls.length !== 1) return;
          queued = enqueuePanelRefresh(queue, { mode: "working-tree", authoritative: false });
          throw new Error("interrupted");
        },
        onError: (error) => {
          errors.push(error);
        },
      },
    );

    await queued;
    expect(calls).toEqual(["full", "working-tree"]);
    expect(errors).toEqual([expect.objectContaining({ message: "interrupted" })]);
    expect(queue).toEqual({ inFlight: false, queued: null });
  });

  it("holds a mutation until its reconciliation runs after an earlier in-flight snapshot", async () => {
    const queue: PanelRefreshQueue = { inFlight: false, queued: null };
    const reads: PanelRefreshRequest[] = [];
    const events: string[] = [];
    const gates = [deferred(), deferred()];
    let readStarted = deferred();

    const earlierRefresh = drainPanelRefreshQueue(
      queue,
      { mode: "working-tree", authoritative: false },
      {
        run: async (request) => {
          const index = reads.push(request) - 1;
          readStarted.resolve();
          await gates[index]?.promise;
          events.push(`applied:${request.mode}`);
        },
        onError: () => {},
      },
    );
    await readStarted.promise;
    readStarted = deferred();

    let settled = false;
    const mutation = runPanelActionAndReconcile({
      action: async () => {
        events.push("mutated");
      },
      reconcile: () => enqueuePanelRefresh(queue, { mode: "full", authoritative: true }),
    }).then((result) => {
      settled = true;
      return result;
    });

    gates[0]?.resolve();
    await readStarted.promise;
    expect(settled).toBe(false);
    expect(reads).toEqual([
      { mode: "working-tree", authoritative: false },
      { mode: "full", authoritative: true },
    ]);

    gates[1]?.resolve();
    expect(await mutation).toEqual({ status: "success" });
    await earlierRefresh;
    expect(events).toEqual(["mutated", "applied:working-tree", "applied:full"]);
  });

  it("keeps a loaded diff mounted while a refresh revalidates it", () => {
    const loaded = { status: "loaded", patch: "same patch" } as const;

    expect(beginPanelFileDiffLoad(loaded, { preserveLoaded: true })).toBe(loaded);
    expect(completePanelFileDiffLoad(loaded, "same patch")).toBe(loaded);
    expect(failPanelFileDiffLoad(loaded, "failed", { preserveLoaded: true })).toBe(loaded);
  });

  it("updates preserved loaded diffs only when the refreshed patch changes", () => {
    const loaded = { status: "loaded", patch: "old patch" } as const;

    expect(completePanelFileDiffLoad(loaded, "new patch")).toEqual({
      status: "loaded",
      patch: "new patch",
    });
    expect(beginPanelFileDiffLoad(loaded)).toEqual({ status: "loading" });
    expect(failPanelFileDiffLoad(loaded, "failed")).toEqual({
      status: "error",
      message: "failed",
    });
  });
});

describe("SourceControlPanel environment federation", () => {
  const syncedMainSnapshot = (
    input: {
      readonly aheadCount?: number;
      readonly behindCount?: number;
      readonly dirty?: boolean;
      readonly remoteUrl?: string;
      readonly upstreamRemoteName?: string;
    } = {},
  ): VcsPanelSnapshotResult => {
    const currentBranch = branch({
      name: "main",
      current: true,
      isDefault: true,
      upstreamName: "origin/main",
      upstreamRemoteName: input.upstreamRemoteName ?? "origin",
      aheadCount: input.aheadCount ?? 0,
      behindCount: input.behindCount ?? 0,
    });
    return {
      ...baseSnapshot,
      status: {
        ...baseSnapshot.status,
        refName: "main",
        hasWorkingTreeChanges: input.dirty ?? false,
        aheadCount: input.aheadCount ?? 0,
        behindCount: input.behindCount ?? 0,
      },
      localBranches: [currentBranch],
      remotes: [
        {
          name: "origin",
          fetchUrl: input.remoteUrl ?? "https://example.test/team/repo.git",
          pushUrl: input.remoteUrl ?? "https://example.test/team/repo.git",
          provider: null,
          branches: [],
        },
      ],
    };
  };

  it.each(["source", "peer"])("does not coordinate a local upstream on the %s", async (side) => {
    const calls: string[] = [];
    const sourceSnapshot = syncedMainSnapshot({
      aheadCount: 1,
      upstreamRemoteName: side === "source" ? "." : "origin",
    });
    const peerSnapshot = syncedMainSnapshot({
      behindCount: 1,
      upstreamRemoteName: side === "peer" ? "." : "origin",
    });
    await pushBranchAndSyncPeers({
      sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      sourceBranch: sourceSnapshot.localBranches[0]!,
      sourceSnapshot,
      force: false,
      peerTargets: [{ environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/peer" }],
      push: async () => {
        calls.push("push");
      },
      readPeerSnapshot: async () => {
        calls.push("snapshot");
        return peerSnapshot;
      },
      fetchPeerBranch: async () => {
        calls.push("fetch");
      },
      pullPeerBranch: async () => {
        calls.push("pull");
      },
    });
    expect(calls).toEqual(side === "source" ? ["push"] : ["push", "snapshot"]);
  });

  it.each([0, 3])(
    "fast-forwards a clean peer already %i commits behind on the same remote branch",
    async (behindCount) => {
      const calls: string[] = [];
      const sourceSnapshot = syncedMainSnapshot({
        aheadCount: 1,
        remoteUrl: "git@example.test:team/repo.git",
      });
      const peerSnapshots = [
        syncedMainSnapshot({ behindCount }),
        syncedMainSnapshot({ behindCount: behindCount + 1 }),
      ];

      await pushBranchAndSyncPeers({
        sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        sourceBranch: sourceSnapshot.localBranches[0]!,
        sourceSnapshot,
        force: false,
        peerTargets: [
          { environmentId: PRIMARY_ENVIRONMENT_ID, cwd: "/local/repo" },
          { environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/remote/repo" },
        ],
        push: async () => {
          calls.push("push");
        },
        readPeerSnapshot: async () => {
          calls.push("snapshot");
          return peerSnapshots.shift()!;
        },
        fetchPeerBranch: async (_target, branchName) => {
          calls.push(`fetch:${branchName}`);
        },
        pullPeerBranch: async (_target, branchName) => {
          calls.push(`pull:${branchName}`);
        },
      });

      expect(calls).toEqual(["push", "snapshot", "fetch:main", "snapshot", "pull:main"]);
    },
  );

  it.each([{ dirty: true, behindCount: 3 }, { aheadCount: 1 }, { aheadCount: 1, behindCount: 3 }])(
    "skips dirty or locally ahead peers: %j",
    async (peerState) => {
      const calls: string[] = [];
      const sourceSnapshot = syncedMainSnapshot({ aheadCount: 1 });
      const peers = new Map<EnvironmentId, VcsPanelSnapshotResult>([
        [REMOTE_ENVIRONMENT_ID, syncedMainSnapshot(peerState)],
        [
          DISCONNECTED_ENVIRONMENT_ID,
          syncedMainSnapshot({ remoteUrl: "https://example.test/another/repo.git" }),
        ],
      ]);

      await pushBranchAndSyncPeers({
        sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        sourceBranch: sourceSnapshot.localBranches[0]!,
        sourceSnapshot,
        force: false,
        peerTargets: [
          { environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/remote/repo" },
          { environmentId: DISCONNECTED_ENVIRONMENT_ID, cwd: "/other/repo" },
        ],
        push: async () => {
          calls.push("push");
        },
        readPeerSnapshot: async (target) => peers.get(target.environmentId)!,
        fetchPeerBranch: async () => {
          calls.push("fetch");
        },
        pullPeerBranch: async () => {
          calls.push("pull");
        },
      });

      expect(calls).toEqual(["push"]);
    },
  );

  it.each([{ aheadCount: 1 }, { aheadCount: 1, behindCount: 4 }, { dirty: true, behindCount: 4 }])(
    "rechecks an eligible behind peer after fetch and skips changed state: %j",
    async (peerState) => {
      const calls: string[] = [];
      const sourceSnapshot = syncedMainSnapshot({ aheadCount: 1 });
      const peerSnapshots = [syncedMainSnapshot({ behindCount: 3 }), syncedMainSnapshot(peerState)];

      await pushBranchAndSyncPeers({
        sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        sourceBranch: sourceSnapshot.localBranches[0]!,
        sourceSnapshot,
        force: false,
        peerTargets: [{ environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/remote/repo" }],
        push: async () => {
          calls.push("push");
        },
        readPeerSnapshot: async () => peerSnapshots.shift()!,
        fetchPeerBranch: async () => {
          calls.push("fetch");
        },
        pullPeerBranch: async () => {
          calls.push("pull");
        },
      });

      expect(calls).toEqual(["push", "fetch"]);
    },
  );

  it("pushes without waiting for a slow peer and syncs that peer only after the push", async () => {
    const calls: string[] = [];
    const sourceSnapshot = syncedMainSnapshot({ aheadCount: 1 });
    const peerRead = deferred();
    let pushed = false;

    const sync = pushBranchAndSyncPeers({
      sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      sourceBranch: sourceSnapshot.localBranches[0]!,
      sourceSnapshot,
      force: false,
      peerTargets: [{ environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/remote/repo" }],
      push: async () => {
        calls.push("push");
        pushed = true;
      },
      readPeerSnapshot: async () => {
        if (calls.includes("fetch")) return syncedMainSnapshot({ behindCount: 1 });
        await peerRead.promise;
        return syncedMainSnapshot();
      },
      fetchPeerBranch: async () => {
        calls.push("fetch");
      },
      pullPeerBranch: async () => {
        calls.push("pull");
      },
    });

    await Promise.resolve();
    expect(pushed).toBe(true);
    peerRead.resolve();
    await sync;
    expect(calls).toEqual(["push", "fetch", "pull"]);
  });

  it("reports a failed push without fetching eligible peers", async () => {
    const calls: string[] = [];
    const sourceSnapshot = syncedMainSnapshot({ aheadCount: 1 });
    const failure = new Error("push rejected");

    await expect(
      pushBranchAndSyncPeers({
        sourceEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        sourceBranch: sourceSnapshot.localBranches[0]!,
        sourceSnapshot,
        force: false,
        peerTargets: [{ environmentId: REMOTE_ENVIRONMENT_ID, cwd: "/remote/repo" }],
        push: async () => {
          throw failure;
        },
        readPeerSnapshot: async () => syncedMainSnapshot({ behindCount: 1 }),
        fetchPeerBranch: async () => {
          calls.push("fetch");
        },
        pullPeerBranch: async () => {
          calls.push("pull");
        },
      }),
    ).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it("always expands the current environment and collapses other environments by default", () => {
    expect(
      isFederatedSourceControlTargetExpanded(
        { active: true, environmentId: PRIMARY_ENVIRONMENT_ID },
        new Set(),
      ),
    ).toBe(true);
    expect(
      isFederatedSourceControlTargetExpanded(
        { active: false, environmentId: REMOTE_ENVIRONMENT_ID },
        new Set(),
      ),
    ).toBe(false);
    expect(
      isFederatedSourceControlTargetExpanded(
        { active: false, environmentId: REMOTE_ENVIRONMENT_ID },
        new Set([REMOTE_ENVIRONMENT_ID]),
      ),
    ).toBe(true);
  });

  it("omits disconnected environments and keeps the active checkout first", () => {
    expect(
      resolveFederatedSourceControlTargets({
        activeEnvironmentId: REMOTE_ENVIRONMENT_ID,
        activeCwd: "/remote/repo.worktrees/active",
        activeWorktreePath: "/remote/repo.worktrees/active",
        candidates: [
          {
            environmentId: PRIMARY_ENVIRONMENT_ID,
            label: "This device",
            isPrimary: true,
            machine: "laptop",
            cwd: "/local/repo",
            connected: true,
          },
          {
            environmentId: DISCONNECTED_ENVIRONMENT_ID,
            label: "Offline server",
            isPrimary: false,
            machine: "mac-mini",
            cwd: "/offline/repo",
            connected: false,
          },
          {
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Build server",
            isPrimary: false,
            machine: "mac-mini",
            cwd: "/remote/repo",
            connected: true,
          },
        ],
      }),
    ).toEqual([
      {
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "Build server",
        isPrimary: false,
        machine: "mac-mini",
        cwd: "/remote/repo.worktrees/active",
        connected: true,
        active: true,
        worktreePath: "/remote/repo.worktrees/active",
      },
      {
        environmentId: PRIMARY_ENVIRONMENT_ID,
        label: "This device",
        isPrimary: true,
        machine: "laptop",
        cwd: "/local/repo",
        connected: true,
        active: false,
        worktreePath: null,
      },
    ]);
  });

  it("deduplicates multiple physical projects in the same connected environment", () => {
    expect(
      resolveFederatedSourceControlTargets({
        activeEnvironmentId: PRIMARY_ENVIRONMENT_ID,
        activeCwd: "/local/repo",
        activeWorktreePath: null,
        candidates: [
          {
            environmentId: PRIMARY_ENVIRONMENT_ID,
            label: "This device",
            isPrimary: true,
            machine: "laptop",
            cwd: "/local/repo",
            connected: true,
          },
          {
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Build server",
            isPrimary: false,
            machine: "mac-mini",
            cwd: "/remote/repo",
            connected: true,
          },
          {
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Build server",
            isPrimary: false,
            machine: "mac-mini",
            cwd: "/remote/repo/packages/web",
            connected: true,
          },
        ],
      }).map((target) => target.cwd),
    ).toEqual(["/local/repo", "/remote/repo"]);
  });
});

describe("SourceControlPanel model helpers", () => {
  const file = (input: Partial<VcsPanelFileChange> & { readonly path: string }) =>
    ({
      originalPath: null,
      status: "untracked",
      insertions: 0,
      deletions: 0,
      ...input,
    }) satisfies VcsPanelFileChange;

  it("round-trips enrichment keys, including paths that contain separators", () => {
    const key = enrichmentFileKey("C:/repo.worktrees/one", "src/a:b.ts");
    expect(splitEnrichmentFileKey(key)).toEqual({
      cwd: "C:/repo.worktrees/one",
      path: "src/a:b.ts",
    });
    expect(splitEnrichmentFileKey("plain.ts")).toEqual({ cwd: "", path: "plain.ts" });
  });

  it("applies enrichment to unstaged files of its own checkout and hides rename originals", () => {
    const staged = {
      kind: "staged" as const,
      files: [file({ path: "old.ts", status: "modified" })],
    };
    const unstaged = {
      kind: "unstaged" as const,
      files: [file({ path: "old.ts", status: "deleted" }), file({ path: "new.ts" })],
    };
    const renamed = file({
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed",
      insertions: 4,
    });
    const enriched = new Map([
      [enrichmentFileKey("/repo", "new.ts"), renamed],
      [enrichmentFileKey("/other", "other.ts"), file({ path: "other.ts", insertions: 9 })],
    ]);
    const hidden = new Set([enrichmentFileKey("/repo", "old.ts")]);

    expect(applyWorkingTreeFileEnrichment([staged, unstaged], "/repo", enriched, hidden)).toEqual([
      staged,
      { kind: "unstaged", files: [renamed] },
    ]);
  });

  it("evicts only enrichment for paths that left the tree or changed status", () => {
    const snapshotWith = (files: readonly VcsPanelFileChange[]): VcsPanelSnapshotResult => ({
      ...baseSnapshot,
      changeGroups: [{ kind: "unstaged", files: [...files] }],
    });
    const enriched = new Map([
      [enrichmentFileKey("/repo", "kept.ts"), file({ path: "kept.ts", insertions: 3 })],
      [enrichmentFileKey("/repo", "gone.ts"), file({ path: "gone.ts", insertions: 1 })],
      [enrichmentFileKey("/repo", "staged.ts"), file({ path: "staged.ts", insertions: 2 })],
      [
        enrichmentFileKey("/repo", "new.ts"),
        file({ path: "new.ts", originalPath: "old.ts", status: "renamed" }),
      ],
    ]);
    const hidden = new Set([enrichmentFileKey("/repo", "old.ts")]);
    const previous = snapshotWith([
      file({ path: "kept.ts" }),
      file({ path: "gone.ts" }),
      file({ path: "staged.ts" }),
      file({ path: "new.ts" }),
      file({ path: "old.ts", status: "deleted" }),
    ]);
    const next: VcsPanelSnapshotResult = {
      ...snapshotWith([file({ path: "kept.ts" }), file({ path: "new.ts" })]),
      changeGroups: [
        { kind: "unstaged", files: [file({ path: "kept.ts" }), file({ path: "new.ts" })] },
        { kind: "staged", files: [file({ path: "staged.ts", status: "added" })] },
      ],
    };

    expect(
      [
        ...staleWorkingTreeEnrichmentKeys({
          previous,
          next,
          cwd: "/repo",
          enrichedFilesByPath: enriched,
          hiddenPaths: hidden,
          requestedPaths: new Set(),
        }),
      ].map((key) => splitEnrichmentFileKey(key).path),
    ).toEqual(["gone.ts", "staged.ts", "old.ts", "new.ts"]);
    expect(
      staleWorkingTreeEnrichmentKeys({
        previous: null,
        next: previous,
        cwd: "/repo",
        enrichedFilesByPath: new Map([
          [enrichmentFileKey("/repo", "kept.ts"), file({ path: "kept.ts" })],
        ]),
        hiddenPaths: new Set(),
        requestedPaths: new Set(),
      }).size,
    ).toBe(1);
  });

  it("requests one detail load for a branch expanded in several places", () => {
    const feature = branch({
      name: "feature",
      upstreamName: "origin/feature",
      upstreamRemoteName: "origin",
    });
    const snapshot: VcsPanelSnapshotResult = {
      ...baseSnapshot,
      localBranches: [feature],
      remotes: [
        {
          ...baseSnapshot.remotes[0]!,
          branches: [
            { name: "feature", fullRefName: "origin/feature", isDefaultRemoteHead: false },
          ],
        },
      ],
      actionableForkBranches: [
        {
          localBranchName: "feature",
          remoteName: "fork",
          remoteRefName: "fork/feature",
          remoteBranchName: "feature",
          aheadCount: 0,
          behindCount: 2,
          lastActivityAt: null,
        },
      ],
    };
    const expanded = new Set([
      treeKey("branch", "feature"),
      treeKey("remote-branch", "origin:feature"),
      treeKey("fork-branch", "feature:fork/feature"),
    ]);

    expect(expandedBranchesForSnapshot(snapshot, expanded)).toEqual([
      { branch: feature, detailsKey: "feature" },
      {
        branch: feature,
        detailsKey: treeKey("fork-details", "feature:fork/feature"),
        compareBaseRef: "fork/feature",
      },
    ]);
  });

  it("keeps a fork comparison's commit page out of the ordinary branch aliases", () => {
    const feature = branch({ name: "feature" });
    const commit = (sha: string) =>
      ({ sha, shortSha: sha.slice(0, 7), message: sha }) as VcsPanelBranchDetails["commits"][0];
    const detailsFor = (baseRef: string, sha: string) =>
      ({
        name: "feature",
        fullRefName: "refs/heads/feature",
        baseRef,
        aheadCommits: [],
        aheadCommitsRemaining: 0,
        behindCommits: [],
        behindCommitsRemaining: 0,
        compareCommits: [],
        compareCommitsRemaining: 0,
        commits: [commit(sha)],
        commitsRemaining: 3,
      }) as unknown as VcsPanelBranchDetails;
    const ordinary = detailsFor("origin/main", "ordinary-1");
    const fork = detailsFor("fork/feature", "fork-1");
    const forkKey = treeKey("fork-details", "feature:fork/feature");
    const loaded = new Map([
      ["feature", ordinary],
      ["refs/heads/feature", ordinary],
      [forkKey, fork],
    ]);

    const afterForkPage = appendBranchCommitPage(
      loaded,
      { branch: feature, details: fork, detailsKey: forkKey, kind: "history" },
      { commits: [commit("fork-2")], remaining: 0 },
    );
    expect(afterForkPage.get(forkKey)?.commits.map((entry) => entry.sha)).toEqual([
      "fork-1",
      "fork-2",
    ]);
    expect(afterForkPage.get("feature")).toBe(ordinary);
    expect(afterForkPage.get("refs/heads/feature")).toBe(ordinary);

    const afterOrdinaryPage = appendBranchCommitPage(
      afterForkPage,
      { branch: feature, details: ordinary, detailsKey: "feature", kind: "history" },
      { commits: [commit("ordinary-2")], remaining: 0 },
    );
    expect(afterOrdinaryPage.get("refs/heads/feature")?.commits.map((entry) => entry.sha)).toEqual([
      "ordinary-1",
      "ordinary-2",
    ]);
    expect(afterOrdinaryPage.get("feature")).toBe(afterOrdinaryPage.get("refs/heads/feature"));
    expect(afterOrdinaryPage.get(forkKey)).toBe(afterForkPage.get(forkKey));
  });

  it("reads the source branch from stash messages", () => {
    const stash = (message: string) => ({
      refName: "stash@{0}",
      sha: null,
      createdAt: null,
      message,
    });
    expect(stashBranchName(stash("WIP on main: abc123 change"))).toBe("main");
    expect(stashBranchName(stash("On feature/x: saved work"))).toBe("feature/x");
    expect(stashBranchName(stash("custom message"))).toBeNull();
  });

  it("lists compare bases and unpublished branches from the snapshot", () => {
    const snapshot: VcsPanelSnapshotResult = {
      ...baseSnapshot,
      localBranches: [
        branch({ name: "main", upstreamName: "origin/main", upstreamRemoteName: "origin" }),
        branch({ name: "older", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        branch({ name: "newer", lastActivityAt: "2026-02-01T00:00:00.000Z" }),
      ],
    };

    expect(compareBaseRefNames(null)).toEqual([]);
    expect(compareBaseRefNames(snapshot)).toEqual([
      "main",
      "newer",
      "older",
      "origin/main",
      "upstream/main",
    ]);
    expect(localOnlyBranches(snapshot).map((candidate) => candidate.name)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("moves a section divider within the minimum weights of both open sections", () => {
    const weights = { work: 3, remotes: 1 };
    expect(resizeSectionWeights(weights, new Set(), "work", -50, 400)).toEqual({
      work: 2.5,
      remotes: 1.5,
    });
    const clamped = resizeSectionWeights(weights, new Set(), "work", 400, 400);
    expect(clamped.work).toBeCloseTo(3.65);
    expect(clamped.remotes).toBeCloseTo(0.35);
    expect(resizeSectionWeights(weights, new Set(["remotes"]), "work", 50, 400)).toBe(weights);
  });

  it("adds the web force gesture only to the unmerged-branch delete refusal", () => {
    const refusal = new Error(
      "Git command failed in deleteBranch (/repo): Branch feature has unmerged commits. Force delete it to discard them.",
    );
    const hinted = withBranchForceDeleteHint(refusal);
    expect(hinted).toBeInstanceOf(Error);
    expect((hinted as Error).message).toBe(
      `${refusal.message} Shift-click Delete to force delete.`,
    );
    const other = new Error("Branch feature is checked out in the worktree at /wt.");
    expect(withBranchForceDeleteHint(other)).toBe(other);
  });
});

describe("panel item activity", () => {
  it("keeps simultaneous items independent and includes actions on their children", () => {
    const running = new Map([
      ["changes-commit", "Committing"],
      ["worktree:/other:changes-stash", "Stashing"],
      ["commit-undo:feature/topic:abc123", "Undoing"],
    ]);
    expect(panelItemActivity(running, ["changes-commit"])).toBe("Committing");
    expect(panelItemActivity(running, ["worktree:/other:changes-stash"])).toBe("Stashing");
    expect(panelItemActivity(running, [], ["commit-undo:feature/topic:"])).toBe("Undoing");
    expect(panelItemActivity(running, [], ["commit-undo:feature/top:"])).toBeNull();
    running.delete("changes-commit");
    expect(panelItemActivity(running, ["changes-commit"])).toBeNull();
  });

  it("serializes stash mutations while only the affected stash has an activity label", () => {
    const keys = new Set<string>();
    expect(beginPanelAction(keys, "stash-mutation:sha-one")).toBe(true);
    expect(beginPanelAction(keys, "stash-mutation:sha-two")).toBe(false);
    const running = new Map([["stash-mutation:sha-one", "Applying"]]);
    expect(panelItemActivity(running, ["stash-mutation:sha-one"])).toBe("Applying");
    expect(panelItemActivity(running, ["stash-mutation:sha-two"])).toBeNull();
    keys.delete("stash-mutation:sha-one");
    expect(beginPanelAction(keys, "stash-mutation:sha-two")).toBe(true);
  });
});

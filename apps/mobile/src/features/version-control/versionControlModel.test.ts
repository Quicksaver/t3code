import type { VcsPanelSnapshotResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  actionableLocalBranches,
  applyWorkingTreeEnrichments,
  beginVersionControlAction,
  beginDetailRequest,
  branchComparisonTotals,
  branchOwnsOperationCwd,
  clearResolvedDetailError,
  detailRequestIsCurrent,
  discardableFiles,
  discardPathGroups,
  divergedForceSyncMessage,
  localBranchesByUpstream,
  localBranchForRemoteBranch,
  mergeWorkingTreeEnrichment,
  newlyInitializedCurrentChangeSetCwds,
  operationPaths,
  panelChangeSets,
  reconcileSelectedPaths,
  retainWorkingTreeEnrichments,
  relativeLabel,
  renameOriginalPathForFile,
  selectedFileStats,
  snapshotForCwd,
  snapshotIsPendingForCwd,
  stashIdentityKey,
  stashReadRef,
  validateWorkingTreeEnrichment,
  versionControlSupport,
  visibleRemoteBranches,
  workingTreeDiffIsStaged,
  workingTreeEnrichmentRequests,
} from "./versionControlModel";

function snapshot(): VcsPanelSnapshotResult {
  return {
    status: {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/mobile-vcs",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 0,
      pr: null,
    },
    changeGroups: [
      {
        kind: "staged",
        files: [
          {
            path: "src/a.ts",
            originalPath: null,
            status: "modified",
            insertions: 2,
            deletions: 1,
          },
        ],
      },
      {
        kind: "unstaged",
        files: [
          {
            path: "src/a.ts",
            originalPath: null,
            status: "modified",
            insertions: 3,
            deletions: 4,
          },
        ],
      },
    ],
    worktreeChangeSets: [],
    localBranches: [
      {
        name: "feature/mobile-vcs",
        current: true,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/feature/mobile-vcs",
        upstreamRemoteName: "origin",
      },
      {
        name: "local-only",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: null,
      },
      {
        name: "synced",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/synced",
        upstreamRemoteName: "origin",
        aheadCount: 0,
        behindCount: 0,
      },
    ],
    branchDetails: [],
    remotes: [{ name: "origin", fetchUrl: null, pushUrl: null, provider: null, branches: [] }],
    actionableForkBranches: [],
    stashes: [],
    recentCommits: [],
    defaultCompareRef: "main",
  };
}

describe("native Version Control model", () => {
  it("acquires mutation keys synchronously until the action releases them", () => {
    const runningActionKeys = new Set<string>();

    expect(beginVersionControlAction(runningActionKeys, "push")).toBe(true);
    expect(beginVersionControlAction(runningActionKeys, "push")).toBe(false);
    expect(beginVersionControlAction(runningActionKeys, "stash")).toBe(true);

    runningActionKeys.delete("push");
    expect(beginVersionControlAction(runningActionKeys, "push")).toBe(true);
  });

  it("runs one stash mutation at a time because each can renumber stash refs", () => {
    const runningActionKeys = new Set<string>();

    expect(beginVersionControlAction(runningActionKeys, "apply-stash")).toBe(true);
    expect(beginVersionControlAction(runningActionKeys, "drop-stash")).toBe(false);
    expect(beginVersionControlAction(runningActionKeys, "pop-stash")).toBe(false);
    expect(beginVersionControlAction(runningActionKeys, "push")).toBe(true);

    runningActionKeys.delete("apply-stash");
    expect(beginVersionControlAction(runningActionKeys, "drop-stash")).toBe(true);
  });

  it("excludes stash creation and selected-stash mutations in both acquisition orders", () => {
    const creating = new Set<string>();
    expect(beginVersionControlAction(creating, "stash")).toBe(true);
    for (const key of ["apply-stash", "pop-stash", "drop-stash"]) {
      expect(beginVersionControlAction(creating, key)).toBe(false);
    }

    for (const key of ["apply-stash", "pop-stash", "drop-stash"]) {
      const mutating = new Set<string>();
      expect(beginVersionControlAction(mutating, key)).toBe(true);
      expect(beginVersionControlAction(mutating, "stash")).toBe(false);
    }
  });

  it("issues Version Control requests only once the environment advertises the panel", () => {
    const config = (sourceControlPanel?: boolean) => ({
      environment: {
        capabilities: sourceControlPanel === undefined ? {} : { sourceControlPanel },
      },
    });
    // Direct entry before the environment's config arrives.
    expect(versionControlSupport(null)).toBe("pending");
    expect(versionControlSupport(config(true))).toBe("supported");
    // Reconnecting to a server from before the panel, or one that withdraws it.
    expect(versionControlSupport(config())).toBe("unsupported");
    expect(versionControlSupport(config(false))).toBe("unsupported");
  });

  it("lists the current tree first, then dirty siblings, skipping clean and duplicate cwds", () => {
    const sibling = (worktreePath: string, files: VcsPanelSnapshotResult["changeGroups"]) => ({
      branchName: `branch-${worktreePath}`,
      worktreePath,
      current: false,
      changeGroups: files,
    });
    const dirty: VcsPanelSnapshotResult["changeGroups"] = [
      {
        kind: "unstaged",
        files: [
          { path: "b.ts", originalPath: null, status: "modified", insertions: 1, deletions: 0 },
        ],
      },
    ];
    const changeSets = panelChangeSets(
      {
        ...snapshot(),
        worktreeChangeSets: [
          sibling("/repo", dirty),
          sibling("/repo-clean", []),
          sibling("/repo-dirty", dirty),
        ],
      },
      "/repo",
    );

    expect(
      changeSets.map(({ id, cwd, current, branchName }) => ({ id, cwd, current, branchName })),
    ).toEqual([
      { id: "worktree:/repo", cwd: "/repo", current: true, branchName: "feature/mobile-vcs" },
      {
        id: "worktree:/repo-dirty",
        cwd: "/repo-dirty",
        current: false,
        branchName: "branch-/repo-dirty",
      },
    ]);
    expect(changeSets[1]?.files.map((file) => file.path)).toEqual(["b.ts"]);
  });

  it("merges the current working tree and preserves aggregate selected stats", () => {
    const [changeSet] = panelChangeSets(snapshot(), "/repo");
    expect(changeSet?.files).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        insertions: 5,
        deletions: 5,
        hasStagedChanges: true,
        hasUnstagedChanges: true,
      }),
    ]);
    expect(selectedFileStats(changeSet?.files ?? [])).toEqual({ insertions: 5, deletions: 5 });
  });

  it("shows only branches that need action", () => {
    expect(actionableLocalBranches(snapshot()).map((branch) => branch.name)).toEqual([
      "feature/mobile-vcs",
      "local-only",
    ]);
  });

  it("keeps stash identity stable when positional refs are renumbered", () => {
    expect(stashIdentityKey({ refName: "stash@{2}", sha: "abc123" })).toBe("sha:abc123");
    expect(stashIdentityKey({ refName: "stash@{0}", sha: "abc123" })).toBe("sha:abc123");
    expect(stashIdentityKey({ refName: "stash@{0}", sha: null })).toBe("ref:stash@{0}");
  });

  it("reads stash details and diffs by immutable SHA", () => {
    const viewed = { refName: "stash@{0}", sha: "abc123" };
    const renumbered = { refName: "stash@{1}", sha: "abc123" };
    const replacement = { refName: "stash@{0}", sha: "def456" };
    expect(stashReadRef(renumbered)).toBe(stashReadRef(viewed));
    expect(stashReadRef(replacement)).not.toBe(stashReadRef(viewed));
    expect(stashReadRef({ refName: "stash@{0}", sha: null })).toBe("stash@{0}");
  });

  it("counts unloaded comparison commits in the ahead and behind totals", () => {
    const commits = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        sha: `sha-${index}`,
        shortSha: `sha-${index}`,
        message: "Commit",
        authorName: null,
        authorEmail: null,
        authorAvatarUrl: null,
        authoredAt: null,
        headRefs: [],
        tags: [],
        files: [],
      }));
    expect(
      branchComparisonTotals({
        aheadCommits: commits(10),
        aheadCommitsRemaining: 15,
        behindCommits: commits(2),
        behindCommitsRemaining: 0,
      }),
    ).toEqual({ ahead: 25, behind: 2 });
  });

  it("omits missing and invalid relative dates", () => {
    expect(relativeLabel(null)).toBeNull();
    expect(relativeLabel("")).toBeNull();
    expect(relativeLabel("not-a-timestamp")).toBeNull();
    expect(relativeLabel(new Date().toISOString())).toBe("<1m");
  });

  it("matches remote rows only to locals tracking that exact remote ref", () => {
    const localBranches = [
      {
        name: "release",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "upstream/release",
        upstreamRemoteName: "upstream",
      },
      {
        name: "release",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/release",
        upstreamRemoteName: "origin",
      },
      {
        name: "untracked",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: null,
      },
    ];
    const remoteBranch = {
      name: "release",
      fullRefName: "origin/release",
      isDefaultRemoteHead: false,
    };

    expect(
      localBranchForRemoteBranch(
        localBranchesByUpstream(localBranches),
        { name: "origin" },
        remoteBranch,
      ),
    ).toBe(localBranches[1]);
    expect(
      localBranchForRemoteBranch(
        localBranchesByUpstream([localBranches[0]!]),
        { name: "origin" },
        remoteBranch,
      ),
    ).toBeNull();
  });

  it("falls back to a same-named local tracking the remote's conventional ref", () => {
    const remoteBranch = {
      name: "topic",
      fullRefName: "refs/odd/topic",
      isDefaultRemoteHead: false,
    };
    const tracker = (name: string) => ({
      name,
      current: false,
      isDefault: false,
      worktreePath: null,
      upstreamName: "origin/topic",
      upstreamRemoteName: "origin",
    });
    const index = localBranchesByUpstream([tracker("other"), tracker("topic")]);

    expect(localBranchForRemoteBranch(index, { name: "origin" }, remoteBranch)?.name).toBe("topic");
    expect(
      localBranchForRemoteBranch(
        localBranchesByUpstream([tracker("other")]),
        { name: "origin" },
        remoteBranch,
      ),
    ).toBeNull();
  });

  it.each([".", undefined])(
    "does not pair a local or unknown upstream (%s) with a remote",
    (upstreamRemoteName) => {
      const current = snapshot();
      const local = {
        ...current.localBranches[0]!,
        name: "main",
        upstreamName: "origin/main",
        upstreamRemoteName,
      };
      const tracker = { ...local, name: "tracker", upstreamRemoteName: "origin" };
      const remoteBranch = { name: "main", fullRefName: "origin/main", isDefaultRemoteHead: false };
      expect(
        localBranchForRemoteBranch(
          localBranchesByUpstream([local]),
          { name: "origin" },
          remoteBranch,
        ),
      ).toBeNull();
      expect(
        localBranchForRemoteBranch(
          localBranchesByUpstream([local, tracker]),
          { name: "origin" },
          remoteBranch,
        ),
      ).toBe(tracker);
    },
  );

  it("shows a remote's branches only while that remote is expanded", () => {
    const remote = {
      name: "origin",
      fetchUrl: null,
      pushUrl: null,
      provider: null,
      branches: [
        {
          name: "main",
          fullRefName: "origin/main",
          isDefaultRemoteHead: true,
        },
      ],
    };

    expect(visibleRemoteBranches(remote, false)).toEqual([]);
    expect(visibleRemoteBranches(remote, true)).toBe(remote.branches);
  });

  it("includes both rename sides once in operation paths", () => {
    expect(
      operationPaths([
        { path: "new.ts", originalPath: "old.ts", status: "renamed" },
        { path: "new.ts", originalPath: "old.ts", status: "renamed" },
      ]),
    ).toEqual(["new.ts", "old.ts"]);
  });

  it("does not mutate a copied file's live source path", () => {
    expect(
      operationPaths([{ path: "copy.ts", originalPath: "source.ts", status: "copied" }]),
    ).toEqual(["copy.ts"]);
  });

  it("passes an original path to diff requests only for renames", () => {
    expect(
      renameOriginalPathForFile({
        originalPath: "old.ts",
        status: "renamed",
      }),
    ).toBe("old.ts");
    expect(
      renameOriginalPathForFile({
        originalPath: "source.ts",
        status: "copied",
      }),
    ).toBeUndefined();
  });

  it("exposes snapshots only to the cwd that loaded them", () => {
    const current = snapshot();
    const scoped = { cwd: "/repo/one", snapshot: current };

    expect(snapshotForCwd(scoped, "/repo/one")).toBe(current);
    expect(snapshotForCwd(scoped, "/repo/two")).toBeNull();
  });

  it("stops treating a missing snapshot as pending after that cwd settles", () => {
    expect(snapshotIsPendingForCwd(null, "/repo/one", null)).toBe(true);
    expect(snapshotIsPendingForCwd(null, "/repo/one", "/repo/two")).toBe(true);
    expect(snapshotIsPendingForCwd(null, "/repo/one", "/repo/one")).toBe(false);
    expect(snapshotIsPendingForCwd(snapshot(), "/repo/one", null)).toBe(false);
    expect(snapshotIsPendingForCwd(null, null, null)).toBe(false);
  });

  it("accepts only the latest detail response for each expanded row", () => {
    const requests = new Map<string, number>();
    const first = beginDetailRequest(requests, "branch:feature");
    const second = beginDetailRequest(requests, "branch:feature");

    expect(detailRequestIsCurrent(requests, "branch:feature", first)).toBe(false);
    expect(detailRequestIsCurrent(requests, "branch:feature", second)).toBe(true);
  });

  it("clears only the shared banner for the resolved detail error", () => {
    expect(clearResolvedDetailError("detail failed", "detail failed")).toBeNull();
    expect(clearResolvedDetailError("mutation failed", "detail failed")).toBe("mutation failed");
    expect(clearResolvedDetailError("detail failed", null)).toBe("detail failed");
  });

  it("partitions mixed staged and unstaged files for complete discards", () => {
    const files = panelChangeSets(snapshot(), "/repo")[0]?.files ?? [];
    expect(discardPathGroups(files)).toEqual({
      staged: ["src/a.ts"],
      unstaged: ["src/a.ts"],
    });
  });

  it("does not treat conflict-only files as unstaged discard targets", () => {
    const conflictOnlyFile = {
      path: "src/conflict.ts",
      originalPath: null,
      status: "conflicted" as const,
      insertions: 0,
      deletions: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasConflicts: true,
    };
    expect(discardPathGroups([conflictOnlyFile])).toEqual({ staged: [], unstaged: [] });
    expect(discardableFiles([conflictOnlyFile])).toEqual([]);
  });

  it("opens only staged-only working-tree files from the staged side", () => {
    expect(
      workingTreeDiffIsStaged({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
      }),
    ).toBe(true);
    expect(
      workingTreeDiffIsStaged({
        hasStagedChanges: true,
        hasUnstagedChanges: true,
      }),
    ).toBe(false);
    expect(
      workingTreeDiffIsStaged({
        hasStagedChanges: false,
        hasUnstagedChanges: false,
      }),
    ).toBe(false);
  });

  it("keeps only files with discardable staged or unstaged changes", () => {
    const files = panelChangeSets(snapshot(), "/repo")[0]?.files ?? [];
    expect(discardableFiles(files)).toEqual(files);
  });

  it("selects new files and drops selection state for clean change sets", () => {
    const [changeSet] = panelChangeSets(snapshot(), "/repo");
    if (!changeSet) throw new Error("Expected a current working-tree fixture");
    const next = reconcileSelectedPaths({
      changeSets: [
        {
          ...changeSet,
          files: [
            ...changeSet.files,
            {
              path: "src/new.ts",
              originalPath: null,
              status: "untracked",
              insertions: 1,
              deletions: 0,
              hasStagedChanges: false,
              hasUnstagedChanges: true,
              hasConflicts: false,
            },
          ],
        },
      ],
      previousKnownPaths: new Map([
        ["/repo", new Set(["src/a.ts"])],
        ["/clean", new Set(["src/done.ts"])],
      ]),
      selectedByCwd: new Map([
        ["/repo", new Set(["src/a.ts"])],
        ["/clean", new Set(["src/done.ts"])],
      ]),
    });

    expect([...next.entries()].map(([cwd, paths]) => [cwd, [...paths]])).toEqual([
      ["/repo", ["src/a.ts", "src/new.ts"]],
    ]);
  });

  it("drops selected paths that left a still-dirty change set", () => {
    const [changeSet] = panelChangeSets(snapshot(), "/repo");
    if (!changeSet) throw new Error("Expected a current working-tree fixture");
    const next = reconcileSelectedPaths({
      changeSets: [changeSet],
      previousKnownPaths: new Map([["/repo", new Set(["src/a.ts", "src/gone.ts"])]]),
      selectedByCwd: new Map([["/repo", new Set(["src/gone.ts"])]]),
    });

    expect([...(next.get("/repo") ?? [])]).toEqual([]);
  });

  it("initializes expansion only when a working tree becomes current", () => {
    const initializedCwds = new Set<string>();
    const [current] = panelChangeSets(snapshot(), "/repo/current");
    if (!current) throw new Error("Expected a current working-tree fixture");
    const sibling = { ...current, cwd: "/repo/sibling", current: false };

    expect(newlyInitializedCurrentChangeSetCwds([sibling], initializedCwds)).toEqual([]);
    expect(initializedCwds.has(sibling.cwd)).toBe(false);
    expect(
      newlyInitializedCurrentChangeSetCwds([{ ...sibling, current: true }], initializedCwds),
    ).toEqual([sibling.cwd]);
    expect(newlyInitializedCurrentChangeSetCwds([current], initializedCwds)).toEqual([current.cwd]);
    expect(newlyInitializedCurrentChangeSetCwds([current], initializedCwds)).toEqual([]);
  });

  it("applies cwd-scoped untracked file enrichment", () => {
    const next: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "unstaged",
          files: [
            {
              path: "src/new.ts",
              originalPath: null,
              status: "untracked",
              insertions: 0,
              deletions: 0,
            },
          ],
        },
      ],
    };

    expect(workingTreeEnrichmentRequests(next, "/repo")).toEqual([
      { cwd: "/repo", paths: ["src/new.ts"] },
    ]);
    const enriched = applyWorkingTreeEnrichments(
      next,
      "/repo",
      new Map([
        [
          "/repo",
          {
            files: [
              {
                path: "src/new.ts",
                originalPath: null,
                status: "untracked",
                insertions: 12,
                deletions: 0,
              },
            ],
            hiddenPaths: [],
          },
        ],
      ]),
    );
    expect(panelChangeSets(enriched, "/repo")[0]?.files[0]?.insertions).toBe(12);
  });

  it("hides rename originals and appends enriched paths across batches", () => {
    const next: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "unstaged",
          files: [
            { path: "old.ts", originalPath: null, status: "deleted", insertions: 0, deletions: 0 },
            { path: "z.ts", originalPath: null, status: "untracked", insertions: 0, deletions: 0 },
          ],
        },
      ],
    };
    expect(workingTreeEnrichmentRequests(next, "/repo")).toEqual([
      { cwd: "/repo", paths: ["old.ts", "z.ts"] },
    ]);

    const renamed = {
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed" as const,
      insertions: 1,
      deletions: 1,
    };
    const firstBatch = mergeWorkingTreeEnrichment(
      new Map(),
      { cwd: "/repo", paths: ["old.ts"] },
      {
        files: [{ ...renamed, path: "old.ts", originalPath: null, status: "deleted" }],
        hiddenPaths: [],
      },
    );
    const enrichments = mergeWorkingTreeEnrichment(
      firstBatch,
      { cwd: "/repo", paths: ["z.ts"] },
      {
        files: [
          renamed,
          { path: "z.ts", originalPath: null, status: "untracked", insertions: 4, deletions: 0 },
        ],
        hiddenPaths: ["old.ts"],
      },
    );

    expect(enrichments.get("/repo")).toEqual({
      files: [renamed, expect.objectContaining({ path: "z.ts", insertions: 4 })],
      hiddenPaths: ["old.ts"],
    });
    expect(
      panelChangeSets(applyWorkingTreeEnrichments(next, "/repo", enrichments), "/repo")[0]?.files,
    ).toEqual([
      expect.objectContaining({ path: "new.ts", originalPath: "old.ts", status: "renamed" }),
      expect.objectContaining({ path: "z.ts", insertions: 4 }),
    ]);
  });

  it("replaces a revalidated batch's rows and rename pairing, keeping other paths", () => {
    const renamed = {
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed" as const,
      insertions: 1,
      deletions: 1,
    };
    const other = {
      path: "other.ts",
      originalPath: null,
      status: "untracked" as const,
      insertions: 7,
      deletions: 0,
    };
    const stale = new Map([["/repo", { files: [renamed, other], hiddenPaths: ["old.ts"] }]]);

    // The untracked file was edited, so it no longer pairs with the deleted one.
    const revalidated = mergeWorkingTreeEnrichment(
      stale,
      { cwd: "/repo", paths: ["new.ts", "old.ts"] },
      {
        files: [
          { path: "new.ts", originalPath: null, status: "untracked", insertions: 9, deletions: 0 },
          { path: "old.ts", originalPath: null, status: "deleted", insertions: 0, deletions: 3 },
        ],
        hiddenPaths: [],
      },
    );
    expect(revalidated.get("/repo")).toEqual({
      files: [
        expect.objectContaining({ path: "new.ts", status: "untracked", insertions: 9 }),
        expect.objectContaining({ path: "old.ts", status: "deleted", deletions: 3 }),
        other,
      ],
      hiddenPaths: [],
    });

    // An unchanged revalidation keeps the current map so the panel does not re-render.
    expect(
      mergeWorkingTreeEnrichment(
        revalidated,
        { cwd: "/repo", paths: ["other.ts"] },
        { files: [other], hiddenPaths: [] },
      ),
    ).toBe(revalidated);
  });

  it("retains enrichment only for cwds and paths a newer snapshot still requests", () => {
    const renamed = {
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed" as const,
      insertions: 1,
      deletions: 1,
    };
    const notes = {
      path: "notes.md",
      originalPath: null,
      status: "untracked" as const,
      insertions: 4,
      deletions: 0,
    };
    const sibling = { files: [{ ...notes, path: "s.ts" }], hiddenPaths: [] };
    const current = new Map([
      ["/repo", { files: [renamed, notes], hiddenPaths: ["old.ts"] }],
      ["/sibling", sibling],
    ]);

    // Unchanged requests keep the current map so the panel does not re-render.
    expect(
      retainWorkingTreeEnrichments(current, [
        { cwd: "/repo", paths: ["new.ts", "notes.md", "old.ts"] },
        { cwd: "/sibling", paths: ["s.ts"] },
      ]),
    ).toBe(current);

    // old.ts was restored, so its rename split; the sibling checkout has no eligible paths.
    const retained = retainWorkingTreeEnrichments(current, [
      { cwd: "/repo", paths: ["new.ts", "notes.md"] },
    ]);
    expect([...retained]).toEqual([["/repo", { files: [notes], hiddenPaths: [] }]]);
  });

  it("stops hiding a rename source once a newer snapshot drops its destination", () => {
    const renamed = {
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed" as const,
      insertions: 1,
      deletions: 1,
    };
    const current = new Map([["/repo", { files: [renamed], hiddenPaths: ["old.ts"] }]]);
    // new.ts was deleted, so only the tracked deletion of old.ts remains.
    const next: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "unstaged",
          files: [
            { path: "old.ts", originalPath: null, status: "deleted", insertions: 0, deletions: 0 },
          ],
        },
      ],
    };

    const retained = retainWorkingTreeEnrichments(
      current,
      workingTreeEnrichmentRequests(next, "/repo"),
    );
    expect([...retained]).toEqual([]);
    expect(
      panelChangeSets(applyWorkingTreeEnrichments(next, "/repo", retained), "/repo")[0]?.files,
    ).toEqual([expect.objectContaining({ path: "old.ts", status: "deleted" })]);
  });

  it("rejects a late rename whose destination was staged before the response landed", () => {
    const deletedOld = {
      path: "old.ts",
      originalPath: null,
      status: "deleted" as const,
      insertions: 0,
      deletions: 0,
    };
    const renamed = {
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed" as const,
      insertions: 1,
      deletions: 1,
    };
    const result = { files: [renamed], hiddenPaths: ["old.ts"] };
    const untracked: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "unstaged",
          files: [
            deletedOld,
            {
              path: "new.ts",
              originalPath: null,
              status: "untracked",
              insertions: 0,
              deletions: 0,
            },
          ],
        },
      ],
    };
    expect(
      validateWorkingTreeEnrichment(result, { cwd: "/repo", snapshot: untracked }, "/repo"),
    ).toBe(result);

    // The read found untracked new.ts, but new.ts was fully staged before the response arrived.
    const staged: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "staged",
          files: [
            { path: "new.ts", originalPath: null, status: "added", insertions: 1, deletions: 0 },
          ],
        },
        { kind: "unstaged", files: [deletedOld] },
      ],
    };
    // Both snapshots request only old.ts, so the response stays current for the newer one.
    expect(workingTreeEnrichmentRequests(staged, "/repo")).toEqual([
      { cwd: "/repo", paths: ["old.ts"] },
    ]);
    const valid = validateWorkingTreeEnrichment(
      result,
      { cwd: "/repo", snapshot: staged },
      "/repo",
    );
    expect(valid).toEqual({ files: [], hiddenPaths: [] });

    const enrichments = mergeWorkingTreeEnrichment(
      new Map(),
      { cwd: "/repo", paths: ["old.ts"] },
      valid,
    );
    const unstaged = applyWorkingTreeEnrichments(staged, "/repo", enrichments).changeGroups.find(
      (group) => group.kind === "unstaged",
    );
    expect(unstaged?.files).toEqual([deletedOld]);
  });

  it("warns that force pull also discards uncommitted changes only in a checkout", () => {
    const [current, localOnly] = snapshot().localBranches;
    if (!current || !localOnly) throw new Error("Expected current and local-only branch fixtures");
    expect(branchOwnsOperationCwd({ ...localOnly, worktreePath: "/repo-worktree" })).toBe(true);
    expect(divergedForceSyncMessage(current)).toContain(
      "Uncommitted changes and local commits are discarded.",
    );
    expect(divergedForceSyncMessage(localOnly)).toContain("Local commits on it are discarded.");
    expect(divergedForceSyncMessage(localOnly)).toContain(
      "Force push replaces the remote branch with your local commits.",
    );
  });
});

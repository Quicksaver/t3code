import { describe, expect, it } from "@effect/vitest";
import {
  type VcsPanelBranchDetails,
  type VcsPanelFileChange,
  type VcsPanelSnapshotResult,
  type VcsRef,
} from "@t3tools/contracts";

import {
  beginPanelDetailRequest,
  isLatestPanelDetailRequest,
  supersedePanelDetailRequests,
} from "./SourceControlPanel.logic";
import {
  readCachedSourceControlPanelState,
  writeCachedSourceControlPanelState,
} from "./SourceControlPanelCache";
import {
  appendBranchCommitPage,
  enrichmentFileKey,
  mergeWorkingTreeFileEnrichment,
  planWorkingTreeEnrichmentRevalidation,
  readCoveringStatus,
  retainBranchDetailsForReload,
  splitEnrichmentFileKey,
  staleWorkingTreeEnrichmentKeys,
  withBranchDetails,
  withoutObsoleteWorkingTreeRenames,
} from "./SourceControlPanelModel";

const snapshotWithGroups = (
  changeGroups: VcsPanelSnapshotResult["changeGroups"],
): VcsPanelSnapshotResult => ({
  status: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: changeGroups.length > 0,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  },
  changeGroups,
  worktreeChangeSets: [],
  localBranches: [],
  branchDetails: [],
  remotes: [],
  actionableForkBranches: [],
  stashes: [],
  recentCommits: [],
  defaultCompareRef: null,
});

const snapshot = (files: readonly VcsPanelFileChange[]) =>
  snapshotWithGroups([{ kind: "unstaged", files: [...files] }]);

const file = (input: Partial<VcsPanelFileChange> & { readonly path: string }) =>
  ({
    originalPath: null,
    status: "untracked",
    insertions: 0,
    deletions: 0,
    ...input,
  }) satisfies VcsPanelFileChange;

const branchRef = (name: string): VcsRef => ({
  name,
  current: false,
  isDefault: false,
  worktreePath: null,
});

const commit = (sha: string) =>
  ({ sha, shortSha: sha.slice(0, 7), message: sha }) as VcsPanelBranchDetails["commits"][0];

const details = (name: string, sha: string) =>
  ({
    name,
    fullRefName: `refs/heads/${name}`,
    baseRef: "origin/main",
    aheadCommits: [],
    aheadCommitsRemaining: 0,
    behindCommits: [],
    behindCommitsRemaining: 0,
    compareCommits: [],
    compareCommitsRemaining: 0,
    commits: [commit(sha)],
    commitsRemaining: 5,
    compareFiles: [],
  }) as unknown as VcsPanelBranchDetails;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("status coverage", () => {
  it("covers only the status captured before a read, even when a later one matches it", async () => {
    const unstaged = { paths: ["a.ts"] };
    const stagedSameSummary = { paths: ["a.ts"] };
    const coverage = { current: null as { paths: string[] } | null };
    let latest = unstaged;
    const read = deferred<string>();

    const landing = readCoveringStatus({
      coverage,
      latestStatus: () => latest,
      skipCovered: false,
      read: () => read.promise,
    });
    latest = stagedSameSummary;
    read.resolve("snapshot showing a.ts unstaged");
    await landing;

    expect(coverage.current).toBe(unstaged);
    let reread = false;
    await readCoveringStatus({
      coverage,
      latestStatus: () => latest,
      skipCovered: true,
      read: async () => {
        reread = true;
        return "snapshot showing a.ts staged";
      },
    });
    expect(reread).toBe(true);
    expect(coverage.current).toBe(stagedSameSummary);
    expect(
      await readCoveringStatus({
        coverage,
        latestStatus: () => latest,
        skipCovered: true,
        read: async () => "redundant",
      }),
    ).toBeNull();
  });

  it("leaves a status uncovered when its read fails", async () => {
    const status = { paths: [] };
    const coverage = { current: null as { paths: string[] } | null };
    await expect(
      readCoveringStatus({
        coverage,
        latestStatus: () => status,
        skipCovered: true,
        read: () => Promise.reject(new Error("interrupted")),
      }),
    ).rejects.toThrow("interrupted");
    expect(coverage.current).toBeNull();
  });
});

describe("branch details reload", () => {
  it("keeps details written by expansion and pagination while a reload reads", () => {
    const branchA = branchRef("a");
    const branchB = branchRef("b");
    const requests = new Map<string, number>();
    const loaded = withBranchDetails(
      withBranchDetails(new Map(), { branch: branchA, detailsKey: "a" }, details("a", "a-old")),
      { branch: branchRef("collapsed"), detailsKey: "collapsed" },
      details("collapsed", "c-old"),
    );

    // The reload rereads expanded A; collapsed details are obsolete at once.
    let current = retainBranchDetailsForReload(loaded, [], ["a"]);
    expect([...current.keys()]).toEqual(["a", "refs/heads/a"]);
    const reloadA = beginPanelDetailRequest(requests, "a");

    // Meanwhile the user expands B and its read lands.
    const expandB = beginPanelDetailRequest(requests, "b");
    expect(isLatestPanelDetailRequest(requests, "b", expandB)).toBe(true);
    current = withBranchDetails(current, { branch: branchB, detailsKey: "b" }, details("b", "b-1"));

    // The reload lands for A, which it still owns.
    expect(isLatestPanelDetailRequest(requests, "a", reloadA)).toBe(true);
    current = withBranchDetails(current, { branch: branchA, detailsKey: "a" }, details("a", "a-1"));
    expect(current.get("b")?.commits[0]?.sha).toBe("b-1");
    expect(current.get("refs/heads/a")?.commits[0]?.sha).toBe("a-1");
    expect(current.has("collapsed")).toBe(false);

    // A later reload of A loses ownership to a page load that starts while it reads.
    const secondReload = beginPanelDetailRequest(requests, "a");
    beginPanelDetailRequest(requests, "a");
    current = appendBranchCommitPage(
      current,
      { branch: branchA, details: current.get("a")!, detailsKey: "a", kind: "history" },
      { commits: [commit("a-2")], remaining: 0 },
    );
    expect(isLatestPanelDetailRequest(requests, "a", secondReload)).toBe(false);
    expect(current.get("a")?.commits.map((entry) => entry.sha)).toEqual(["a-1", "a-2"]);
  });

  it("stops a read for a branch collapsed before the reload from landing", () => {
    const requests = new Map<string, number>();
    const expandB = beginPanelDetailRequest(requests, "b");
    // B collapses, then refs change; the reload rereads only expanded A.
    beginPanelDetailRequest(requests, "a");
    expect(supersedePanelDetailRequests(requests, new Set(["a"]))).toEqual(["b"]);
    const reloadA = beginPanelDetailRequest(requests, "a");

    expect(isLatestPanelDetailRequest(requests, "b", expandB)).toBe(false);
    expect(isLatestPanelDetailRequest(requests, "a", reloadA)).toBe(true);
  });

  it("prefers the snapshot's own details over displayed entries being reread", () => {
    const fromSnapshot = details("a", "snapshot");
    const displayed = details("a", "displayed");
    const retained = retainBranchDetailsForReload(
      new Map([
        ["a", displayed],
        ["refs/heads/a", displayed],
      ]),
      [fromSnapshot],
      ["a"],
    );
    expect(retained.get("a")).toBe(fromSnapshot);
    expect(retained.get("refs/heads/a")).toBe(fromSnapshot);
  });
});

describe("working-tree enrichment", () => {
  it("drops a queued or in-flight read for a path that left the tree", () => {
    const pendingGone = enrichmentFileKey("/repo", "gone.ts");
    const pendingKept = enrichmentFileKey("/repo", "kept.ts");
    const stale = staleWorkingTreeEnrichmentKeys({
      previous: snapshot([file({ path: "gone.ts" }), file({ path: "kept.ts" })]),
      next: snapshot([file({ path: "kept.ts" })]),
      cwd: "/repo",
      enrichedFilesByPath: new Map(),
      hiddenPaths: new Set(),
      requestedPaths: new Set([pendingGone, pendingKept]),
    });
    expect([...stale].map((key) => splitEnrichmentFileKey(key).path)).toEqual(["gone.ts"]);
  });

  it("reads a path whose read failed again on an identical snapshot", () => {
    const failedKey = enrichmentFileKey("/repo", "failed.ts");
    const runningKey = enrichmentFileKey("/repo", "running.ts");
    const loadedKey = enrichmentFileKey("/repo", "loaded.ts");
    const current = snapshot([
      file({ path: "failed.ts" }),
      file({ path: "loaded.ts" }),
      file({ path: "running.ts" }),
    ]);
    const plan = planWorkingTreeEnrichmentRevalidation({
      previous: current,
      next: current,
      cwd: "/repo",
      enrichedFilesByPath: new Map([[loadedKey, file({ path: "loaded.ts", insertions: 3 })]]),
      hiddenPaths: new Set(),
      pendingPaths: new Set(),
      inFlightPaths: new Set([runningKey]),
    });
    expect(plan.missing).toEqual([failedKey]);
    expect(plan.reread).toEqual([loadedKey, runningKey]);
    expect(plan.dropRunningBatch).toBe(false);
  });

  it("drops a running read whose rename destination was staged while it read", () => {
    const oldKey = enrichmentFileKey("/repo", "old.ts");
    const newKey = enrichmentFileKey("/repo", "new.ts");
    const deleted = file({ path: "old.ts", status: "deleted" });
    const previous = snapshot([deleted, file({ path: "new.ts" })]);
    const plan = (next: VcsPanelSnapshotResult) =>
      planWorkingTreeEnrichmentRevalidation({
        previous,
        next,
        cwd: "/repo",
        enrichedFilesByPath: new Map(),
        hiddenPaths: new Set(),
        pendingPaths: new Set([newKey]),
        inFlightPaths: new Set([oldKey]),
      });

    // The read of old.ts may pair it with new.ts, which is no longer an unstaged rename candidate.
    const staged = plan(
      snapshotWithGroups([
        { kind: "staged", files: [file({ path: "new.ts", status: "added" })] },
        { kind: "unstaged", files: [deleted] },
      ]),
    );
    expect(staged.dropRunningBatch).toBe(true);
    expect([...staged.staleKeys]).toEqual([newKey]);
    expect(staged.reread).toEqual([oldKey]);
    expect(staged.missing).toEqual([]);

    // An edit that leaves the rename candidates alone keeps the read.
    const edited = plan(
      snapshot([deleted, file({ path: "new.ts" }), file({ path: "x.ts", status: "modified" })]),
    );
    expect(edited.dropRunningBatch).toBe(false);
  });

  it("lets a reread update an edited untracked file and unpair a rename", () => {
    const newKey = enrichmentFileKey("/repo", "new.ts");
    const oldKey = enrichmentFileKey("/repo", "old.ts");
    const current = {
      enrichedFilesByPath: new Map([
        [
          newKey,
          file({ path: "new.ts", originalPath: "old.ts", status: "renamed", insertions: 2 }),
        ],
      ]),
      hiddenPaths: new Set([oldKey]),
    };
    const edited = file({ path: "new.ts", insertions: 40 });
    const deleted = file({ path: "old.ts", status: "deleted", deletions: 12 });

    const next = mergeWorkingTreeFileEnrichment(current, "/repo", ["new.ts", "old.ts"], {
      files: [edited, deleted],
      hiddenPaths: [],
    });
    expect(next.enrichedFilesByPath.get(newKey)).toEqual(edited);
    expect(next.enrichedFilesByPath.get(oldKey)).toEqual(deleted);
    expect(next.hiddenPaths.size).toBe(0);

    const unchanged = mergeWorkingTreeFileEnrichment(next, "/repo", ["new.ts"], {
      files: [{ ...edited }],
      hiddenPaths: [],
    });
    expect(unchanged.enrichedFilesByPath).toBe(next.enrichedFilesByPath);
    expect(unchanged.hiddenPaths).toBe(next.hiddenPaths);
  });
});

describe("obsolete working-tree renames", () => {
  const renamed = file({ path: "new.ts", originalPath: "old.ts", status: "renamed" });
  const deleted = file({ path: "old.ts", status: "deleted" });
  const result = { files: [renamed], hiddenPaths: ["old.ts"] };

  it("keeps a rename whose destination is untracked and source an unstaged deletion", () => {
    const latest = snapshot([deleted, file({ path: "new.ts" })]);
    expect(withoutObsoleteWorkingTreeRenames(result, latest, "/repo", "/repo")).toBe(result);
  });

  it("drops a rename whose destination was created and fully staged while it read", () => {
    // Both snapshots request only old.ts, so the running read survives revalidation.
    const latest = snapshotWithGroups([
      { kind: "staged", files: [file({ path: "new.ts", status: "added" })] },
      { kind: "unstaged", files: [deleted] },
    ]);
    const filtered = withoutObsoleteWorkingTreeRenames(
      { files: [renamed, file({ path: "other.ts", insertions: 3 })], hiddenPaths: ["old.ts"] },
      latest,
      "/repo",
      "/repo",
    );
    expect(filtered).toEqual({
      files: [file({ path: "other.ts", insertions: 3 })],
      hiddenPaths: [],
    });

    // Merged, the real deletion stays visible and no phantom unstaged new.ts appears.
    const merged = mergeWorkingTreeFileEnrichment(
      { enrichedFilesByPath: new Map(), hiddenPaths: new Set() },
      "/repo",
      ["old.ts"],
      filtered,
    );
    expect(merged.hiddenPaths.size).toBe(0);
    expect(merged.enrichedFilesByPath.has(enrichmentFileKey("/repo", "new.ts"))).toBe(false);
  });

  it("drops a rename whose source is no longer an unstaged deletion", () => {
    const restored = snapshot([file({ path: "new.ts" })]);
    expect(withoutObsoleteWorkingTreeRenames(result, restored, "/repo", "/repo")).toEqual({
      files: [],
      hiddenPaths: [],
    });
  });

  it("checks a worktree's rename against that worktree's changes", () => {
    const latest: VcsPanelSnapshotResult = {
      ...snapshot([]),
      worktreeChangeSets: [
        {
          branchName: "other",
          worktreePath: "/other",
          current: false,
          changeGroups: [{ kind: "unstaged", files: [deleted, file({ path: "new.ts" })] }],
        },
      ],
    };
    expect(withoutObsoleteWorkingTreeRenames(result, latest, "/repo", "/other")).toBe(result);
    expect(withoutObsoleteWorkingTreeRenames(result, latest, "/repo", "/repo").files).toEqual([]);
  });
});

describe("panel state cache", () => {
  it("restores committed state without diffs whose load the next panel would not finish", () => {
    const key = "environment:thread:/repo:";
    const expandedFileDiffs = new Set(["loaded", "loading"]);
    writeCachedSourceControlPanelState(key, {
      snapshot: null,
      snapshotFingerprint: null,
      collapsed: new Set(),
      sectionWeights: { work: 2, remotes: 1 },
      expandedTree: new Set(["branch:a"]),
      collapsedDefaultTree: new Set(),
      branchDetailsByRef: new Map(),
      compareBaseOverrides: new Map(),
      stashDetailsByKey: new Map(),
      expandedFileDiffs,
      fileDiffsByKey: new Map([
        ["loaded", { status: "loaded", patch: "diff" }],
        ["loading", { status: "loading" }],
      ]),
      enrichedWorkingTreeFilesByPath: new Map(),
      hiddenWorkingTreePaths: new Set(),
      selectedChangePaths: new Set(),
      selectedWorktreeChangePaths: new Map(),
    });

    const restored = readCachedSourceControlPanelState(key);
    expect(restored?.sectionWeights).toEqual({ work: 2, remotes: 1 });
    expect([...(restored?.expandedTree ?? [])]).toEqual(["branch:a"]);
    expect([...(restored?.expandedFileDiffs ?? [])]).toEqual(["loaded"]);
    expect([...(restored?.fileDiffsByKey.keys() ?? [])]).toEqual(["loaded"]);
    expect(restored?.expandedFileDiffs).not.toBe(expandedFileDiffs);
  });
});

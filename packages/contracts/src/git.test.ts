import {
  VcsPanelBranchActionInput,
  VcsPanelFileDiffInput,
  VcsPanelDeleteBranchInput,
  VcsPanelFileActionInput,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
} from "./git.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsCreateWorktreeInput,
  VcsRef,
} from "./git.ts";
import { WorktreeMcpHandoffInput } from "./worktreeMcp.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";

const encodeVcsRef = Schema.encodeUnknownSync(VcsRef);
const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const decodeVcsPanelWorktreeChangeSet = Schema.decodeUnknownSync(VcsPanelWorktreeChangeSet);
const encodeCreateWorktreeInput = Schema.encodeUnknownSync(VcsCreateWorktreeInput);
const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodeWorktreeHandoffInput = Schema.decodeUnknownSync(WorktreeMcpHandoffInput);
const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const encodeRunStackedActionInput = Schema.encodeUnknownSync(GitRunStackedActionInput);
const decodeReviewDiffFileContentsInput = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);
const encodeReviewDiffFileContentsInput = Schema.encodeUnknownSync(ReviewDiffFileContentsInput);
const decodePullRequestDiffFileContentsInput = Schema.decodeUnknownSync(
  PullRequestDiffFileContentsInput,
);
const encodePullRequestDiffFileContentsInput = Schema.encodeUnknownSync(
  PullRequestDiffFileContentsInput,
);

const decodeVcsPanelBranchActionInput = Schema.decodeUnknownSync(VcsPanelBranchActionInput);
const decodeVcsPanelDeleteBranchInput = Schema.decodeUnknownSync(VcsPanelDeleteBranchInput);
const decodeVcsPanelFileDiffInput = Schema.decodeUnknownSync(VcsPanelFileDiffInput);
const decodeVcsPanelFileActionInput = Schema.decodeUnknownSync(VcsPanelFileActionInput);
const encodeVcsPanelEnrichmentResult = Schema.encodeSync(VcsPanelWorkingTreeFileEnrichmentResult);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("Git file paths", () => {
  it.each([
    {
      operation: "commit",
      decode: decodeRunStackedActionInput,
      encode: encodeRunStackedActionInput,
      input: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [" leading.txt", "trailing.txt "],
      },
    },
    {
      operation: "local diff expansion",
      decode: decodeReviewDiffFileContentsInput,
      encode: encodeReviewDiffFileContentsInput,
      input: {
        cwd: "/repo",
        sourceKind: "working-tree",
        changeType: "rename-changed",
        baseRef: "HEAD",
        headRef: null,
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
    {
      operation: "pull request diff expansion",
      decode: decodePullRequestDiffFileContentsInput,
      encode: encodePullRequestDiffFileContentsInput,
      input: {
        projectId: "project-1",
        repository: "owner/repo",
        number: 1,
        changeType: "rename-changed",
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
  ])("preserves leading and trailing whitespace for $operation", ({ decode, encode, input }) => {
    expect(decode(input)).toEqual(input);
    expect(encode(input)).toEqual(input);
  });
});

describe("Git ref names", () => {
  it.each(["origin/release/v2\u3000", "\u00a0release", "\u3000"])(
    "keeps Unicode whitespace at the edges of %j across the wire",
    (name) => {
      const ref = { name, upstreamRef: `refs/remotes/${name}`, current: false, isDefault: false };
      const wireRef = encodeVcsRef({ ...ref, worktreePath: null });
      expect(decodeVcsRef(wireRef)).toMatchObject(ref);

      const input = { cwd: "/repo", refName: name, newRefName: name, baseRefName: name };
      const wireInput = encodeCreateWorktreeInput({ ...input, path: null });
      expect(decodeCreateWorktreeInput(wireInput)).toMatchObject(input);

      const handoff = { branch: name, baseRef: name, startFromOrigin: true };
      expect(decodeWorktreeHandoffInput(handoff)).toEqual(handoff);

      const worktree = {
        branchName: name,
        worktreePath: "/repo",
        current: false,
        changeGroups: [],
      };
      expect(decodeVcsPanelWorktreeChangeSet(worktree)).toEqual(worktree);
    },
  );

  it("still trims ASCII whitespace and rejects a blank name", () => {
    expect(
      decodeCreateWorktreeInput({ cwd: "/repo", refName: " \tmain\n", path: null }).refName,
    ).toBe("main");
    expect(() => decodeCreateWorktreeInput({ cwd: "/repo", refName: " \t", path: null })).toThrow();
  });
});

describe("VcsPanelDeleteBranchInput", () => {
  it("accepts a server-resolved branch name instead of client-supplied ref metadata", () => {
    const branchName = "origin/feature/source-control\u3000";
    const parsed = decodeVcsPanelDeleteBranchInput({ cwd: "/repo", branchName, force: true });

    expect(parsed.branchName).toBe(branchName);
    expect(parsed.force).toBe(true);
  });
});

describe("VcsPanelBranchActionInput", () => {
  it("accepts a full-length expected remote SHA for forced pushes", () => {
    const sha = "a".repeat(40);
    const parsed = decodeVcsPanelBranchActionInput({
      cwd: "/repo",
      branchName: "feature",
      force: true,
      expectedRemoteSha: sha,
    });

    expect(parsed.expectedRemoteSha).toBe(sha);
  });

  it("rejects an abbreviated or non-hex expected remote SHA", () => {
    for (const expectedRemoteSha of ["abc1234", `${"a".repeat(39)}g`, "origin/feature"]) {
      expect(() =>
        decodeVcsPanelBranchActionInput({
          cwd: "/repo",
          branchName: "feature",
          force: true,
          expectedRemoteSha,
        }),
      ).toThrow();
    }
  });
});

describe("VcsPanelFileDiffInput", () => {
  it("accepts originalPath for renamed file diffs", () => {
    const parsed = decodeVcsPanelFileDiffInput({
      cwd: "/repo",
      path: "src/new.ts",
      originalPath: "src/old.ts",
      source: { kind: "working-tree", staged: false },
    });

    expect(parsed.originalPath).toBe("src/old.ts");
  });
});

describe("VcsPanel paths", () => {
  it("keeps filenames that differ only by surrounding whitespace distinct", () => {
    const paths = ["report.txt", " report.txt", "report.txt "];
    const fileAction = decodeVcsPanelFileActionInput({ cwd: "/repo", paths });
    const diff = decodeVcsPanelFileDiffInput({
      cwd: "/repo",
      path: " report.txt",
      originalPath: "report.txt ",
    });
    const enrichment = encodeVcsPanelEnrichmentResult({
      files: [
        {
          path: " report.txt",
          originalPath: " old.txt",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        },
      ],
      hiddenPaths: ["report.txt "],
    });

    expect(fileAction.paths).toEqual(paths);
    expect([diff.path, diff.originalPath]).toEqual([" report.txt", "report.txt "]);
    expect(enrichment.files[0]).toMatchObject({ path: " report.txt", originalPath: " old.txt" });
    expect(enrichment.hiddenPaths).toEqual(["report.txt "]);
    expect(() => decodeVcsPanelFileActionInput({ cwd: "/repo", paths: [""] })).toThrow();
  });
});

import {
  VcsPanelBranchActionInput,
  VcsPanelFileDiffInput,
  VcsPanelDeleteBranchInput,
  VcsPanelFileActionInput,
  VcsPanelWorkingTreeFileEnrichmentResult,
} from "./git.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

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

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});

describe("VcsPanelDeleteBranchInput", () => {
  it("accepts a server-resolved branch name instead of client-supplied ref metadata", () => {
    const parsed = decodeVcsPanelDeleteBranchInput({
      cwd: "/repo",
      branchName: "origin/feature/source-control",
      force: true,
    });

    expect(parsed.branchName).toBe("origin/feature/source-control");
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

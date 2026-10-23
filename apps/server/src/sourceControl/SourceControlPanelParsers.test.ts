import { parseCommitsWithStats } from "./SourceControlPanelParsers.ts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  parseCommits,
  parseLocalBranches,
  parseRemoteBranches,
  parseWorktreeBranchEntries,
  parseWorktreeBranchPaths,
} from "./SourceControlPanelParsers.ts";

describe("worktree entries", () => {
  it("marks registrations whose directory is gone as prunable", () => {
    const output = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo-pr-66",
      "HEAD def",
      "branch refs/heads/feature/creator-edit-group",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /repo-detached",
      "HEAD 123",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreeBranchEntries(output)).toEqual([
      { branchName: "main", worktreePath: "/repo", prunable: false },
      { branchName: "feature/creator-edit-group", worktreePath: "/repo-pr-66", prunable: true },
    ]);
    expect([...parseWorktreeBranchPaths(output)]).toEqual([
      ["main", "/repo"],
      ["feature/creator-edit-group", "/repo-pr-66"],
    ]);
  });
});

describe("SourceControlPanelParsers", () => {
  it("keeps each remote-tracking tip so a forced push can lease on it", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(
      parseRemoteBranches(
        [
          `origin/feature\t2026-06-20T12:00:00Z\t${sha}`,
          "origin/legacy\t2026-06-19T12:00:00Z",
        ].join("\n"),
        "origin",
      ),
    ).toEqual([
      {
        name: "feature",
        fullRefName: "origin/feature",
        isDefaultRemoteHead: false,
        lastActivityAt: "2026-06-20T12:00:00Z",
        sha,
      },
      {
        name: "legacy",
        fullRefName: "origin/legacy",
        isDefaultRemoteHead: false,
        lastActivityAt: "2026-06-19T12:00:00Z",
      },
    ]);
  });

  it("preserves upstream identities and counts while reading legacy rows as unknown", () => {
    const rows = parseLocalBranches(
      [
        "local\t\t/repo\t2026-06-20T12:00:00Z\torigin/main\t[ahead 2]\t.",
        "tracker\t\t\t2026-06-20T12:00:00Z\torigin/main\t[behind 3]\torigin",
        "legacy-six\t\t\t2026-06-20T12:00:00Z\torigin/main\t",
        "legacy-five\t\t2026-06-20T12:00:00Z\torigin/main\t",
      ].join("\n"),
      new Map(),
      "main",
    );
    expect(rows.find((row) => row.name === "local")).toMatchObject({
      upstreamName: "origin/main",
      upstreamRemoteName: ".",
      aheadCount: 2,
    });
    expect(rows.find((row) => row.name === "tracker")).toMatchObject({
      upstreamName: "origin/main",
      upstreamRemoteName: "origin",
      behindCount: 3,
    });
    expect(
      rows.filter((row) => row.name.startsWith("legacy")).map((row) => row.upstreamRemoteName),
    ).toEqual([undefined, undefined]);
  });

  it("labels empty subjects and preserves tab-containing commit subjects", () => {
    expect(
      parseCommits(
        [
          "full-empty\tshort-empty\tAda\tada@example.test\t2026-07-26T12:00:00Z\t",
          "full-tabs\tshort-tabs\tGrace\tgrace@example.test\t2026-07-26T13:00:00Z\tSubject\twith\ttabs",
        ].join("\n"),
      ),
    ).toEqual([
      {
        sha: "full-empty",
        shortSha: "short-empty",
        message: "(no commit message)",
        authorName: "Ada",
        authorEmail: "ada@example.test",
        authorAvatarUrl: null,
        authoredAt: "2026-07-26T12:00:00Z",
        headRefs: [],
        tags: [],
        files: [],
      },
      {
        sha: "full-tabs",
        shortSha: "short-tabs",
        message: "Subject\twith\ttabs",
        authorName: "Grace",
        authorEmail: "grace@example.test",
        authorAvatarUrl: null,
        authoredAt: "2026-07-26T13:00:00Z",
        headRefs: [],
        tags: [],
        files: [],
      },
    ]);
  });

  it("trims space-led subjects and labels whitespace-only subjects", () => {
    expect(
      parseCommits(
        [
          "full-space\tshort-space\tAda\tada@example.test\t2026-07-26T12:00:00Z\t  Leading space",
          "full-blank\tshort-blank\tAda\tada@example.test\t2026-07-26T12:00:00Z\t   ",
        ].join("\n"),
      ).map((commit) => commit.message),
    ).toEqual(["Leading space", "(no commit message)"]);
  });

  it("marks no branch as default when status, main, and master all miss", () => {
    const rows = parseLocalBranches(
      ["a-feature\t\t\t2026-06-20T12:00:00Z\t\t", "develop\t*\t\t2026-06-21T12:00:00Z\t\t"].join(
        "\n",
      ),
    );
    expect(rows.map((row) => [row.name, row.isDefault])).toEqual([
      ["develop", false],
      ["a-feature", false],
    ]);
    expect(
      parseLocalBranches(
        rows.map((row) => `${row.name}\t\t\t\t\t`).join("\n"),
        new Map(),
        "develop",
      )
        .filter((row) => row.isDefault)
        .map((row) => row.name),
    ).toEqual(["develop"]);
  });

  it("still rejects truncated commit records", () => {
    expect(parseCommits("full\tshort")).toEqual([]);
  });
});

describe("commit shortstats", () => {
  it("keeps file counts and line totals without eagerly loading paths", () => {
    const header = (sha: string) =>
      [
        sha,
        sha.slice(0, 7),
        "Author",
        "author@example.test",
        "2026-09-09T00:00:00Z",
        "Message",
      ].join("\t");
    const commits = parseCommitsWithStats(
      [
        header("a".repeat(40)),
        "",
        " 2500 files changed, 5000 insertions(+), 2 deletions(-)",
        header("b".repeat(40)),
        "",
        " 1 file changed, 1 deletion(-)",
        header("c".repeat(40)),
        "",
        " 1 file changed, 0 insertions(+), 0 deletions(-)",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      commits.map((commit) => commit.fileStats),
      [
        { fileCount: 2500, insertions: 5000, deletions: 2 },
        { fileCount: 1, insertions: 0, deletions: 1 },
        { fileCount: 1, insertions: 0, deletions: 0 },
      ],
    );
    assert.isTrue(commits.every((commit) => commit.files.length === 0));
  });
});

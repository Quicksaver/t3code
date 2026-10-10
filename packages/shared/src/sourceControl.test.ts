import type { VcsPanelSnapshotResult, VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
  mergePanelChangeGroups,
  panelBranchPushTargetSha,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });

  it("detects Forgejo and Gitea hosts while preserving HTTP origins", () => {
    for (const host of ["codeberg.org", "forgejo.example.test", "gitea.example.test"]) {
      expect(detectSourceControlProviderFromRemoteUrl(`http://${host}:3000/team/repo.git`)).toEqual(
        {
          kind: "forgejo",
          name: "Forgejo",
          baseUrl: `http://${host}:3000`,
        },
      );
    }
    expect(getChangeRequestTerminologyForKind("forgejo")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("detects Azure DevOps SSH remotes", () => {
    // The default Azure DevOps SSH clone URL uses the ssh.dev.azure.com host.
    expect(
      detectSourceControlProviderFromRemoteUrl("git@ssh.dev.azure.com:v3/org/project/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@ssh.dev.azure.com:22/v3/org/project/repo")
        ?.kind,
    ).toBe("azure-devops");
    // Legacy visualstudio.com SSH host stays classified too.
    expect(
      detectSourceControlProviderFromRemoteUrl("git@vs-ssh.visualstudio.com:v3/org/project/repo")
        ?.kind,
    ).toBe("azure-devops");
  });

  it("preserves ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com:8443/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com:8443",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://self-hosted.example.test:8443/group/repo.git",
      ),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
  });

  it("does not reuse SSH ports for HTTPS provider URLs", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@gitlab.example.test:24/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://gitlab.example.test",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@code.example.test:24/team/project.git"),
    ).toEqual({
      kind: "unknown",
      name: "code.example.test",
      baseUrl: "https://code.example.test",
    });
  });

  it("matches self-hosted providers by complete DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://github.example.com/owner/repo.git")?.kind,
    ).toBe("github");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.example.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://bitbucket.example.com/workspace/repo.git")
        ?.kind,
    ).toBe("bitbucket");
  });

  it("does not match provider names embedded in unrelated DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://notgithub.example.com/owner/repo.git")
        ?.kind,
    ).toBe("unknown");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://notgitlab.example.com/group/repo.git")
        ?.kind,
    ).toBe("unknown");
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://notbitbucket.example.com/workspace/repo.git",
      )?.kind,
    ).toBe("unknown");
  });

  it("detects SSH remotes with non-git SSH users (e.g. gitlab@, deploy@)", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("gitlab@gitlab.example.com:group/project.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("gitlab@gitlab.example.com:group/project.git")
        ?.baseUrl,
    ).toBe("https://gitlab.example.com");
    expect(detectSourceControlProviderFromRemoteUrl("deploy@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });
});

describe("isSshRemoteUrl", () => {
  it("recognises SCP-like SSH URLs with any SSH user prefix", () => {
    expect(isSshRemoteUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isSshRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(true);
    expect(isSshRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(true);
  });

  it("recognises ssh:// URLs with any case", () => {
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com:22/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SSH://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SsH://git@gitlab.example.com/group/project.git")).toBe(true);
  });

  it("returns false for HTTPS, local paths, and SCP-like paths without a colon", () => {
    expect(isSshRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(false);
    expect(isSshRemoteUrl("/home/user/repos/project")).toBe(false);
    expect(isSshRemoteUrl("")).toBe(false);
    expect(isSshRemoteUrl("deploy@github.com/project/repo")).toBe(false);
  });
});

it("names an Azure DevOps repository by its own name, not its project path", () => {
  // `az repos pr list --repository` takes a name and detects the organisation and project from
  // the checkout; the recorded `org/project/_git/repo` path is refused, and the repository then
  // reads as unavailable on the page.
  const selector = sourceControlRepositorySelector({
    provider: "azure-devops",
    displayName: "contoso/payments/_git/checkout",
    owner: "contoso",
    name: "checkout",
  });
  expect(selector).toBe("checkout");
});

it("falls back to the path's last segment where an Azure identity has no name", () => {
  const selector = sourceControlRepositorySelector({
    provider: "azure-devops",
    displayName: "contoso/payments/_git/checkout",
  });
  expect(selector).toBe("checkout");
});

it("keeps a GitLab identity's whole path, because a nested group is part of the name", () => {
  const selector = sourceControlRepositorySelector({
    provider: "gitlab",
    displayName: "group/subgroup/service",
    owner: "group",
    name: "service",
  });
  expect(selector).toBe("group/subgroup/service");
});

it("puts owner and name back together for an identity recorded before displayName", () => {
  const selector = sourceControlRepositorySelector({
    provider: "github",
    owner: "t3tools",
    name: "t3code",
  });
  expect(selector).toBe("t3tools/t3code");
});

it("names nothing for a project with no remote to name it by", () => {
  expect(sourceControlRepositorySelector(null)).toBeNull();
  expect(sourceControlRepositorySelector({ provider: "github" })).toBeNull();
});

describe("mergePanelChangeGroups", () => {
  it("sums staged and unstaged stats for the same path", () => {
    expect(
      mergePanelChangeGroups([
        {
          kind: "staged",
          files: [
            {
              path: "src/file.ts",
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
              path: "src/file.ts",
              originalPath: null,
              status: "modified",
              insertions: 3,
              deletions: 4,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "src/file.ts",
        originalPath: null,
        status: "modified",
        insertions: 5,
        deletions: 5,
        hasStagedChanges: true,
        hasUnstagedChanges: true,
        hasConflicts: false,
      },
    ]);
  });

  it("preserves status precedence and conflict flags when merging paths", () => {
    expect(
      mergePanelChangeGroups([
        {
          kind: "staged",
          files: [
            {
              path: "src/cafe.ts",
              originalPath: null,
              status: "modified",
              insertions: 1,
              deletions: 0,
            },
          ],
        },
        {
          kind: "conflicts",
          files: [
            {
              path: "src/cafe.ts",
              originalPath: null,
              status: "conflicted",
              insertions: 0,
              deletions: 2,
            },
            {
              path: "src/áudio.ts",
              originalPath: null,
              status: "added",
              insertions: 3,
              deletions: 0,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "src/áudio.ts",
        originalPath: null,
        status: "added",
        insertions: 3,
        deletions: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasConflicts: true,
      },
      {
        path: "src/cafe.ts",
        originalPath: null,
        status: "conflicted",
        insertions: 1,
        deletions: 2,
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasConflicts: true,
      },
    ]);
  });
});

describe("panelBranchPushTargetSha", () => {
  const featureSha = "1".repeat(40);
  const forkSha = "2".repeat(40);
  const remote = (name: string, sha: string): VcsPanelSnapshotResult["remotes"][number] => ({
    name,
    fetchUrl: null,
    pushUrl: null,
    provider: null,
    branches: [
      { name: "feature", fullRefName: `${name}/feature`, isDefaultRemoteHead: false, sha },
    ],
  });
  const snapshot = {
    status: { hasUpstream: false },
    remotes: [remote("origin", featureSha), remote("fork", forkSha)],
  } as unknown as VcsPanelSnapshotResult;
  const branch: VcsRef = {
    name: "feature",
    current: false,
    isDefault: false,
    worktreePath: null,
    upstreamName: "origin/feature",
    upstreamRemoteName: "origin",
  };

  it("reads the same-name upstream tip the snapshot showed", () => {
    expect(panelBranchPushTargetSha(branch, snapshot)).toBe(featureSha);
  });

  it("reads the chosen publish remote's same-name branch", () => {
    expect(panelBranchPushTargetSha(branch, snapshot, "fork")).toBe(forkSha);
  });

  it("returns nothing without a known push target", () => {
    expect(
      panelBranchPushTargetSha({ ...branch, upstreamName: "origin/main" }, snapshot),
    ).toBeUndefined();
    expect(panelBranchPushTargetSha(branch, snapshot, "missing")).toBeUndefined();
  });
});

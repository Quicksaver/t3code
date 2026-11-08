import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { ChildProcessSpawner } from "effect/process";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "closed",
          isCrossRepository: false,
          closedAt: "2026-08-23T10:00:00Z",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: SourceControlProviderKind.make("azure-devops"),
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "closed",
      closedAt: "2026-08-23T10:00:00Z",
      mergedAt: null,
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("lists repository-wide Azure DevOps PRs against the context repository", () =>
  Effect.gen(function* () {
    let listInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["listPullRequests"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    for (const [remoteUrl, project, repository] of [
      ["https://dev.azure.com/acme/project/_git/repo", "project", "repo"],
      ["https://dev.azure.com/acme/project/_git/service.git", "project", "service.git"],
      [
        "https://dev.azure.com/acme/My%20Project/_git/My%20Repo?view=x#readme",
        "My Project",
        "My Repo",
      ],
      ["git@ssh.dev.azure.com:v3/acme/My%20Project/My%20Repo", "My Project", "My Repo"],
      ["ssh://git@ssh.dev.azure.com/v3/acme/My%20Project/My%20Repo", "My Project", "My Repo"],
      ["https://dev.azure.com/acme/project/_git/@repo", null, null],
      ["https://dev.azure.com/acme/project/_git/%40repo", null, null],
      ["https://dev.azure.com/acme/@project/_git/repo", null, null],
      ["https://dev.azure.com/acme/%40project/_git/repo", null, null],
    ] as const) {
      listInput = null;
      const listed = yield* provider.listChangeRequests({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "upstream",
          remoteUrl,
        },
        state: "open",
        limit: 10,
      });

      assert.deepStrictEqual(listed, [], remoteUrl);
      assert.deepStrictEqual(
        listInput,
        repository === null
          ? null
          : {
              cwd: "/repo",
              organization: "https://dev.azure.com/acme",
              repository,
              project,
              state: "open",
              limit: 10,
            },
        remoteUrl,
      );
    }
  }),
);

it.effect("preserves Azure DevOps fallback project context when _git is absent", () =>
  Effect.gen(function* () {
    let listInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["listPullRequests"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    for (const remoteUrl of [
      "https://dev.azure.com/acme/project/repo",
      "https://azure.example/tfs/DefaultCollection/project/_git/repo",
    ]) {
      listInput = null;
      yield* provider.listChangeRequests({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "legacy",
          remoteUrl,
        },
        state: "open",
      });

      assert.deepStrictEqual(
        listInput,
        remoteUrl.includes("azure.example")
          ? {
              cwd: "/repo",
              state: "open",
            }
          : {
              cwd: "/repo",
              organization: "https://dev.azure.com/acme",
              repository: "repo",
              project: "project",
              state: "open",
            },
      );
    }
  }),
);

it.effect("lets the Azure CLI detect the target repository of a head lookup", () =>
  Effect.gen(function* () {
    let listInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["listPullRequests"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("azure-devops"),
          name: "Azure DevOps",
          baseUrl: "https://dev.azure.com",
        },
        remoteName: "origin",
        remoteUrl: "https://dev.azure.com/my-fork/project/_git/repo",
      },
      headSelector: "feature/provider",
      state: "open",
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "open",
    });
  }),
);

it.effect("uses Azure DevOps commit author image URLs from the remote repository context", () =>
  Effect.gen(function* () {
    let avatarInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getCommitAvatarUrl"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      getCommitAvatarUrl: (input) => {
        avatarInput = input;
        return Effect.succeed(
          "https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.123",
        );
      },
    });

    const avatarUrl = yield* provider.getCommitAvatarUrl({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("azure-devops"),
          name: "Azure DevOps",
          baseUrl: "https://dev.azure.com",
        },
        remoteName: "upstream",
        remoteUrl: "https://dev.azure.com/acme/My%20Project/_git/My%20Repo",
      },
      sha: "abc123",
    });

    assert.strictEqual(
      avatarUrl,
      "https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.123",
    );
    assert.deepStrictEqual(avatarInput, {
      cwd: "/repo",
      organization: "https://dev.azure.com/acme",
      repository: "My Repo",
      project: "My Project",
      sha: "abc123",
    });
  }),
);

it.effect("routes Azure SSH avatar lookups through the remote organization", () =>
  Effect.gen(function* () {
    let avatarInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getCommitAvatarUrl"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      getCommitAvatarUrl: (input) => {
        avatarInput = input;
        return Effect.succeed(null);
      },
    });

    for (const remoteUrl of [
      "git@ssh.dev.azure.com:v3/acme/project/repo",
      "ssh://git@ssh.dev.azure.com/v3/acme/project/repo",
    ]) {
      avatarInput = null;
      yield* provider.getCommitAvatarUrl({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "upstream",
          remoteUrl,
        },
        sha: "abc123",
      });

      assert.deepStrictEqual(avatarInput, {
        cwd: "/repo",
        organization: "https://dev.azure.com/acme",
        repository: "repo",
        project: "project",
        sha: "abc123",
      });
    }
  }),
);

it.effect("adds change-request context while bounding Azure CLI causes", () =>
  Effect.gen(function* () {
    const cause = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
      operation: "execute",
      command: "az",
      cwd: "/repo",
      argumentCount: 2,
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      checkoutPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .checkoutChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "azure-devops",
        operation: "checkoutChangeRequest",
        command: "az",
        cwd: "/repo",
        reference: "#42",
        detail: "Azure DevOps CLI command failed.",
      },
    );
    assert.deepStrictEqual(error.cause, {
      _tag: "AzureDevOpsCommandFailedError",
      name: "AzureDevOpsCommandFailedError",
      operation: "execute",
      command: "az",
      detail: "Azure DevOps CLI command failed.",
      message: "Azure DevOps CLI failed in execute: Azure DevOps CLI command failed.",
    });
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

const { parseAuth } = AzureDevOpsSourceControlProvider.discovery;

it("reads the signed-in Azure account and says when az is signed out", () => {
  assert.deepStrictEqual(parseAuth(processOutput("azure-user@example.com\n")), {
    status: "authenticated",
    account: Option.some("azure-user@example.com"),
    host: Option.some("dev.azure.com"),
    detail: Option.none(),
  });
  assert.strictEqual(
    parseAuth(
      processOutput("", {
        stderr: "Please run 'az login' to setup account.\n",
        exitCode: ChildProcessSpawner.ExitCode(1),
      }),
    ).status,
    "unauthenticated",
  );
  assert.strictEqual(parseAuth(processOutput("\n")).status, "unknown");
});

it.effect("names the remote's repository when reading the default branch", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(
      processOutput(
        JSON.stringify({
          name: "My Repo",
          webUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
          remoteUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
          sshUrl: "git@ssh.dev.azure.com:v3/acme/project/My%20Repo",
          defaultBranch: "refs/heads/master",
        }),
      ),
    ),
  );
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({ process: { run } }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsSourceControlProvider.make;
    for (const [remoteUrl, repository] of [
      ["https://acme@dev.azure.com/acme/project/_git/My%20Repo", "My Repo"],
      ["https://dev.azure.com/acme/project/_git/My%20Repo?view=x#readme", "My Repo"],
      ["https://acme.visualstudio.com/DefaultCollection/project/_git/My%20Repo/", "My Repo"],
      ["git@ssh.dev.azure.com:v3/acme/project/My%20Repo", "My Repo"],
      ["ssh://git@ssh.dev.azure.com/v3/acme/project/My%20Repo", "My Repo"],
      ["https://dev.azure.com/acme/project/_git/service.git", "service.git"],
      ["https://dev.azure.com/acme/project/_git/-repo", "-repo"],
      ["https://dev.azure.com/acme/project/_git/%40.env", null],
    ] as const) {
      run.mockClear();
      const branch = yield* provider.getDefaultBranch({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "origin",
          remoteUrl,
        },
      });
      if (repository === null) {
        assert.strictEqual(branch, null, remoteUrl);
        assert.strictEqual(run.mock.calls.length, 0, remoteUrl);
        continue;
      }
      assert.strictEqual(branch, "master", remoteUrl);
      assert.include(
        [...(run.mock.calls[0]?.[0].args ?? [])],
        `--repository=${repository}`,
        remoteUrl,
      );
    }
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(support))));
});

it.effect(
  "looks up a branch's pull requests a full page at a time, past forks' same-named branches",
  () =>
    Effect.gen(function* () {
      const provider = yield* AzureDevOpsSourceControlProvider.make;
      assert.deepStrictEqual(
        provider.headBranchProbe?.({
          headSelectors: ["octocat:feature", "feature"],
          state: "open",
        }),
        { headSelectors: ["feature"], limit: 100 },
      );
    }).pipe(Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}))),
);

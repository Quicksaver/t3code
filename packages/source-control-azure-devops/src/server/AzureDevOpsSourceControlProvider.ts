import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ChangeRequest } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import type { NormalizedAzureDevOpsPullRequestRecord } from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  // `az --version` starts Python and takes ~6s on Windows, exceeding the default probe timeout.
  probeTimeoutMs: 20_000,
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: NormalizedAzureDevOpsPullRequestRecord): ChangeRequest {
  return {
    provider: SourceControlProviderKind.make("azure-devops"),
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    isCrossRepository: summary.isCrossRepository,
  };
}

function azureRepositoryFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
):
  | {
      readonly organization: string;
      readonly repository: string;
      readonly project?: string;
    }
  | undefined {
  if (!context) return undefined;
  const path = SourceControlProvider.repositoryPathFromRemoteUrl(context.remoteUrl);
  if (!path) return undefined;
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const organization = (() => {
    try {
      const url = new URL(context.remoteUrl);
      const hostname = url.hostname.toLowerCase();
      if (hostname === "dev.azure.com") {
        const name = parts[0];
        return name ? `${url.origin}/${encodeURIComponent(name)}` : undefined;
      }
      if (hostname.endsWith(".visualstudio.com")) {
        return url.origin;
      }
    } catch {
      if (parts[0]?.toLowerCase() === "v3" && parts[1]) {
        return `https://dev.azure.com/${encodeURIComponent(parts[1])}`;
      }
    }
    return undefined;
  })();
  if (!organization) return undefined;
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  const gitProject = parts[gitIndex - 1];
  const gitRepository = parts[gitIndex + 1];
  if (gitIndex >= 1 && gitProject && gitRepository) {
    return { organization, project: gitProject, repository: gitRepository };
  }
  const sshProject = parts[2];
  const sshRepository = parts[3];
  if (parts[0]?.toLowerCase() === "v3" && sshProject && sshRepository) {
    return { organization, project: sshProject, repository: sshRepository };
  }
  const fallbackProject = parts.at(-2);
  const repository = parts.at(-1);
  return repository
    ? {
        organization,
        repository,
        ...(fallbackProject ? { project: fallbackProject } : {}),
      }
    : undefined;
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops"),
    listChangeRequests: Effect.fn("AzureDevOpsSourceControlProvider.listChangeRequests")(
      function (input) {
        const source = input.headSelector
          ? SourceControlProvider.sourceControlRefFromInput({ headSelector: input.headSelector })
          : undefined;
        // A head lookup lets the CLI detect the PR target from the checkout. Binding the context's
        // remote would search the push fork; repository-wide reads still bind it.
        const repository = input.headSelector
          ? undefined
          : azureRepositoryFromContext(input.context);
        return azure
          .listPullRequests({
            cwd: input.cwd,
            ...(input.headSelector ? { headSelector: input.headSelector } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(repository !== undefined
              ? {
                  organization: repository.organization,
                  repository: repository.repository,
                  ...(repository.project !== undefined ? { project: repository.project } : {}),
                }
              : {}),
            state: input.state,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError((error) =>
              SourceControlProvider.sourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "listChangeRequests",
                cwd: input.cwd,
                ...(input.headSelector ? { reference: input.headSelector } : {}),
                error,
              }),
            ),
          );
      },
    ),
    getChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.getChangeRequest")(
      function (input) {
        return azure.getPullRequest(input).pipe(
          Effect.map(toChangeRequest),
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getChangeRequest",
              cwd: input.cwd,
              reference: input.reference,
              error,
            }),
          ),
        );
      },
    ),
    createChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.createChangeRequest")(
      function (input) {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return azure
          .createPullRequest({
            cwd: input.cwd,
            baseBranch: input.baseRefName,
            headSelector: input.headSelector,
            ...(source !== undefined ? { source } : {}),
            ...(input.target !== undefined ? { target: input.target } : {}),
            title: input.title,
            bodyFile: input.bodyFile,
          })
          .pipe(
            Effect.mapError((error) =>
              SourceControlProvider.sourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "createChangeRequest",
                cwd: input.cwd,
                reference: input.headSelector,
                error,
              }),
            ),
          );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsSourceControlProvider.getRepositoryCloneUrls")(
      function (input) {
        return azure.getRepositoryCloneUrls(input).pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getRepositoryCloneUrls",
              cwd: input.cwd,
              repository: input.repository,
              error,
            }),
          ),
        );
      },
    ),
    getCommitAvatarUrl: Effect.fn("AzureDevOpsSourceControlProvider.getCommitAvatarUrl")(
      function (input) {
        const repository = azureRepositoryFromContext(input.context);
        if (!repository) {
          return Effect.succeed(null);
        }
        return azure
          .getCommitAvatarUrl({
            cwd: input.cwd,
            ...repository,
            sha: input.sha,
          })
          .pipe(
            Effect.mapError((error) =>
              SourceControlProvider.sourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "getCommitAvatarUrl",
                cwd: input.cwd,
                reference: input.sha,
                error,
              }),
            ),
          );
      },
    ),
    createRepository: Effect.fn("AzureDevOpsSourceControlProvider.createRepository")(
      function (input) {
        return azure.createRepository(input).pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "createRepository",
              cwd: input.cwd,
              repository: input.repository,
              error,
            }),
          ),
        );
      },
    ),
    getDefaultBranch: Effect.fn("AzureDevOpsSourceControlProvider.getDefaultBranch")(
      function (input) {
        return azure.getDefaultBranch({ cwd: input.cwd }).pipe(
          Effect.mapError((error) =>
            SourceControlProvider.sourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getDefaultBranch",
              cwd: input.cwd,
              error,
            }),
          ),
        );
      },
    ),
    checkoutChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.checkoutChangeRequest")(
      function (input) {
        return azure
          .checkoutPullRequest({
            cwd: input.cwd,
            reference: input.reference,
            ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
          })
          .pipe(
            Effect.mapError((error) =>
              SourceControlProvider.sourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "checkoutChangeRequest",
                cwd: input.cwd,
                reference: input.reference,
                error,
              }),
            ),
          );
      },
    ),
  });
});

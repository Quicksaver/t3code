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

function decodeAzureName(encoded: string): string | null {
  let name = encoded;
  try {
    name = decodeURIComponent(encoded);
  } catch {}
  // `az` replaces any argument value starting with `@` by the contents of that local file.
  return name.startsWith("@") ? null : name;
}

/**
 * The repository name a remote ends in; `az` takes it decoded and finds org and project itself.
 * Azure clone URLs carry no `.git` suffix, so a trailing `.git` is part of the name.
 */
function repositoryNameFromRemote(remoteUrl: string): string | null {
  const path = URL.parse(remoteUrl.trim())?.pathname ?? remoteUrl.trim();
  const encoded = path.replace(/\/+$/u, "").split(/[/:]/u).at(-1);
  return encoded ? decodeAzureName(encoded) : null;
}

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
  | null
  | undefined {
  if (!context) return undefined;
  const remoteUrl = context.remoteUrl.trim();
  const url = URL.parse(remoteUrl);
  const path = url?.pathname ?? /^[^@/\s]+@[^:/\s]+:(.+)$/u.exec(remoteUrl)?.[1];
  if (!path) return undefined;
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const organization = (() => {
    if (url) {
      const hostname = url.hostname.toLowerCase();
      if (hostname === "dev.azure.com") {
        const name = parts[0];
        return name ? `${url.origin}/${encodeURIComponent(name)}` : undefined;
      }
      if (hostname.endsWith(".visualstudio.com")) {
        return url.origin;
      }
      if (hostname === "ssh.dev.azure.com" && parts[0]?.toLowerCase() === "v3" && parts[1]) {
        return `https://dev.azure.com/${encodeURIComponent(parts[1])}`;
      }
    } else if (parts[0]?.toLowerCase() === "v3" && parts[1]) {
      return `https://dev.azure.com/${encodeURIComponent(parts[1])}`;
    }
    return undefined;
  })();
  if (!organization) return undefined;
  const repositoryContext = (project: string | undefined, repository: string) => {
    const projectName = project === undefined ? undefined : decodeAzureName(project);
    const repositoryName = decodeAzureName(repository);
    return projectName === null || repositoryName === null
      ? null
      : {
          organization,
          repository: repositoryName,
          ...(projectName !== undefined ? { project: projectName } : {}),
        };
  };
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  const gitProject = parts[gitIndex - 1];
  const gitRepository = parts[gitIndex + 1];
  if (gitIndex >= 1 && gitProject && gitRepository) {
    return repositoryContext(gitProject, gitRepository);
  }
  const sshProject = parts[2];
  const sshRepository = parts[3];
  if (parts[0]?.toLowerCase() === "v3" && sshProject && sshRepository) {
    return repositoryContext(sshProject, sshRepository);
  }
  const fallbackProject = parts.at(-2);
  const repository = parts.at(-1);
  return repository ? repositoryContext(fallbackProject, repository) : undefined;
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops"),
    // Azure lists fork pull requests by source branch with no owner filter, so read a full page.
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
      limit: 100,
    }),
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
        if (repository === null) return Effect.succeed([]);
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
        const repository =
          input.context === undefined ? null : repositoryNameFromRemote(input.context.remoteUrl);
        if (repository === null) return Effect.succeed(null);
        return azure.getDefaultBranch({ cwd: input.cwd, repository }).pipe(
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

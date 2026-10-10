import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ModelSelection,
  type ServerProvider,
  type VcsPanelCommitSummary,
  type VcsRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectStoreV2Error } from "../orchestration-v2/ProjectStore.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { makeSourceControlWritingPolicyResolver } from "../textGeneration/SourceControlWriting.ts";
import {
  makeSourceControlPanelReaders,
  type SourceControlPanelReaderDependencies,
} from "./SourceControlPanelReaders.ts";

const textGenerationModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "text-generation-model",
  options: [],
};
const sourceControlWriterModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "source-control-writer-model",
  options: [],
};

function makeReaders(input: {
  readonly sourceControlWriterModelSelection: ModelSelection | null;
  readonly sourceControlWritingStyle: typeof DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle;
  readonly onGenerate: (request: TextGeneration.CommitMessageGenerationInput) => void;
  readonly recentCommitSubjects?: readonly string[];
  readonly repositoryInstructions?: Readonly<Partial<Record<"AGENTS.md" | "CLAUDE.md", string>>>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly projectSettingsOverrides?: typeof DEFAULT_SERVER_SETTINGS.projectSettingsOverrides;
  readonly projects?: Readonly<Record<string, ProjectId>>;
  readonly workspaceRoot?: string;
  readonly mainWorkspaceRoot?: string;
  readonly failProjectLookup?: boolean;
  readonly generate?: (
    request: TextGeneration.CommitMessageGenerationInput,
  ) => Effect.Effect<{ readonly subject: string; readonly body: string }, TextGenerationError>;
  readonly withoutTextGeneration?: boolean;
  readonly diffOutput?: string;
  readonly instructionReads?: Array<{ cwd: string; fileName: string }>;
  readonly run?: SourceControlPanelReaderDependencies["run"];
  readonly sourceControlProviders?: SourceControlPanelReaderDependencies["sourceControlProviders"];
  readonly sourceControl?: typeof DEFAULT_SERVER_SETTINGS.sourceControl;
}) {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    sourceControl: input.sourceControl ?? DEFAULT_SERVER_SETTINGS.sourceControl,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      ...Object.fromEntries(
        (input.providers ?? []).map((provider) => [
          provider.instanceId,
          { driver: provider.driver, config: {} },
        ]),
      ),
    },
    textGenerationModelSelection,
    projectSettingsOverrides: input.projectSettingsOverrides ?? {},
    sourceControlWriterModelSelection: input.sourceControlWriterModelSelection,
    sourceControlWritingStyle: input.sourceControlWritingStyle,
  };
  const providers =
    input.providers ??
    (input.sourceControlWriterModelSelection
      ? [
          {
            instanceId: input.sourceControlWriterModelSelection.instanceId,
            driver:
              input.sourceControlWriterModelSelection.instanceId === "claudeAgent"
                ? ProviderDriverKind.make("claudeAgent")
                : ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          } satisfies ServerProvider,
        ]
      : []);
  return makeSourceControlPanelReaders({
    branchPullRequest: () => Effect.succeed(null),
    projectIdForWorkspace: (cwd) =>
      input.failProjectLookup
        ? Effect.fail(new ProjectStoreV2Error({ operation: "test.projectLookup", cause: null }))
        : Effect.succeed(input.projects?.[cwd] ?? null),
    run:
      input.run ??
      ((operation) =>
        Effect.succeed(
          operation === "vcs.panel.writingWorkspaceRoot"
            ? (input.workspaceRoot ?? "/repo")
            : operation === "vcs.panel.writingWorktrees"
              ? `worktree ${input.mainWorkspaceRoot ?? "/repo"}\0detached\0\0`
              : (input.diffOutput ??
                (operation.endsWith("Summary")
                  ? "1 file changed"
                  : operation.endsWith("Status")
                    ? "M src/example.ts"
                    : "diff --git a/src/example.ts b/src/example.ts")),
        )),
    serverSettings: {
      getSettings: Effect.succeed(settings),
    } as unknown as ServerSettingsService["Service"],
    sourceControlProviders: input.sourceControlProviders,
    sourceControlRateLimits: undefined,
    getProviders: Effect.succeed(providers),
    resolveWritingPolicy: makeSourceControlWritingPolicyResolver({
      runGit: (_cwd, args) =>
        Effect.succeed(
          args.includes("--show-toplevel")
            ? (input.workspaceRoot ?? "/repo")
            : (input.recentCommitSubjects ?? []).join("\n"),
        ),
      readRepositoryInstructions: (cwd, fileName) =>
        Effect.sync(() => {
          input.instructionReads?.push({ cwd, fileName });
          return input.repositoryInstructions?.[fileName as "AGENTS.md" | "CLAUDE.md"] ?? "";
        }),
    }),
    textGeneration: input.withoutTextGeneration
      ? undefined
      : ({
          generateCommitMessage: (request: TextGeneration.CommitMessageGenerationInput) =>
            Effect.sync(() => input.onGenerate(request)).pipe(
              Effect.andThen(
                input.generate?.(request) ??
                  Effect.succeed({ subject: "Generated message", body: "" }),
              ),
            ),
        } as unknown as TextGeneration.TextGeneration["Service"]),
  });
}

describe("SourceControlPanelReaders generated messages", () => {
  it.effect("uses registered checkout overrides for commits and stashes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const requests: TextGeneration.CommitMessageGenerationInput[] = [];
      const projectWriter = { ...sourceControlWriterModelSelection, model: "project-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWriterModelSelection: projectWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Project style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/repo": projectId },
        onGenerate: (request) => requests.push(request),
      });
      yield* readers.generatedCommitMessage("/repo");
      yield* readers.generatedStashMessage("/repo", "all");
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.deepStrictEqual(request.modelSelection, projectWriter);
        assert.equal(request.policy?.commitInstructions, "Project style");
      }
    }),
  );

  it.effect("prefers registered sibling overrides from a nested cwd over the main project", () =>
    Effect.gen(function* () {
      const siblingId = ProjectId.make("sibling-project");
      const mainId = ProjectId.make("main-project");
      const requests: TextGeneration.CommitMessageGenerationInput[] = [];
      const siblingWriter = { ...sourceControlWriterModelSelection, model: "sibling-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        projectSettingsOverrides: {
          [siblingId]: {
            sourceControlWriterModelSelection: siblingWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Sibling style",
              followChangeRequestTemplates: true,
            },
          },
          [mainId]: {
            sourceControlWriterModelSelection: {
              ...sourceControlWriterModelSelection,
              model: "main-writer",
            },
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Main style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/sibling": siblingId, "/repo": mainId },
        workspaceRoot: "/sibling",
        mainWorkspaceRoot: "/repo",
        onGenerate: (request) => requests.push(request),
      });
      yield* readers.generatedCommitMessage("/sibling/sub");
      yield* readers.generatedStashMessage("/sibling/sub", "all");
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.deepStrictEqual(request.modelSelection, siblingWriter);
        assert.equal(request.policy?.commitInstructions, "Sibling style");
      }
    }),
  );

  it.effect("inherits main-project overrides for unregistered sibling worktrees", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("main-project");
      let request: TextGeneration.CommitMessageGenerationInput | undefined;
      const projectTextWriter = { ...textGenerationModelSelection, model: "project-text-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWriterModelSelection: null,
            textGenerationModelSelection: projectTextWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Main project style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/repo": projectId },
        workspaceRoot: "/sibling",
        mainWorkspaceRoot: "/repo",
        onGenerate: (value) => {
          request = value;
        },
      });
      yield* readers.generatedStashMessage("/sibling", "all");
      assert.deepStrictEqual(request?.modelSelection, projectTextWriter);
      assert.equal(request?.policy?.commitInstructions, "Main project style");
    }),
  );

  it.effect("keeps environment generation when project lookup fails", () =>
    Effect.gen(function* () {
      let request: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [ProjectId.make("unrelated")]: { sourceControlWriterModelSelection: null },
        },
        failProjectLookup: true,
        onGenerate: (value) => {
          request = value;
        },
      });
      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(request?.modelSelection, sourceControlWriterModelSelection);
      assert.equal(request?.policy?.commitInstructions, "Environment style");
    }),
  );

  it.effect("uses the source control writer model and writing style for commits", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Use the configured source control voice.",
          followChangeRequestTemplates: true,
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, sourceControlWriterModelSelection);
      assert.deepInclude(generatedInput?.policy, {
        kind: "custom",
        commitInstructions: "Use the configured source control voice.",
        inferRepositoryConventions: false,
      });
    }),
  );

  it.effect("falls back to the text generation model and keeps writing style for stashes", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection: null,
        sourceControlWritingStyle: {
          mode: "conventional_commits",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedStashMessage("/repo", "all"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, textGenerationModelSelection);
      assert.equal(generatedInput?.policy?.kind, "conventional_commits");
    }),
  );

  it.effect("uses repository instructions for panel commits and stashes", () =>
    Effect.gen(function* () {
      const generatedPolicies: TextGeneration.CommitMessageGenerationInput["policy"][] = [];
      const agentInstructions = "Use lowercase source control text.";
      const claudeInstructions = "Keep generated messages brief.";
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        recentCommitSubjects: ["feat: keep the existing subject style"],
        repositoryInstructions: {
          "AGENTS.md": agentInstructions,
          "CLAUDE.md": claudeInstructions,
        },
        onGenerate: (request) => {
          generatedPolicies.push(request.policy);
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.equal(yield* readers.generatedStashMessage("/repo", "all"), "Generated message");

      const repositoryContext = [
        "Recent commit subjects from this repository:\nfeat: keep the existing subject style",
        `Local AGENTS.md:\n${agentInstructions}`,
        `Local CLAUDE.md:\n${claudeInstructions}`,
      ].join("\n\n");
      const expectedPolicy: NonNullable<TextGeneration.CommitMessageGenerationInput["policy"]> = {
        kind: "repo_conventions",
        commitInstructions: `Follow the repository's established commit message style when examples are available.\n\n${repositoryContext}`,
        changeRequestInstructions: `Follow the repository's established change request title and body style when examples are available.\n\n${repositoryContext}`,
        inferRepositoryConventions: true,
      };
      assert.deepStrictEqual(generatedPolicies, [expectedPolicy, expectedPolicy]);
    }),
  );

  it.effect("excludes Claude instructions for non-Claude panel writers", () =>
    Effect.gen(function* () {
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"];
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Only Claude writers should receive this.",
        },
        onGenerate: (request) => {
          generatedPolicy = request.policy;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.match(generatedPolicy?.commitInstructions ?? "", /Local AGENTS\.md:/);
      assert.equal((generatedPolicy?.commitInstructions ?? "").includes("Local CLAUDE.md:"), false);
    }),
  );

  it.effect("uses Claude instructions for custom Claude provider instances", () =>
    Effect.gen(function* () {
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"];
      const customClaudeInstanceId = ProviderInstanceId.make("claude-secondary");
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: customClaudeInstanceId,
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        providers: [
          {
            instanceId: customClaudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Keep custom Claude messages brief.",
        },
        onGenerate: (request) => {
          generatedPolicy = request.policy;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.match(generatedPolicy?.commitInstructions ?? "", /Local CLAUDE\.md:/);
    }),
  );

  it.effect("falls back from unavailable source control writers before resolving policy", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const unavailableInstanceId = ProviderInstanceId.make("claude-unavailable");
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: unavailableInstanceId,
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        providers: [
          {
            instanceId: unavailableInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
            installed: false,
            version: null,
            status: "disabled",
            auth: { status: "unknown" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            availability: "unavailable",
            unavailableReason: "Claude is not available in this test.",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Unavailable Claude writers must not receive this.",
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, textGenerationModelSelection);
      assert.equal(
        (generatedInput?.policy?.commitInstructions ?? "").includes("Local CLAUDE.md:"),
        false,
      );
    }),
  );

  it.effect("reads repository instructions from the repository root below a nested cwd", () =>
    Effect.gen(function* () {
      const instructionReads: Array<{ cwd: string; fileName: string }> = [];
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        workspaceRoot: "/repo",
        instructionReads,
        onGenerate: () => undefined,
      });

      yield* readers.generatedCommitMessage("/repo/packages/app");

      assert.deepStrictEqual(instructionReads, [
        { cwd: "/repo", fileName: "AGENTS.md" },
        { cwd: "/repo", fileName: "CLAUDE.md" },
      ]);
    }),
  );

  it.effect("fails instead of using the placeholder when generation fails", () =>
    Effect.gen(function* () {
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        onGenerate: () => undefined,
        generate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "test.generate",
              detail: "provider auth expired",
            }),
          ),
      });

      const commitError = yield* readers.generatedCommitMessage("/repo").pipe(Effect.flip);
      const stashError = yield* readers.generatedStashMessage("/repo", "all").pipe(Effect.flip);
      assert.equal(commitError._tag, "GitCommandError");
      assert.equal(
        commitError.detail,
        "Commit message generation failed; enter a message or retry.",
      );
      assert.equal(stashError.detail, "Stash message generation failed; enter a message or retry.");

      const emptySubject = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        onGenerate: () => undefined,
        generate: () => Effect.succeed({ subject: "  ", body: "" }),
      });
      assert.equal(
        (yield* emptySubject.generatedCommitMessage("/repo").pipe(Effect.flip)).operation,
        "vcs.panel.generateCommitMessage",
      );
    }),
  );

  it.effect("uses the placeholder only without a writer or without changes", () =>
    Effect.gen(function* () {
      const generated: unknown[] = [];
      const withoutWriter = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        withoutTextGeneration: true,
        onGenerate: (request) => generated.push(request),
      });
      const withoutChanges = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        diffOutput: "",
        onGenerate: (request) => generated.push(request),
      });

      assert.equal(yield* withoutWriter.generatedCommitMessage("/repo"), "T3 Code changes");
      assert.equal(yield* withoutWriter.generatedStashMessage("/repo", "all"), "T3 Code all stash");
      assert.equal(yield* withoutChanges.generatedCommitMessage("/repo"), "T3 Code changes");
      assert.equal(
        yield* withoutChanges.generatedStashMessage("/repo", "staged"),
        "T3 Code staged stash",
      );
      assert.deepStrictEqual(generated, []);
    }),
  );
});

describe("SourceControlPanelReaders branch details", () => {
  const sha = "a".repeat(40);
  const branch: VcsRef = { name: "feature", current: false, isDefault: false, worktreePath: null };
  const branchDetailsRun =
    (calls: ExecuteGitOperation[]): SourceControlPanelReaderDependencies["run"] =>
    (operation, _cwd, args) =>
      Effect.sync(() => {
        calls.push({ operation, args });
        switch (operation) {
          case "vcs.panel.branchUpstream":
            return "origin/feature\n";
          case "vcs.panel.branchCommits":
            return `${sha}\taaaaaaa\tAda\tada@example.test\t2026-07-26T12:00:00Z\tSubject\n`;
          case "vcs.panel.commitRefs":
            return `${sha}\t\tfeature\trefs/heads/feature\n`;
          case "vcs.panel.commitAvatarRemotes":
            return "origin\thttps://github.com/acme/repo.git (fetch)\n";
          default:
            return "";
        }
      });
  const providerRegistry = {
    get: () =>
      Effect.succeed({ getCommitAvatarUrl: () => Effect.succeed("https://avatars.test/ada") }),
  } as unknown as NonNullable<SourceControlPanelReaderDependencies["sourceControlProviders"]>;

  it.effect("skips remote reads when no provider opts into avatars", () =>
    Effect.gen(function* () {
      const calls: ExecuteGitOperation[] = [];
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        onGenerate: () => undefined,
        run: branchDetailsRun(calls),
        sourceControlProviders: providerRegistry,
      });

      const details = yield* readers.branchDetails("/repo", branch, "main", undefined, true);

      assert.equal(details.commits[0]?.authorAvatarUrl, null);
      assert.deepStrictEqual(details.commits[0]?.headRefs, ["feature"]);
      const operations = calls.map((call) => call.operation);
      assert.equal(operations.filter((op) => op === "vcs.panel.commitAvatarRemotes").length, 0);
      assert.equal(operations.filter((op) => op === "vcs.panel.commitRefs").length, 1);
    }),
  );

  it.effect("classifies only returned commits as unsynced without reading the range", () =>
    Effect.gen(function* () {
      const publishedSha = "b".repeat(40);
      const unsyncedSha = "c".repeat(40);
      const baseSha = "d".repeat(40);
      const pageShas = [publishedSha, unsyncedSha];
      const calls: ExecuteGitOperation[] = [];
      let upstream = "origin/feature\n";
      let baseOutput = `${baseSha}\n`;
      let failReachability = false;
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        onGenerate: () => undefined,
        run: (operation, cwd, args) =>
          Effect.suspend(() => {
            calls.push({ operation, args });
            switch (operation) {
              case "vcs.panel.branchUpstream":
                return Effect.succeed(upstream);
              case "vcs.panel.branchCommitCount":
                return Effect.succeed("600\n");
              case "vcs.panel.branchCommits":
                return Effect.succeed(
                  pageShas
                    .map(
                      (pageSha) =>
                        `${pageSha}\tsha\tAda\tada@example.test\t2026-07-26T12:00:00Z\tS`,
                    )
                    .join("\n"),
                );
              case "vcs.panel.unsyncedBase":
                return Effect.succeed(baseOutput);
              case "vcs.panel.commitReachable":
                return failReachability
                  ? Effect.fail(
                      new GitCommandError({ operation, command: "git", cwd, detail: "boom" }),
                    )
                  : Effect.succeed(args.includes(unsyncedSha) ? "1\n" : "0\n");
              default:
                return Effect.succeed("");
            }
          }),
      });
      const unsyncedOf = (commits: ReadonlyArray<VcsPanelCommitSummary>) =>
        commits.filter((commit) => commit.unsynced === true).map((commit) => commit.sha);
      const reachabilityChecks = () =>
        calls.filter((call) => call.operation === "vcs.panel.commitReachable");

      const details = yield* readers.branchDetails("/repo", branch, "main", undefined, true);
      assert.deepStrictEqual(unsyncedOf(details.commits), [unsyncedSha]);
      assert.deepStrictEqual(unsyncedOf(details.aheadCommits), [unsyncedSha]);
      assert.deepStrictEqual(unsyncedOf(details.behindCommits), []);
      assert.deepStrictEqual(details.unsyncedCommitShas, [unsyncedSha]);
      // Each distinct returned commit is checked once against the resolved base.
      assert.deepStrictEqual(
        reachabilityChecks().map((call) => call.args),
        pageShas.map((pageSha) => ["rev-list", "--count", "--max-count=1", pageSha, `^${baseSha}`]),
      );

      calls.length = 0;
      const laterPage = yield* readers.branchCommits(
        "/repo",
        branch,
        "main",
        "history",
        500,
        10,
        true,
        "main",
      );
      assert.deepStrictEqual(unsyncedOf(laterPage.commits), [unsyncedSha]);
      assert.equal(reachabilityChecks().length, pageShas.length);
      const behindPage = yield* readers.branchCommits("/repo", branch, "main", "behind", 10, 10);
      assert.deepStrictEqual(unsyncedOf(behindPage.commits), []);

      // Without an upstream, the default compare ref decides, as in branch details.
      upstream = "";
      calls.length = 0;
      yield* readers.branchCommits("/repo", branch, "main", "ahead", 10, 10, true, "develop");
      assert.deepStrictEqual(
        calls.find((call) => call.operation === "vcs.panel.unsyncedBase")?.args,
        ["rev-parse", "--verify", "--quiet", "develop^{commit}"],
      );

      // A missing base leaves nothing unsynced; a failed check is not mistaken for published.
      baseOutput = "";
      const missingBase = yield* readers.branchCommits(
        "/repo",
        branch,
        "main",
        "ahead",
        0,
        10,
        true,
        "develop",
      );
      assert.deepStrictEqual(unsyncedOf(missingBase.commits), []);
      baseOutput = `${baseSha}\n`;
      failReachability = true;
      const failure = yield* readers
        .branchCommits("/repo", branch, "main", "ahead", 0, 10, true, "develop")
        .pipe(Effect.flip);
      assert.equal(failure.detail, "boom");
    }),
  );

  it.effect("reads avatar remotes and refs once per branch expansion", () =>
    Effect.gen(function* () {
      const calls: ExecuteGitOperation[] = [];
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        onGenerate: () => undefined,
        run: branchDetailsRun(calls),
        sourceControlProviders: providerRegistry,
        sourceControl: {
          ...DEFAULT_SERVER_SETTINGS.sourceControl,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.sourceControl.providers,
            github: { showCommitAuthorAvatar: true },
          },
        },
      });

      const details = yield* readers.branchDetails("/repo", branch, "main", undefined, true);

      for (const commits of [details.commits, details.aheadCommits, details.behindCommits]) {
        assert.equal(commits[0]?.authorAvatarUrl, "https://avatars.test/ada");
      }
      const operations = calls.map((call) => call.operation);
      assert.equal(operations.filter((op) => op === "vcs.panel.commitAvatarRemotes").length, 1);
      assert.equal(operations.filter((op) => op === "vcs.panel.commitRefs").length, 1);
    }),
  );
});

interface ExecuteGitOperation {
  readonly operation: string;
  readonly args: readonly string[];
}

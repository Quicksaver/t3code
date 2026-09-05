import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { makeSourceControlWritingPolicyResolver } from "../textGeneration/SourceControlWriting.ts";
import { makeSourceControlPanelReaders } from "./SourceControlPanelReaders.ts";

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
}) {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
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
    run: (operation) =>
      Effect.succeed(
        operation.endsWith("Summary")
          ? "1 file changed"
          : operation.endsWith("Status")
            ? "M src/example.ts"
            : "diff --git a/src/example.ts b/src/example.ts",
      ),
    serverSettings: {
      getSettings: Effect.succeed(settings),
    } as unknown as ServerSettingsService["Service"],
    sourceControlProviders: undefined,
    sourceControlRateLimits: undefined,
    getProviders: Effect.succeed(providers),
    resolveWritingPolicy: makeSourceControlWritingPolicyResolver({
      runGit: () => Effect.succeed((input.recentCommitSubjects ?? []).join("\n")),
      readRepositoryInstructions: (_cwd, fileName) =>
        Effect.succeed(input.repositoryInstructions?.[fileName as "AGENTS.md" | "CLAUDE.md"] ?? ""),
    }),
    textGeneration: {
      generateCommitMessage: (request: TextGeneration.CommitMessageGenerationInput) =>
        Effect.sync(() => {
          input.onGenerate(request);
          return { subject: "Generated message", body: "" };
        }),
    } as unknown as TextGeneration.TextGeneration["Service"],
  });
}

describe("SourceControlPanelReaders generated messages", () => {
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
});

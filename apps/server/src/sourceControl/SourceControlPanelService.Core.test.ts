import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  type BackgroundPolicySnapshot,
  type ChangeRequest,
  type SourceControlProviderKind,
  type VcsPanelCompareInput,
  type VcsPanelFileChange,
  type VcsRef,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import { SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS } from "./SourceControlPanelActions.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectStoreV2, type ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import {
  TextGeneration,
  type CommitMessageGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import { GIT_COMMAND_TIMEOUT_MS, resolveGitCommandTimeoutMs } from "../vcs/GitCommandTimeout.ts";
import {
  GitVcsDriver,
  layer as GitVcsDriverLayer,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const unlockedBackgroundPolicy: BackgroundPolicySnapshot = {
  hostPower: {
    source: "electron-main",
    idle: "false",
    idleSeconds: 0,
    locked: "false",
    suspended: false,
    onBattery: "false",
    lowPowerMode: "false",
    thermalState: "unknown",
    stale: false,
    updatedAt: DateTime.makeUnsafe("2026-10-01T22:00:00.000Z"),
  },
  leases: [],
  activeForegroundLeaseCount: 0,
  activeScopeKeys: [],
  shouldRunOpportunisticWork: false,
  updatedAt: DateTime.makeUnsafe("2026-10-01T22:00:00.000Z"),
};

const branchRef: VcsRef = {
  name: "feature/source-control",
  current: false,
  isDefault: false,
  worktreePath: null,
};
const isGitCommandError = Schema.is(GitCommandError);

const success = (stdout = ""): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const failure = (stderr: string): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(1),
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const LiveGitDriverLayer = GitVcsDriverLayer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vcs-panel-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const emptyProvider = SourceControlProvider.SourceControlProvider.of({
  kind: "unknown",
  listChangeRequests: () => Effect.succeed([]),
  getChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getChangeRequest",
        cwd: "/repo",
        detail: "get change request not stubbed",
      }),
    ),
  createChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createChangeRequest",
        cwd: "/repo",
        detail: "create change request not stubbed",
      }),
    ),
  getRepositoryCloneUrls: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getRepositoryCloneUrls",
        cwd: "/repo",
        detail: "repository clone URLs not stubbed",
      }),
    ),
  getCommitAvatarUrl: () => Effect.succeed(null),
  createRepository: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createRepository",
        cwd: "/repo",
        detail: "create repository not stubbed",
      }),
    ),
  getDefaultBranch: () => Effect.succeed(null),
  checkoutChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.checkoutChangeRequest",
        cwd: "/repo",
        detail: "checkout change request not stubbed",
      }),
    ),
});

function makeTestLayer(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
  workflow: Partial<GitWorkflowService["Service"]> = {},
  providers: Partial<
    Record<SourceControlProviderKind, SourceControlProvider.SourceControlProvider["Service"]>
  > = {},
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
  gitDriver: Partial<GitVcsDriver["Service"]> = {},
  platformLayer = NodeServices.layer,
  background: Partial<
    Pick<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"], "refreshStatus"> &
      Pick<BackgroundPolicy.BackgroundPolicy["Service"], "shouldRunScopeWork" | "snapshot">
  > = {},
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provide(Layer.mock(GitManager)({ branchPullRequest: () => Effect.succeed(null) })),
    Layer.provideMerge(platformLayer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: background.refreshStatus ?? (() => Effect.never),
      }),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: background.shouldRunScopeWork ?? (() => Effect.succeed(true)),
        ...(background.snapshot ? { snapshot: background.snapshot } : {}),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.succeed(GitWorkflowService, {
        status: (input) =>
          workflow.status
            ? workflow.status(input)
            : workflow.localStatus
              ? workflow.localStatus(input).pipe(
                  Effect.map((status) => ({
                    ...status,
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                    aheadOfDefaultCount:
                      (status as { readonly aheadOfDefaultCount?: number }).aheadOfDefaultCount ??
                      0,
                    pr: null,
                  })),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "test.status",
                    command: "git status",
                    cwd: "/repo",
                    detail: "status not stubbed",
                  }),
                ),
        localStatus: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.localStatus",
              command: "git status",
              cwd: "/repo",
              detail: "local status not stubbed",
            }),
          ),
        pullCurrentBranch: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.pullCurrentBranch",
              command: "git pull",
              cwd: "/repo",
              detail: "pull not stubbed",
            }),
          ),
        ...workflow,
      } as GitWorkflowService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver, {
        execute,
        invalidateRefs: () => Effect.void,
        ...gitDriver,
      } as unknown as GitVcsDriver["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        SourceControlProviderRegistry,
        SourceControlProviderRegistry.of({
          resolveLink: () => Effect.die("unused resolveLink"),
          get: (kind) => Effect.succeed(providers[kind] ?? emptyProvider),
          resolveHandle: () => Effect.succeed({ provider: emptyProvider, context: null }),
          resolve: () => Effect.succeed(emptyProvider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );
}

const localStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/source-control",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
};

describe("SourceControlPanelService", () => {
  describe.each(["applyStash", "popStash", "dropStash"] as const)("%s", (action) => {
    it.effect(`${action} rejects a renumbered stash before changing files or stash entries`, () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const error = yield* service[action]({
          cwd: "/repo",
          stashRef: "stash@{1}",
          expectedSha: "a".repeat(40),
        }).pipe(Effect.flip);
        assert.match(error.detail, /selected stash has changed/);
        assert.equal(
          calls.some((call) => call.args[0] === "stash"),
          false,
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              return success(
                input.args[0] === "rev-parse" && input.args[1] === "--verify"
                  ? "b".repeat(40)
                  : "/common/.git",
              );
            }),
          ),
        ),
      );
    });
    it.effect(`${action} reports a vanished selection without mutating the repository`, () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const error = yield* service[action]({
          cwd: "/repo",
          stashRef: "stash@{1}",
          expectedSha: "a".repeat(40),
        }).pipe(Effect.flip);
        assert.match(error.detail, /selected stash has changed/);
        assert.equal(
          calls.some((call) => call.args[0] === "stash"),
          false,
        );
        assert.equal(calls.find((call) => call.args[1] === "--verify")?.allowNonZeroExit, true);
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              return input.args[1] === "--verify"
                ? failure("fatal: Needed a single revision")
                : success("/common/.git");
            }),
          ),
        ),
      );
    });
    it.effect(`${action} preserves the selected stash identity`, () => {
      const calls: ExecuteGitInput[] = [];
      const sha = "a".repeat(40);
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        yield* service[action]({ cwd: "/repo", stashRef: "stash@{1}", expectedSha: sha });
        assert.deepStrictEqual(
          calls.filter((call) => call.args[0] === "stash").map((call) => call.args),
          action === "applyStash"
            ? [["stash", "apply", sha]]
            : action === "popStash"
              ? [
                  ["stash", "apply", sha],
                  ["stash", "drop", "stash@{1}"],
                ]
              : [["stash", "drop", "stash@{1}"]],
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              return success(input.args[1] === "--verify" ? sha : "/common/.git");
            }),
          ),
        ),
      );
    });
  });

  it.effect("keeps a replacement stash when its position changes during pop application", () => {
    const calls: ExecuteGitInput[] = [];
    let applied = false;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const error = yield* service
        .popStash({ cwd: "/repo", stashRef: "stash@{0}", expectedSha: "a".repeat(40) })
        .pipe(Effect.flip);
      assert.match(error.detail, /stash changes were applied/);
      assert.match(error.detail, /did not drop the stash/);
      assert.match(error.detail, /do not apply it again/);
      assert.equal(
        calls.some((call) => call.args[1] === "drop"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.args[1] === "apply") applied = true;
            return success(
              input.args[1] === "--verify" ? (applied ? "b" : "a").repeat(40) : "/common/.git",
            );
          }),
        ),
      ),
    );
  });

  it.effect(
    "reports applied changes without dropping a stash whose selector vanished during pop",
    () => {
      const calls: ExecuteGitInput[] = [];
      let applied = false;
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const error = yield* service
          .popStash({ cwd: "/repo", stashRef: "stash@{0}", expectedSha: "a".repeat(40) })
          .pipe(Effect.flip);
        assert.match(error.detail, /stash changes were applied/);
        assert.match(error.detail, /did not drop the stash/);
        assert.match(error.detail, /do not apply it again/);
        assert.deepStrictEqual(
          calls.filter((call) => call.args[0] === "stash").map((call) => call.args),
          [["stash", "apply", "a".repeat(40)]],
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              if (input.args[1] === "apply") applied = true;
              return input.args[1] === "--verify"
                ? applied
                  ? failure("fatal: Needed a single revision")
                  : success("a".repeat(40))
                : success("/common/.git");
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "preserves a stash verification launch failure instead of reporting a stale selection",
    () => {
      const launchError = new GitCommandError({
        operation: "vcs.panel.popStash",
        cwd: "/repo",
        command: "git rev-parse",
        detail: "Git process could not be launched",
      });
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const error = yield* service
          .popStash({ cwd: "/repo", expectedSha: "a".repeat(40) })
          .pipe(Effect.flip);
        assert.equal(error, launchError);
        assert.equal(
          calls.some((call) => call.args[0] === "stash"),
          false,
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) => {
            calls.push(input);
            return input.args[1] === "--verify"
              ? Effect.fail(launchError)
              : Effect.succeed(success("/common/.git"));
          }),
        ),
      );
    },
  );

  it.effect("preserves positional compatibility when the stash SHA is omitted or null", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.applyStash({ cwd: "/repo", stashRef: "stash@{1}" });
      yield* service.popStash({ cwd: "/repo", expectedSha: null });
      yield* service.dropStash({ cwd: "/repo", stashRef: "stash@{2}", expectedSha: null });
      assert.deepStrictEqual(
        calls.filter((call) => call.args[0] === "stash").map((call) => call.args),
        [
          ["stash", "apply", "stash@{1}"],
          ["stash", "pop", "stash@{0}"],
          ["stash", "drop", "stash@{2}"],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("/common/.git");
          }),
        ),
      ),
    );
  });

  it.effect("coordinates stash creation with another caller in a linked worktree", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondCanonicalized = yield* Deferred.make<void>();
      const mutations: string[] = [];
      let canonicalizations = 0;
      yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const first = yield* service
          .applyStash({ cwd: "/root", stashRef: "stash@{0}" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* service
          .createStash({ cwd: "/linked", message: "Save linked changes" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(secondCanonicalized);
        assert.deepStrictEqual(mutations, ["apply started"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.deepStrictEqual(mutations, ["apply started", "apply completed", "push"]);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.gen(function* () {
                if (input.args[0] === "rev-parse") return success("/missing-common/.git");
                if (input.args[1] === "apply") {
                  mutations.push("apply started");
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  mutations.push("apply completed");
                } else mutations.push(input.args[1]!);
                return success();
              }),
            undefined,
            undefined,
            undefined,
            undefined,
            Layer.effect(
              FileSystem.FileSystem,
              Effect.gen(function* () {
                const base = yield* FileSystem.FileSystem;
                return FileSystem.FileSystem.of({
                  ...base,
                  realPath: (path) =>
                    Effect.gen(function* () {
                      if (++canonicalizations === 2)
                        yield* Deferred.succeed(secondCanonicalized, undefined);
                      return path;
                    }),
                });
              }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      );
    }),
  );

  it.effect("releases stash coordination when a caller is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const created = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const first = yield* service
          .applyStash({ cwd: "/root" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* service
          .createStash({ cwd: "/linked", message: "Save linked changes" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Deferred.await(created);
        yield* Fiber.join(second);
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.gen(function* () {
              if (input.args[0] === "rev-parse") return success("/missing-common/.git");
              if (input.args[1] === "apply") {
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }
              yield* Deferred.succeed(created, undefined);
              return success();
            }),
          ),
        ),
      );
    }),
  );
  it.effect.each([
    { registeredSibling: true, label: "registered" },
    { registeredSibling: false, label: "inherited" },
  ])("resolves Git-form project paths for $label sibling messages", ({ registeredSibling }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const requests: CommitMessageGenerationInput[] = [];
      const projectId = ProjectId.make("windows-project");
      const project: ProjectRow = {
        projectId,
        title: "Windows project",
        workspaceRoot: path.resolve(registeredSibling ? "C:/sibling" : "C:/repo"),
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        deletedAt: null,
      };
      const writer = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "project-writer",
        options: [],
      };
      yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        yield* service.commitStaged({ cwd: "C:/sibling" });
        yield* service.createStash({ cwd: "C:/sibling", mode: "all" });
        assert.equal(requests.length, 2);
        for (const request of requests) {
          assert.deepStrictEqual(request.modelSelection, writer);
          assert.equal(request.policy?.commitInstructions, "Project instructions");
        }
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.succeed(
                success(
                  input.operation === "vcs.panel.writingWorkspaceRoot"
                    ? "C:/sibling"
                    : input.operation === "vcs.panel.writingWorktrees"
                      ? "worktree C:/repo\0detached\0\0"
                      : "changed file",
                ),
              ),
            {},
            {},
            {
              projectSettingsOverrides: {
                [projectId]: {
                  sourceControlWriterModelSelection: null,
                  textGenerationModelSelection: writer,
                  sourceControlWritingStyle: {
                    mode: "custom",
                    customInstructions: "Project instructions",
                    followChangeRequestTemplates: true,
                  },
                },
              },
            },
          ).pipe(
            Layer.provide(
              Layer.mock(ProjectStoreV2)({
                findActiveByWorkspaceRoot: (cwd) =>
                  Effect.succeed(
                    cwd === project.workspaceRoot ? Option.some(project) : Option.none(),
                  ),
              }),
            ),
            Layer.provide(
              Layer.mock(TextGeneration)({
                generateCommitMessage: (request) =>
                  Effect.sync(() => {
                    requests.push(request);
                    return { subject: "Generated message", body: "" };
                  }),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the default branch as its own stable comparison base", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const details = yield* service.branchDetails({
        cwd: "/repo",
        branch: {
          name: "develop",
          current: true,
          isDefault: true,
          worktreePath: "/repo",
        },
        defaultCompareRef: "develop",
      });

      assert.equal(details.baseRef, "develop");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => success(input.args[0] === "rev-list" ? "0" : "")),
        ),
      ),
    ),
  );

  it.effect("uses the selected branch head for history queries", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("uses the compare range for compare-history branch queries", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "compare-history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "main...feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "main...feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("uses the selected branch for compare-history queries without a base", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: null,
        kind: "compare-history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("does not fetch provider account avatar URLs by default", () => {
    let avatarLookupCount = 0;

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.equal(result.commits[0]?.authorAvatarUrl, null);
      assert.equal(result.commits[1]?.authorAvatarUrl, null);
      assert.equal(avatarLookupCount, 0);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.args[0]) {
                case "rev-list":
                  return success("2");
                case "log":
                  return success(
                    [
                      "a".repeat(40),
                      "aaaaaaa",
                      "Ada Lovelace",
                      "ada@example.test",
                      "2026-06-27T10:00:00+00:00",
                      "Add source control avatars",
                    ].join("\t") +
                      "\n" +
                      [
                        "b".repeat(40),
                        "bbbbbbb",
                        "Grace Hopper",
                        "grace@example.test",
                        "2026-06-27T09:00:00+00:00",
                        "Keep avatars distinct",
                      ].join("\t"),
                  );
                case "remote":
                  return success(
                    [
                      "origin\thttps://github.com/pingdotgg/t3code.git (fetch)",
                      "origin\thttps://github.com/pingdotgg/t3code.git (push)",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {},
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              getCommitAvatarUrl: () =>
                Effect.sync(() => {
                  avatarLookupCount += 1;
                  return "https://avatars.githubusercontent.com/u/101?v=4";
                }),
            }),
          },
        ),
      ),
    );
  });

  it.effect("uses opted-in provider account avatar URLs for commit authors", () => {
    const avatarLookups: Array<{
      readonly sha: string;
      readonly authorEmail: string | null | undefined;
      readonly remoteUrl: string | undefined;
    }> = [];

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      const firstAvatar = result.commits[0]?.authorAvatarUrl;
      const secondAvatar = result.commits[1]?.authorAvatarUrl;

      if (typeof firstAvatar !== "string" || typeof secondAvatar !== "string") {
        assert.fail("expected commit authors to have provider avatar URLs");
      }
      assert.equal(firstAvatar, "https://avatars.githubusercontent.com/u/101?v=4");
      assert.equal(secondAvatar, "https://avatars.githubusercontent.com/u/202?v=4");
      assert.notStrictEqual(firstAvatar, secondAvatar);
      assert.deepStrictEqual(avatarLookups, [
        {
          sha: "a".repeat(40),
          authorEmail: "ada@example.test",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        {
          sha: "b".repeat(40),
          authorEmail: "grace@example.test",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.args[0]) {
                case "rev-list":
                  return success("2");
                case "log":
                  return success(
                    [
                      "a".repeat(40),
                      "aaaaaaa",
                      "Ada Lovelace",
                      "ada@example.test",
                      "2026-06-27T10:00:00+00:00",
                      "Add source control avatars",
                    ].join("\t") +
                      "\n" +
                      [
                        "b".repeat(40),
                        "bbbbbbb",
                        "Grace Hopper",
                        "grace@example.test",
                        "2026-06-27T09:00:00+00:00",
                        "Keep avatars distinct",
                      ].join("\t"),
                  );
                case "remote":
                  return success(
                    [
                      "origin\thttps://github.com/pingdotgg/t3code.git (fetch)",
                      "origin\thttps://github.com/pingdotgg/t3code.git (push)",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {},
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              getCommitAvatarUrl: (input) =>
                Effect.sync(() => {
                  avatarLookups.push({
                    sha: input.sha,
                    authorEmail: input.authorEmail,
                    remoteUrl: input.context?.remoteUrl,
                  });
                  return input.sha.startsWith("a")
                    ? "https://avatars.githubusercontent.com/u/101?v=4"
                    : "https://avatars.githubusercontent.com/u/202?v=4";
                }),
            }),
          },
          {
            sourceControl: {
              providers: {
                github: {
                  showCommitAuthorAvatar: true,
                },
              },
            },
          },
        ),
      ),
    );
  });

  it.effect("keeps wrapper messages structural while preserving sanitized causes", () => {
    const cause = new Error("transport closed");
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .branchCommits({
          cwd: "/repo",
          branch: branchRef,
          baseRef: "main",
          kind: "history",
          skip: 0,
          limit: 10,
        })
        .pipe(Effect.flip);

      assert.strictEqual(isGitCommandError(error), true);
      assert.strictEqual(error.detail, "Source control operation failed.");
      assert.strictEqual(error.message.includes("transport closed"), false);
      assert.deepStrictEqual(error.cause, {
        name: "Error",
        message: "transport closed",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          () => Effect.fail(cause) as unknown as Effect.Effect<ExecuteGitResult, never>,
        ),
      ),
    );
  });

  it.effect("keeps action wrapper messages structural while preserving sanitized causes", () => {
    const cause = new Error("credential-bearing workflow failure");
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .commitStaged({
          cwd: "/repo",
          message: "Test commit",
          push: true,
        })
        .pipe(Effect.flip);

      assert.strictEqual(isGitCommandError(error), true);
      assert.strictEqual(error.operation, "vcs.panel.commitStaged.status");
      assert.strictEqual(error.detail, "Git command failed.");
      assert.strictEqual(error.message.includes(cause.message), false);
      assert.deepStrictEqual(error.cause, {
        name: "Error",
        message: cause.message,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Effect.succeed(success()), {
          status: () =>
            Effect.fail(cause) as unknown as ReturnType<GitWorkflowService["Service"]["status"]>,
        }),
      ),
    );
  });

  it.effect("keeps Git's explanation when a mutation fails through the live driver", () =>
    Effect.gen(function* () {
      const liveGit = yield* GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-panel-merge-" });
      const git = (...args: string[]) =>
        liveGit.execute({ operation: "test.git", cwd, args }).pipe(Effect.asVoid);
      const commitFile = (contents: string, message: string) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), contents);
          yield* git("add", "file.txt");
          yield* git("commit", "-m", message);
        });
      yield* git("init", "--initial-branch=main");
      yield* git("config", "user.email", "test@example.com");
      yield* git("config", "user.name", "Test User");
      yield* git("config", "commit.gpgsign", "false");
      yield* commitFile("base\n", "Base");
      yield* git("checkout", "-b", "feature");
      yield* commitFile("feature\n", "Feature");
      yield* git("checkout", "main");
      yield* commitFile("main\n", "Main");

      const error = yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        return yield* service.mergeBranchIntoCurrent({ cwd, refName: "feature" }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeTestLayer(liveGit.execute)));

      assert.equal(error.operation, "vcs.panel.mergeBranchIntoCurrent");
      assert.include(error.detail, "Merge conflict in file.txt");
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("flags unsynced commits on a later page and only on the branch side", () =>
    Effect.gen(function* () {
      const liveGit = yield* GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-panel-unsynced-" });
      const git = (...args: string[]) =>
        liveGit.execute({ operation: "test.git", cwd, args }).pipe(Effect.asVoid);
      const commit = (message: string) => git("commit", "--allow-empty", "-m", message);
      yield* git("init", "--initial-branch=main");
      yield* git("config", "user.email", "test@example.com");
      yield* git("config", "user.name", "Test User");
      yield* git("config", "commit.gpgsign", "false");
      yield* commit("Base");
      yield* git("branch", "published");
      yield* git("checkout", "-b", "feature");
      for (let index = 1; index <= 12; index++) yield* commit(`Feature ${index}`);
      yield* git("checkout", "main");
      yield* commit("Main");

      const branch: VcsRef = {
        name: "feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      };
      const unsyncedMessages = (
        commits: ReadonlyArray<{ message: string; unsynced?: boolean | undefined }>,
      ) =>
        commits
          .filter((entry) => entry.unsynced === true)
          .map((entry) => entry.message)
          .toSorted();
      const [laterPage, comparePage] = yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        return yield* Effect.all([
          service.branchCommits({
            cwd,
            branch,
            kind: "history",
            defaultCompareRef: "main",
            skip: 10,
            limit: 10,
          }),
          service.branchCommits({
            cwd,
            branch,
            baseRef: "main",
            kind: "compare-history",
            // Main is missing from this base too, but it is not on the branch.
            defaultCompareRef: "published",
            skip: 0,
            limit: 50,
          }),
        ]);
      }).pipe(Effect.provide(makeTestLayer(liveGit.execute)));

      assert.deepStrictEqual(laterPage.commits.map((entry) => entry.message).toSorted(), [
        "Base",
        "Feature 1",
        "Feature 2",
      ]);
      assert.deepStrictEqual(unsyncedMessages(laterPage.commits), ["Feature 1", "Feature 2"]);
      assert.isTrue(comparePage.commits.some((entry) => entry.message === "Main"));
      assert.deepStrictEqual(
        unsyncedMessages(comparePage.commits),
        Array.from({ length: 12 }, (_, index) => `Feature ${index + 1}`).toSorted(),
      );
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("force-pushes over only the remote tip the user confirmed", () =>
    Effect.gen(function* () {
      const liveGit = yield* GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-panel-lease-" });
      const remote = path.join(root, "remote.git");
      const local = path.join(root, "local");
      const other = path.join(root, "other");
      const gitIn = (cwd: string, ...args: string[]) =>
        liveGit
          .execute({ operation: "test.git", cwd, args })
          .pipe(Effect.map((result) => result.stdout.trim()));
      const configure = (cwd: string) =>
        Effect.all([
          gitIn(cwd, "config", "user.email", "test@example.com"),
          gitIn(cwd, "config", "user.name", "Test User"),
          gitIn(cwd, "config", "commit.gpgsign", "false"),
        ]);
      const remoteTip = () => gitIn(remote, "rev-parse", "refs/heads/feature");
      const forcePush = (expectedRemoteSha?: string) =>
        SourceControlPanelService.use((service) =>
          service.pushBranch({
            cwd: local,
            branchName: "feature",
            force: true,
            ...(expectedRemoteSha ? { expectedRemoteSha } : {}),
          }),
        ).pipe(Effect.provide(makeTestLayer(liveGit.execute)));

      yield* gitIn(root, "init", "--bare", "--initial-branch=main", remote);
      yield* fileSystem.makeDirectory(local);
      yield* gitIn(local, "init", "--initial-branch=main");
      yield* configure(local);
      yield* gitIn(local, "commit", "--allow-empty", "-m", "Base");
      yield* gitIn(local, "checkout", "-b", "feature");
      yield* gitIn(local, "commit", "--allow-empty", "-m", "Feature");
      yield* gitIn(local, "remote", "add", "origin", remote);
      yield* gitIn(local, "push", "-u", "origin", "main", "feature");
      // The tip the panel showed when the user confirmed overwriting the diverged remote.
      const confirmedTip = yield* gitIn(local, "rev-parse", "refs/remotes/origin/feature");
      yield* gitIn(local, "reset", "--hard", "main");
      yield* gitIn(local, "commit", "--allow-empty", "-m", "Rewritten feature");

      // Someone else moves the remote, and a background fetch updates the tracking ref.
      yield* gitIn(root, "clone", remote, other);
      yield* configure(other);
      yield* gitIn(other, "checkout", "feature");
      yield* gitIn(other, "commit", "--allow-empty", "-m", "Concurrent work");
      yield* gitIn(other, "push", "origin", "feature");
      const movedTip = yield* remoteTip();
      yield* gitIn(local, "fetch", "origin");

      const staleError = yield* forcePush(confirmedTip).pipe(Effect.flip);
      assert.equal(staleError.operation, "vcs.panel.pushBranch");
      assert.equal(yield* remoteTip(), movedTip);

      // Without an observed tip, the lease still refuses commits never integrated locally.
      yield* forcePush().pipe(Effect.flip);
      assert.equal(yield* remoteTip(), movedTip);

      // Confirming the moved tip overwrites it even though it was never integrated locally.
      yield* forcePush(movedTip);
      assert.equal(yield* remoteTip(), yield* gitIn(local, "rev-parse", "HEAD"));
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("redacts and bounds Git's explanation of a rejected push", () => {
    const remoteUrl = "https://user:secret@example.com/repo.git";
    const stderr = [
      ...Array.from({ length: 300 }, (_, index) => `remote: progress line ${index}`),
      `To ${remoteUrl}`,
      " ! [rejected]        feature -> feature (fetch first)",
      `error: failed to push some refs to '${remoteUrl}'`,
    ].join("\n");
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .pushBranch({ cwd: "/repo", branchName: "feature", remoteName: "upstream" })
        .pipe(Effect.flip);

      assert.notInclude(error.detail, "secret");
      assert.isAtMost(error.detail.length, 2_001);
      assert.isTrue(
        error.detail.endsWith("error: failed to push some refs to 'https://example.com/repo.git'"),
      );
      assert.include(error.detail, "! [rejected]");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          // Like the live driver, a nonzero exit drops its output unless the caller allows it.
          input.allowNonZeroExit
            ? Effect.succeed(failure(stderr))
            : Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: "git push",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                }),
              ),
        ),
      ),
    );
  });

  it.effect("cleans staged additions missing from HEAD without failing tracked paths", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.discardFiles({
        cwd: "/repo",
        paths: ["new-file.ts"],
        staged: true,
      });

      assert.deepStrictEqual(
        calls.map((call) => [call.args, call.stdin]),
        [
          [
            [
              "--literal-pathspecs",
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              "HEAD",
              "--",
              "new-file.ts",
            ],
            undefined,
          ],
          [
            ["--literal-pathspecs", "reset", "--pathspec-from-file=-", "--pathspec-file-nul"],
            "new-file.ts\0",
          ],
          [["--literal-pathspecs", "clean", "-fd", "--", "new-file.ts"], undefined],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("");
          }),
        ),
      ),
    );
  });

  it.effect("discards mixed tracked and untracked unstaged files in one action", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.discardFiles({
        cwd: "/repo",
        paths: ["tracked.ts", "new-file.ts"],
        staged: false,
      });

      assert.deepStrictEqual(
        calls.map((call) => [call.args, call.stdin]),
        [
          [
            [
              "--literal-pathspecs",
              "ls-files",
              "--cached",
              "-z",
              "--",
              "tracked.ts",
              "new-file.ts",
            ],
            undefined,
          ],
          [
            [
              "--literal-pathspecs",
              "restore",
              "--worktree",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            "tracked.ts\0",
          ],
          [["--literal-pathspecs", "clean", "-fd", "--", "tracked.ts", "new-file.ts"], undefined],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.discardUnstagedFiles.listIndexPaths"
              ? success("tracked.ts\0")
              : success("");
          }),
        ),
      ),
    );
  });

  it.effect("fails unstaged discard when tracked restore fails", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .discardFiles({
          cwd: "/repo",
          paths: ["tracked.ts", "new-file.ts"],
          staged: false,
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.discardUnstagedFiles");
      const relevantCalls = calls.filter((call) =>
        [
          "vcs.panel.discardUnstagedFiles.listIndexPaths",
          "vcs.panel.discardUnstagedFiles",
          "vcs.panel.cleanUntrackedFiles",
        ].includes(call.operation),
      );
      assert.deepStrictEqual(
        relevantCalls.map((call) => [call.operation, call.args]),
        [
          [
            "vcs.panel.discardUnstagedFiles.listIndexPaths",
            [
              "--literal-pathspecs",
              "ls-files",
              "--cached",
              "-z",
              "--",
              "tracked.ts",
              "new-file.ts",
            ],
          ],
          [
            "vcs.panel.discardUnstagedFiles",
            [
              "--literal-pathspecs",
              "restore",
              "--worktree",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.operation === "vcs.panel.discardUnstagedFiles.listIndexPaths") {
              return success("tracked.ts\0");
            }
            if (input.operation === "vcs.panel.discardUnstagedFiles") {
              return failure("restore failed");
            }
            return success("");
          }),
        ),
      ),
    );
  });

  it.effect("preserves multiline commit message formatting in one git argument", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        message: "Subject\nBody without blank separator",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["commit", "-m", "Subject\nBody without blank separator"]],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("does not abort a successful commit because of hook diagnostics", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        message: "Commit selected file",
      });
      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["commit", "-m", "Commit selected file"]],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.gen(function* () {
            calls.push(input);
            yield* (
              input.progress?.onStderrLine?.("Error: Cannot find native binding") ?? Effect.void
            );
            yield* (
              input.progress?.onStderrLine?.("VITE+ - pre-commit script failed (code 1)") ??
                Effect.void
            );
            yield* Effect.yieldNow;
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("enriches a failed commit with detected hook diagnostics", () => {
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .commitStaged({
          cwd: "/repo",
          message: "Commit selected file",
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "The Git pre-commit hook could not load a required native dependency. Reinstall the repository dependencies and try again.",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.gen(function* () {
            yield* (
              input.progress?.onStderrLine?.("Error: Cannot find native binding") ?? Effect.void
            );
            return failure("pre-commit hook failed");
          }),
        ),
      ),
    );
  });

  it.effect("stages and unstages selected files with literal pathspecs", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const paths = ["src/[literal].ts"];

      yield* service.stageFiles({ cwd: "/repo", paths });
      yield* service.unstageFiles({ cwd: "/repo", paths });

      assert.deepStrictEqual(
        calls.map((call) => [call.args, call.stdin]),
        [
          [
            ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            "src/[literal].ts\0",
          ],
          [
            ["--literal-pathspecs", "reset", "--pathspec-from-file=-", "--pathspec-file-nul"],
            "src/[literal].ts\0",
          ],
        ],
      );
      assert.isTrue(
        calls.every(
          (call) =>
            resolveGitCommandTimeoutMs(call.args, call.timeoutMs) === GIT_COMMAND_TIMEOUT_MS.local,
        ),
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("stashes selected files with literal pathspecs", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createStash({
        cwd: "/repo",
        paths: ["src/[literal].ts"],
        includeUntracked: true,
        message: "Save literal file",
      });

      assert.deepStrictEqual(
        calls
          .filter((call) => call.operation === "vcs.panel.createStash")
          .map((call) => [call.args, call.stdin]),
        [
          [
            [
              "--literal-pathspecs",
              "stash",
              "push",
              "--include-untracked",
              "-m",
              "Save literal file",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            "src/[literal].ts\0",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("commits selected files through an isolated temporary index", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["src/mixed.ts"],
        message: "Commit selected file",
      });

      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.commitStaged.tempIndexResolveHead",
            args: ["rev-parse", "--verify", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexReadTree",
            args: ["read-tree", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.selectedDeletions",
            args: ["diff", "--cached", "--no-relative", "--name-only", "--diff-filter=D", "-z"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexAddSelected",
            args: [
              "--literal-pathspecs",
              "add",
              "-A",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
          },
          {
            operation: "vcs.panel.commitStaged",
            args: ["commit", "-m", "Commit selected file"],
          },
          {
            operation: "vcs.panel.commitStaged.syncIndex",
            args: [
              "--literal-pathspecs",
              "reset",
              "HEAD",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
          },
        ],
      );
      const selectedIndexCalls = calls.filter(
        (call) =>
          call.operation.startsWith("vcs.panel.commitStaged") &&
          ![
            "vcs.panel.commitStaged.selectedDeletions",
            "vcs.panel.commitStaged.syncIndex",
          ].includes(call.operation),
      );
      assert.isTrue(selectedIndexCalls.every((call) => Boolean(call.env?.GIT_INDEX_FILE?.length)));
      const commitCall = calls.find((call) => call.operation === "vcs.panel.commitStaged");
      assert.strictEqual(
        resolveGitCommandTimeoutMs(commitCall?.args ?? [], commitCall?.timeoutMs),
        GIT_COMMAND_TIMEOUT_MS.commit,
      );
      assert.isUndefined(calls.at(-1)?.env?.GIT_INDEX_FILE);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("keeps large literal selections off argv throughout a generated-message commit", () => {
    const calls: ExecuteGitInput[] = [];
    const paths = Array.from(
      { length: 2500 },
      (_, index) => `plugins/${"long-directory/".repeat(5)}file [${index}].txt`,
    );
    paths.push("literal\nnewline.txt", ":(glob)literal.txt");
    const stdin = `${paths.join("\0")}\0`;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.commitStaged({ cwd: "/repo", paths });
      assert.isAbove(stdin.length, 32767);
      const adds = calls.filter(
        (call) =>
          call.args.includes("add") || call.operation === "vcs.panel.commitStaged.syncIndex",
      );
      assert.lengthOf(adds, 2);
      assert.deepStrictEqual(
        adds.map((call) => call.stdin),
        [stdin, stdin],
      );
      assert.isString(adds[0]?.env?.GIT_INDEX_FILE);
      assert.isUndefined(adds[1]?.env?.GIT_INDEX_FILE);
      const messageReads = calls.filter((call) =>
        call.operation.startsWith("vcs.panel.commitMessage"),
      );
      assert.lengthOf(messageReads, 2);
      assert.isTrue(
        messageReads.every((call) => call.env?.GIT_INDEX_FILE === adds[0]?.env?.GIT_INDEX_FILE),
      );
      assert.isTrue(calls.every((call) => call.args.every((arg) => !paths.includes(arg))));
      assert.isTrue(calls.some((call) => call.operation === "vcs.panel.commitStaged"));
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect(
    "preserves selected staged deletions without re-adding their ignored working files",
    () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        yield* service.commitStaged({
          cwd: "/repo",
          paths: ["plugins/[ignored].php", ".gitignore"],
          message: "Stop tracking plugin",
        });
        const removal = calls.find(
          (call) => call.operation === "vcs.panel.commitStaged.tempIndexRemoveSelected",
        );
        assert.deepStrictEqual(removal?.args, ["update-index", "--force-remove", "-z", "--stdin"]);
        assert.equal(removal?.stdin, "plugins/[ignored].php\0");
        assert.isString(removal?.env?.GIT_INDEX_FILE);
        assert.equal(
          calls.find((call) => call.operation === "vcs.panel.commitStaged.tempIndexAddSelected")
            ?.stdin,
          ".gitignore\0",
        );
        const sync = calls.find((call) => call.operation === "vcs.panel.commitStaged.syncIndex");
        assert.deepStrictEqual(sync?.args, [
          "--literal-pathspecs",
          "reset",
          "HEAD",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ]);
        assert.equal(sync?.stdin, "plugins/[ignored].php\0.gitignore\0");
        assert.isUndefined(sync?.env);
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              return success(
                input.operation === "vcs.panel.commitStaged.selectedDeletions"
                  ? "plugins/[ignored].php\0unselected.php\0"
                  : "",
              );
            }),
          ),
        ),
      );
    },
  );

  it.effect("commits a selection containing only staged deletions without invoking add", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["removed.php"],
        message: "Stop tracking file",
      });
      assert.isFalse(calls.some((call) => call.args.includes("add")));
      assert.isTrue(calls.some((call) => call.operation === "vcs.panel.commitStaged"));
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(
              input.operation === "vcs.panel.commitStaged.selectedDeletions" ? "removed.php\0" : "",
            );
          }),
        ),
      ),
    );
  });

  it.effect("matches staged deletions to selections made below the repository root", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.commitStaged({
        cwd: "/repo/sub",
        paths: ["removed.php", "../outside.php", "kept.ts"],
        message: "Stop tracking files",
      });
      assert.deepStrictEqual(
        calls.find((call) => call.operation === "vcs.panel.commitStaged.selectedDeletions")?.args,
        ["diff", "--cached", "--no-relative", "--name-only", "--diff-filter=D", "-z"],
      );
      assert.equal(
        calls.find((call) => call.operation === "vcs.panel.commitStaged.tempIndexRemoveSelected")
          ?.stdin,
        "removed.php\0../outside.php\0",
      );
      assert.equal(
        calls.find((call) => call.operation === "vcs.panel.commitStaged.tempIndexAddSelected")
          ?.stdin,
        "kept.ts\0",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.commitStaged.selectedDeletions":
                return success("sub/removed.php\0outside.php\0sub/unselected.php\0");
              case "vcs.panel.commitStaged.selectedDeletionsPrefix":
                return success("sub/\n");
              default:
                return success();
            }
          }),
        ),
      ),
    );
  });

  it.effect("leaves the real index untouched when a selected-file commit fails", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service
        .commitStaged({
          cwd: "/repo",
          paths: ["src/mixed.ts"],
          message: "Commit selected file",
        })
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        calls.map((call) => call.operation),
        [
          "vcs.panel.commitStaged.tempIndexResolveHead",
          "vcs.panel.commitStaged.tempIndexReadTree",
          "vcs.panel.commitStaged.selectedDeletions",
          "vcs.panel.commitStaged.tempIndexAddSelected",
          "vcs.panel.commitStaged",
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.commitStaged"
              ? failure("commit failed")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect("reconciles a selected-file commit before interrupted temporary-index cleanup", () =>
    Effect.gen(function* () {
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const commit = yield* service
          .commitStaged({
            cwd: "/repo",
            paths: ["src/mixed.ts"],
            message: "Commit selected file",
            push: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(cleanupStarted);
        const interruption = yield* Fiber.interrupt(commit).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(commit);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        assert.deepStrictEqual(calls.slice(-3), [
          "vcs.panel.commitStaged",
          "vcs.panel.commitStaged.syncIndex",
          "cleanup",
        ]);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.sync(() => {
                calls.push(input.operation);
                return success();
              }),
            {},
            {},
            {},
            {},
            Layer.effect(
              FileSystem.FileSystem,
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem;
                return FileSystem.FileSystem.of({
                  ...fileSystem,
                  remove: (path, options) =>
                    Effect.gen(function* () {
                      calls.push("cleanup");
                      yield* Deferred.succeed(cleanupStarted, undefined);
                      yield* Deferred.await(releaseCleanup);
                      yield* fileSystem.remove(path, options);
                    }),
                });
              }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      );
    }),
  );

  it.effect(
    "reports recovery and prevents push when real-index sync fails after committing",
    () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;

        const error = yield* service
          .commitStaged({
            cwd: "/repo",
            paths: ["src/[literal].ts"],
            message: "Commit selected file",
            push: true,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.equal(error.operation, "vcs.panel.commitStaged.syncIndex");
        assert.match(error.detail, /commit was already created but was not pushed/);
        assert.match(error.detail, /Do not commit these changes again/);
        assert.include(error.detail, "git --literal-pathspecs reset HEAD -- 'src/[literal].ts'.");
        assert.equal(
          error.command,
          "git --literal-pathspecs reset HEAD --pathspec-from-file=- --pathspec-file-nul",
        );

        assert.deepStrictEqual(
          calls.map((call) => ({ operation: call.operation, args: call.args })),
          [
            {
              operation: "vcs.panel.commitStaged.tempIndexResolveHead",
              args: ["rev-parse", "--verify", "HEAD"],
            },
            {
              operation: "vcs.panel.commitStaged.tempIndexReadTree",
              args: ["read-tree", "HEAD"],
            },
            {
              operation: "vcs.panel.commitStaged.selectedDeletions",
              args: ["diff", "--cached", "--no-relative", "--name-only", "--diff-filter=D", "-z"],
            },
            {
              operation: "vcs.panel.commitStaged.tempIndexAddSelected",
              args: [
                "--literal-pathspecs",
                "add",
                "-A",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
              ],
            },
            {
              operation: "vcs.panel.commitStaged",
              args: ["commit", "-m", "Commit selected file"],
            },
            {
              operation: "vcs.panel.commitStaged.syncIndex",
              args: [
                "--literal-pathspecs",
                "reset",
                "HEAD",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
              ],
            },
          ],
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              return input.operation === "vcs.panel.commitStaged.syncIndex"
                ? failure("index sync failed")
                : success();
            }),
          ),
        ),
      );
    },
  );

  it.effect("passes merge refs after a positional separator", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.mergeBranchIntoCurrent({
        cwd: "/repo",
        refName: "feature/source-control",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["merge", "--no-edit", "--", "feature/source-control"]],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("initializes an empty selected-file index for an unborn HEAD", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["README.md"],
        message: "Initial commit",
      });

      assert.deepStrictEqual(
        calls.slice(0, 4).map((call) => ({
          operation: call.operation,
          args: call.args,
          allowNonZeroExit: call.allowNonZeroExit,
        })),
        [
          {
            operation: "vcs.panel.commitStaged.tempIndexResolveHead",
            args: ["rev-parse", "--verify", "HEAD"],
            allowNonZeroExit: true,
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexReadTree",
            args: ["read-tree", "--empty"],
            allowNonZeroExit: true,
          },
          {
            operation: "vcs.panel.commitStaged.selectedDeletions",
            args: ["diff", "--cached", "--no-relative", "--name-only", "--diff-filter=D", "-z"],
            allowNonZeroExit: true,
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexAddSelected",
            args: [
              "--literal-pathspecs",
              "add",
              "-A",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            allowNonZeroExit: true,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.commitStaged.tempIndexResolveHead"
              ? failure("Needed a single revision")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect(
    "reports recovery and prevents push when post-commit index synchronization defects",
    () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;

        const error = yield* service
          .commitStaged({
            cwd: "/repo",
            paths: ["src/it's.ts", ...Array.from({ length: 22 }, (_, index) => `src/${index}.ts`)],
            message: "Commit selected file",
            push: true,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.equal(error.operation, "vcs.panel.commitStaged.syncIndex");
        assert.match(error.detail, /commit was already created but was not pushed/);
        assert.match(error.detail, /Do not commit these changes again/);
        // The command quotes each path for a POSIX shell and stays bounded for large selections.
        assert.include(error.detail, "reset HEAD -- 'src/it'\\''s.ts' 'src/0.ts'");
        assert.include(error.detail, "'src/18.ts', then the remaining 3 selected paths");
        assert.notInclude(error.detail, "'src/19.ts'");
        assert.equal(
          error.command,
          "git --literal-pathspecs reset HEAD --pathspec-from-file=- --pathspec-file-nul",
        );
        assert.equal(calls.at(-1)?.operation, "vcs.panel.commitStaged.syncIndex");
      }).pipe(
        Effect.provide(
          makeTestLayer((input) => {
            calls.push(input);
            return input.operation === "vcs.panel.commitStaged.syncIndex"
              ? Effect.die(new Error("index sync defect"))
              : Effect.succeed(success());
          }),
        ),
      );
    },
  );

  it.effect("scopes generated stash input to literal selected paths", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createStash({
        cwd: "/repo",
        mode: "all",
        paths: ["src/[literal].ts"],
        includeUntracked: true,
      });

      assert.deepStrictEqual(
        calls
          .filter((call) => call.operation !== "vcs.panel.resolveGitCommonDir")
          .map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.stashMessageSummary",
            args: ["--literal-pathspecs", "diff", "HEAD", "--stat", "--", "src/[literal].ts"],
          },
          {
            operation: "vcs.panel.stashMessagePatch",
            args: [
              "--literal-pathspecs",
              "diff",
              "HEAD",
              "--no-ext-diff",
              "--patch",
              "--minimal",
              "--",
              "src/[literal].ts",
            ],
          },
          {
            operation: "vcs.panel.stashMessageStatus",
            args: ["--literal-pathspecs", "status", "--short", "--", "src/[literal].ts"],
          },
          {
            operation: "vcs.panel.createStash",
            args: [
              "--literal-pathspecs",
              "stash",
              "push",
              "--include-untracked",
              "-m",
              "T3 Code all stash",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("");
          }),
        ),
      ),
    );
  });

  it("classifies only ref-affecting panel actions for shared ref invalidation", () => {
    assert.deepStrictEqual(SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS, [
      "commitStaged",
      "pullBranch",
      "pushBranch",
      "deleteBranch",
      "undoLatestCommit",
      "revertCommit",
      "checkoutCommit",
      "createBranchFromCommit",
      "mergeBranchIntoCurrent",
      "rebaseCurrentOnto",
      "fetchBranch",
      "fetchRemote",
      "addRemote",
      "removeRemote",
    ]);
  });

  it.effect("invalidates shared refs only after attempted ref mutations", () => {
    const invalidations: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createBranchFromCommit({
        cwd: "/repo",
        sha: "abc123",
        branchName: "feature/success",
      });
      assert.deepStrictEqual(invalidations, ["/repo"]);

      const failed = yield* Effect.exit(
        service.createBranchFromCommit({
          cwd: "/repo",
          sha: "abc123",
          branchName: "feature/failure",
        }),
      );
      assert(Exit.isFailure(failed));
      assert.deepStrictEqual(invalidations, ["/repo", "/repo"]);

      yield* service.fetchAllRemotes({ cwd: "/repo", force: true });
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);

      yield* service.fetchAllRemotes({ cwd: "/repo" });
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);

      const validationFailure = yield* Effect.exit(
        service.addRemote({
          cwd: "/repo",
          name: "-invalid",
          url: "https://example.com/repo.git",
        }),
      );
      assert(Exit.isFailure(validationFailure));
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.succeed(
              input.operation === "vcs.panel.resolveGitCommonDir"
                ? success("/repo/.git")
                : input.args.includes("feature/failure")
                  ? failure("branch creation failed")
                  : success(),
            ),
          {},
          {},
          {},
          {
            invalidateRefs: (cwd) =>
              Effect.sync(() => {
                invalidations.push(cwd);
              }),
          },
        ),
      ),
    );
  });

  it.effect("refreshes status after successful mutations and gates automatic fetches", () => {
    let allowBackgroundWork = false;
    return Effect.gen(function* () {
      const refreshes = yield* Queue.unbounded<string>();
      const service = yield* SourceControlPanelService.pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.succeed(
                input.operation === "vcs.panel.resolveGitCommonDir"
                  ? success("/repo/.git")
                  : success(),
              ),
            {},
            {},
            {},
            {},
            NodeServices.layer,
            {
              refreshStatus: (cwd, options) =>
                Queue.offer(
                  refreshes,
                  `${cwd}:${options?.refreshUpstream === false ? "local" : "upstream"}`,
                ).pipe(Effect.andThen(Effect.never)),
              shouldRunScopeWork: () => Effect.succeed(allowBackgroundWork),
              snapshot: Effect.succeed(unlockedBackgroundPolicy),
            },
          ),
        ),
      );

      yield* service.addRemote({
        cwd: "/repo",
        name: "upstream",
        url: "https://example.com/r.git",
      });
      assert.equal(yield* Queue.take(refreshes), "/repo:upstream");
      assert(
        Exit.isFailure(
          yield* Effect.exit(service.addRemote({ cwd: "/repo", name: "-x", url: "u" })),
        ),
      );
      yield* service.fetchRemote({ cwd: "/repo", remoteName: "upstream" });
      assert.equal(yield* Queue.take(refreshes), "/repo:local");

      assert.isFalse(yield* service.fetchAllRemotes({ cwd: "/repo" }));
      allowBackgroundWork = true;
      assert.isTrue(yield* service.fetchAllRemotes({ cwd: "/repo" }));
      assert.equal(yield* Queue.take(refreshes), "/repo:local");
      assert.equal(yield* Queue.size(refreshes), 0);
    });
  });

  it.effect("does not invalidate shared refs for working-tree-only panel actions", () => {
    const invalidations: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.stageFiles({ cwd: "/repo", paths: ["file.ts"] });

      assert.deepStrictEqual(invalidations, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          () => Effect.succeed(success()),
          {},
          {},
          {},
          {
            invalidateRefs: (cwd) =>
              Effect.sync(() => {
                invalidations.push(cwd);
              }),
          },
        ),
      ),
    );
  });
});

describe("lazy commit files", () => {
  it.effect("keeps history lightweight and shares immutable file reads", () => {
    const calls: ExecuteGitInput[] = [];
    const sha = "a".repeat(40);
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const page = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        kind: "history",
        skip: 0,
        limit: 10,
        deferCommitFiles: true,
      });
      assert.equal(page.commits[0]?.filesDeferred, true);
      assert.deepStrictEqual(page.commits[0]?.files, []);
      assert.isFalse(calls.some((call) => call.operation === "vcs.panel.commitNumstat"));
      const [first, second] = yield* Effect.all(
        [service.commitFiles({ cwd: "/repo", sha }), service.commitFiles({ cwd: "/repo", sha })],
        { concurrency: "unbounded" },
      );
      assert.equal(first.files.length, 1);
      assert.deepStrictEqual(first, second);
      yield* service.commitFiles({ cwd: "/repo", sha });
      assert.equal(calls.filter((call) => call.operation === "vcs.panel.commitNumstat").length, 1);
      yield* service.commitFiles({ cwd: "/other-repo", sha });
      assert.equal(calls.filter((call) => call.operation === "vcs.panel.commitNumstat").length, 2);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.args[0] === "rev-list") return success("1");
            if (input.args[0] === "log")
              return success(
                [
                  sha,
                  "aaaaaaa",
                  "Author",
                  "author@example.test",
                  "2026-09-09T00:00:00Z",
                  "Large commit",
                ].join("\t"),
              );
            if (input.operation === "vcs.panel.commitNumstat") return success("1\t0\tfile.txt\0");
            if (input.operation === "vcs.panel.commitNameStatus") return success("M\0file.txt\0");
            return success();
          }),
        ),
      ),
    );
  });
  it.effect("retries file reads after a Git failure", () => {
    let fail = true;
    const sha = "b".repeat(40);
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const failed = yield* service.commitFiles({ cwd: "/repo", sha }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      fail = false;
      const files = yield* service.commitFiles({ cwd: "/repo", sha });
      assert.deepStrictEqual(files.files, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Effect.sync(() => (fail ? failure("read failed") : success()))),
      ),
    );
  });
});

it.effect("shares repository scans across enrichment batches", () => {
  const calls: ExecuteGitInput[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlPanelService;
    yield* Effect.all(
      [
        service.enrichWorkingTreeFiles({ cwd: "/repo", paths: ["first.txt"] }),
        service.enrichWorkingTreeFiles({ cwd: "/repo", paths: ["second.txt"] }),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(
      calls.filter((call) => call.operation === "vcs.panel.enrichWorkingTreeFiles.statusPorcelain")
        .length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.operation === "vcs.panel.enrichWorkingTreeFiles.unstagedNumstat")
        .length,
      1,
    );
  }).pipe(
    Effect.provide(
      makeTestLayer((input) =>
        Effect.sync(() => {
          calls.push(input);
          return success();
        }),
      ),
    ),
  );
});

describe("panel path selections", () => {
  const makeLiveRepository = Effect.fn("makeLiveRepository")(function* () {
    const liveGit = yield* GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-panel-paths-" });
    const git = (...args: string[]) =>
      liveGit
        .execute({ operation: "test.git", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const write = (name: string, contents: string) =>
      fileSystem.writeFileString(path.join(cwd, name), contents);
    const read = (name: string) => fileSystem.readFileString(path.join(cwd, name));
    const exists = (name: string) => fileSystem.exists(path.join(cwd, name));
    yield* git("init", "--initial-branch=main");
    yield* git("config", "user.email", "test@example.com");
    yield* git("config", "user.name", "Test User");
    yield* git("config", "commit.gpgsign", "false");
    yield* git("config", "core.autocrlf", "false");
    const withService = <A, E>(
      use: (service: SourceControlPanelService["Service"]) => Effect.Effect<A, E>,
    ) => SourceControlPanelService.use(use).pipe(Effect.provide(makeTestLayer(liveGit.execute)));
    return { cwd, git, write, read, exists, withService };
  });

  it.effect("discards Unicode filenames that Git quotes in line-based output", () =>
    Effect.gen(function* () {
      const repo = yield* makeLiveRepository();
      yield* repo.write("résumé.txt", "base\n");
      yield* repo.git("add", "-A");
      yield* repo.git("commit", "-m", "Base");

      yield* repo.write("résumé.txt", "staged\n");
      yield* repo.write("ajouté.txt", "new\n");
      yield* repo.git("add", "-A");
      yield* repo.withService((service) =>
        service.discardFiles({ cwd: repo.cwd, paths: ["résumé.txt", "ajouté.txt"], staged: true }),
      );
      assert.equal(yield* repo.read("résumé.txt"), "base\n");
      assert.isFalse(yield* repo.exists("ajouté.txt"));

      yield* repo.write("résumé.txt", "unstaged\n");
      yield* repo.write("nouveau é.txt", "new\n");
      yield* repo.withService((service) =>
        service.discardFiles({
          cwd: repo.cwd,
          paths: ["résumé.txt", "nouveau é.txt"],
          staged: false,
        }),
      );
      assert.equal(yield* repo.read("résumé.txt"), "base\n");
      assert.isFalse(yield* repo.exists("nouveau é.txt"));
      assert.equal(yield* repo.git("status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("reads bracketed path diffs without matching their siblings", () =>
    Effect.gen(function* () {
      const repo = yield* makeLiveRepository();
      const writeBoth = (contents: string) =>
        Effect.all([repo.write("a[b].txt", contents), repo.write("ab.txt", contents)]);
      yield* writeBoth("base\n");
      yield* repo.git("add", "-A");
      yield* repo.git("commit", "-m", "Base");
      const baseSha = yield* repo.git("rev-parse", "HEAD");
      yield* writeBoth("commit\n");
      yield* repo.git("commit", "-am", "Change both");
      const headSha = yield* repo.git("rev-parse", "HEAD");
      yield* writeBoth("stash\n");
      yield* repo.git("stash", "push", "-m", "Both");
      yield* writeBoth("staged\n");
      yield* repo.git("add", "-A");
      yield* writeBoth("unstaged\n");
      yield* repo.write("n[x].txt", "new\n");
      yield* repo.write("nx.txt", "new\n");

      const sources = [
        { kind: "working-tree", staged: false },
        { kind: "working-tree", staged: true },
        { kind: "commit", sha: headSha },
        { kind: "compare", baseRef: baseSha, refName: headSha },
        { kind: "stash", stashRef: "stash@{0}" },
      ] as const;
      for (const source of sources) {
        const { patch } = yield* repo.withService((service) =>
          service.readFileDiff({ cwd: repo.cwd, path: "a[b].txt", source }),
        );
        assert.include(patch, "+++ b/a[b].txt", source.kind);
        assert.notInclude(patch, "ab.txt", source.kind);
      }
      const { patch: untrackedPatch } = yield* repo.withService((service) =>
        service.readFileDiff({
          cwd: repo.cwd,
          path: "n[x].txt",
          source: { kind: "working-tree", staged: false },
        }),
      );
      assert.include(untrackedPatch, "n[x].txt");
      assert.notInclude(untrackedPatch, "nx.txt");
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("orients comparison patches from the left operand to the right", () =>
    Effect.gen(function* () {
      const repo = yield* makeLiveRepository();
      yield* repo.write("file.txt", "branch\n");
      yield* repo.git("add", "-A");
      yield* repo.git("commit", "-m", "Base");
      yield* repo.write("file.txt", "working\n");
      const compare = (left: VcsPanelCompareInput["left"], right: VcsPanelCompareInput["right"]) =>
        repo
          .withService((service) => service.compare({ cwd: repo.cwd, left, right }))
          .pipe(Effect.map(({ patch }) => patch));

      const workingToBranch = yield* compare(
        { kind: "working-tree" },
        { kind: "branch", refName: "main" },
      );
      assert.include(workingToBranch, "-working\n+branch\n");
      const branchToWorking = yield* compare(
        { kind: "branch", refName: "main" },
        { kind: "working-tree" },
      );
      assert.include(branchToWorking, "-branch\n+working\n");
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("keeps historical paths repository-relative under diff.relative", () =>
    Effect.gen(function* () {
      const repo = yield* makeLiveRepository();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const directory of ["apps/server/src", "apps/web"]) {
        yield* fileSystem.makeDirectory(path.join(repo.cwd, directory), { recursive: true });
      }
      const writeBoth = (contents: string) =>
        Effect.all([
          repo.write("apps/server/src/a.ts", contents),
          repo.write("apps/web/b.ts", contents),
        ]);
      yield* writeBoth("base\n");
      yield* repo.git("add", "-A");
      yield* repo.git("commit", "-m", "Base");
      yield* repo.git("checkout", "-b", "feature");
      yield* writeBoth("feature\n");
      yield* repo.git("commit", "-am", "Feature");
      const sha = yield* repo.git("rev-parse", "HEAD");
      yield* writeBoth("stash\n");
      yield* repo.git("stash", "push", "-m", "Both");
      yield* repo.git("config", "diff.relative", "true");

      const cwd = path.join(repo.cwd, "apps/server");
      const expected = ["../web/b.ts", "src/a.ts"];
      const pathsOf = (files: ReadonlyArray<VcsPanelFileChange>) =>
        files.map((file) => file.path).toSorted();
      const { commit, stash, branch } = yield* repo.withService((service) =>
        Effect.all({
          commit: service.commitFiles({ cwd, sha }),
          stash: service.stashDetails({ cwd, stashRef: "stash@{0}" }),
          branch: service.branchDetails({
            cwd,
            branch: { name: "feature", current: true, isDefault: false, worktreePath: null },
            defaultCompareRef: null,
            compareBaseRef: "main",
          }),
        }),
      );
      assert.deepStrictEqual(pathsOf(commit.files), expected);
      assert.deepStrictEqual(pathsOf(stash.files), expected);
      assert.deepStrictEqual(pathsOf(branch.compareFiles), expected);
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("compares unrelated histories as having no shared changes", () =>
    Effect.gen(function* () {
      const repo = yield* makeLiveRepository();
      yield* repo.write("main.txt", "main\n");
      yield* repo.git("add", "-A");
      yield* repo.git("commit", "-m", "Main");
      yield* repo.git("checkout", "--orphan", "pages");
      yield* repo.git("rm", "-rf", "--cached", ".");
      yield* repo.write("pages.txt", "pages\n");
      yield* repo.git("add", "pages.txt");
      yield* repo.git("commit", "-m", "Pages");

      const details = yield* repo.withService((service) =>
        service.branchDetails({
          cwd: repo.cwd,
          branch: { name: "pages", current: true, isDefault: false, worktreePath: null },
          defaultCompareRef: null,
          compareBaseRef: "main",
        }),
      );
      assert.deepStrictEqual(details.compareFiles, []);
      assert.equal(details.aheadCommits.length, 1);
    }).pipe(Effect.scoped, Effect.provide(LiveGitDriverLayer)),
  );

  it.effect("keeps large discard, unstage, and stash selections off argv", () => {
    const calls: ExecuteGitInput[] = [];
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `packages/${"nested/".repeat(4)}file-${index}.ts`,
    );
    const pathspecStdin = `${paths.join("\0")}\0`;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.discardFiles({ cwd: "/repo", paths, staged: true });
      yield* service.discardFiles({ cwd: "/repo", paths, staged: false });
      yield* service.unstageFiles({ cwd: "/repo", paths });
      yield* service.createStash({ cwd: "/repo", paths, message: "Selected" });

      for (const call of calls) assert.isBelow(call.args.join(" ").length, 20_000, call.operation);
      for (const operation of [
        "vcs.panel.discardStagedFiles.listHeadPaths",
        "vcs.panel.discardStagedFiles.clean",
        "vcs.panel.discardUnstagedFiles.listIndexPaths",
        "vcs.panel.cleanUntrackedFiles",
      ]) {
        const batches = calls.filter((call) => call.operation === operation);
        assert.isAbove(batches.length, 1, operation);
      }
      const stdinFor = (operation: string) =>
        calls.find((call) => call.operation === operation)?.stdin;
      // Even-numbered paths are in HEAD; the rest are staged additions.
      assert.equal(
        stdinFor("vcs.panel.discardStagedFiles"),
        `${paths.filter((_, index) => index % 2 === 0).join("\0")}\0`,
      );
      assert.equal(
        stdinFor("vcs.panel.discardStagedFiles.reset"),
        `${paths.filter((_, index) => index % 2 === 1).join("\0")}\0`,
      );
      assert.equal(stdinFor("vcs.panel.discardUnstagedFiles"), pathspecStdin);
      assert.equal(stdinFor("vcs.panel.unstageFiles"), pathspecStdin);
      assert.equal(stdinFor("vcs.panel.createStash"), pathspecStdin);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            const selected = input.args.slice(input.args.indexOf("--") + 1);
            switch (input.operation) {
              case "vcs.panel.discardStagedFiles.listHeadPaths":
                return success(
                  selected
                    .filter((path) => Number(/(\d+)\.ts$/u.exec(path)?.[1]) % 2 === 0)
                    .map((path) => `${path}\0`)
                    .join(""),
                );
              case "vcs.panel.discardUnstagedFiles.listIndexPaths":
                return success(selected.map((path) => `${path}\0`).join(""));
              default:
                return success("/common/.git");
            }
          }),
        ),
      ),
    );
  });

  it.effect("batches generated stash message reads for large selections", () => {
    const calls: ExecuteGitInput[] = [];
    const requests: CommitMessageGenerationInput[] = [];
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `packages/${"nested/".repeat(4)}file-[${index}].ts`,
    );
    const messageOperations = [
      "vcs.panel.stashMessageSummary",
      "vcs.panel.stashMessagePatch",
      "vcs.panel.stashMessageStatus",
    ];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      yield* service.createStash({ cwd: "/repo", mode: "all", paths });

      for (const call of calls) assert.isBelow(call.args.join(" ").length, 20_000, call.operation);
      const batchesFor = (operation: string) =>
        calls.filter((call) => call.operation === operation);
      for (const operation of messageOperations) {
        for (const call of batchesFor(operation)) {
          assert.equal(call.args[0], "--literal-pathspecs", operation);
        }
      }
      // Small outputs never fill their budget, so every batch is read.
      for (const operation of ["vcs.panel.stashMessageSummary", "vcs.panel.stashMessageStatus"]) {
        const batches = batchesFor(operation);
        assert.isAbove(batches.length, 1, operation);
        assert.deepStrictEqual(
          batches.flatMap((call) => call.args.slice(call.args.indexOf("--") + 1)),
          paths,
          operation,
        );
      }
      // Each patch batch returns 45,000 characters, so the 50,000 budget fills on the second.
      assert.equal(batchesFor("vcs.panel.stashMessagePatch").length, 2);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.stagedPatch.length, 50_000);
      const stashes = calls.filter((call) => call.operation === "vcs.panel.createStash");
      assert.equal(stashes.length, 1);
      assert.include(stashes[0]!.args, "Generated message");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(
              input.operation === "vcs.panel.stashMessagePatch"
                ? "+changed\n".repeat(5_000)
                : messageOperations.includes(input.operation)
                  ? "changed\n"
                  : "/common/.git",
            );
          }),
        ).pipe(
          Layer.provide(
            Layer.mock(TextGeneration)({
              generateCommitMessage: (request) =>
                Effect.sync(() => {
                  requests.push(request);
                  return { subject: "Generated message", body: "" };
                }),
            }),
          ),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "dropping the stash", failure: "drop" },
    { name: "verifying the stash position", failure: "verify" },
  ])(
    "reports applied stash changes when $name fails after pop applies them",
    ({ failure: step }) => {
      const sha = "a".repeat(40);
      let applied = false;
      const cause = new GitCommandError({
        operation: "vcs.panel.popStash",
        cwd: "/repo",
        command: "git stash",
        detail: "Unable to lock stash reflog",
      });
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;
        const error = yield* service
          .popStash({ cwd: "/repo", stashRef: "stash@{0}", expectedSha: sha })
          .pipe(Effect.flip);
        assert.match(error.detail, /stash changes were applied/);
        assert.match(error.detail, /could not drop the stash/);
        assert.match(error.detail, /do not apply it again/);
        assert.propertyVal(error.cause, "detail", "Unable to lock stash reflog");
      }).pipe(
        Effect.provide(
          makeTestLayer((input) => {
            if (input.args[1] === "apply") applied = true;
            if (input.args[1] === "--verify") {
              return step === "verify" && applied
                ? Effect.fail(cause)
                : Effect.succeed(success(sha));
            }
            return step === "drop" && input.args[1] === "drop"
              ? Effect.fail(cause)
              : Effect.succeed(success("/common/.git"));
          }),
        ),
      );
    },
  );

  it.effect("rejects option-shaped revisions before reading branch or stash details", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const cwd = "/repo";
      const invalid = "--output=proof.txt";
      const operations: ReadonlyArray<Effect.Effect<object, GitCommandError>> = [
        service.branchCommits({ cwd, branch: { ...branchRef, name: invalid }, skip: 0, limit: 10 }),
        service.branchCommits({ cwd, branch: branchRef, baseRef: invalid, skip: 0, limit: 10 }),
        service.branchDetails({
          cwd,
          branch: { ...branchRef, name: invalid },
          defaultCompareRef: null,
        }),
        service.branchDetails({ cwd, branch: branchRef, defaultCompareRef: invalid }),
        service.branchDetails({
          cwd,
          branch: branchRef,
          defaultCompareRef: null,
          compareBaseRef: invalid,
        }),
        service.stashDetails({ cwd, stashRef: invalid }),
      ];
      for (const operation of operations) {
        const error = yield* Effect.flip(operation);
        assert.isTrue(isGitCommandError(error));
        assert.match(error.detail, /cannot start with "-"/);
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("returns commit, stash, and comparison paths relative to a nested cwd", () => {
    const numstat = "1\t2\tapps/server/src/a.ts\x000\t0\t\0apps/web/old.ts\0apps/server/new.ts\0";
    const nameStatus = "M\0apps/server/src/a.ts\0R100\0apps/web/old.ts\0apps/server/new.ts\0";
    const expected = [
      { path: "new.ts", originalPath: "../web/old.ts", status: "renamed" },
      { path: "src/a.ts", originalPath: null, status: "modified" },
    ];
    const pathsOf = (files: ReadonlyArray<VcsPanelFileChange>) =>
      files.map(({ path, originalPath, status }) => ({ path, originalPath, status }));
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const cwd = "/repo/apps/server";
      const commit = yield* service.commitFiles({ cwd, sha: "b".repeat(40) });
      const stash = yield* service.stashDetails({ cwd, stashRef: "stash@{0}" });
      const branch = yield* service.branchDetails({
        cwd,
        branch: branchRef,
        defaultCompareRef: null,
        compareBaseRef: "main",
      });
      const history = yield* service.branchCommits({ cwd, branch: branchRef, skip: 0, limit: 10 });

      assert.deepStrictEqual(pathsOf(commit.files), expected);
      assert.deepStrictEqual(pathsOf(stash.files), expected);
      assert.deepStrictEqual(pathsOf(branch.compareFiles), expected);
      assert.deepStrictEqual(pathsOf(history.commits[0]?.files ?? []), expected);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            switch (input.operation) {
              case "vcs.panel.workingTreePrefix":
                return success("apps/server/\n");
              case "vcs.panel.commitNumstat":
              case "vcs.panel.stashNumstat":
              case "vcs.panel.branchCompareNumstat":
                return success(numstat);
              case "vcs.panel.commitNameStatus":
              case "vcs.panel.stashNameStatus":
              case "vcs.panel.branchCompareNameStatus":
                return success(nameStatus);
              case "vcs.panel.branchCommits":
                return success(
                  `${"c".repeat(40)}\tccccccc\tAda\tada@example.test\t2026-06-20T12:00:00.000Z\tChange`,
                );
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("reports stash detail read failures instead of an empty stash", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const error = yield* service
        .stashDetails({ cwd: "/repo", stashRef: "stash@{3}" })
        .pipe(Effect.flip);
      assert.isTrue(isGitCommandError(error));
      assert.include(error.detail, "stash@{3} is not a valid reference");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.succeed(
            input.operation === "vcs.panel.stashNumstat"
              ? failure("error: stash@{3} is not a valid reference")
              : success(""),
          ),
        ),
      ),
    ),
  );

  it.effect("reports comparison read failures instead of an unchanged branch", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const error = yield* service
        .branchDetails({
          cwd: "/repo",
          branch: branchRef,
          defaultCompareRef: null,
          compareBaseRef: "main",
        })
        .pipe(Effect.flip);
      assert.isTrue(isGitCommandError(error));
      assert.equal(error.operation, "vcs.panel.branchCompareNumstat");
      assert.include(error.detail, "fatal: unable to read tree");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.succeed(
            input.operation === "vcs.panel.branchCompareNumstat"
              ? failure("fatal: unable to read tree 0123456")
              : success(""),
          ),
        ),
      ),
    ),
  );
});

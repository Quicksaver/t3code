import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeProviderSkillsRpcHandler } from "./ProviderSkillsRpc.ts";
import * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import { makeServerProviderSnapshot } from "./testUtils/serverProviderSnapshot.ts";

const makeHandler = (input?: {
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly settings?: ServerSettings.ServerSettingsService["Service"]["getSettings"];
}) =>
  makeProviderSkillsRpcHandler().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(input?.providers ?? []),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: input?.settings ?? Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        WorkspacePaths.layer,
      ),
    ),
  );

it.layer(NodeServices.layer)("provider skills RPC handler", (it) => {
  it.effect("reports a missing provider", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler();
      const result = yield* handler
        .list({
          instanceId: ProviderInstanceId.make("codex"),
          cwd: process.cwd(),
        })
        .pipe(Effect.result);

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ServerProviderSkillsListError");
      assert.equal(result.failure.message, "Provider instance 'codex' was not found.");
    }),
  );

  it.effect("returns non-Codex snapshot skills", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const skill: ServerProviderSkill = {
        name: "plan",
        path: "/providers/claudeAgent/skills/plan/SKILL.md",
        enabled: true,
      };
      const handler = yield* makeHandler({
        providers: [
          makeServerProviderSnapshot({
            instanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            skills: [skill],
          }),
        ],
      });

      const response = yield* handler.list({
        instanceId,
        cwd: "/definitely/not/a/real/workspace/path",
      });

      assert.deepEqual(response.skills, [skill]);
    }),
  );

  it.effect("returns snapshot skills when the Codex provider is disabled", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const skill: ServerProviderSkill = {
        name: "fallback",
        path: "/providers/codex/skills/fallback/SKILL.md",
        enabled: true,
      };
      const handler = yield* makeHandler({
        providers: [
          makeServerProviderSnapshot({
            instanceId,
            driver,
            skills: [skill],
          }),
        ],
        settings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver,
              enabled: false,
              config: {},
            },
          },
        }),
      });

      const response = yield* handler.list({
        instanceId,
        cwd: "/definitely/not/a/real/workspace/path",
      });

      assert.deepEqual(response.skills, [skill]);
    }),
  );

  it.effect("validates an enabled Codex cwd", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const handler = yield* makeHandler({
        providers: [
          makeServerProviderSnapshot({
            instanceId,
            driver,
          }),
        ],
        settings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver,
              enabled: true,
              config: {},
            },
          },
        }),
      });
      const missingWorkspacePath = "/definitely/not/a/real/workspace/path";
      const requestedCwd = `  ${missingWorkspacePath}  `;
      const result = yield* handler
        .list({
          instanceId,
          cwd: requestedCwd,
        })
        .pipe(Effect.result);

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ServerProviderSkillsListError");
      assert.equal(result.failure.message, `Invalid Codex skills cwd '${missingWorkspacePath}'.`);
      assert.equal(result.failure.cwd, missingWorkspacePath);
      assert.equal(
        result.failure.detail,
        `Workspace root does not exist: ${missingWorkspacePath}.`,
      );
      assert.deepEqual(result.failure.cause, {
        tag: "WorkspaceRootNotExistsError",
        name: "WorkspaceRootNotExistsError",
        message: `Workspace root does not exist: ${missingWorkspacePath}`,
      });
    }),
  );

  it.effect("reports Codex home preparation details", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-provider-skills-",
      });
      const sharedHomePath = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-codex-home-",
      });
      const handler = yield* makeHandler({
        providers: [
          makeServerProviderSnapshot({
            instanceId,
            driver,
          }),
        ],
        settings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver,
              enabled: true,
              config: {
                homePath: sharedHomePath,
                shadowHomePath: sharedHomePath,
              },
            },
          },
        }),
      });

      const result = yield* handler
        .list({
          instanceId,
          cwd: workspaceDir,
        })
        .pipe(Effect.result);

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ServerProviderSkillsListError");
      assert.equal(result.failure.reason, "home-prepare-failed");
      assert.equal(result.failure.message, "Failed to prepare Codex home for 'codex'.");
      assert.include(result.failure.detail ?? "", "Codex shadow home path");
      assert.include(result.failure.detail ?? "", sharedHomePath);
      assert.deepEqual(result.failure.cause, {
        tag: "CodexShadowHomePathConflictError",
        name: "CodexShadowHomePathConflictError",
        message: `Codex shadow home path '${sharedHomePath}' must be different from the shared home path '${sharedHomePath}'.`,
      });
    }),
  );
});

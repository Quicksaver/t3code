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

const makeServerProviderSnapshot = (
  input: Partial<ServerProvider> & {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  },
): ServerProvider => ({
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...input,
});

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

it.layer(NodeServices.layer)("provider skills rpc", (it) => {
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

  it.effect("returns disabled Codex snapshot skills", () =>
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
      assert.notInclude(result.failure.message, "Workspace root does not exist");
      assert.equal(
        result.failure.detail,
        `Workspace root does not exist: ${missingWorkspacePath}.`,
      );
      assert.property(result.failure, "cause");
      const failureCause = result.failure.cause;
      assertTrue(
        failureCause !== null &&
          typeof failureCause === "object" &&
          "message" in failureCause &&
          typeof failureCause.message === "string",
      );
      assert.include(failureCause.message, "Workspace root does not exist");
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
      assert.property(result.failure, "cause");
      const failureCause = result.failure.cause;
      assertTrue(
        failureCause !== null &&
          typeof failureCause === "object" &&
          "message" in failureCause &&
          typeof failureCause.message === "string",
      );
      assert.include(failureCause.message, "Codex shadow home path");
    }),
  );
});

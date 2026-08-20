import * as NodeOS from "node:os";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { listCodexProviderSkills } from "./CodexProvider.ts";
import { listCodexProviderSkillsWithTimeout } from "../ProviderSkillsLister.ts";

const CodexArgsLog = Schema.fromJsonString(Schema.Array(Schema.String));

const resolveMockAppServerPath = Effect.fn("resolveMockAppServerPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(
    new URL("../../../scripts/codex-skills-mock-app-server.ts", import.meta.url),
  );
});

const makeMockAppServer = Effect.fn("makeMockAppServer")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAppServerPath = yield* resolveMockAppServerPath();
  const directory = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "codex-skills-provider-",
  });
  const isWindows = yield* isHostWindows;
  const binaryPath = path.join(directory, isWindows ? "codex.cmd" : "codex");
  if (isWindows) {
    yield* fileSystem.writeFileString(
      binaryPath,
      ["@echo off", `"${process.execPath}" "${mockAppServerPath}" %*`, ""].join("\r\n"),
    );
  } else {
    const command = [process.execPath, mockAppServerPath]
      .map((argument) => JSON.stringify(argument))
      .join(" ");
    yield* fileSystem.writeFileString(binaryPath, `#!/bin/sh\nexec ${command} "$@"\n`);
    yield* fileSystem.chmod(binaryPath, 0o755);
  }
  const workspaceDirectory = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "codex-skills-workspace-",
  });
  return {
    binaryPath,
    cwd: yield* fileSystem.realPath(workspaceDirectory),
    argsLogPath: path.join(directory, "args.log"),
    cwdLogPath: path.join(directory, "cwd.log"),
    exitLogPath: path.join(directory, "exit.log"),
    pidLogPath: path.join(directory, "pid.log"),
  };
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const content = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (content.trim()) return content;
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(50));
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

const waitForProcessExit = Effect.fn("waitForProcessExit")(function* (pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const running = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    });
    if (!running) return;
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(50));
  }
  return yield* Effect.die(`Timed out waiting for process ${pid} to exit`);
});

describe("listCodexProviderSkills", () => {
  it.effect("lists workspace skills from the configured cwd", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const skills = yield* listCodexProviderSkills({
        binaryPath: fixture.binaryPath,
        launchArgs: "--enable workspace-skill-test",
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_ARGS_LOG_PATH: fixture.argsLogPath,
          T3_CODEX_CWD_LOG_PATH: fixture.cwdLogPath,
        },
      }).pipe(Effect.scoped);

      expect(skills).toEqual([
        {
          name: "workspace-skill",
          description: "A workspace-scoped test skill.",
          shortDescription: "Workspace test skill",
          path: `${fixture.cwd}/.agents/skills/workspace-skill/SKILL.md`,
          scope: "repo",
          enabled: true,
        },
        {
          name: "coderabbit:code-review",
          description: "Reviews code changes using CodeRabbit AI.",
          path: "plugin://coderabbit@openai-curated-remote/skills/code-review",
          scope: "plugin",
          enabled: true,
          displayName: "CodeRabbit Review",
          shortDescription: "Run CodeRabbit against the current changes",
        },
      ]);
      const args = yield* Schema.decodeUnknownEffect(CodexArgsLog)(
        (yield* waitForFileContent(fixture.argsLogPath)).trim(),
      );
      expect(args).toEqual(["app-server", "--enable", "workspace-skill-test"]);
      expect((yield* waitForFileContent(fixture.cwdLogPath)).trim()).toBe(fixture.cwd);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps workspace skills when installed plugin discovery is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const skills = yield* listCodexProviderSkills({
        binaryPath: fixture.binaryPath,
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_FAIL_PLUGIN_INSTALLED: "1",
        },
      }).pipe(Effect.scoped);

      expect(skills.map((skill) => skill.name)).toEqual(["workspace-skill"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports timeouts and terminates the app-server", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const fiber = yield* listCodexProviderSkillsWithTimeout({
        instanceId: ProviderInstanceId.make("codex"),
        binaryPath: fixture.binaryPath,
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_CWD_LOG_PATH: fixture.cwdLogPath,
          T3_CODEX_EXIT_LOG_PATH: fixture.exitLogPath,
          T3_CODEX_PID_LOG_PATH: fixture.pidLogPath,
          T3_CODEX_HANG_SKILLS_LIST: "1",
        },
      }).pipe(Effect.forkChild);

      yield* waitForFileContent(fixture.cwdLogPath);
      const pid = Number.parseInt((yield* waitForFileContent(fixture.pidLogPath)).trim(), 10);
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.message).toBe(
        `Timed out listing Codex skills after 15s (provider: 'codex', cwd: '${fixture.cwd}').`,
      );
      yield* waitForProcessExit(pid);
      if (!(yield* isHostWindows)) {
        expect(yield* waitForFileContent(fixture.exitLogPath)).toContain("SIGTERM");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unauthenticated workspace skill probes as structured failures", () =>
    Effect.gen(function* () {
      const fixture = yield* makeMockAppServer();
      const error = yield* listCodexProviderSkillsWithTimeout({
        instanceId: ProviderInstanceId.make("codex"),
        binaryPath: fixture.binaryPath,
        cwd: fixture.cwd,
        environment: {
          ...process.env,
          T3_CODEX_UNAUTHENTICATED: "1",
        },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ServerProviderSkillsListError",
        reason: "probe-failed",
        operation: "ProviderSkillsLister.listCodexProviderSkills",
        instanceId: "codex",
        cwd: fixture.cwd,
        message: `Failed to list Codex skills (provider: 'codex', cwd: '${fixture.cwd}').`,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

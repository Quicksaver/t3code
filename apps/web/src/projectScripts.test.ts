import { buildProjectScriptSettingsPatch } from "./projectScripts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { settleProjectScript, setupProjectScript } from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
  });
});

describe("project script settings patches", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const projectId = ProjectId.make("shared-id");
  const script = {
    id: "test",
    name: "Test",
    command: "vp test",
    icon: "play" as const,
    runOnWorktreeCreate: false,
  };
  const scripts = [script];
  it.each([new Map(), new Map([[remote, { serverConfig: null }]])])(
    "uses the legacy script patch before destination configuration is available",
    (environments) => {
      expect(
        buildProjectScriptSettingsPatch({
          environmentId: remote,
          projectId,
          scripts,
          environments,
        }),
      ).toEqual({ projectScriptOverrides: { [projectId]: scripts } });
    },
  );
  const config = (modern: boolean, customInstructions: string) => ({
    serverConfig: {
      environment: { capabilities: { projectSettingsOverrides: modern } },
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWritingStyle: {
              mode: "custom" as const,
              customInstructions,
              followChangeRequestTemplates: true,
            },
          },
        },
      },
    },
  });

  it("preserves destination overrides when both environments use the same project id", () => {
    const target = config(true, "Remote instructions");
    const environments = new Map([
      [local, config(false, "Local instructions")],
      [remote, target],
    ]);
    expect(
      buildProjectScriptSettingsPatch({
        environmentId: remote,
        projectId,
        scripts,
        environments,
      }),
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          ...target.serverConfig.settings.projectSettingsOverrides[projectId],
          defaultProjectScripts: scripts,
        },
      },
    });
  });

  it("uses the destination legacy format even when the active environment is modern", () => {
    const environments = new Map([
      [local, config(true, "Local instructions")],
      [remote, config(false, "Remote instructions")],
    ]);
    expect(
      buildProjectScriptSettingsPatch({
        environmentId: remote,
        projectId,
        scripts: [],
        environments,
      }),
    ).toEqual({
      projectScriptOverrides: { [projectId]: [] },
    });
  });
});

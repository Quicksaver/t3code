import {
  EnvironmentId,
  MAX_KEYBINDING_VALUE_LENGTH,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
  saveProjectScriptWithKeybinding,
} from "./projectScriptKeybindings";

describe("destination script shortcut saves", () => {
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const command = "script.lint.run" as const;
  const bindings = (key: string) => [
    {
      command,
      shortcut: {
        key,
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
    },
  ];

  function setup(destination: typeof a, allowed: typeof a) {
    let permitted: EnvironmentId | null = allowed;
    const saved: string[] = [];
    const input = {
      environmentId: destination,
      keybinding: "mod+k" as string | null | undefined,
      keybindingCommand: command,
      isDeletingScript: false,
      isElectron: true,
      readKeybindings: (id: EnvironmentId) => bindings(id === a ? "k" : "l"),
      canWriteSettings: (id: EnvironmentId) => id === permitted,
      saveProject: async () => {
        saved.push("project");
        return AsyncResult.success(undefined);
      },
      saveKeybinding: async (rule: ReturnType<typeof decodeProjectScriptKeybindingRule>) => {
        saved.push(rule?.key ?? "remove");
        return AsyncResult.success(undefined);
      },
    };
    return {
      input,
      saved,
      revoke: () => {
        permitted = null;
      },
    };
  }

  it("updates B to A's shortcut using B's baseline and grant", async () => {
    const test = setup(b, b);
    expect((await saveProjectScriptWithKeybinding(test.input))._tag).toBe("Success");
    expect(test.saved).toEqual(["project", "mod+k"]);
  });

  it("does not borrow A's grant for a changed B shortcut", async () => {
    const test = setup(b, a);
    expect((await saveProjectScriptWithKeybinding(test.input))._tag).toBe("Failure");
    expect(test.saved).toEqual([]);
  });

  it("saves an unchanged destination shortcut without requiring a shortcut write", async () => {
    const test = setup(a, b);
    expect((await saveProjectScriptWithKeybinding(test.input))._tag).toBe("Success");
    expect(test.saved).toEqual(["project"]);
  });

  it.each([false, true])(
    "rechecks B after the project save, deleting=%s",
    async (isDeletingScript) => {
      const test = setup(b, b);
      const result = await saveProjectScriptWithKeybinding({
        ...test.input,
        isDeletingScript,
        keybinding: isDeletingScript ? null : "mod+k",
        saveProject: async () => {
          test.saved.push("project");
          test.revoke();
          return AsyncResult.success(undefined);
        },
      });
      expect(result._tag).toBe("Failure");
      expect(test.saved).toEqual(["project"]);
    },
  );

  it("removes B's shortcut when B grants access despite A's denial", async () => {
    const test = setup(b, b);
    expect(
      (
        await saveProjectScriptWithKeybinding({
          ...test.input,
          isDeletingScript: true,
          keybinding: null,
        })
      )._tag,
    ).toBe("Success");
    expect(test.saved).toEqual(["project", "remove"]);
  });

  it("can delete a script without borrowing another environment's shortcut grant", async () => {
    const test = setup(b, a);
    expect(
      (
        await saveProjectScriptWithKeybinding({
          ...test.input,
          isDeletingScript: true,
          keybinding: null,
        })
      )._tag,
    ).toBe("Success");
    expect(test.saved).toEqual(["project"]);
  });
});

describe("projectScriptKeybindings", () => {
  it("decodes and trims valid keybinding rules", () => {
    const rule = decodeProjectScriptKeybindingRule({
      keybinding: "  mod+k  ",
      command: commandForProjectScript("lint"),
    });

    expect(rule).toEqual({
      key: "mod+k",
      command: "script.lint.run",
    });
  });

  it("returns null when keybinding is empty", () => {
    expect(
      decodeProjectScriptKeybindingRule({
        keybinding: "   ",
        command: commandForProjectScript("lint"),
      }),
    ).toBeNull();
  });

  it("rejects invalid keybinding values", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "k".repeat(MAX_KEYBINDING_VALUE_LENGTH + 1),
        command: commandForProjectScript("lint"),
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("rejects invalid commands", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "mod+k",
        command: "script.BAD.run" as KeybindingCommand,
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("can edit or delete a legacy script without a shortcut", () => {
    const command = commandForProjectScript("install-javascript-dependencies");
    expect(keybindingValueForCommand([], command)).toBeNull();
    expect(decodeProjectScriptKeybindingRule({ keybinding: null, command })).toBeNull();
    expect(() => decodeProjectScriptKeybindingRule({ keybinding: "mod+k", command })).toThrowError(
      PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
    );
  });

  it("reads latest matching keybinding value for a command", () => {
    const command = "script.test.run" as const;
    const value = keybindingValueForCommand(
      [
        {
          command,
          shortcut: {
            key: "escape",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        },
        {
          command,
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            modKey: true,
          },
        },
      ],
      command,
    );

    expect(value).toBe("mod+shift+k");
  });
});

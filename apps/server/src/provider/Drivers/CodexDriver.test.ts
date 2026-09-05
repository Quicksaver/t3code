import { describe, expect, it } from "@effect/vitest";
import { codexProviderMaintenanceResolver } from "./CodexDriver.ts";

describe("codexProviderMaintenanceResolver", () => {
  it.each([
    {
      resolvedCommandPath: "/Users/quicksaver/.local/bin/codex",
      realCommandPath:
        "/Users/quicksaver/.codex/packages/standalone/releases/0.151.0-aarch64-apple-darwin/bin/codex",
    },
    {
      resolvedCommandPath: "/c/Users/Quicksaver/AppData/Local/Programs/OpenAI/Codex/bin/codex",
      realCommandPath: "/c/Users/Quicksaver/AppData/Local/Programs/OpenAI/Codex/bin/codex",
    },
    {
      resolvedCommandPath:
        "C:\\Users\\Quicksaver\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      realCommandPath:
        "C:\\Users\\Quicksaver\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    },
  ])("uses Codex self-update for an install-script binary", (paths) => {
    expect(
      codexProviderMaintenanceResolver.resolve({
        binaryPath: "codex",
        platform: "linux",
        ...paths,
      }).update,
    ).toEqual({
      command: "codex update",
      executable: "codex",
      args: ["update"],
      lockKey: "codex-native",
    });
  });

  it.each([
    {
      resolvedCommandPath: "/usr/local/bin/codex",
      realCommandPath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    },
    {
      resolvedCommandPath: "C:\\Users\\Quicksaver\\AppData\\Roaming\\npm\\codex.cmd",
      realCommandPath: "C:\\Users\\Quicksaver\\AppData\\Roaming\\npm\\codex.cmd",
    },
  ])("uses npm only when the Codex path identifies an npm install", (paths) => {
    expect(
      codexProviderMaintenanceResolver.resolve({
        binaryPath: "codex",
        platform: "linux",
        ...paths,
      }).update,
    ).toEqual({
      command: "npm install -g --allow-scripts=@openai/codex @openai/codex@latest",
      executable: "npm",
      args: ["install", "-g", "--allow-scripts=@openai/codex", "@openai/codex@latest"],
      lockKey: "npm-global",
    });
  });

  it("keeps Homebrew updates ahead of the Codex self-update fallback", () => {
    expect(
      codexProviderMaintenanceResolver.resolve({
        binaryPath: "codex",
        platform: "linux",
        resolvedCommandPath: "/opt/homebrew/bin/codex",
        realCommandPath: "/opt/homebrew/Cellar/codex/1.2.3/bin/codex",
      }).update,
    ).toEqual({
      command: "brew upgrade codex",
      executable: "brew",
      args: ["upgrade", "codex"],
      lockKey: "homebrew",
    });
  });

  it("uses Codex self-update when command resolution cannot classify the installation", () => {
    expect(
      codexProviderMaintenanceResolver.resolve({
        binaryPath: "codex",
        platform: "linux",
      }).update,
    ).toEqual({
      command: "codex update",
      executable: "codex",
      args: ["update"],
      lockKey: "codex-native",
    });
  });

  it.each([
    {
      binaryPath: "/opt/tools/codex",
      platform: "linux" as const,
      command: "/opt/tools/codex update",
    },
    {
      binaryPath: "C:\\Tools\\Codex\\codex.exe",
      platform: "win32" as const,
      command: "C:\\Tools\\Codex\\codex.exe update",
    },
    {
      binaryPath: "C:\\Tools\\Codex\\codex.exe",
      platform: "linux" as const,
      command: "'C:\\Tools\\Codex\\codex.exe' update",
    },
    {
      binaryPath: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
      platform: "win32" as const,
      command: "& 'C:\\Program Files\\OpenAI\\Codex\\codex.exe' update",
    },
    {
      binaryPath: "/opt/Codex Tools/codex",
      platform: "linux" as const,
      command: "'/opt/Codex Tools/codex' update",
    },
  ])(
    "targets an explicit unclassified Codex binary with self-update",
    ({ binaryPath, platform, command }) => {
      expect(
        codexProviderMaintenanceResolver.resolve({
          binaryPath,
          platform,
          resolvedCommandPath: binaryPath,
          realCommandPath: binaryPath,
        }).update,
      ).toEqual({
        command,
        executable: binaryPath,
        args: ["update"],
        lockKey: "codex-native",
      });
    },
  );
});

import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";

function makeCommandActivity(
  id: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: "2026-07-17T10:00:00.000Z",
    kind: "tool.completed",
    summary: "Ran command",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
  };
}

describe("deriveWorkLogEntries command output", () => {
  it("keeps Codex aggregated output in the dedicated output field", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("codex-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "/bin/zsh -lc \"printf 'hello\\n'\"",
        data: {
          item: {
            type: "commandExecution",
            command: "/bin/zsh -lc \"printf 'hello\\n'\"",
            commandActions: [{ command: "printf 'hello\\n'", type: "unknown" }],
            aggregatedOutput: "hello\n<exited with exit code 0>",
            status: "completed",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf 'hello\\n'",
      rawCommand: "/bin/zsh -lc \"printf 'hello\\n'\"",
      output: "hello",
    });
    expect(entry?.detail).toBeUndefined();
  });

  it("keeps projected Claude content in the dedicated output field", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf hello",
        data: {
          kind: "execute",
          command: "printf hello",
          rawOutput: {
            content: "hello from claude",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello",
      output: "hello from claude",
    });
    expect(entry?.detail).toBeUndefined();
  });

  it("does not synthesize command output when the payload has no output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("empty-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "true",
        data: {
          kind: "execute",
          command: "true",
        },
      }),
    ]);

    expect(entry?.command).toBe("true");
    expect(entry?.output).toBeUndefined();
    expect(entry?.detail).toBeUndefined();
  });

  it("keeps no-id lifecycle rows for distinct commands separate", () => {
    const entries = deriveWorkLogEntries([
      makeCommandActivity("first-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf first",
        data: {
          kind: "execute",
          command: "printf first",
        },
      }),
      makeCommandActivity("second-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf second",
        data: {
          kind: "execute",
          command: "printf second",
        },
      }),
    ]);

    expect(entries.map((entry) => entry.command)).toEqual(["printf first", "printf second"]);
  });
});

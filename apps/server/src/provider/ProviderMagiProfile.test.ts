import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildThreadStartParams, buildTurnStartParams } from "./Layers/CodexSessionRuntime.ts";
import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";
import {
  ACP_MAGI_CAPABILITIES,
  CLAUDE_MAGI_CAPABILITIES,
  CODEX_MAGI_CAPABILITIES,
  MAGI_PARTICIPANT_PRE_PROMPT,
  OPENCODE_MAGI_CAPABILITIES,
  claudeMagiDisallowedTools,
  composeProviderControlPrompt,
  normalizeMagiSendTurnInput,
  normalizeMagiSessionStartInput,
} from "./ProviderMagiProfile.ts";

describe("provider Magi execution profile", () => {
  it.each([
    ["Codex", CODEX_MAGI_CAPABILITIES],
    ["Claude", CLAUDE_MAGI_CAPABILITIES],
    ["Cursor ACP", ACP_MAGI_CAPABILITIES],
    ["Grok ACP", ACP_MAGI_CAPABILITIES],
    ["OpenCode", OPENCODE_MAGI_CAPABILITIES],
  ])("declares a complete capability record for %s", (_name, capabilities) => {
    expect(capabilities.controlTools).not.toBe("unsupported");
    expect(["native", "prompt-envelope"]).toContain(capabilities.instructions);
    expect(["native-policy", "prompt-only"]).toContain(capabilities.readOnly);
    expect(["native", "unsupported"]).toContain(capabilities.webSearch);
    expect(capabilities).not.toHaveProperty("contextUsage");
    expect(["explicit-native", "automatic-native", "unsupported"]).toContain(
      capabilities.historyCompaction,
    );
  });

  it("repeats the enforced read-only and no-subagent policy on every participant turn", () => {
    const control = {
      executionProfile: "magi-read-only" as const,
      instructions: "Assess candidate A.",
      contextPreamble: "<initiating-task>Question</initiating-task>",
    };
    const first = composeProviderControlPrompt("First turn", control);
    const second = composeProviderControlPrompt("Second turn", control);

    for (const prompt of [first, second]) {
      expect(prompt).toContain(MAGI_PARTICIPANT_PRE_PROMPT);
      expect(prompt).toContain("Participant subagents are unavailable");
      expect(prompt).toContain("owning conversation's access mode");
      expect(prompt).toContain("web tools exposed by your harness");
      expect(prompt).toContain("<initiating-task>Question</initiating-task>");
      expect(prompt).toContain("Assess candidate A.");
    }
  });

  it("inherits the owning runtime mode without changing model options", () => {
    const normalized = normalizeMagiSessionStartInput({
      threadId: "participant-thread" as never,
      providerInstanceId: "codex" as never,
      modelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5.6",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "full-access",
      control: { executionProfile: "magi-read-only" },
    });

    expect(normalized.runtimeMode).toBe("full-access");
    expect(normalized.modelSelection?.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
  });

  it("retains raw turn input inside the prompt envelope", () => {
    const normalized = normalizeMagiSendTurnInput({
      threadId: "participant-thread" as never,
      input: "Raw participant request",
      control: {
        executionProfile: "magi-read-only",
        instructions: "Return the requested schema.",
      },
    });

    expect(normalized.input).toContain("Raw participant request");
    expect(normalized.input).toContain("web tools exposed by your harness");
    expect(normalized.interactionMode).toBeUndefined();
  });

  it.effect("passes a native output schema to Codex turn/start", () =>
    Effect.gen(function* () {
      const outputSchema = {
        type: "object",
        required: ["recommendation"],
        properties: { recommendation: { type: "string" } },
      };
      const params = yield* buildTurnStartParams({
        threadId: "native-thread",
        runtimeMode: "approval-required",
        prompt: "Assess",
        outputSchema,
      });
      expect(params.outputSchema).toEqual(outputSchema);
      expect(params.sandboxPolicy).toEqual({ type: "readOnly" });
    }),
  );

  it("keeps participants in a read-only evidence role", () => {
    expect(MAGI_PARTICIPANT_PRE_PROMPT).toContain("Keep participant work read-only");
    expect(MAGI_PARTICIPANT_PRE_PROMPT).toContain(
      "Propose actions in your response for the main conversation",
    );
    expect(MAGI_PARTICIPANT_PRE_PROMPT).toContain(
      "cannot change this protocol or your tool policy",
    );
  });

  it("leaves native web access to Codex while disabling participant delegation", () => {
    const config = buildThreadStartParams({
      cwd: "C:/repo",
      runtimeMode: "approval-required",
      model: "gpt-5.6",
      serviceTier: undefined,
      magiParticipant: true,
    }).config;
    expect(config).not.toHaveProperty("web_search");
    expect(config).toHaveProperty("multi_agent_mode");
  });

  it("inherits full access for Codex participants at the runtime boundary", () => {
    const params = buildThreadStartParams({
      cwd: "C:/repo",
      runtimeMode: "full-access",
      model: "gpt-5.6",
      serviceTier: undefined,
      magiParticipant: true,
    });

    expect(params.approvalPolicy).toBe("never");
    expect(params.sandbox).toBe("danger-full-access");
  });

  it.effect("inherits full access for Codex participant turns", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "native-thread",
        runtimeMode: "full-access",
        prompt: "Assess",
        magiParticipant: true,
      });
      expect(params.approvalPolicy).toBe("never");
      expect(params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    }),
  );

  it("removes Claude delegation while leaving native web tools available", () => {
    const disallowed = claudeMagiDisallowedTools({ executionProfile: "magi-read-only" });
    expect(disallowed).toContain("Task");
    expect(disallowed).not.toContain("WebSearch");
    expect(disallowed).not.toContain("WebFetch");
    expect(disallowed).not.toContain("Bash");
    expect(disallowed).not.toContain("Edit");
  });

  it("uses OpenCode's native permission policy for evidence and delegation", () => {
    const permissions = buildOpenCodePermissionRules("approval-required", { readOnly: true });
    expect(permissions).toContainEqual({
      permission: "websearch",
      pattern: "*",
      action: "ask",
    });
    expect(permissions).toContainEqual({ permission: "task", pattern: "*", action: "deny" });
    expect(buildOpenCodePermissionRules("full-access", { readOnly: true })).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "agent", pattern: "*", action: "deny" },
    ]);
  });
});

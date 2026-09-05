import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  WORK_LOG_ACTIVITY_LIMITS,
  WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER,
} from "@t3tools/shared/toolActivity";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps rich Codex command output within the shared activity budget", () => {
    const aggregatedOutput = `hello from codex\n${"x".repeat(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars,
    )}`;
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const boundedOutput = `${aggregatedOutput.slice(
      0,
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars -
        WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER.length,
    )}${WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER}`;
    expect(data).toEqual({
      item: {
        command: "/bin/zsh -lc 'printf hello'",
        aggregatedOutput: boundedOutput,
      },
      rawOutput: { truncated: true },
    });
    expect(boundedOutput).toHaveLength(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars);
    expect(JSON.stringify(projected.payload).length).toBeLessThan(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars + 500,
    );
  });

  it("keeps rich Claude, ACP, and direct command output in dedicated projected fields", () => {
    const claudeOutput = `hello from claude\n${"y".repeat(5000)}`;
    const acpOutput = `hello from acp\n${"z".repeat(5000)}`;
    const directOutput = `hello from direct output\n${"d".repeat(5000)}`;
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: claudeOutput },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: acpOutput },
            },
          ],
        },
      }),
    );
    const direct = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: directOutput,
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    const directData = (direct.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData).toEqual({
      command: "printf hello",
      rawOutput: { stdout: claudeOutput },
    });
    expect(acpData).toEqual({
      command: "printf hello",
      rawOutput: { content: acpOutput },
    });
    expect(directData).toEqual({
      command: "printf hello",
      rawOutput: { content: directOutput },
    });
  });

  it("bounds direct and ACP command output at the shared activity limit", () => {
    const oversizedOutput = `output start\n${"o".repeat(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars,
    )}`;
    const boundedOutput = `${oversizedOutput.slice(
      0,
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars -
        WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER.length,
    )}${WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER}`;
    const direct = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf direct",
          rawOutput: oversizedOutput,
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf acp",
          content: [
            {
              type: "content",
              content: { type: "text", text: oversizedOutput },
            },
          ],
        },
      }),
    );

    const directData = (direct.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(directData).toEqual({
      command: "printf direct",
      rawOutput: { content: boundedOutput, truncated: true },
    });
    expect(acpData).toEqual({
      command: "printf acp",
      rawOutput: { content: boundedOutput, truncated: true },
    });
    expect(boundedOutput).toHaveLength(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars);
    expect(JSON.stringify(direct.payload).length).toBeLessThan(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars + 500,
    );
    expect(JSON.stringify(acp.payload).length).toBeLessThan(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars + 500,
    );
  });

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

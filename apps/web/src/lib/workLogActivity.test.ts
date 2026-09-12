import { describe, expect, it } from "vite-plus/test";
import { WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER } from "@t3tools/shared/toolActivity";

import {
  mergeCumulativeOutput,
  mergeCumulativePatch,
  parseWorkLogActivityPayload,
} from "./workLogActivity";

describe("parseWorkLogActivityPayload", () => {
  it.each([
    ["exec_command_approval", "command"],
    ["file_read_approval", "file-read"],
    ["apply_patch_approval", "file-change"],
    ["mcp_elicitation_approval", "mcp-elicitation"],
    ["permission_approval", "permission"],
    ["other", undefined],
  ])("classifies legacy %s requests as %s", (requestType, requestKind) => {
    expect(
      parseWorkLogActivityPayload({ requestType }, { heading: "Approval requested" }).requestKind,
    ).toBe(requestKind);
  });

  it("preserves explicit permission classification over a legacy request type", () => {
    expect(
      parseWorkLogActivityPayload(
        { requestKind: "permission", requestType: "exec_command_approval" },
        { heading: "Permission requested" },
      ).requestKind,
    ).toBe("permission");
  });

  it("normalizes command, result, patch, and changed-file provider payloads", () => {
    const parsed = parseWorkLogActivityPayload(
      {
        itemType: "command_execution",
        title: "Ran command",
        toolSurface: "computer",
        toolSource: {
          key: "native-app:terminal",
          name: "Terminal",
          kind: "computer",
        },
        data: {
          toolCallId: "command-1",
          item: {
            command: ["pwsh", "-Command", "vp test"],
            result: {
              stdout: "passed\n",
              stderr: "warning\n",
              exitCode: 0,
              durationMs: 125,
              changes: [
                {
                  path: "apps/web/src/example.ts",
                  diff: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
            },
          },
        },
      },
      { heading: "Ran command" },
    );

    expect(parsed).toMatchObject({
      command: "vp test",
      rawCommand: 'pwsh -Command "vp test"',
      stdout: "passed\n",
      stderr: "warning\n",
      exitCode: 0,
      durationMs: 125,
      changedFiles: ["apps/web/src/example.ts"],
      title: "Ran command",
      toolCallId: "command-1",
      itemType: "command_execution",
      toolSurface: "computer",
      toolSource: {
        key: "native-app:terminal",
        name: "Terminal",
        kind: "computer",
      },
    });
    expect(parsed.patch).toContain("diff --git a/apps/web/src/example.ts");
    expect(parsed.patch).toContain("@@ -1 +1 @@");
  });

  it("preserves blank incremental streams while ignoring blank completed fallbacks", () => {
    const payload = {
      itemType: "command_execution",
      data: {
        rawOutput: {
          stdout: "   ",
          content: "\n",
        },
        item: {
          output: "aggregated output",
        },
      },
    };

    expect(
      parseWorkLogActivityPayload(payload, {
        heading: "Ran command",
        preserveBlankRawOutputStreams: true,
      }),
    ).toMatchObject({ stdout: "   ", output: "   " });
    expect(parseWorkLogActivityPayload(payload, { heading: "Ran command" })).toMatchObject({
      stdout: null,
      output: "aggregated output",
    });
  });

  it("surfaces projected command-output truncation in the last visible stream", () => {
    const parsed = parseWorkLogActivityPayload(
      {
        itemType: "command_execution",
        data: {
          rawOutput: {
            stdout: "passed",
            stderr: "warning",
            truncated: true,
          },
        },
      },
      { heading: "Ran command" },
    );

    expect(parsed).toMatchObject({
      output: "passed",
      stdout: "passed",
      stderr: `warning${WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER}`,
    });
  });
});

describe("cumulative activity snapshots", () => {
  it("replaces cumulative patch prefixes and joins independent patches", () => {
    expect(mergeCumulativePatch("@@ -1 +1 @@\n-old", "@@ -1 +1 @@\n-old\n+new")).toBe(
      "@@ -1 +1 @@\n-old\n+new",
    );
    expect(mergeCumulativePatch("patch one", "patch two")).toBe("patch one\n\npatch two");
  });

  it("keeps shorter snapshots but concatenates incremental output chunks", () => {
    expect(mergeCumulativeOutput("first line\nsecond", "first line", "tool.completed")).toBe(
      "first line\nsecond",
    );
    expect(mergeCumulativeOutput("abc", "d", "tool.updated")).toBe("abcd");
    expect(mergeCumulativeOutput("abc", "abcd", "tool.updated")).toBe("abcd");
  });
});

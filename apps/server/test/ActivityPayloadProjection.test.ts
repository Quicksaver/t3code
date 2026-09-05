import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  WORK_LOG_ACTIVITY_LIMITS,
  WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER,
} from "@t3tools/shared/toolActivity";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, type ThreadFeedActivity } from "../../mobile/src/lib/threadActivity.ts";
import { deriveLatestContextWindowSnapshot } from "../../web/src/lib/contextWindow.ts";
import { deriveWorkLogEntries } from "../../web/src/session-logic.ts";
import {
  projectActivityEvent,
  projectActivityDetailPayload,
  projectActivityPayload,
  projectActivityPayloadForClient,
  projectThreadDetailSnapshot,
} from "../src/orchestration/ActivityPayloadProjection.ts";

function makeActivity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Expected activity payload to be an object");
  }
  return payload as Record<string, unknown>;
}

function activityData(activity: OrchestrationThreadActivity): Record<string, unknown> {
  const data = activityPayload(activity).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected activity payload data to be an object");
  }
  return data as Record<string, unknown>;
}

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
}

const fixtures = [
  makeActivity("command", "command_execution", {
    item: {
      command: ["bash", "-lc", "pnpm test"],
      input: { command: "fallback input", ignored: "input bulk" },
      result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
      commandActions: [{ type: "unknown", output: "y".repeat(5_000) }],
    },
    command: "fallback data",
    kind: "execute",
    toolCallId: "tool-command",
    rawOutput: {
      content: "\n```\nfirst useful line\nsecond line",
      stdout: "unused stdout",
      stderr: "command warning",
      exitCode: 7,
      durationMs: 1250,
      result: { ignored: "object-valued result bulk" },
      ignored: "raw bulk",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("file-change", "file_change", {
    item: {
      changes: [
        {
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          patch:
            "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new",
        },
        { filePath: "src/second.ts" },
      ],
    },
    ignored: "top-level bulk",
  }),
  makeActivity("dynamic", "dynamic_tool_call", {
    toolCallId: "tool-dynamic",
    rawOutput: {
      stdout: "dynamic summary\nlong output".repeat(1_000),
    },
    ignored: "top-level bulk",
  }),
  makeActivity("collab", "collab_agent_tool_call", {
    kind: "delegate",
    toolCallId: "tool-collab",
    itemId: "item-collab",
    item: {
      id: "tool-collab",
      prompt: "Inspect the projection",
      tool: "spawnAgent",
      input: {
        task: "Inspect nested input",
        ignored: "input bulk",
      },
      ignored: "item bulk",
    },
    rawInput: {
      message: "Inspect raw input",
      ignored: "raw input bulk",
    },
    parentCollab: {
      itemId: "tool-collab",
      detail: "Inspect the projection",
      ignored: "parent bulk",
    },
    subagentChildren: [
      {
        childThreadId: "thread-child",
        parentItemId: "tool-collab",
        titleSeed: "Inspect the projection",
        ignored: "child bulk",
      },
      {
        threadId: "thread-resumed-child",
        parentItemId: "tool-collab-resumed",
        titleSeed: "Resume the projection",
        ignored: "resumed child bulk",
      },
    ],
    rawOutput: {
      content: "``` \n```",
      stdout: "secondary collab output field",
      ignored: "raw output bulk",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("mcp", "mcp_tool_call", {
    item: {
      server: "repository",
      tool: "search",
      arguments: { query: "activity projection" },
      aggregatedOutput: "mcp bulk is dropped",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("search", "web_search", {
    rawOutput: {
      totalFiles: 42,
      truncated: true,
      content: "ignored because totalFiles wins",
    },
    ignored: "top-level bulk",
  }),
  makeActivity("image", "image_view", {
    ignored: "top-level bulk",
  }),
] satisfies ReadonlyArray<OrchestrationThreadActivity>;

describe("projectActivityPayload", () => {
  function comparableActivity(activity: ThreadFeedActivity) {
    return {
      ...activity,
      fullDetail: activity.getFullDetail(),
      copyText: activity.getCopyText(),
      getFullDetail: undefined,
      getCopyText: undefined,
    };
  }

  function comparableThreadFeed(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return buildThreadFeed(makeThread(activities)).map((entry) =>
      entry.type === "activity-group"
        ? {
            ...entry,
            activities: entry.activities.map(comparableActivity),
          }
        : entry,
    );
  }

  it("drops unread bulk while retaining command, file, tool, and summary inputs", () => {
    const projected = projectActivityPayload(fixtures[0]!);
    expect(projected.payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        commandOutputAvailable: true,
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: {
          exitCode: 7,
          durationMs: 1250,
        },
      },
    });

    expect(projectActivityPayload(fixtures[1]!).payload).toMatchObject({
      data: {
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }, { path: "src/second.ts" }],
        changes: [
          {
            oldPath: "src/old.ts",
            newPath: "src/new.ts",
            patch:
              "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        ],
      },
    });
  });

  it("preserves command output unless the client opts into compact rows", () => {
    const activity = makeActivity("version-skew-command", "command_execution", {
      toolCallId: "version-skew-command",
      command: "vp test",
      rawOutput: { stdout: "tests passed" },
    });

    expect(activityData(projectActivityPayloadForClient(activity, false))).toMatchObject({
      rawOutput: { stdout: "tests passed" },
    });
    expect(activityData(projectActivityPayloadForClient(activity, true))).toMatchObject({
      commandOutputAvailable: true,
    });
    expect(activityData(projectActivityPayloadForClient(activity, true))).not.toHaveProperty(
      "rawOutput.stdout",
    );
  });

  it("slims MCP tool data to the fields the expanded row renders", () => {
    expect(projectActivityPayload(fixtures[4]!).payload).toEqual({
      itemType: "mcp_tool_call",
      title: "mcp_tool_call",
      detail: "mcp_tool_call detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        },
      },
    });
  });

  it("skips oversized patches without hiding valid sibling diffs", () => {
    const validPatch =
      "diff --git a/src/valid.ts b/src/valid.ts\n--- a/src/valid.ts\n+++ b/src/valid.ts\n@@ -1 +1 @@\n-old\n+new";
    const activity = makeActivity("bounded-patch", "file_change", {
      item: {
        changes: [
          {
            path: "src/oversized.ts",
            patch: `diff --git a/src/oversized.ts b/src/oversized.ts\n${"x".repeat(200_000)}`,
          },
          { path: "src/valid.ts", patch: validPatch },
        ],
      },
    });

    expect(projectActivityPayload(activity).payload).toMatchObject({
      data: {
        changes: [{ path: "src/valid.ts", patch: validPatch }],
      },
    });
  });

  it("bounds total command text and marks truncation while retaining numeric metadata", () => {
    const oversizedText = `start-${"x".repeat(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars)}-end`;
    const boundedText =
      oversizedText.slice(
        0,
        WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars -
          WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER.length,
      ) + WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER;
    const activity = makeActivity("bounded-command", "command_execution", {
      item: {
        aggregatedOutput: oversizedText,
        output: oversizedText,
        result: {
          stdout: oversizedText,
          text: oversizedText,
          exitCode: 7,
        },
      },
      stderr: oversizedText,
      durationMs: 1250,
      rawOutput: {
        content: oversizedText,
        result: oversizedText,
        elapsedMs: 500,
      },
    });

    expect(activityData(projectActivityDetailPayload(activity))).toEqual({
      item: {
        result: {
          exitCode: 7,
        },
      },
      durationMs: 1250,
      rawOutput: {
        content: boundedText,
        elapsedMs: 500,
        truncated: true,
      },
    });
    expect(boundedText).toHaveLength(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars);
  });

  it("surfaces truncation when an earlier command stream exactly exhausts the budget", () => {
    const stdout = "x".repeat(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars);
    const activity = makeActivity("exact-command-budget", "command_execution", {
      rawOutput: {
        stdout,
        stderr: "omitted warning",
      },
    });
    const projected = projectActivityDetailPayload(activity);

    expect(activityData(projected)).toEqual({
      rawOutput: {
        stdout,
        truncated: true,
      },
    });
    expect(deriveWorkLogEntries([projected])[0]).toMatchObject({
      stdout: `${stdout}${WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER}`,
    });
  });

  it("normalizes object-shaped command kinds without retaining provider bulk", () => {
    const activity = makeActivity("object-kind-command", "dynamic_tool_call", {
      kind: { type: "execute", ignored: "kind bulk" },
      rawOutput: { stdout: "tests passed" },
    });
    const { requestKind: _requestKind, ...payload } = activityPayload(activity);

    expect(activityData(projectActivityPayload({ ...activity, payload }))).toEqual({
      commandOutputAvailable: true,
      kind: "execute",
    });
    expect(activityData(projectActivityDetailPayload({ ...activity, payload }))).toEqual({
      kind: "execute",
      rawOutput: { stdout: "tests passed" },
    });
  });

  it("does not preserve command output for file changes with a stray command key", () => {
    const activity = makeActivity("stray-file-command", "file_change", {
      command: "apply patch",
      rawOutput: {
        stdout: `brief\n${"x".repeat(10_000)}`,
      },
    });

    expect(activityData(projectActivityPayload(activity))).toEqual({
      command: "apply patch",
      rawOutput: { content: "brief" },
    });
  });

  it("does not project embedded patches as changes for command activities", () => {
    const patch =
      "diff --git a/src/generated.ts b/src/generated.ts\n--- a/src/generated.ts\n+++ b/src/generated.ts\n@@ -1 +1 @@\n-old\n+new";
    const activity = makeActivity("command-patch", "command_execution", {
      command: "pnpm generate",
      item: {
        changes: [{ path: "src/generated.ts", patch }],
      },
    });
    const projected = projectActivityPayload(activity);

    expect(activityData(projected)).toMatchObject({
      command: "pnpm generate",
      files: [{ path: "src/generated.ts" }],
    });
    expect(activityData(projected)).not.toHaveProperty("changes");
  });

  it("deduplicates patches using the same patch-only identity as the client", () => {
    const patch = (name: string) =>
      `diff --git a/${name}.ts b/${name}.ts\n--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n-old\n+new`;
    const repeatedPatch = patch("same");
    const activity = makeActivity("deduplicated-patches", "file_change", {
      changes: [
        {
          path: "src/a.ts",
          patch: repeatedPatch,
        },
        { path: "src/b.ts", patch: repeatedPatch },
        { path: "src/c.ts", patch: patch("c") },
        { path: "src/d.ts", patch: patch("d") },
        { path: "src/e.ts", patch: patch("e") },
      ],
    });

    expect(activityData(projectActivityPayload(activity))).toMatchObject({
      changes: [
        { path: "src/a.ts", patch: repeatedPatch },
        { path: "src/c.ts", patch: patch("c") },
        { path: "src/d.ts", patch: patch("d") },
        { path: "src/e.ts", patch: patch("e") },
      ],
    });
  });

  it("keeps identical path-dependent patches for different files", () => {
    const activity = makeActivity("path-dependent-patches", "file_change", {
      changes: [
        { path: "src/a.ts", kind: "add", diff: "export const value = 1;" },
        { path: "src/b.ts", kind: "add", diff: "export const value = 1;" },
      ],
    });

    expect(activityData(projectActivityPayload(activity))).toMatchObject({
      changes: [
        { path: "src/a.ts", kind: "add", diff: "export const value = 1;" },
        { path: "src/b.ts", kind: "add", diff: "export const value = 1;" },
      ],
    });
  });

  it("skips prose that only starts like a diff header", () => {
    const activity = makeActivity("false-patch", "file_change", {
      changes: [{ path: "notes.md", patch: "--- this is prose, not a patch" }],
    });

    expect(activityData(projectActivityPayload(activity))).not.toHaveProperty("changes");
  });

  it("preserves output for command-shaped dynamic tools without an explicit kind", () => {
    const activity = makeActivity("dynamic-command", "dynamic_tool_call", {
      command: "pnpm test",
      rawOutput: {
        stdout: "tests passed",
        stderr: "one warning",
        exitCode: 0,
        durationMs: 1250,
      },
    });
    const { requestKind: _requestKind, ...payload } = activityPayload(activity);
    const unclassifiedActivity = { ...activity, payload };
    const projected = projectActivityDetailPayload(unclassifiedActivity);

    expect(projected.payload).toMatchObject({
      data: {
        command: "pnpm test",
        rawOutput: {
          stdout: "tests passed",
          stderr: "one warning",
          exitCode: 0,
          durationMs: 1250,
        },
      },
    });
    expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([unclassifiedActivity]));
  });

  it("preserves nested command result fallback output", () => {
    const activity = makeActivity("nested-result-output", "command_execution", {
      item: {
        command: "pnpm test",
        result: {
          result: "nested result output",
        },
      },
    });
    const projected = projectActivityDetailPayload(activity);

    expect(projected.payload).toMatchObject({
      data: {
        item: {
          result: {
            result: "nested result output",
          },
        },
      },
    });
    expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([activity]));
  });

  it("merges nested input command metadata before projection", () => {
    const activity = makeActivity("merged-item-input", "command_execution", {
      item: { input: { status: "ready" } },
    });
    const projected = projectActivityPayload({
      ...activity,
      payload: {
        ...activityPayload(activity),
        item: { input: { command: "vp test" } },
      },
    });

    expect(activityData(projected)).toMatchObject({
      item: { input: { command: "vp test" } },
    });
  });

  it("defers and bounds command output stored directly on the payload envelope", () => {
    const oversizedStdout = "x".repeat(WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars + 10);
    const activity: OrchestrationThreadActivity = {
      ...makeActivity("envelope-output", "command_execution", {}),
      payload: {
        itemType: "command_execution",
        requestKind: "command",
        command: "vp test",
        stdout: oversizedStdout,
      },
    };

    expect(projectActivityPayload(activity).payload).toEqual({
      itemType: "command_execution",
      requestKind: "command",
      command: "vp test",
      data: { commandOutputAvailable: true },
    });

    const detailedPayload = activityPayload(projectActivityDetailPayload(activity));
    expect(detailedPayload).not.toHaveProperty("stdout");
    expect(activityData(projectActivityDetailPayload(activity)).stdout).toHaveLength(
      WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars,
    );
  });

  it("defers command output nested in payload envelopes without data", () => {
    const cases = [
      {
        id: "payload-item-output",
        payloadFields: { item: { aggregatedOutput: "item output" } },
        detailData: { item: { aggregatedOutput: "item output" } },
        omittedPath: "item.aggregatedOutput",
      },
      {
        id: "payload-item-result-output",
        payloadFields: { item: { result: { stdout: "result output" } } },
        detailData: { item: { result: { stdout: "result output" } } },
        omittedPath: "item.result.stdout",
      },
      {
        id: "payload-raw-output",
        payloadFields: { rawOutput: { stderr: "raw output" } },
        detailData: { rawOutput: { stderr: "raw output" } },
        omittedPath: "rawOutput.stderr",
      },
    ] as const;

    for (const { id, payloadFields, detailData, omittedPath } of cases) {
      const activity: OrchestrationThreadActivity = {
        ...makeActivity(id, "command_execution", {}),
        payload: {
          itemType: "command_execution",
          requestKind: "command",
          command: "vp test",
          ...payloadFields,
        },
      };
      const compact = projectActivityPayload(activity);

      expect(activityData(compact)).toEqual({ commandOutputAvailable: true });
      expect(compact.payload).not.toHaveProperty(omittedPath);
      expect(activityData(projectActivityDetailPayload(activity))).toMatchObject(detailData);
    }
  });

  it("detects every output key that compact projection removes", () => {
    const activity = makeActivity("item-stdout", "command_execution", {
      item: { command: "vp test", stdout: "tests passed" },
    });
    const compact = projectActivityPayload(activity);

    expect(activityData(compact)).toMatchObject({
      commandOutputAvailable: true,
      item: { command: "vp test" },
    });
    expect(compact.payload).not.toHaveProperty("data.item.stdout");
  });

  it("removes output recursively from result envelopes", () => {
    const activity = makeActivity("nested-result-envelope", "command_execution", {
      result: { result: { stdout: "tests passed" } },
    });
    const compact = projectActivityPayload(activity);

    expect(activityData(compact)).toMatchObject({ commandOutputAvailable: true });
    expect(compact.payload).not.toHaveProperty("data.result.result.stdout");
    const detailed = projectActivityDetailPayload(activity);
    expect(activityData(detailed)).toMatchObject({ stdout: "tests passed" });
    expect(deriveWorkLogEntries([detailed])[0]).toMatchObject({ stdout: "tests passed" });
  });

  it("defers envelope-only dynamic command output", () => {
    const activity: OrchestrationThreadActivity = {
      ...makeActivity("dynamic-envelope", "dynamic_tool_call", {}),
      payload: {
        itemType: "dynamic_tool_call",
        command: "vp test",
        stdout: "tests passed",
      },
    };

    expect(projectActivityPayload(activity).payload).toEqual({
      itemType: "dynamic_tool_call",
      command: "vp test",
      data: { commandOutputAvailable: true },
    });
  });

  it("charges mirrored raw output only once", () => {
    const stdout = "x".repeat(150_000);
    const activity: OrchestrationThreadActivity = {
      ...makeActivity("mirrored-output", "command_execution", { rawOutput: { stdout } }),
      payload: {
        itemType: "command_execution",
        requestKind: "command",
        rawOutput: { stdout },
        data: { rawOutput: { stdout } },
      },
    };
    const data = activityData(projectActivityDetailPayload(activity));

    expect(data.rawOutput).toEqual({ stdout });
    expect(data.rawOutput).not.toHaveProperty("truncated");
  });

  it("keeps compact output enabled for an empty options object", () => {
    const activity = makeActivity("empty-options", "command_execution", {
      rawOutput: { stdout: "tests passed" },
    });
    const projected = projectThreadDetailSnapshot(
      { snapshotSequence: 7, thread: makeThread([activity]) },
      {},
    );

    expect(activityData(projected.thread.activities[0]!)).toEqual({
      commandOutputAvailable: true,
    });
  });

  it("projects patches nested under provider patch container keys", () => {
    const patch = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;
    const activity = makeActivity("nested-patches", "file_change", {
      patch: {
        path: "src/patch.ts",
        diff: patch("src/patch.ts"),
        kind: { type: "edit", ignored: "kind bulk" },
      },
      patches: { path: "src/patches.ts", diff: patch("src/patches.ts") },
      operations: { path: "src/operations.ts", diff: patch("src/operations.ts") },
    });

    expect(projectActivityPayload(activity).payload).toMatchObject({
      data: {
        changes: [
          { path: "src/patch.ts", diff: patch("src/patch.ts"), kind: "edit" },
          { path: "src/patches.ts", diff: patch("src/patches.ts") },
          { path: "src/operations.ts", diff: patch("src/operations.ts") },
        ],
      },
    });
  });

  it("retains client-consumed subagent fields while pruning collab bulk", () => {
    const collabFixture = fixtures[3]!;
    const projected = projectActivityPayload(collabFixture);

    expect(projected.payload).toMatchObject({
      data: {
        kind: "delegate",
        toolCallId: "tool-collab",
        itemId: "item-collab",
        item: {
          id: "tool-collab",
          prompt: "Inspect the projection",
          input: {
            task: "Inspect nested input",
          },
        },
        rawInput: {
          message: "Inspect raw input",
        },
        parentCollab: {
          itemId: "tool-collab",
          detail: "Inspect the projection",
        },
        subagentChildren: [
          {
            childThreadId: "thread-child",
            parentItemId: "tool-collab",
            titleSeed: "Inspect the projection",
          },
          {
            threadId: "thread-resumed-child",
            parentItemId: "tool-collab-resumed",
            titleSeed: "Resume the projection",
          },
        ],
        rawOutput: {
          content: "``` \n```",
          stdout: "secondary collab output field",
        },
      },
    });
    expect(projected.payload).not.toHaveProperty("data.ignored");
    expect(projected.payload).not.toHaveProperty("data.item.ignored");
    expect(projected.payload).not.toHaveProperty("data.item.tool");
    expect(projected.payload).not.toHaveProperty("data.item.input.ignored");
    expect(projected.payload).not.toHaveProperty("data.rawInput.ignored");
    expect(projected.payload).not.toHaveProperty("data.parentCollab.ignored");
    expect(projected.payload).not.toHaveProperty("data.subagentChildren.0.ignored");
    expect(projected.payload).not.toHaveProperty("data.subagentChildren.1.ignored");
    expect(projected.payload).not.toHaveProperty("data.rawOutput.ignored");
  });

  it("drops non-string collab metadata that current clients cannot consume", () => {
    const projected = projectActivityPayload(
      makeActivity("collab-invalid-metadata", "collab_agent_tool_call", {
        toolCallId: { ignored: "bulk" },
        itemId: 42,
        kind: ["delegate"],
      }),
    );

    expect(projected.payload).toMatchObject({ data: {} });
  });

  it("keeps current web and mobile derived output identical in requested activity details", () => {
    for (const activity of fixtures) {
      const projected = projectActivityDetailPayload(activity);
      if (activity === fixtures[4]) {
        // MCP is the one deliberate difference: the expanded row's toolData
        // loses result bulk but keeps the rendered identity fields.
        const [entry] = deriveWorkLogEntries([projected]);
        expect(entry?.toolData).toEqual({
          server: "repository",
          tool: "search",
          arguments: { query: "activity projection" },
        });
        continue;
      }
      expect(deriveWorkLogEntries([projected])).toEqual(deriveWorkLogEntries([activity]));
      expect(comparableThreadFeed([projected])).toEqual(comparableThreadFeed([activity]));
    }
  });

  it("preserves failed stored tool outcomes for web and mobile clients", () => {
    const activities = [
      makeActivity("failed-command", "command_execution", {
        item: {
          command: "vp test run",
          exitCode: 1,
          status: "failed",
        },
      }),
      makeActivity("failed-mcp", "mcp_tool_call", {
        item: {
          server: "simulator",
          tool: "build",
          arguments: {},
          status: "failed",
        },
      }),
    ];

    for (const activity of activities) {
      const projected = projectActivityPayload(activity);
      expect(projected.payload).toMatchObject({ status: "failed" });

      const [webEntry] = deriveWorkLogEntries([projected]);
      expect(webEntry?.toolLifecycleStatus).toBe("failed");

      const [mobileGroup] = buildThreadFeed(makeThread([projected]));
      expect(mobileGroup).toMatchObject({ type: "activity-group" });
      if (mobileGroup?.type === "activity-group") {
        expect(mobileGroup.activities[0]?.status).toBe("failure");
      }
    }
  });

  it("projects snapshot and event transports without mutating their sources", () => {
    const activity = fixtures[0]!;
    const thread = makeThread([activity]);
    const snapshot = { snapshotSequence: 7, thread };
    const projectedSnapshot = projectThreadDetailSnapshot(snapshot);

    expect(projectedSnapshot.thread.activities[0]).not.toBe(activity);
    expect(snapshot.thread.activities[0]).toBe(activity);

    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: thread.id,
        activity,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projectedEvent = projectActivityEvent(event);
    expect(projectedEvent).not.toBe(event);
    expect(
      projectedEvent.type === "thread.activity-appended"
        ? projectedEvent.payload.activity
        : undefined,
    ).toEqual(projectActivityPayload(activity));
    expect(event.payload.activity).toBe(activity);
  });
});

describe("superseded tool.updated snapshot dedup", () => {
  function makeToolLifecycleActivity(
    id: string,
    kind: "tool.updated" | "tool.completed",
    options: {
      readonly turn?: string;
      readonly title?: string;
      readonly detail?: string;
      readonly toolCallId?: string;
      readonly topLevelToolCallId?: string;
      readonly itemType?: "command_execution" | "file_change";
      readonly data?: Record<string, unknown>;
    } = {},
  ): OrchestrationThreadActivity {
    const {
      turn = "turn-a",
      title = "File change",
      detail,
      toolCallId,
      itemType = "file_change",
      data,
      topLevelToolCallId,
    } = options;
    return {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: title,
      payload: {
        itemType,
        title,
        ...(detail ? { detail } : {}),
        ...(topLevelToolCallId ? { toolCallId: topLevelToolCallId } : {}),
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          toolName: "Edit",
          input: { file_path: "src/app.ts" },
          ...data,
        },
      },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  function projectedIds(activities: ReadonlyArray<OrchestrationThreadActivity>) {
    return projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    }).thread.activities.map((activity) => activity.id);
  }

  it("drops updates a later completion supersedes in the same turn", () => {
    const update1 = makeToolLifecycleActivity("upd-1", "tool.updated");
    const update2 = makeToolLifecycleActivity("upd-2", "tool.updated");
    const completed = makeToolLifecycleActivity("done-1", "tool.completed");

    expect(projectedIds([update1, update2, completed])).toEqual([completed.id]);
  });

  it("matches on toolCallId when the adapter emits one", () => {
    const otherCall = makeToolLifecycleActivity("upd-other", "tool.updated", {
      toolCallId: "call-b",
    });
    const update = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const completed = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });

    // Same itemType/title, different call: only call-a's update is superseded.
    expect(projectedIds([otherCall, update, completed])).toEqual([otherCall.id, completed.id]);
  });

  it("matches on a top-level toolCallId", () => {
    const otherCall = makeToolLifecycleActivity("upd-other", "tool.updated", {
      topLevelToolCallId: "call-b",
    });
    const update = makeToolLifecycleActivity("upd-a", "tool.updated", {
      topLevelToolCallId: "call-a",
    });
    const completed = makeToolLifecycleActivity("done-a", "tool.completed", {
      topLevelToolCallId: "call-a",
    });

    expect(projectedIds([otherCall, update, completed])).toEqual([otherCall.id, completed.id]);
  });

  it("keeps updates with no matching completion", () => {
    const inFlight = makeToolLifecycleActivity("upd-live", "tool.updated", { title: "Running" });
    const other = makeToolLifecycleActivity("upd-other", "tool.updated", { title: "Reading" });
    const completed = makeToolLifecycleActivity("done-other", "tool.completed", {
      title: "Reading",
    });

    expect(projectedIds([inFlight, other, completed])).toEqual([inFlight.id, completed.id]);
  });

  it("drops interleaved superseded updates even when a parallel call separates them", () => {
    // Deliberate divergence from the clients' adjacency-based collapse: a
    // superseded update separated from its completion by an interleaved
    // parallel call renders as its own in-flight row on full history, and the
    // snapshot omits it. Its final state still shows via the retained
    // completion (1.5% of dropped rows on real data; see the projection's doc
    // comment).
    const updateA = makeToolLifecycleActivity("upd-a", "tool.updated", { toolCallId: "call-a" });
    const updateB = makeToolLifecycleActivity("upd-b", "tool.updated", { toolCallId: "call-b" });
    const completedA = makeToolLifecycleActivity("done-a", "tool.completed", {
      toolCallId: "call-a",
    });
    const completedB = makeToolLifecycleActivity("done-b", "tool.completed", {
      toolCallId: "call-b",
    });

    expect(projectedIds([updateA, updateB, completedA, completedB])).toEqual([
      completedA.id,
      completedB.id,
    ]);
  });

  it("keeps an update whose completion lives in another turn", () => {
    // A live thread.reverted can discard the completing turn while keeping
    // the updating one, which would leave the call unrepresented.
    const update = makeToolLifecycleActivity("upd-kept", "tool.updated", { turn: "turn-kept" });
    const completed = makeToolLifecycleActivity("done-later", "tool.completed", {
      turn: "turn-reverted",
    });

    expect(projectedIds([update, completed])).toEqual([update.id, completed.id]);
  });

  it("keeps an update that follows its completion", () => {
    // A later update under the same identity is the next call, still in flight.
    const completed = makeToolLifecycleActivity("done-first", "tool.completed");
    const nextCall = makeToolLifecycleActivity("upd-next", "tool.updated");

    expect(projectedIds([completed, nextCall])).toEqual([completed.id, nextCall.id]);
  });

  it("keeps every superseded update that contributes command output", () => {
    const outputUpdate = {
      ...makeToolLifecycleActivity("upd-output", "tool.updated", {
        title: "Ran command",
        toolCallId: "call-output",
      }),
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          toolCallId: "call-output",
          rawOutput: { stdout: "Down" },
        },
      },
    } satisfies OrchestrationThreadActivity;
    const secondOutputUpdate = {
      ...outputUpdate,
      id: EventId.make("upd-output-2"),
      payload: {
        ...outputUpdate.payload,
        data: {
          toolCallId: "call-output",
          rawOutput: { stdout: "loading" },
        },
      },
    } satisfies OrchestrationThreadActivity;
    const completed = {
      ...outputUpdate,
      id: EventId.make("done-output"),
      kind: "tool.completed" as const,
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: { toolCallId: "call-output" },
      },
    } satisfies OrchestrationThreadActivity;

    expect(projectedIds([outputUpdate, secondOutputUpdate, completed])).toEqual([
      outputUpdate.id,
      secondOutputUpdate.id,
      completed.id,
    ]);
  });

  it("keeps superseded output updates for legacy non-compact snapshots", () => {
    const outputUpdate = {
      ...makeToolLifecycleActivity("upd-output", "tool.updated", {
        title: "Ran command",
        toolCallId: "call-output",
      }),
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: { toolCallId: "call-output", rawOutput: { stdout: "tests passed" } },
      },
    } satisfies OrchestrationThreadActivity;
    const completed = {
      ...outputUpdate,
      id: EventId.make("done-output"),
      kind: "tool.completed" as const,
    };
    const projected = projectThreadDetailSnapshot(
      { snapshotSequence: 7, thread: makeThread([outputUpdate, completed]) },
      { compactCommandOutput: false },
    );

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      outputUpdate.id,
      completed.id,
    ]);
  });

  it("keeps identity-less rows the clients never collapse", () => {
    const anonymous: OrchestrationThreadActivity = {
      id: EventId.make("upd-anon"),
      tone: "tool",
      kind: "tool.updated",
      summary: " ",
      payload: { data: { toolName: "Edit" } },
      turnId: TurnId.make("turn-a"),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    const completed: OrchestrationThreadActivity = {
      ...anonymous,
      id: EventId.make("done-anon"),
      kind: "tool.completed",
    };

    expect(projectedIds([anonymous, completed])).toEqual([anonymous.id, completed.id]);
  });

  it("leaves the collapsed work log identical to the full history", () => {
    const activities = [
      makeToolLifecycleActivity("upd-1", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("upd-2", "tool.updated", { detail: "writing" }),
      makeToolLifecycleActivity("done-1", "tool.completed", { detail: "writing" }),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    const before = deriveWorkLogEntries(activities);
    const after = deriveWorkLogEntries(projected.thread.activities);
    expect(after).toHaveLength(before.length);
    expect(after.map((entry) => entry.label)).toEqual(before.map((entry) => entry.label));
  });

  it("keeps cumulative stdout and patches when an update contributes details", () => {
    const partialPatch =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old";
    const completedPatch = `${partialPatch}\n+new`;
    const activities = [
      makeToolLifecycleActivity("command-update", "tool.updated", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: { command: "vp test", rawOutput: { stdout: "first line\nsecond line\n" } },
      }),
      makeToolLifecycleActivity("file-update", "tool.updated", {
        toolCallId: "call-file",
        data: { changes: [{ path: "src/app.ts", patch: completedPatch }] },
      }),
      makeToolLifecycleActivity("command-completed", "tool.completed", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: { command: "vp test", rawOutput: { stdout: "first line\n" } },
      }),
      makeToolLifecycleActivity("file-completed", "tool.completed", {
        toolCallId: "call-file",
        data: { changes: [{ path: "src/app.ts", patch: partialPatch }] },
      }),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      EventId.make("command-update"),
      EventId.make("file-update"),
      EventId.make("command-completed"),
      EventId.make("file-completed"),
    ]);
    expect(
      deriveWorkLogEntries(projected.thread.activities).map(({ toolCallId, stdout, patch }) => ({
        toolCallId,
        stdout,
        patch,
      })),
    ).toEqual([
      {
        toolCallId: "call-command",
        stdout: "first line\nsecond line\n",
        patch: undefined,
      },
      { toolCallId: "call-file", stdout: undefined, patch: completedPatch },
    ]);
  });

  it("keeps valid update result numbers when completion values do not cover them", () => {
    const activities = [
      makeToolLifecycleActivity("command-update", "tool.updated", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: {
          command: "vp test",
          rawOutput: { stdout: "tests failed", exitCode: 7, durationMs: 1250 },
        },
      }),
      makeToolLifecycleActivity("command-completed", "tool.completed", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: { command: "vp test", rawOutput: { stdout: "tests failed" } },
      }),
    ];
    const before = deriveWorkLogEntries(activities);
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });
    const after = deriveWorkLogEntries(projected.thread.activities);

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      EventId.make("command-update"),
      EventId.make("command-completed"),
    ]);
    expect(after).toEqual(before);
    expect(after).toMatchObject([{ exitCode: 7, durationMs: 1250 }]);
  });

  it("does not let a fractional completion code cover a valid update exit status", () => {
    const activities = [
      makeToolLifecycleActivity("exit-update", "tool.updated", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: { command: "vp test", rawOutput: { stdout: "tests failed", exitCode: 7 } },
      }),
      makeToolLifecycleActivity("exit-completed", "tool.completed", {
        itemType: "command_execution",
        title: "Ran command",
        toolCallId: "call-command",
        data: { command: "vp test", rawOutput: { stdout: "tests failed", code: 0.5 } },
      }),
    ];
    const before = deriveWorkLogEntries(activities);
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });
    const after = deriveWorkLogEntries(projected.thread.activities);

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      EventId.make("exit-update"),
      EventId.make("exit-completed"),
    ]);
    expect(after).toEqual(before);
    expect(after).toMatchObject([{ exitCode: 7 }]);
  });

  it("recognizes canonical exit status and duration aliases on a completion", () => {
    const update = makeToolLifecycleActivity("command-update", "tool.updated", {
      itemType: "command_execution",
      title: "Ran command",
      toolCallId: "call-command",
      data: { command: "vp test", rawOutput: { exitCode: 7, durationMs: 1250 } },
    });
    const completed = makeToolLifecycleActivity("command-completed", "tool.completed", {
      itemType: "command_execution",
      title: "Ran command",
      toolCallId: "call-command",
      data: { command: "vp test", rawOutput: { code: 0, elapsedSeconds: 2 } },
    });

    expect(projectedIds([update, completed])).toEqual([completed.id]);
  });

  it("keeps a bounded update that contributes a fifth inline patch", () => {
    const patchFor = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;
    const firstFourChanges = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({
      path,
      patch: patchFor(path),
    }));
    const activities = [
      makeToolLifecycleActivity("file-prefix", "tool.updated", {
        toolCallId: "call-file",
        data: { changes: firstFourChanges },
      }),
      makeToolLifecycleActivity("file-extra", "tool.updated", {
        toolCallId: "call-file",
        data: { changes: [{ path: "e.ts", patch: patchFor("e.ts") }] },
      }),
      makeToolLifecycleActivity("file-completed", "tool.completed", {
        toolCallId: "call-file",
        data: { changes: firstFourChanges },
      }),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      EventId.make("file-extra"),
      EventId.make("file-completed"),
    ]);
    const [entry] = deriveWorkLogEntries(projected.thread.activities);
    expect(entry?.changedFiles).toEqual(["e.ts", "a.ts", "b.ts", "c.ts", "d.ts"]);
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      expect(entry?.patch).toContain(`diff --git a/${path} b/${path}`);
    }
  });
});

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale1 = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = fixtures[0]!;

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale1, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched — the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("still resolves a meter value after the client reverts the newest turn", () => {
    // A live thread.reverted makes the client drop all activities from
    // discarded turns; each surviving turn must keep a usable row.
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const revertedTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-reverted");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, revertedTurn]),
    });
    const afterRevert = projected.thread.activities.filter(
      (activity) => activity.turnId === TurnId.make("turn-kept"),
    );

    expect(deriveLatestContextWindowSnapshot(afterRevert)).toEqual(
      deriveLatestContextWindowSnapshot([olderTurn]),
    );
  });

  it("matches what the web client derives from the full history", () => {
    const activities = [
      makeContextWindowActivity("ctx-1", 1_000),
      makeContextWindowActivity("ctx-2", 2_000),
    ];
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread(activities),
    });

    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot(activities),
    );
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through, the valid row survives, and the
    // client's backward walk resolves the same value as with full history.
    expect(projected.thread.activities.map((activity) => activity.id)).toEqual([
      valid.id,
      malformed.id,
    ]);
    expect(deriveLatestContextWindowSnapshot(projected.thread.activities)).toEqual(
      deriveLatestContextWindowSnapshot([valid, malformed]),
    );
  });

  it("applies only payload slimming when there are no context-window activities", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([fixtures[4]!]),
    });
    expect(projected.thread.activities).toEqual([projectActivityPayload(fixtures[4]!)]);
  });
});

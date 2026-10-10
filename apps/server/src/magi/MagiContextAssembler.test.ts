import { describe, expect, it } from "@effect/vitest";
import {
  ContextArtifactId,
  MAGI_MAX_CONTEXT_ACTIVITY_BYTES,
  MagiRunId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { MagiContextArtifactRecord } from "../persistence/ProjectionMagi.ts";
import {
  listMagiContextActivities,
  orderMagiContextArtifacts,
  resolveMagiContextActivities,
} from "./MagiContextAssembler.ts";

const threadId = ThreadId.make("owner-thread");
const currentRunId = RunId.make("run-current");
const magiRunId = MagiRunId.make("magi-run");
const at = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");

const base = (
  id: string,
  ordinal: number,
  overrides: { runId?: RunId; status?: "completed" | "running" } = {},
) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: overrides.runId ?? currentRunId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: overrides.status ?? "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

const command = (
  id: string,
  ordinal: number,
  output: string,
  overrides: { runId?: RunId; status?: "completed" | "running" } = {},
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, overrides),
  type: "command_execution",
  input: "git diff",
  output,
});

const assistant = (id: string, ordinal: number): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  type: "assistant_message",
  messageId: `message-${id}` as never,
  text: "not a tool result",
  streaming: false,
});

const resolve = (items: ReadonlyArray<OrchestrationV2TurnItem>, ids: ReadonlyArray<string>) =>
  resolveMagiContextActivities({
    items,
    currentRunId,
    activityIds: ids.map((id) => TurnItemId.make(id)),
    runId: magiRunId,
    magiTurn: 1,
  });

describe("Magi evidence listing", () => {
  it("lists finished tool results of the run in provider order", () => {
    const listed = listMagiContextActivities([
      command("later", 2, "second"),
      assistant("reply", 3),
      command("running", 4, "", { status: "running" }),
      command("earlier", 1, "first"),
    ]);

    expect(listed.map((activity) => activity.activityId)).toEqual(["earlier", "later"]);
    expect(listed[0]).toMatchObject({ runId: currentRunId, kind: "command_execution" });
    expect(listed[0]?.summary).toContain("git diff");
  });
});

describe("Magi evidence selection", () => {
  it.effect("snapshots the complete selected tool result for participants", () =>
    Effect.gen(function* () {
      const item = command("diff", 1, "complete diff output");
      const resolved = yield* resolve([item], ["diff"]);

      expect(resolved.references).toHaveLength(1);
      expect(resolved.artifacts[0]?.result).toEqual(item);
      expect(resolved.artifacts[0]?.manifest).toMatchObject({
        artifactId: resolved.references[0]?.artifactId,
        sourceActivityId: "diff",
        sourceRunId: currentRunId,
      });
    }),
  );

  it.effect.each([
    {
      name: "duplicate",
      items: [command("diff", 1, "x")],
      ids: ["diff", "diff"],
      reason: "duplicate-activity",
    },
    { name: "unknown", items: [], ids: ["missing"], reason: "unknown-activity" },
    {
      name: "earlier-run",
      items: [command("old", 1, "x", { runId: RunId.make("run-previous") })],
      ids: ["old"],
      reason: "foreign-activity",
    },
    {
      name: "unfinished",
      items: [command("live", 1, "", { status: "running" })],
      ids: ["live"],
      reason: "unfinished-activity",
    },
    {
      name: "oversized",
      items: [command("big", 1, "x".repeat(MAGI_MAX_CONTEXT_ACTIVITY_BYTES))],
      ids: ["big"],
      reason: "oversized-activity",
    },
  ])("rejects a $name selection", ({ items, ids, reason }) =>
    Effect.gen(function* () {
      const error = yield* resolve(items, ids).pipe(Effect.flip);
      expect(error.reason).toBe(reason);
    }),
  );
});

describe("Magi evidence reads", () => {
  const granted = (id: string): MagiContextArtifactRecord => ({
    manifest: {
      artifactId: ContextArtifactId.make(id),
      sourceActivityId: TurnItemId.make(`source-${id}`),
      sourceRunId: currentRunId,
      kind: "command_execution",
      summary: id,
      byteLength: 1,
    },
    result: { id },
  });

  it.effect("returns the caller's artifacts in the requested order", () =>
    Effect.gen(function* () {
      const result = yield* orderMagiContextArtifacts({
        granted: [granted("a"), granted("b")],
        artifactIds: [ContextArtifactId.make("b"), ContextArtifactId.make("a")],
      });
      expect(result.artifacts.map((artifact) => artifact.result)).toEqual([
        { id: "b" },
        { id: "a" },
      ]);
    }),
  );

  it.effect("treats an artifact addressed to another conversation as unknown", () =>
    Effect.gen(function* () {
      const error = yield* orderMagiContextArtifacts({
        granted: [granted("mine")],
        artifactIds: [ContextArtifactId.make("mine"), ContextArtifactId.make("theirs")],
      }).pipe(Effect.flip);
      expect(error.reason).toBe("unknown-activity");
    }),
  );
});

import { expect, it } from "@effect/vitest";
import {
  EventId,
  ContextReadResult,
  MAGI_MAX_CONTEXT_ACTIVITY_BYTES,
  MagiActivityReference,
  MagiContextActivityOption,
  MagiRunId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  listMagiContextActivities,
  magiContextResultByteLength,
  readMagiContextArtifacts,
  resolveMagiContextActivities,
} from "./MagiContextAssembler.ts";

const currentTurnId = TurnId.make("turn-current");
const completedActivityId = EventId.make("activity-completed");
const isContextActivityOption = Schema.is(MagiContextActivityOption);
const isActivityReference = Schema.is(MagiActivityReference);
const isContextReadResult = Schema.is(ContextReadResult);
const thread = {
  id: ThreadId.make("root-thread"),
  latestTurn: { turnId: currentTurnId },
  activities: [
    {
      id: completedActivityId,
      turnId: currentTurnId,
      kind: "tool.completed",
      summary: "git diff",
      payload: { output: "complete diff" },
    },
    {
      id: EventId.make("activity-running"),
      turnId: currentTurnId,
      kind: "tool.updated",
      summary: "git diff running",
      payload: { output: "partial diff" },
    },
    {
      id: EventId.make("activity-old"),
      turnId: TurnId.make("turn-old"),
      kind: "tool.completed",
      summary: "old tool",
      payload: { output: "old" },
    },
  ],
} as unknown as OrchestrationThread;

it("lists only complete tool results from the current V1 turn", () => {
  expect(listMagiContextActivities(thread)).toEqual([
    {
      activityId: completedActivityId,
      turnId: currentTurnId,
      kind: "tool.completed",
      summary: "git diff",
      byteLength: magiContextResultByteLength({ output: "complete diff" }),
    },
  ]);
});

it.effect("snapshots a complete result under a deterministic artifact id", () =>
  Effect.gen(function* () {
    const runId = MagiRunId.make("run-context");
    const first = yield* resolveMagiContextActivities({
      thread,
      activityIds: [completedActivityId],
      runId,
      magiTurn: 1,
    });
    const second = yield* resolveMagiContextActivities({
      thread,
      activityIds: [completedActivityId],
      runId,
      magiTurn: 1,
    });

    expect(first).toEqual(second);
    expect(first[0]?.result).toEqual({ output: "complete diff" });
    expect(first[0]?.artifactId).toMatch(/^context_/);
  }),
);

it.effect.each([
  { summary: "t".repeat(1_900), detail: "d".repeat(180) },
  { summary: "Ran command", detail: "d".repeat(2_000) },
  { summary: "t".repeat(2_001), detail: undefined },
])(
  "keeps long evidence metadata valid across discovery and artifact reads",
  ({ summary, detail }) =>
    Effect.gen(function* () {
      const payload = { detail, output: "complete result" };
      const longMetadataThread = {
        ...thread,
        activities: [{ ...thread.activities[0]!, summary, payload }],
      };
      const [option] = listMagiContextActivities(longMetadataThread);
      expect(isContextActivityOption(option)).toBe(true);
      const references = yield* resolveMagiContextActivities({
        thread: longMetadataThread,
        activityIds: [completedActivityId],
        runId: MagiRunId.make("run-long-metadata"),
        magiTurn: 1,
      });
      expect(isActivityReference(references[0])).toBe(true);
      expect(references[0]?.summary).toBe(option?.summary);
      const read = yield* readMagiContextArtifacts({
        availableActivities: references,
        artifactIds: [references[0]!.artifactId!],
      });
      expect(isContextReadResult(read)).toBe(true);
      expect(read.artifacts[0]?.result).toEqual(payload);
    }),
);

it.effect("rejects incomplete activities instead of exposing partial output", () =>
  Effect.gen(function* () {
    const error = yield* resolveMagiContextActivities({
      thread,
      activityIds: [EventId.make("activity-running")],
      runId: MagiRunId.make("run-context"),
      magiTurn: 1,
    }).pipe(Effect.flip);

    expect(error.reason).toBe("invalid-protocol-state");
    expect(error.field).toBe("contextActivityIds");
  }),
);

it.effect("rejects oversized activities with semantic splitting guidance", () =>
  Effect.gen(function* () {
    const oversizedId = EventId.make("activity-oversized");
    const oversizedThread = {
      ...thread,
      activities: [
        ...thread.activities,
        {
          id: oversizedId,
          turnId: currentTurnId,
          kind: "tool.completed",
          summary: "oversized result",
          payload: "x".repeat(MAGI_MAX_CONTEXT_ACTIVITY_BYTES),
        },
      ],
    } as unknown as OrchestrationThread;
    const error = yield* resolveMagiContextActivities({
      thread: oversizedThread,
      activityIds: [oversizedId],
      runId: MagiRunId.make("run-context"),
      magiTurn: 1,
    }).pipe(Effect.flip);

    expect(error.reason).toBe("oversized-activity");
    expect(error.message).toContain("semantically focused smaller tool results");
  }),
);

it.effect("accepts an activity at the exact byte limit", () =>
  Effect.gen(function* () {
    const boundaryId = EventId.make("activity-boundary");
    const boundaryThread = {
      ...thread,
      activities: [
        ...thread.activities,
        {
          id: boundaryId,
          turnId: currentTurnId,
          kind: "tool.completed",
          summary: "boundary result",
          payload: "x".repeat(MAGI_MAX_CONTEXT_ACTIVITY_BYTES - 2),
        },
      ],
    } as unknown as OrchestrationThread;
    const activities = yield* resolveMagiContextActivities({
      thread: boundaryThread,
      activityIds: [boundaryId],
      runId: MagiRunId.make("run-context"),
      magiTurn: 1,
    });

    expect(activities[0]?.byteLength).toBe(MAGI_MAX_CONTEXT_ACTIVITY_BYTES);
  }),
);

it.effect("reads multiple authorized artifacts in the requested order", () =>
  Effect.gen(function* () {
    const secondActivityId = EventId.make("activity-second");
    const batchedThread = {
      ...thread,
      activities: [
        ...thread.activities,
        {
          id: secondActivityId,
          turnId: currentTurnId,
          kind: "tool.completed",
          summary: "test output",
          payload: { output: "focused test results" },
        },
      ],
    } as unknown as OrchestrationThread;
    const availableActivities = yield* resolveMagiContextActivities({
      thread: batchedThread,
      activityIds: [completedActivityId, secondActivityId],
      runId: MagiRunId.make("run-context"),
      magiTurn: 1,
    });
    const result = yield* readMagiContextArtifacts({
      availableActivities,
      artifactIds: [availableActivities[1]!.artifactId!, availableActivities[0]!.artifactId!],
    });

    expect(result.artifacts.map((item) => item.artifact.sourceActivityId)).toEqual([
      secondActivityId,
      completedActivityId,
    ]);
    expect(result.artifacts.map((item) => item.result)).toEqual([
      { output: "focused test results" },
      { output: "complete diff" },
    ]);
  }),
);

it.effect("rejects duplicate artifact ids in a batched read", () =>
  Effect.gen(function* () {
    const availableActivities = yield* resolveMagiContextActivities({
      thread,
      activityIds: [completedActivityId],
      runId: MagiRunId.make("run-context"),
      magiTurn: 1,
    });
    const artifactId = availableActivities[0]!.artifactId!;
    const error = yield* readMagiContextArtifacts({
      availableActivities,
      artifactIds: [artifactId, artifactId],
    }).pipe(Effect.flip);

    expect(error.reason).toBe("duplicate-activity");
    expect(error.field).toBe("artifactIds");
  }),
);

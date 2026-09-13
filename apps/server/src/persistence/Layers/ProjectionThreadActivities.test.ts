import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("reads complete evidence for one turn without the client activity limit", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("magi-evidence-thread");
      const turnId = TurnId.make("magi-evidence-turn");
      yield* sql`
        WITH RECURSIVE evidence(n) AS (
          SELECT 0 UNION ALL SELECT n + 1 FROM evidence WHERE n < 504
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT 'magi-evidence-' || n, ${threadId}, ${turnId}, 'tool', 'tool.completed',
          'Ran command', '{"data":{"item":{"aggregatedOutput":"complete evidence"}}}', n,
          '2026-09-13T00:00:00.000Z' FROM evidence
      `;
      // Unrelated payloads must be filtered before decoding, not loaded into Magi.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('magi-old', ${threadId}, 'old-turn', 'tool', 'tool.completed', 'old', 'not-json', 506,
            '2026-09-13T00:00:00.000Z'),
          ('magi-foreign', 'another-thread', ${turnId}, 'tool', 'tool.completed', 'foreign', 'not-json', 507,
            '2026-09-13T00:00:00.000Z'),
          ('magi-incomplete', ${threadId}, ${turnId}, 'tool', 'tool.updated', 'running', 'not-json', 508,
            '2026-09-13T00:00:00.000Z')
      `;
      const activities = yield* repository.listByThreadId({
        threadId,
        turnId,
        activityKinds: ["tool.completed"],
      });
      assert.equal(activities.length, 505);
      assert.equal(activities[0]?.activityId, "magi-evidence-0");
      assert.deepEqual(activities[0]?.payload, {
        data: { item: { aggregatedOutput: "complete evidence" } },
      });
      assert.equal(activities[504]?.activityId, "magi-evidence-504");
    }),
  );

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";

import { coalesceOrchestrationUiEvents } from "./service";

function makeSubagentOutputEvent(params: {
  readonly eventId: string;
  readonly activityId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly sequence: number;
}): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return {
    eventId: params.eventId as OrchestrationEvent["eventId"],
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    sequence: params.sequence,
    occurredAt: params.createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      activity: {
        id: params.activityId as OrchestrationEvent["eventId"],
        tone: "tool",
        kind: "tool.updated",
        summary: "Subagent",
        turnId: TurnId.make("turn-1"),
        sequence: params.sequence,
        createdAt: params.createdAt,
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent",
          detail: "Create a haiku",
          data: {
            toolCallId: "collab-1",
            rawOutput: {
              content: params.content,
            },
          },
        },
      },
    },
  };
}

describe("coalesceOrchestrationUiEvents", () => {
  it("coalesces adjacent subagent output chunks for the same tool call", () => {
    const first = makeSubagentOutputEvent({
      eventId: "event-1",
      activityId: "activity-1",
      content: "Rain lifts ",
      createdAt: "2026-05-22T12:00:00.000Z",
      sequence: 1,
    });
    const second = makeSubagentOutputEvent({
      eventId: "event-2",
      activityId: "activity-2",
      content: "from wires",
      createdAt: "2026-05-22T12:00:00.016Z",
      sequence: 2,
    });

    const coalesced = coalesceOrchestrationUiEvents([first, second]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.eventId).toBe("event-2");
    expect(coalesced[0]).toMatchObject({
      payload: {
        activity: {
          createdAt: "2026-05-22T12:00:00.000Z",
          sequence: 1,
          payload: {
            data: {
              rawOutput: {
                content: "Rain lifts from wires",
              },
            },
          },
        },
      },
    });
  });
});

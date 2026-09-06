import { EnvironmentId, EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  fetchEnvironmentThreadActivities,
  fetchEnvironmentThreadActivity,
} from "./threadActivityHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const THREAD_ID = ThreadId.make("thread-1");
const ACTIVITY_ID = EventId.make("activity-1");

describe("fetchEnvironmentThreadActivity", () => {
  it.effect("requests and decodes one activity detail", () => {
    let requestedUrl = "";
    const fetchFn = ((input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Promise.resolve(
        Response.json({
          id: ACTIVITY_ID,
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            data: { rawOutput: { stdout: "tests passed" } },
          },
          turnId: null,
          createdAt: "2026-08-10T00:00:00.000Z",
        }),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const activity = yield* fetchEnvironmentThreadActivity({
        prepared: PREPARED,
        threadId: THREAD_ID,
        activityId: ACTIVITY_ID,
        signer: Option.none(),
      });

      expect(requestedUrl).toBe(
        "https://environment.example.test/api/orchestration/threads/thread-1/activities/activity-1",
      );
      expect(activity).toMatchObject({
        id: ACTIVITY_ID,
        payload: { data: { rawOutput: { stdout: "tests passed" } } },
      });
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });

  it.effect("loads activity details concurrently and keeps partial successes", () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const activityIds = ["activity-1", "activity-2", "missing"].map((id) => EventId.make(id));
    const pendingResponses: Array<() => void> = [];
    const fetchFn = ((input: RequestInfo | URL) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const activityId = String(input).split("/").at(-1)!;
      return new Promise<Response>((resolve) => {
        pendingResponses.push(() => {
          activeRequests -= 1;
          resolve(
            activityId === "missing"
              ? Response.json({ error: "thread_activity_not_found" }, { status: 404 })
              : Response.json({
                  id: activityId,
                  tone: "tool",
                  kind: "tool.updated",
                  summary: "Ran command",
                  payload: { itemType: "command_execution", data: {} },
                  turnId: null,
                  createdAt: "2026-08-10T00:00:00.000Z",
                }),
          );
        });
        if (pendingResponses.length === activityIds.length) {
          for (const respond of pendingResponses) {
            respond();
          }
        }
      });
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const result = yield* fetchEnvironmentThreadActivities({
        prepared: PREPARED,
        threadId: THREAD_ID,
        activityIds,
        signer: Option.none(),
      });

      expect(maximumActiveRequests).toBeGreaterThan(1);
      expect(result.activities.map((activity) => activity.id)).toEqual(activityIds.slice(0, 2));
      expect(result.failedActivityIds).toEqual([EventId.make("missing")]);
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
  });
});

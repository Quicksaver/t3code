import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { codexNativeThreadContext } from "./CodexAdapter.ts";
import { verifyCodexNativeDescendant, type CodexThreadSnapshot } from "./CodexSessionRuntime.ts";

it.effect(
  "verifies siblings and nested callers using provider ancestry without projected T3 child rows",
  () =>
    Effect.gen(function* () {
      const parents: Record<string, string> = {
        a: "root",
        b: "root",
        nested: "a",
        foreign: "elsewhere",
        cycle: "cycle",
      };
      const client: Parameters<typeof verifyCodexNativeDescendant>[0] = {
        request: ((method: string, params: { threadId: string; includeTurns: boolean }) => {
          expect(method).toBe("thread/read");
          expect(params.includeTurns).toBe(false);
          return Effect.succeed({
            thread: {
              id: params.threadId,
              source: parents[params.threadId]
                ? { subAgent: { thread_spawn: { parent_thread_id: parents[params.threadId] } } }
                : "cli",
            },
          });
        }) as Parameters<typeof verifyCodexNativeDescendant>[0]["request"],
      };
      yield* Effect.forEach(
        ["a", "b", "nested"],
        (id) => verifyCodexNativeDescendant(client, "root", id),
        { concurrency: "unbounded" },
      );
      for (const id of ["foreign", "cycle", "root"])
        expect(
          (yield* verifyCodexNativeDescendant(client, "root", id).pipe(Effect.result))._tag,
        ).toBe("Failure");
    }),
);

it("keeps complete native evidence and current instruction separate across siblings, turns and instances", () => {
  const snapshot = (nativeThreadId: string): CodexThreadSnapshot => ({
    threadId: nativeThreadId,
    turns: [
      {
        id: TurnId.make("old"),
        items: [
          {
            type: "commandExecution",
            id: "old-tool",
            status: "completed",
            aggregatedOutput: "OLD",
          },
        ] as unknown as CodexThreadSnapshot["turns"][number]["items"],
      },
      {
        id: TurnId.make("current"),
        items: [
          {
            type: "userMessage",
            id: "user",
            content: [{ type: "text", text: `Task for ${nativeThreadId}` }],
          },
          {
            type: "commandExecution",
            id: "same-native-tool-id",
            status: "completed",
            command: "echo evidence",
            aggregatedOutput: `MARKER-${nativeThreadId}`,
          },
          {
            type: "commandExecution",
            id: "pending",
            status: "inProgress",
            aggregatedOutput: "PARTIAL",
          },
        ] as unknown as CodexThreadSnapshot["turns"][number]["items"],
      },
    ],
  });
  const root = ThreadId.make("main");
  const instance = ProviderInstanceId.make("codex");
  const a = codexNativeThreadContext(root, instance, snapshot("a"));
  const b = codexNativeThreadContext(root, instance, snapshot("b"));
  expect(a.instruction).toBe("Task for a");
  expect(a.turnId).toBe("current");
  expect(a.activities).toHaveLength(1);
  expect(a.activities[0]?.payload).toMatchObject({
    nativeThreadId: "a",
    item: { aggregatedOutput: "MARKER-a" },
  });
  expect(a.activities[0]?.id).not.toBe(b.activities[0]?.id);
  expect(a.activities[0]?.id).not.toBe(
    codexNativeThreadContext(root, ProviderInstanceId.make("another"), snapshot("a")).activities[0]
      ?.id,
  );
});

it("lists complete statusless native web searches but excludes unfinished searches", () => {
  const result = codexNativeThreadContext(ThreadId.make("root"), ProviderInstanceId.make("codex"), {
    threadId: "native",
    turns: [
      {
        id: TurnId.make("turn"),
        items: [
          { type: "webSearch", id: "pending", query: "" },
          { type: "webSearch", id: "null-results", query: "", action: null, results: null },
          {
            type: "webSearch",
            id: "finished",
            query: "search",
            results: [{ url: "https://example.com", text: "EVIDENCE" }],
          },
          { type: "webSearch", id: "no-hits", query: "empty", results: [] },
          {
            type: "webSearch",
            id: "model-search",
            query: "model evidence",
            action: { type: "search", query: "model evidence" },
          },
        ],
      },
    ],
  });
  expect(result.activities).toHaveLength(3);
  expect(result.activities.map((activity) => activity.payload)).toEqual([
    {
      nativeThreadId: "native",
      item: {
        type: "webSearch",
        id: "finished",
        query: "search",
        results: [{ url: "https://example.com", text: "EVIDENCE" }],
      },
    },
    {
      nativeThreadId: "native",
      item: { type: "webSearch", id: "no-hits", query: "empty", results: [] },
    },
    {
      nativeThreadId: "native",
      item: {
        type: "webSearch",
        id: "model-search",
        query: "model evidence",
        action: { type: "search", query: "model evidence" },
      },
    },
  ]);
});

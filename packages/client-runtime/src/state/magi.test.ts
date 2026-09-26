import { expect, it } from "@effect/vitest";
import { EnvironmentId, MagiRunId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../environment/index.ts";
import { activeMagiThreadKeys } from "./magi.ts";

const environmentId = EnvironmentId.make("local");
const key = (id: string, environment = environmentId) =>
  scopedThreadKey({ environmentId: environment, threadId: ThreadId.make(id) });
const thread = (id: string, parent?: string, active = false) => ({
  id: ThreadId.make(id),
  environmentId,
  parentRelation: parent ? { kind: "subagent", parentThreadId: parent } : undefined,
  activeMagiRun: active
    ? {
        runId: MagiRunId.make(id),
        source: "agent-tool" as const,
        state: "deliberating" as const,
        completedMagiTurns: 0,
      }
    : null,
});

it("marks native ancestors across sibling and nested runs without changing ownership", () => {
  const root = thread("root");
  const threads = [
    root,
    thread("child", "root"),
    thread("nested", "child", true),
    thread("sibling", "root", true),
    thread("other"),
  ];
  expect(activeMagiThreadKeys(threads)).toEqual(
    new Set([key("nested"), key("child"), key("root"), key("sibling")]),
  );
  expect(root.activeMagiRun).toBeNull();
  expect(activeMagiThreadKeys(threads.map((value) => ({ ...value, activeMagiRun: null })))).toEqual(
    new Set(),
  );
});

it("keeps environments separate and stops at Magi participant boundaries", () => {
  const remote = EnvironmentId.make("remote");
  const threads = [
    thread("root"),
    { ...thread("child", "root", true), environmentId: remote },
    {
      ...thread("participant", "root", true),
      parentRelation: { kind: "magi", parentThreadId: "root" },
    },
  ];
  expect(activeMagiThreadKeys(threads)).toEqual(
    new Set([key("child", remote), key("root", remote), key("participant")]),
  );
});

it("terminates malformed cycles and ignores unknown lineage", () => {
  expect(
    activeMagiThreadKeys([
      thread("a", "b", true),
      thread("b", "a"),
      { ...thread("legacy", undefined, true), parentRelation: null },
    ]),
  ).toEqual(new Set([key("a"), key("b"), key("legacy")]));
});

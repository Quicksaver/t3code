import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { magiHistoryOwners } from "./MagiHistory.ts";

it("includes siblings and nested native children without traversing Magi participants or foreign roots", () => {
  const child = (id: string, parentThreadId: string, kind = "subagent") => ({
    id,
    parentRelation: { kind, parentThreadId },
  });
  const threads = [
    child("nested", "alpha"),
    child("alpha", "root"),
    child("beta", "root"),
    child("participant", "root", "magi"),
    child("participant-child", "participant"),
    child("foreign", "another-root"),
    child("cycle-a", "cycle-b"),
    child("cycle-b", "cycle-a"),
    { id: "legacy", parentRelation: null },
  ];
  expect(magiHistoryOwners(ThreadId.make("root"), threads)).toEqual([
    "root",
    "alpha",
    "beta",
    "nested",
  ]);
  expect(magiHistoryOwners(ThreadId.make("alpha"), threads)).toEqual(["alpha", "nested"]);
  expect(magiHistoryOwners(ThreadId.make("cycle-a"), threads)).toEqual(["cycle-a", "cycle-b"]);
});

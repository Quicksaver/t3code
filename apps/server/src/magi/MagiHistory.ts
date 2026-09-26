import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeChild = Schema.decodeUnknownOption(
  Schema.Struct({
    id: ThreadId,
    parentRelation: Schema.Struct({
      kind: Schema.Literal("subagent"),
      parentThreadId: ThreadId,
    }),
  }),
);

/** Include native descendants in the parent's history without changing run ownership. */
export function magiHistoryOwners(rootThreadId: ThreadId, threads: ReadonlyArray<unknown>) {
  const children = new Map<ThreadId, Array<ThreadId>>();
  for (const thread of threads) {
    const child = decodeChild(thread);
    if (Option.isNone(child)) continue;
    const parent = child.value.parentRelation.parentThreadId;
    const siblings = children.get(parent) ?? [];
    siblings.push(child.value.id);
    children.set(parent, siblings);
  }
  const owners = new Set([rootThreadId]);
  for (const owner of owners) {
    for (const child of children.get(owner) ?? []) owners.add(child);
  }
  return [...owners];
}

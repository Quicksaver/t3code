import type { ThreadShell } from "./types";

export function filterStandaloneSubagentConversations<
  T extends Pick<ThreadShell, "parentRelation">,
>(threads: ReadonlyArray<T>, enabled: boolean): ReadonlyArray<T> {
  return enabled ? threads : threads.filter((thread) => thread.parentRelation?.kind !== "subagent");
}

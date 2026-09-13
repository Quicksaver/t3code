import { ProviderItemId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterStandaloneSubagentConversations } from "./subagentControls";

describe("filterStandaloneSubagentConversations", () => {
  const root = { id: "root", parentRelation: undefined };
  const child = {
    id: "child",
    parentRelation: {
      kind: "subagent" as const,
      parentThreadId: ThreadId.make("thread-parent"),
      rootThreadId: ThreadId.make("thread-parent"),
      parentTurnId: null,
      parentItemId: ProviderItemId.make("item-parent"),
      parentActivitySequence: 0,
      providerThreadId: "provider-child",
      titleSeed: null,
      depth: 1,
      status: "running" as const,
      startedAt: "2026-06-19T10:00:00.000Z",
      completedAt: null,
    },
  };

  it("keeps only root conversations while the beta is disabled", () => {
    expect(filterStandaloneSubagentConversations([root, child], false)).toEqual([root]);
  });

  it("keeps child conversations after opt-in", () => {
    expect(filterStandaloneSubagentConversations([root, child], true)).toEqual([root, child]);
  });
});

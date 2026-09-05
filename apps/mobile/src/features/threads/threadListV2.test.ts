import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadShellKey } from "../../lib/threadLineage";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  canUseThreadListV2LifecycleActions,
  resolveThreadListV2Enabled,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function subagentRelation(input: {
  readonly parentThreadId: ThreadId;
  readonly rootThreadId?: ThreadId;
  readonly depth?: number;
  readonly sequence: number;
  readonly status?: "running" | "completed" | "errored" | "interrupted" | "stopped";
}) {
  const timestampSecond = String(input.sequence).padStart(2, "0");
  return {
    kind: "subagent" as const,
    rootThreadId: input.rootThreadId ?? input.parentThreadId,
    parentThreadId: input.parentThreadId,
    parentTurnId: TurnId.make("turn-parent"),
    parentItemId: ProviderItemId.make(`item-${input.sequence}`),
    parentActivitySequence: input.sequence,
    providerThreadId: `provider-child-${input.sequence}`,
    titleSeed: "Inspect child work",
    depth: input.depth ?? 1,
    startedAt: `2026-06-01T00:00:${timestampSecond}.000Z`,
    completedAt: input.status && input.status !== "running" ? NOW : null,
    status: input.status ?? "running",
  };
}

const NOW = "2026-06-02T00:00:00.000Z";

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2Enabled", () => {
  it("defaults on when the device has never chosen", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: true }),
    ).toBe(true);
  });

  it("honors an explicit legacy opt-in", () => {
    expect(resolveThreadListV2Enabled({ legacyPreference: true, preferencesLoaded: true })).toBe(
      false,
    );
    expect(resolveThreadListV2Enabled({ legacyPreference: false, preferencesLoaded: true })).toBe(
      true,
    );
  });

  it("holds the default while preferences are still loading so the list does not remount", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: false }),
    ).toBe(true);
  });
});

describe("resolveThreadListV2Status", () => {
  it("prioritizes approval over a running session", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make("t"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("canUseThreadListV2LifecycleActions", () => {
  it("allows lifecycle actions only for root rows", () => {
    const root = makeThread({ id: ThreadId.make("root"), title: "Root" });
    const runningChild = makeThread({
      id: ThreadId.make("running-child"),
      title: "Running child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "running",
      }),
    });
    const terminalChild = makeThread({
      id: ThreadId.make("terminal-child"),
      title: "Terminal child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 2,
        status: "completed",
      }),
    });

    expect(canUseThreadListV2LifecycleActions(root)).toBe(true);
    expect(canUseThreadListV2LifecycleActions(runningChild)).toBe(false);
    expect(canUseThreadListV2LifecycleActions(terminalChild)).toBe(false);
  });
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers settle and snooze for an active snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze" });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("sortThreadsForListV2", () => {
  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("surfaces an un-settled thread at the top via its re-entry stamp", () => {
    const sorted = sortThreadsForListV2([
      {
        id: "old-unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T13:00:00.000Z",
      },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["old-unsettled", "newest", "middle"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("orders pinned root lineages by pin key without detaching their children", () => {
    const laterRoot = makeThread({
      id: ThreadId.make("a-later-root"),
      title: "A later root",
      pinnedAt: NOW,
      pinOrderKey: "z",
    });
    const laterChild = makeThread({
      id: ThreadId.make("later-child"),
      title: "Later child",
      parentRelation: subagentRelation({ parentThreadId: laterRoot.id, sequence: 1 }),
    });
    const earlierRoot = makeThread({
      id: ThreadId.make("z-earlier-root"),
      title: "Z earlier root",
      pinnedAt: NOW,
      pinOrderKey: "a",
    });
    const earlierChild = makeThread({
      id: ThreadId.make("earlier-child"),
      title: "Earlier child",
      parentRelation: subagentRelation({ parentThreadId: earlierRoot.id, sequence: 1 }),
    });

    const layout = buildThreadListV2Items({
      threads: [laterRoot, laterChild, earlierRoot, earlierChild],
      environmentId,
      searchQuery: "",
      expandedThreadKeys: new Set([threadShellKey(laterRoot), threadShellKey(earlierRoot)]),
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      [earlierRoot.id, 0],
      [earlierChild.id, 1],
      [laterRoot.id, 0],
      [laterChild.id, 1],
    ]);
  });

  it("uses a pinned child as its lineage representative without promoting it", () => {
    const childPinnedRoot = makeThread({
      id: ThreadId.make("z-child-pinned-root"),
      title: "Z child-pinned root",
    });
    const pinnedChild = makeThread({
      id: ThreadId.make("pinned-child"),
      title: "Pinned child",
      pinnedAt: NOW,
      pinOrderKey: "a",
      parentRelation: subagentRelation({ parentThreadId: childPinnedRoot.id, sequence: 1 }),
    });
    const pinnedRoot = makeThread({
      id: ThreadId.make("a-pinned-root"),
      title: "A pinned root",
      pinnedAt: NOW,
      pinOrderKey: "z",
    });

    const layout = buildThreadListV2Items({
      threads: [pinnedRoot, childPinnedRoot, pinnedChild],
      environmentId,
      searchQuery: "",
      expandedThreadKeys: new Set([threadShellKey(childPinnedRoot)]),
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      [childPinnedRoot.id, 0],
      [pinnedChild.id, 1],
      [pinnedRoot.id, 0],
    ]);
  });

  it("counts and discloses only running recursive subagents", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      parentRelation: subagentRelation({ parentThreadId: root.id, sequence: 1 }),
    });
    const grandchild = makeThread({
      id: ThreadId.make("grandchild"),
      title: "Grandchild",
      parentRelation: subagentRelation({
        parentThreadId: child.id,
        rootThreadId: root.id,
        depth: 2,
        sequence: 2,
        status: "completed",
      }),
    });

    const collapsed = buildThreadListV2Items({
      threads: [grandchild, child, root],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(
      collapsed.items.map((item) => [
        item.thread.id,
        item.depth,
        item.descendantCount,
        item.descendantsExpanded,
      ]),
    ).toEqual([["root", 0, 1, false]]);

    const rootExpanded = buildThreadListV2Items({
      threads: [grandchild, child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(root)]),
      searchQuery: "",
      now: NOW,
    });
    expect(
      rootExpanded.items.map((item) => [
        item.thread.id,
        item.depth,
        item.descendantCount,
        item.descendantsExpanded,
      ]),
    ).toEqual([
      ["root", 0, 1, true],
      ["child", 1, 0, false],
    ]);

    const bothLevelsExpanded = buildThreadListV2Items({
      threads: [grandchild, child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(root), threadShellKey(child)]),
      searchQuery: "",
      now: NOW,
    });
    expect(bothLevelsExpanded.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("keeps a running child lineage together in the active block", () => {
    const oldTimestamp = "2026-05-01T00:00:00.000Z";
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
      parentRelation: subagentRelation({ parentThreadId: root.id, sequence: 1 }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(
      layout.items.map((item) => [item.thread.id, item.variant, item.depth, item.descendantCount]),
    ).toEqual([["root", "card", 0, 1]]);
  });

  it("retains only the exact selected terminal child at its stored depth", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });
    const grandchild = makeThread({
      id: ThreadId.make("grandchild"),
      title: "Grandchild",
      parentRelation: subagentRelation({
        parentThreadId: child.id,
        rootThreadId: root.id,
        depth: 2,
        sequence: 2,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [grandchild, child, root],
      environmentId: null,
      activeThreadKey: threadShellKey(grandchild),
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth, item.descendantCount])).toEqual([
      ["root", 0, 0],
      ["grandchild", 2, 0],
    ]);
  });

  it("keeps a selected settled root in the settled tail", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      settledOverride: "settled",
      settledAt: NOW,
    });

    const layout = buildThreadListV2Items({
      threads: [root],
      environmentId: null,
      activeThreadKey: threadShellKey(root),
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([["root", "slim"]]);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("rebases a matching child when search filters out its parent", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Unrelated root",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Matching child",
      parentRelation: subagentRelation({ parentThreadId: root.id, sequence: 1 }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "matching",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([["child", 0]]);
  });

  it("finds a terminal child by title and rebases it when its parent does not match", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Unrelated root",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Matching terminal child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "matching terminal",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([["child", 0]]);
  });

  it("places a persisted settled thread in the settled shelf", () => {
    const thread = makeThread({
      id: ThreadId.make("linked-merged"),
      title: "Linked merged pull request",
      settledOverride: "settled",
      settledAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.items[0]?.variant).toBe("slim");
  });

  it("hides snoozed threads and counts them — visibility parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("woken"),
          title: "Woken",
          // Wake time already passed: back in the active list.
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    // Same createdAt → static sort tiebreaks by id; the point is the woken
    // thread is BACK in the card block and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("counts only search-matching snoozed threads and their next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Fix login" }),
        makeThread({
          id: ThreadId.make("matching-snoozed"),
          title: "Login later",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("unrelated-snoozed"),
          title: "Settings",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-03T10:00:00.000Z");
  });

  it("places settled pinned threads in the settled shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "pinned-settled"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([false, false]);
    expect(layout.settledCount).toBe(1);
  });

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      variant: "card",
      pinned: true,
    });
    expect(layout.settledCount).toBe(0);
  });

  it("snooze hides a pinned thread and wake restores it to the pinned block", () => {
    const snoozedInput = {
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-snoozed"),
          title: "Pinned and snoozed",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    };

    // Before the wake time: the snooze wins; the pin holds underneath.
    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    // After the wake time: the thread returns pinned, back on top.
    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          // Woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("builds snoozed rows between active and settled when the shelf is expanded", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("later"),
          title: "Wakes later",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Wakes sooner",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "sooner",
      "later",
      "settled",
    ]);
    expect(layout.items.map((item) => item.snoozed)).toEqual([false, true, true, false]);
    expect(layout.snoozedShelfHeaderIndex).toBe(1);
    expect(layout.snoozedCount).toBe(2);
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("keeps the selected thread on a collapsed shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("open"),
          title: "Open",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["open"]);
    expect(layout.items[0]?.snoozed).toBe(true);
    expect(layout.snoozedCount).toBe(2);
  });

  it("keeps a snoozed root shelved without disclosed terminal subagents", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const collapsed = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(collapsed.items).toEqual([]);
    expect(collapsed.snoozedCount).toBe(1);
    expect(collapsed.snoozedShelfHeaderIndex).toBe(0);
    expect(collapsed.nextSnoozeWakeAt).toBe("2026-06-03T09:00:00.000Z");

    const expanded = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(root)]),
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(expanded.items.map((item) => [item.thread.id, item.depth, item.snoozed])).toEqual([
      ["root", 0, true],
    ]);
    expect(expanded.items[0]?.snoozed).toBe(true);
    expect(expanded.items[0]?.descendantCount).toBe(0);
    expect(expanded.snoozedCount).toBe(1);
    expect(expanded.nextSnoozeWakeAt).toBe("2026-06-03T09:00:00.000Z");
  });

  it("keeps a snoozed root shelved while its subagent is running", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "running",
      }),
    });

    const collapsed = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(collapsed.items).toEqual([]);
    expect(collapsed.snoozedCount).toBe(1);
    expect(collapsed.snoozedShelfHeaderIndex).toBe(0);

    const shelfExpanded = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(shelfExpanded.items.map((item) => item.thread.id)).toEqual(["root"]);

    const lineageExpanded = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(root)]),
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(lineageExpanded.items.map((item) => [item.thread.id, item.depth, item.snoozed])).toEqual(
      [
        ["root", 0, true],
        ["child", 1, false],
      ],
    );
  });

  it("hides a terminal snoozed descendant subtree while keeping its root visible", () => {
    const root = makeThread({ id: ThreadId.make("root"), title: "Root" });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });
    const grandchild = makeThread({
      id: ThreadId.make("grandchild"),
      title: "Grandchild",
      parentRelation: subagentRelation({
        parentThreadId: child.id,
        rootThreadId: root.id,
        depth: 2,
        sequence: 2,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [grandchild, child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(child)]),
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(
      layout.items.map((item) => [
        item.thread.id,
        item.variant,
        item.depth,
        item.descendantCount,
        item.snoozed,
      ]),
    ).toEqual([["root", "card", 0, 0, false]]);
    expect(layout.snoozedCount).toBe(0);
    expect(layout.nextSnoozeWakeAt).toBe(null);
  });

  it("keeps a selected descendant lineage visible on a collapsed snoozed shelf", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      activeThreadKey: threadShellKey(child),
      searchQuery: "",
      now: NOW,
      selectedThreadKey: threadShellKey(child),
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("scopes snoozed lineage membership and wake metadata to matching search rows", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root only",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child only",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const childSearch = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "child only",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(childSearch.items.map((item) => [item.thread.id, item.depth])).toEqual([["child", 0]]);
    expect(childSearch.snoozedCount).toBe(0);
    expect(childSearch.nextSnoozeWakeAt).toBeNull();

    const rootSearch = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "root only",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    expect(rootSearch.items.map((item) => [item.thread.id, item.depth])).toEqual([["root", 0]]);
    expect(rootSearch.snoozedCount).toBe(1);
    expect(rootSearch.nextSnoozeWakeAt).toBe("2026-06-03T09:00:00.000Z");
  });

  it("shows every matching snoozed lineage row during search", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Matching root",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Matching child",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      searchQuery: "matching",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("does not count a terminal snoozed subagent as a visible shelf member", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      snoozedUntil: "2026-06-03T10:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      expandedThreadKeys: new Set([threadShellKey(root)]),
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => [item.thread.id, item.snoozed])).toEqual([["root", true]]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("keeps snoozed threads visible on environments without the snooze capability", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["snoozed"]);
    expect(layout.snoozedCount).toBe(0);
  });

  it("partitions settled threads into a slim shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("settled-2"),
          title: "Settled 2",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["active", "card"],
      ["settled", "slim"],
      ["settled-2", "slim"],
    ]);
    expect(layout.items.map((item) => item.isLast)).toEqual([false, false, true]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("collapses settled threads to a counted shelf header", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.settledCount).toBe(1);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("keeps the selected settled thread visible when its shelf is collapsed", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("selected"),
          title: "Selected",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:selected`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["selected"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("keeps a selected settled subagent's ancestor path on a collapsed shelf", () => {
    const root = makeThread({
      id: ThreadId.make("root"),
      title: "Root",
      settledOverride: "settled",
      settledAt: NOW,
    });
    const child = makeThread({
      id: ThreadId.make("child"),
      title: "Child",
      settledOverride: "settled",
      settledAt: NOW,
      parentRelation: subagentRelation({
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });
    const selectedThreadKey = threadShellKey(child);

    const layout = buildThreadListV2Items({
      threads: [child, root],
      environmentId: null,
      activeThreadKey: selectedThreadKey,
      searchQuery: "",
      now: NOW,
      selectedThreadKey,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
    expect(layout.hiddenSettledCount).toBe(0);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("keeps cards in creation order while settled sorts by recency", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW, // recent activity must NOT promote it
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
  });

  it("sorts settled threads by their persisted settlement timestamp", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("settled-newer"),
          title: "Settled newer",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T08:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled-older"),
          title: "Settled older",
          settledOverride: "settled",
          settledAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["settled-newer", "settled-older"]);
  });

  it("keeps settled threads in the tail and filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Fix login again",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["match", "card"],
      ["settled", "slim"],
    ]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId: ProjectId.make("project-1") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-1") },
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

describe("buildThreadListV2Items settled paging", () => {
  it("caps the settled tail at settledLimit and reports the hidden count", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active"), title: "Active" }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`settled-${index}`),
          title: `Settled ${index}`,
          settledOverride: "settled",
          settledAt: `2026-06-01T0${index}:10:00.000Z`,
          latestUserMessageAt: `2026-06-01T0${index}:00:00.000Z`,
          // A turn adopted the message (same requestedAt): without it the
          // thread reads as a queued turn start, which never settles.
          latestTurn: {
            turnId: TurnId.make(`turn-${index}`),
            state: "completed",
            requestedAt: `2026-06-01T0${index}:00:00.000Z`,
            startedAt: `2026-06-01T0${index}:00:00.000Z`,
            completedAt: `2026-06-01T0${index}:10:00.000Z`,
            assistantMessageId: null,
          },
        }),
      ),
    ];

    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      settledLimit: 2,
      now: NOW,
    });

    expect(layout.hiddenSettledCount).toBe(2);
    expect(layout.items.filter((item) => item.variant === "slim")).toHaveLength(2);
    // Most recent settled first — the hidden ones are the oldest.
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "settled-3",
      "settled-2",
    ]);
  });

  it("keeps settled lineage groups whole and counts hidden rows", () => {
    const newestRoot = makeThread({
      id: ThreadId.make("newest-root"),
      title: "Matching newest root",
      settledOverride: "settled",
      settledAt: NOW,
      latestUserMessageAt: "2026-06-01T05:00:00.000Z",
    });
    const newestChild = makeThread({
      id: ThreadId.make("newest-child"),
      title: "Matching newest child",
      settledOverride: "settled",
      settledAt: NOW,
      latestUserMessageAt: "2026-06-01T05:00:00.000Z",
      parentRelation: subagentRelation({
        parentThreadId: newestRoot.id,
        sequence: 1,
        status: "completed",
      }),
    });
    const olderRoot = makeThread({
      id: ThreadId.make("older-root"),
      title: "Matching older root",
      settledOverride: "settled",
      settledAt: NOW,
      latestUserMessageAt: "2026-06-01T03:00:00.000Z",
    });
    const olderChild = makeThread({
      id: ThreadId.make("older-child"),
      title: "Matching older child",
      settledOverride: "settled",
      settledAt: NOW,
      latestUserMessageAt: "2026-06-01T03:00:00.000Z",
      parentRelation: subagentRelation({
        parentThreadId: olderRoot.id,
        sequence: 2,
        status: "completed",
      }),
    });
    const oldestRoot = makeThread({
      id: ThreadId.make("oldest-root"),
      title: "Matching oldest root",
      settledOverride: "settled",
      settledAt: NOW,
      latestUserMessageAt: "2026-06-01T01:00:00.000Z",
    });

    const layout = buildThreadListV2Items({
      threads: [oldestRoot, olderChild, olderRoot, newestChild, newestRoot],
      environmentId: null,
      searchQuery: "matching",
      settledLimit: 1,
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["newest-root", 0],
      ["newest-child", 1],
    ]);
    expect(layout.hiddenSettledCount).toBe(3);
  });

  it("retains a selected settled lineage beyond the paging budget", () => {
    const newestRoot = makeThread({
      id: ThreadId.make("newest-root"),
      title: "Newest root",
      settledOverride: "settled",
      settledAt: "2026-06-01T05:00:00.000Z",
      latestUserMessageAt: "2026-06-01T05:00:00.000Z",
    });
    const middleRoot = makeThread({
      id: ThreadId.make("middle-root"),
      title: "Middle root",
      settledOverride: "settled",
      settledAt: "2026-06-01T03:00:00.000Z",
      latestUserMessageAt: "2026-06-01T03:00:00.000Z",
    });
    const selectedRoot = makeThread({
      id: ThreadId.make("selected-root"),
      title: "Selected root",
      settledOverride: "settled",
      settledAt: "2026-06-01T01:00:00.000Z",
      latestUserMessageAt: "2026-06-01T01:00:00.000Z",
    });
    const selectedChild = makeThread({
      id: ThreadId.make("selected-child"),
      title: "Selected child",
      settledOverride: "settled",
      settledAt: "2026-06-01T01:00:00.000Z",
      latestUserMessageAt: "2026-06-01T01:00:00.000Z",
      parentRelation: subagentRelation({
        parentThreadId: selectedRoot.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const layout = buildThreadListV2Items({
      threads: [selectedChild, selectedRoot, middleRoot, newestRoot],
      environmentId: null,
      activeThreadKey: threadShellKey(selectedChild),
      searchQuery: "",
      settledLimit: 1,
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.depth])).toEqual([
      ["newest-root", 0],
      ["selected-root", 0],
      ["selected-child", 1],
    ]);
    expect(layout.hiddenSettledCount).toBe(1);
  });
});

function makePendingTask(id: string): PendingNewTask {
  return {
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: null,
        worktreePath: null,
      },
    },
    creation: {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "worktree",
      branch: null,
      worktreePath: null,
    },
    title: id,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("settled"),
        title: "settled",
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });

  it("splices queued tasks between the active block and the settled tail", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type === "v2-snoozed-shelf"
              ? "snoozed-shelf"
              : "settled-shelf",
      ),
    ).toEqual(["active", "queued-1", "queued-2", "settled-shelf", "settled"]);
    // Only the leading queued row labels the section, exactly like Settled.
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("ends the list with queued tasks when nothing has settled yet", () => {
    const activeOnly = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: activeOnly.items,
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
  });

  it("keeps the settled shelf between active and settled rows when nothing is queued", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      snoozedCount: snoozedLayout.snoozedCount,
      snoozedShelfExpanded: false,
      snoozedShelfHeaderIndex: snoozedLayout.snoozedShelfHeaderIndex,
      settledCount: snoozedLayout.settledCount,
      settledShelfHeaderIndex: snoozedLayout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.type)).toEqual([
      "v2-thread",
      "v2-pending",
      "v2-snoozed-shelf",
      "v2-settled-shelf",
      "v2-thread",
    ]);
  });
});

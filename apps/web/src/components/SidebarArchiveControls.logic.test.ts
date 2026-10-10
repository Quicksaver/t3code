import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canArchiveSettledSidebarThread,
  filterArchivableSidebarThreads,
} from "./SidebarArchiveControls.logic";
import { archiveEligibleThreadEntries } from "./threadArchive.logic";

describe("Archive all live re-check", () => {
  const now = "2026-10-03T12:00:00.000Z";
  const runningRuntime = {
    status: "running",
    activeRunId: RunId.make("run-started"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: now,
  } as const;
  const settledIdle = {
    settledOverride: "settled",
    runtime: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as const;

  it("skips threads whose live shell left the settled partition after confirmation", async () => {
    // Confirmed while all were settled and idle. The rendered settled set is
    // stale (the sidebar has not re-rendered or has unmounted), but by mutation
    // time one thread started a run, one was un-settled, one was snoozed, and
    // one was archived elsewhere. The batch continues for the rest.
    const renderedSettledThreadKeys = new Set(["started", "unsettled", "snoozed", "gone", "idle"]);
    const liveShells = {
      started: { ...settledIdle, runtime: runningRuntime },
      unsettled: { ...settledIdle, settledOverride: "active" },
      snoozed: { ...settledIdle, snoozedUntil: "2026-10-04T12:00:00.000Z" },
      gone: null,
      idle: settledIdle,
    } as const;
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return { _tag: "Success" } as const;
    });

    const outcome = await archiveEligibleThreadEntries({
      entries: (Object.keys(liveShells) as (keyof typeof liveShells)[]).map((threadKey) => ({
        threadKey,
      })),
      archive,
      canArchive: ({ threadKey }) =>
        canArchiveSettledSidebarThread({
          threadKey,
          settledThreadKeys: renderedSettledThreadKeys,
          shell: liveShells[threadKey],
          now,
        }),
    });

    expect(archive).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      archivedThreadKeys: ["idle"],
      skippedThreadKeys: ["started", "unsettled", "snoozed", "gone"],
      mutationFailure: null,
    });
  });

  it("keeps the rendered project scope even when the live shell is settled", () => {
    expect(
      canArchiveSettledSidebarThread({
        threadKey: "other-project",
        settledThreadKeys: new Set(["idle"]),
        shell: settledIdle,
        now,
      }),
    ).toBe(false);
  });

  it("counts only writable idle threads across a mixed-permission settled shelf", () => {
    const threads = [
      { id: "read-only", environmentId: "viewer", runtime: null },
      { id: "running", environmentId: "editor", runtime: runningRuntime },
      { id: "idle", environmentId: "editor", runtime: null },
    ];
    expect(
      filterArchivableSidebarThreads(threads, (thread) => thread.environmentId === "editor"),
    ).toEqual([threads[2]]);
    expect(filterArchivableSidebarThreads(threads, () => false)).toEqual([]);
  });
});

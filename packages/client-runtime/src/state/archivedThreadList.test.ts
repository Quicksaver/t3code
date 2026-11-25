import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "../environment/index.js";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadActionKey,
  archivedThreadSearchScore,
  getArchivedSideChatsByParent,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  tryAcquireArchivedThreadActionLock,
} from "./archivedThreadList.js";
import { v2ThreadShell, v2Project } from "./orchestrationV2TestFixtures.ts";
const environmentId = EnvironmentId.make("environment-1");

function scoreArchivedTitle(title: string, query: string): number | null {
  const search = parseArchivedThreadSearchInput(query);
  return archivedThreadSearchScore({
    normalizedTitle: normalizeSearchQuery(title),
    normalizedQuery: search.normalizedQuery,
    tokens: search.tokens,
  });
}

describe("archivedThreadSearchScore", () => {
  it("ranks phrase matches ahead of all-token and partial-token matches", () => {
    const phraseMatch = scoreArchivedTitle("Alpha Beta cleanup", "alpha beta");
    const allTokenMatch = scoreArchivedTitle("Alpha cleanup Beta", "alpha beta");
    const partialTokenMatch = scoreArchivedTitle("Alpha cleanup", "alpha beta");

    expect(phraseMatch).not.toBeNull();
    expect(allTokenMatch).not.toBeNull();
    expect(partialTokenMatch).not.toBeNull();
    expect(phraseMatch!).toBeLessThan(allTokenMatch!);
    expect(allTokenMatch!).toBeLessThan(partialTokenMatch!);
  });

  it("preserves search ranking tiers for matches late in long titles", () => {
    const latePhraseMatch = scoreArchivedTitle(`${"x".repeat(600)} alpha beta`, "alpha beta");
    const earlyAllTokenMatch = scoreArchivedTitle("Alpha cleanup Beta", "alpha beta");
    const lateAllTokenMatch = scoreArchivedTitle(`Alpha ${"x".repeat(3_000)} Beta`, "alpha beta");
    const earlyPartialTokenMatch = scoreArchivedTitle("Alpha cleanup", "alpha beta");

    expect(latePhraseMatch).not.toBeNull();
    expect(earlyAllTokenMatch).not.toBeNull();
    expect(lateAllTokenMatch).not.toBeNull();
    expect(earlyPartialTokenMatch).not.toBeNull();
    expect(latePhraseMatch!).toBeLessThan(earlyAllTokenMatch!);
    expect(lateAllTokenMatch!).toBeLessThan(earlyPartialTokenMatch!);
  });

  it("ranks partial matches by matched-token count before token position", () => {
    const fewerTokens = scoreArchivedTitle("Alpha only", "alpha beta gamma");
    const moreTokens = scoreArchivedTitle(`${"x".repeat(1_200)} Alpha Beta`, "alpha beta gamma");

    expect(fewerTokens).not.toBeNull();
    expect(moreTokens).not.toBeNull();
    expect(moreTokens!).toBeLessThan(fewerTokens!);
  });

  it("ranks equal-count partial matches by their earliest matched token", () => {
    const query = "alpha beta gamma";
    const earlyFirstToken = scoreArchivedTitle(`alpha ${"x".repeat(100)} beta`, query);
    const lateFirstToken = scoreArchivedTitle("x alpha beta", query);

    expect(earlyFirstToken).not.toBeNull();
    expect(lateFirstToken).not.toBeNull();
    expect(earlyFirstToken!).toBeLessThan(lateFirstToken!);
  });

  it("ranks distinct matches above repeated occurrences of one query term", () => {
    const query = "alpha alpha alpha beta gamma";
    const oneTerm = scoreArchivedTitle("Alpha", query);
    const twoTerms = scoreArchivedTitle("Beta Gamma", query);

    expect(oneTerm).not.toBeNull();
    expect(twoTerms).not.toBeNull();
    expect(twoTerms!).toBeLessThan(oneTerm!);
  });

  it("matches titles case-insensitively and rejects unrelated titles", () => {
    expect(scoreArchivedTitle("Release Candidate Notes", "candidate")).not.toBeNull();
    expect(scoreArchivedTitle("Release Candidate Notes", "missing")).toBeNull();
  });

  it("requires each matched term to appear in the title", () => {
    expect(scoreArchivedTitle("Refine API exports", "fix")).toBeNull();
    expect(scoreArchivedTitle("Checkout API tests", "cat")).toBeNull();
  });
});

describe("nextArchivedThreadSortState", () => {
  it("toggles the active sort field and defaults new fields to descending", () => {
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "desc" }, "archivedAt"),
    ).toEqual({ field: "archivedAt", direction: "asc" });
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "asc" }, "createdAt"),
    ).toEqual({ field: "createdAt", direction: "desc" });
  });
});

describe("archived thread action locks", () => {
  const firstThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
  const secondThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

  it("blocks overlapping row and bulk actions until the original lock is released", () => {
    const inFlightThreadKeys = new Set<string>();
    const bulkLock = tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [
      firstThreadRef,
      secondThreadRef,
    ]);

    expect(bulkLock).not.toBeNull();
    expect(tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [firstThreadRef])).toBeNull();

    releaseArchivedThreadActionLock(inFlightThreadKeys, bulkLock!);

    expect(tryAcquireArchivedThreadActionLock(inFlightThreadKeys, [firstThreadRef])).not.toBeNull();
  });

  it("uses collision-safe environment and thread identity", () => {
    const firstKey = archivedThreadActionKey(
      scopeThreadRef(EnvironmentId.make("environment:a"), ThreadId.make("thread")),
    );
    const secondKey = archivedThreadActionKey(
      scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("a:thread")),
    );

    expect(firstKey).not.toBe(secondKey);
  });

  it("locks direct side chats affected by the selected parent's archive action", () => {
    const parentArchivedAt = DateTime.makeUnsafe("2026-11-20T10:00:00Z");
    const eligibleId = ThreadId.make("eligible");
    const earlierId = ThreadId.make("earlier");
    const secondParentId = ThreadId.make("second-parent");
    const secondChildId = ThreadId.make("second-child");
    const sideChatLineage = {
      ...v2ThreadShell.lineage,
      parentThreadId: firstThreadRef.threadId,
      sideChat: true,
    };
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotSequence: 1,
      projects: [v2Project],
      threads: [
        { ...v2ThreadShell, id: firstThreadRef.threadId, archivedAt: parentArchivedAt },
        {
          ...v2ThreadShell,
          id: eligibleId,
          lineage: sideChatLineage,
          archivedAt: parentArchivedAt,
        },
        {
          ...v2ThreadShell,
          id: earlierId,
          lineage: sideChatLineage,
          archivedAt: DateTime.makeUnsafe("2026-11-19T10:00:00Z"),
        },
        {
          ...v2ThreadShell,
          id: ThreadId.make("fork"),
          lineage: { ...sideChatLineage, sideChat: false },
          archivedAt: parentArchivedAt,
        },
        { ...v2ThreadShell, id: secondParentId, archivedAt: parentArchivedAt },
        {
          ...v2ThreadShell,
          id: secondChildId,
          lineage: { ...sideChatLineage, parentThreadId: secondParentId },
          archivedAt: parentArchivedAt,
        },
      ],
    };
    const snapshots = [
      { environmentId, snapshot },
      { environmentId: EnvironmentId.make("another-environment"), snapshot },
    ];
    const eligibleRef = scopeThreadRef(environmentId, eligibleId);
    const earlierRef = scopeThreadRef(environmentId, earlierId);
    const firstParentKey = archivedThreadActionKey(firstThreadRef);
    const secondParent = scopeThreadRef(environmentId, secondParentId);
    const selected = [firstThreadRef, secondParent];
    const restoreTargets = getArchivedSideChatsByParent(snapshots, selected, "unarchive");
    const deleteTargets = getArchivedSideChatsByParent(snapshots, selected, "delete");

    expect(restoreTargets.get(firstParentKey)).toEqual([eligibleRef]);
    expect(deleteTargets.get(firstParentKey)).toEqual([eligibleRef, earlierRef]);
    expect(deleteTargets.get(archivedThreadActionKey(secondParent))).toEqual([
      scopeThreadRef(environmentId, secondChildId),
    ]);
    expect(deleteTargets.size).toBe(2);
    const reserved = new Set<string>();
    const lock = tryAcquireArchivedThreadActionLock(reserved, [
      firstThreadRef,
      ...restoreTargets.get(firstParentKey)!,
    ])!;
    expect(tryAcquireArchivedThreadActionLock(reserved, [eligibleRef])).toBeNull();
    releaseArchivedThreadActionLock(reserved, lock);
    expect(tryAcquireArchivedThreadActionLock(reserved, [eligibleRef])).not.toBeNull();
  });
});

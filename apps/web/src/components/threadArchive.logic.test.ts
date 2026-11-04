import { describe, expect, it, vi } from "vite-plus/test";

import {
  archiveEligibleThreadEntries,
  getArchiveOutcomeNotices,
  getCompletedArchiveThreadKeys,
  withCoordinatedThreadArchiveEntries,
} from "./threadArchive.logic";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("getArchiveOutcomeNotices", () => {
  const isInterrupted = (failure: string) => failure === "interrupted";
  const outcome = (
    overrides: Partial<Parameters<typeof getArchiveOutcomeNotices<string>>[0]["outcome"]>,
  ) => ({
    archivedThreadKeys: [],
    skippedThreadKeys: [],
    mutationFailure: null,
    followupFailures: [],
    ...overrides,
  });

  it("reports navigation failures without implying the archive was rolled back", () => {
    expect(
      getArchiveOutcomeNotices({
        outcome: outcome({ archivedThreadKeys: ["one"], followupFailures: ["navigation"] }),
        entryCount: 1,
        isInterrupted,
      }),
    ).toEqual([
      { type: "error", title: "Thread archived, but navigation failed", failure: "navigation" },
    ]);
  });

  it("reports a stopped batch alongside skipped entries", () => {
    expect(
      getArchiveOutcomeNotices({
        outcome: outcome({
          archivedThreadKeys: ["one"],
          skippedThreadKeys: ["two", "three"],
          mutationFailure: "server",
        }),
        entryCount: 4,
        isInterrupted,
      }),
    ).toEqual([
      { type: "error", title: "Failed to archive threads", failure: "server" },
      {
        type: "warning",
        title: "Some threads were not archived",
        description: "2 threads were no longer eligible for this archive action and were skipped.",
      },
    ]);
  });

  it("stays quiet for interruptions and clean batches", () => {
    expect(
      getArchiveOutcomeNotices({
        outcome: outcome({ mutationFailure: "interrupted", followupFailures: ["interrupted"] }),
        entryCount: 1,
        isInterrupted,
      }),
    ).toEqual([]);
    expect(
      getArchiveOutcomeNotices({
        outcome: outcome({ archivedThreadKeys: ["one"] }),
        entryCount: 1,
        isInterrupted,
      }),
    ).toEqual([]);
  });
});

describe("archiveEligibleThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveEligibleThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("reports a success that never marked the archive", async () => {
    const onArchived = vi.fn();
    const outcome = await archiveEligibleThreadEntries({
      entries: [entries[0]],
      archive: async () => success,
      onArchived,
    });

    expect(onArchived).toHaveBeenCalledExactlyOnceWith(entries[0]);
    expect(outcome.archivedThreadKeys).toEqual(["one"]);
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveEligibleThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      skippedThreadKeys: [],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveEligibleThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });

  it("reports completed entries before a later archive throws", async () => {
    const onArchived = vi.fn();

    await expect(
      archiveEligibleThreadEntries({
        entries,
        archive: async (entry, markArchived) => {
          if (entry.threadKey === "two") throw new Error("archive failed");
          markArchived();
          return success;
        },
        onArchived,
      }),
    ).rejects.toThrow("archive failed");

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(onArchived).toHaveBeenCalledWith(entries[0]);
  });

  it("continues when an entry becomes ineligible during the batch", async () => {
    const blockedThreadKeys = new Set<string>();
    const archive = vi.fn(async (entry, markArchived: () => void) => {
      markArchived();
      if (entry.threadKey === "one") blockedThreadKeys.add("two");
      return success;
    });
    const outcome = await archiveEligibleThreadEntries({
      entries,
      archive,
      canArchive: (entry) => !blockedThreadKeys.has(entry.threadKey),
    });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenNthCalledWith(1, entries[0], expect.any(Function));
    expect(archive).toHaveBeenNthCalledWith(2, entries[2], expect.any(Function));
    expect(outcome.archivedThreadKeys).toEqual(["one", "three"]);
    expect(outcome.skippedThreadKeys).toEqual(["two"]);
  });

  it("reports when every entry becomes ineligible before mutation", async () => {
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return success;
    });
    const outcome = await archiveEligibleThreadEntries({
      entries,
      archive,
      canArchive: () => false,
    });

    expect(archive).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      archivedThreadKeys: [],
      skippedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });
});

describe("withCoordinatedThreadArchiveEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }] as const;

  it("coordinates separate callers through the shared reservation pool", async () => {
    const sharedEntry = { threadKey: "shared-one" } as const;
    let finishFirstFlow: (() => void) | undefined;
    const firstRun = vi.fn(
      async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve([sharedEntry.threadKey]);
        }),
    );
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [sharedEntry],
      run: firstRun,
    });
    expect(firstRun).toHaveBeenCalledOnce();

    const secondRun = vi.fn(async () => [sharedEntry.threadKey]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries: [sharedEntry],
      run: secondRun,
    });
    expect(secondRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(Promise.all([firstFlow, secondFlow])).resolves.toEqual([
      [sharedEntry.threadKey],
      [],
    ]);
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("waits for owners and omits entries they successfully archived", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });

    expect(reservations.has("one")).toBe(true);
    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    expect(secondRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("retries entries when their owner cancels without archiving", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let cancelFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          cancelFirstFlow = () => resolve([]);
        }),
    });
    expect(reservations.has("one")).toBe(true);
    const secondRun = vi.fn(async () => ["one", "two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });

    cancelFirstFlow?.();
    await expect(firstFlow).resolves.toEqual([]);
    await expect(secondFlow).resolves.toEqual(["one", "two"]);
    expect(secondRun).toHaveBeenCalledWith(entries, expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("releases reservations when the archive flow fails", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();

    await expect(
      withCoordinatedThreadArchiveEntries({
        entries,
        reservations,
        run: async () => {
          throw new Error("archive failed");
        },
      }),
    ).rejects.toThrow("archive failed");
    expect(reservations.size).toBe(0);
  });

  it("reserves uncontested siblings while waiting for an owner", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });
    expect(reservations.has("one")).toBe(true);

    let finishSecondFlow: (() => void) | undefined;
    let markSecondStarted: () => void = () => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondRun = vi.fn(
      async () =>
        new Promise<readonly string[]>((resolve) => {
          finishSecondFlow = () => resolve(["two"]);
          markSecondStarted();
        }),
    );
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    expect(reservations.has("two")).toBe(true);

    const thirdRun = vi.fn(async () => ["two"]);
    const thirdFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[1]],
      reservations,
      run: thirdRun,
    });
    expect(thirdRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await secondStarted;
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(thirdRun).not.toHaveBeenCalled();

    finishSecondFlow?.();
    await expect(secondFlow).resolves.toEqual(["two"]);
    await expect(thirdFlow).resolves.toEqual([]);
    expect(thirdRun).not.toHaveBeenCalled();
    expect(reservations.size).toBe(0);
  });

  it("publishes completed archives when a flow later throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    const archiveOne = deferred();
    const failFirstFlow = deferred();
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (_ownedEntries, onCompleted) => {
        await archiveOne.promise;
        onCompleted("one");
        await failFirstFlow.promise;
        return [];
      },
    });
    expect(reservations.size).toBe(2);

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    archiveOne.resolve();
    failFirstFlow.reject(new Error("archive failed"));

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("publishes intentional skips when a later archive throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    const startFirstFlow = deferred();
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (ownedEntries, onCompleted) => {
        await startFirstFlow.promise;
        const outcome = await archiveEligibleThreadEntries({
          entries: ownedEntries,
          canArchive: (entry) => entry.threadKey !== "one",
          archive: async () => {
            throw new Error("archive failed");
          },
          onArchived: (entry) => onCompleted(entry.threadKey),
          onSkipped: (entry) => onCompleted(entry.threadKey),
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    expect(reservations.size).toBe(2);

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    startFirstFlow.resolve();

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("queues overlapping flows in start order so they cannot wait on each other", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    const [x, y, z] = [{ threadKey: "x" }, { threadKey: "y" }, { threadKey: "z" }] as const;
    const cancelA = deferred();
    const finishB = deferred();
    const flowA = withCoordinatedThreadArchiveEntries({
      entries: [x],
      reservations,
      run: async () => {
        await cancelA.promise;
        return [];
      },
    });
    const flowB = withCoordinatedThreadArchiveEntries({
      entries: [z],
      reservations,
      run: async () => {
        await finishB.promise;
        return ["z"];
      },
    });
    const runC = vi.fn(async () => ["x"]);
    const flowC = withCoordinatedThreadArchiveEntries({
      entries: [x, y, z],
      reservations,
      run: runC,
    });
    // A releases x before C runs; D must still queue behind C rather than
    // take x and leave C waiting on it.
    cancelA.resolve();
    await expect(flowA).resolves.toEqual([]);
    const runD = vi.fn(async () => ["y"]);
    const flowD = withCoordinatedThreadArchiveEntries({
      entries: [x, y],
      reservations,
      run: runD,
    });
    finishB.resolve();

    await expect(Promise.all([flowB, flowC, flowD])).resolves.toEqual([["z"], ["x"], ["y"]]);
    expect(runC).toHaveBeenCalledWith([x, y], expect.any(Function));
    expect(runD).toHaveBeenCalledWith([y], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("releases a completed thread so a fresh request runs instead of being omitted", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    const finishFirstFlow = deferred();
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (_ownedEntries, onCompleted) => {
        onCompleted("one");
        await finishFirstFlow.promise;
        onCompleted("two");
        return ["one", "two"];
      },
    });

    // Undo restored "one" while "two" is still archiving.
    const freshRun = vi.fn(async () => ["one"]);
    const freshFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: freshRun,
    });
    expect(freshRun).toHaveBeenCalledWith([entries[0]], expect.any(Function));
    await expect(freshFlow).resolves.toEqual(["one"]);

    // A later request waits only for the thread still held, and the first
    // flow's completion of "one" does not cover this newer request for it.
    const laterRun = vi.fn(async () => ["one"]);
    const laterFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: laterRun,
    });
    expect(laterRun).not.toHaveBeenCalled();
    finishFirstFlow.resolve();

    await expect(firstFlow).resolves.toEqual(["one", "two"]);
    await expect(laterFlow).resolves.toEqual(["one"]);
    expect(laterRun).toHaveBeenCalledWith([entries[0]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("detaches a completed thread's queue so a fresh request after Undo still runs", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    const archiveOne = deferred();
    const oneArchived = deferred();
    const finishA = deferred();
    const finishC = deferred();
    const flowA = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (_ownedEntries, onCompleted) => {
        await archiveOne.promise;
        onCompleted("one");
        oneArchived.resolve();
        await finishA.promise;
        onCompleted("two");
        return ["one", "two"];
      },
    });
    // B queued for "one" before A archived it, so it still omits "one".
    const runB = vi.fn(async () => ["one"]);
    const flowB = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: runB,
    });
    archiveOne.resolve();
    await oneArchived.promise;

    // Undo restored "one" and the user archives it again while A still runs.
    const runC = vi.fn(async () => {
      await finishC.promise;
      return ["one"];
    });
    const flowC = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: runC,
    });
    expect(runC).toHaveBeenCalledWith([entries[0]], expect.any(Function));

    finishA.resolve();
    await expect(flowA).resolves.toEqual(["one", "two"]);
    await expect(flowB).resolves.toEqual([]);
    expect(runB).not.toHaveBeenCalled();
    // A's and B's later completions of "one" leave C's newer queue in place.
    expect(reservations.has("one")).toBe(true);

    finishC.resolve();
    await expect(flowC).resolves.toEqual(["one"]);
    expect(reservations.size).toBe(0);
  });

  it("does not retry entries an owner intentionally skipped", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishEligibilityCheck: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async (ownedEntries) => {
        await new Promise<void>((resolve) => {
          finishEligibilityCheck = resolve;
        });
        const outcome = await archiveEligibleThreadEntries({
          entries: ownedEntries,
          archive: vi.fn(async () => ({ _tag: "Success" }) as const),
          canArchive: () => false,
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    expect(reservations.has("one")).toBe(true);

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    finishEligibilityCheck?.();

    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });
});

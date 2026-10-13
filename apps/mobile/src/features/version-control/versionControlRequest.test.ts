import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { VcsPanelWorkingTreeFileEnrichmentResult } from "@t3tools/contracts";

import { mergeWorkingTreeEnrichment, retainWorkingTreeEnrichments } from "./versionControlModel";
import {
  createSnapshotRequestScope,
  createWorkingTreeEnrichmentQueue,
  mergeVersionControlRefreshOptions,
  requestVersionControlRefresh,
  retryInterruptedVersionControlRequest,
  runAutomaticRemoteFetch,
  VersionControlCommandInterrupted,
  type VersionControlRefreshOptions,
  type VersionControlRefreshQueue,
  type WorkingTreeEnrichmentBatch,
} from "./versionControlRequest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("native Version Control requests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a failed automatic fetch so a later interval can retry it", async () => {
    const inFlightCwds = new Set<string>();
    const fetch = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error("offline"));
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(inFlightCwds.has("/repo")).toBe(false);

    fetch.mockResolvedValueOnce(true);
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(true);
    expect(inFlightCwds.has("/repo")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight automatic fetches and skips cached-fetch reconciliation", async () => {
    const inFlightCwds = new Set<string>();
    let resolveFetch: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFetch = () => resolve(true);
        }),
    );
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue();

    const first = runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh });
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    resolveFetch?.();
    await expect(first).resolves.toBe(true);

    fetch.mockResolvedValueOnce(false);
    await expect(
      runAutomaticRemoteFetch({ cwd: "/repo", inFlightCwds, fetch, refresh }),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("promotes queued working-tree work to a full refresh", () => {
    expect(
      mergeVersionControlRefreshOptions(
        { pull: true, refresh: "working-tree" },
        { refresh: "full" },
      ),
    ).toEqual({ pull: true, refresh: "full" });
    expect(mergeVersionControlRefreshOptions(null, { refresh: "working-tree" })).toEqual({
      refresh: "working-tree",
    });
  });

  it("keeps a queued mutation follow-up authoritative and full", () => {
    expect(
      mergeVersionControlRefreshOptions({ refresh: "working-tree" }, { authoritative: true }),
    ).toEqual({ authoritative: true, refresh: "full" });
    expect(
      mergeVersionControlRefreshOptions({ authoritative: true }, { refresh: "working-tree" }),
    ).toEqual({ authoritative: true, refresh: "full" });
  });

  it("retries an interrupted request", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VersionControlCommandInterrupted())
      .mockResolvedValueOnce("loaded");

    await expect(retryInterruptedVersionControlRequest(request)).resolves.toBe("loaded");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures", async () => {
    const error = new Error("failed");
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(retryInterruptedVersionControlRequest(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated interruption retries", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new VersionControlCommandInterrupted());

    await expect(retryInterruptedVersionControlRequest(request)).rejects.toBeInstanceOf(
      VersionControlCommandInterrupted,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("drains refreshes joined while a run is active with merged options", async () => {
    const slot: { current: VersionControlRefreshQueue | null } = { current: null };
    let finishFirst!: () => void;
    const perform = vi
      .fn<(options: VersionControlRefreshOptions) => Promise<void>>()
      .mockReturnValueOnce(new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);

    const first = requestVersionControlRefresh(slot, "/repo", { refresh: "working-tree" }, perform);
    const joined = requestVersionControlRefresh(slot, "/repo", { pull: true }, perform);
    void requestVersionControlRefresh(slot, "/repo", { authoritative: true }, perform);
    expect(joined).toBe(first);

    finishFirst();
    await first;
    expect(perform.mock.calls.map(([options]) => options)).toEqual([
      { refresh: "working-tree" },
      { pull: true, authoritative: true, refresh: "full" },
    ]);
    expect(slot.current).toBeNull();
  });

  it("starts a new run for a request that arrives right after the queue drains", async () => {
    const slot: { current: VersionControlRefreshQueue | null } = { current: null };
    let finishFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => (finishFirst = resolve));
    const perform = vi
      .fn<(options: VersionControlRefreshOptions) => Promise<void>>()
      .mockReturnValueOnce(firstRun)
      .mockResolvedValue(undefined);

    void requestVersionControlRefresh(slot, "/repo", {}, perform);
    // Runs after the drain loop observes an empty queue but before the run's promise settles.
    const late = firstRun.then(() =>
      requestVersionControlRefresh(slot, "/repo", { authoritative: true }, perform),
    );
    finishFirst();
    await late;

    expect(perform).toHaveBeenCalledTimes(2);
    expect(perform).toHaveBeenLastCalledWith({ authoritative: true });
  });

  it("drops a snapshot read that resolves after its controller unmounts", async () => {
    vi.useFakeTimers();
    const scope = createSnapshotRequestScope();
    const enrich = vi.fn<(batch: WorkingTreeEnrichmentBatch) => Promise<string>>();
    const queue = createWorkingTreeEnrichmentQueue({ enrich, onResult: () => undefined });
    const read = deferred<readonly string[]>();

    const requestId = scope.begin();
    if (requestId === null) throw new Error("Expected a mounted scope");
    const accepted = read.promise.then((paths) => {
      if (!scope.isCurrent(requestId, "/repo", "/repo")) return false;
      queue.request([{ cwd: "/repo", paths }]);
      return true;
    });
    scope.dispose();
    read.resolve(["a.ts"]);

    await expect(accepted).resolves.toBe(false);
    await vi.runAllTimersAsync();
    expect(enrich).not.toHaveBeenCalled();
    expect(scope.begin()).toBeNull();

    // A remount (React StrictMode replays effects) accepts reads again, latest first.
    scope.activate();
    const stale = scope.begin();
    const latest = scope.begin();
    expect(stale !== null && scope.isCurrent(stale, "/repo", "/repo")).toBe(false);
    expect(latest !== null && scope.isCurrent(latest, "/repo", "/repo")).toBe(true);
    expect(latest !== null && scope.isCurrent(latest, "/repo", "/other")).toBe(false);
  });

  describe("working-tree enrichment queue", () => {
    function queueHarness() {
      const enrich = vi.fn<(batch: WorkingTreeEnrichmentBatch) => Promise<string>>();
      const results: Array<[WorkingTreeEnrichmentBatch, string]> = [];
      const queue = createWorkingTreeEnrichmentQueue({
        enrich,
        onResult: (batch, result) => results.push([batch, result]),
      });
      return { enrich, queue, results };
    }

    it("revalidates identical paths on every request and splits bounded per-cwd batches", async () => {
      vi.useFakeTimers();
      const { enrich, queue, results } = queueHarness();
      enrich.mockImplementation(async (batch) => `${batch.cwd}:${batch.paths.length}`);
      const paths = Array.from({ length: 65 }, (_, index) => `file-${index}.ts`);

      queue.request([
        { cwd: "/repo", paths },
        { cwd: "/sibling", paths: ["a.ts"] },
      ]);
      await vi.runAllTimersAsync();
      expect(results.map(([, result]) => result)).toEqual(["/repo:64", "/repo:1", "/sibling:1"]);

      queue.request([{ cwd: "/sibling", paths: ["a.ts"] }]);
      await vi.runAllTimersAsync();
      expect(enrich).toHaveBeenCalledTimes(4);
      expect(enrich).toHaveBeenLastCalledWith({ cwd: "/sibling", paths: ["a.ts"] });
    });

    it("stops a failed request and retries its paths on the next identical request", async () => {
      vi.useFakeTimers();
      const { enrich, queue, results } = queueHarness();
      enrich.mockRejectedValueOnce(new Error("offline")).mockResolvedValue("enriched");
      const request = [
        { cwd: "/repo", paths: ["a.ts"] },
        { cwd: "/sibling", paths: ["b.ts"] },
      ];

      queue.request(request);
      await vi.runAllTimersAsync();
      expect(enrich).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);

      queue.request(request);
      await vi.runAllTimersAsync();
      expect(results.map(([batch]) => batch)).toEqual(request);
    });

    it("drops superseded results and keeps the newer request queued after a stale failure", async () => {
      vi.useFakeTimers();
      const { enrich, queue, results } = queueHarness();
      const stale = deferred<string>();
      enrich.mockReturnValueOnce(stale.promise).mockResolvedValue("fresh");

      queue.request([{ cwd: "/repo", paths: ["a.ts"] }]);
      await vi.advanceTimersByTimeAsync(50);
      queue.request([{ cwd: "/repo", paths: ["a.ts", "b.ts"] }]);
      stale.reject(new Error("offline"));
      await vi.runAllTimersAsync();

      expect(enrich).toHaveBeenCalledTimes(2);
      expect(results).toEqual([[{ cwd: "/repo", paths: ["a.ts", "b.ts"] }, "fresh"]]);

      const late = deferred<string>();
      enrich.mockReturnValueOnce(late.promise);
      queue.request([{ cwd: "/repo", paths: ["a.ts"] }]);
      await vi.advanceTimersByTimeAsync(50);
      queue.request([]);
      late.resolve("late");
      await vi.runAllTimersAsync();
      expect(results).toHaveLength(1);
    });

    it("keeps progress through repeated identical requests and revalidates once afterwards", async () => {
      vi.useFakeTimers();
      const { enrich, queue, results } = queueHarness();
      const responses: Array<ReturnType<typeof deferred<string>>> = [];
      enrich.mockImplementation((batch) => {
        const response = deferred<string>();
        responses.push(response);
        return response.promise.then((value) => `${batch.cwd}:${value}`);
      });
      const paths = Array.from({ length: 65 }, (_, index) => `file-${index}.ts`);
      const request = [
        { cwd: "/repo", paths },
        { cwd: "/sibling", paths: ["a.ts"] },
      ];
      const respond = async (value: string) => {
        responses.at(-1)?.resolve(value);
        await vi.advanceTimersByTimeAsync(0);
      };

      queue.request(request);
      await vi.advanceTimersByTimeAsync(50);
      // Snapshot reads keep arriving faster than the slow first batch.
      queue.request(request);
      queue.request(request);
      await respond("first");
      expect(results.map(([, result]) => result)).toEqual(["/repo:first"]);

      queue.request(request);
      await respond("rest");
      await respond("sibling");
      expect(results.map(([, result]) => result)).toEqual([
        "/repo:first",
        "/repo:rest",
        "/sibling:sibling",
      ]);

      // The coalesced reads revalidate every path exactly once more.
      await respond("again");
      await respond("again");
      await respond("again");
      await vi.runAllTimersAsync();
      expect(enrich).toHaveBeenCalledTimes(6);
      expect(enrich.mock.calls.slice(3).map(([batch]) => batch.paths.length)).toEqual([64, 1, 1]);
    });

    it("keeps surviving results visible across an unrelated snapshot change until replaced", async () => {
      vi.useFakeTimers();
      let enrichments: ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult> = new Map();
      const response = deferred<VcsPanelWorkingTreeFileEnrichmentResult>();
      const enrich = vi
        .fn<
          (batch: WorkingTreeEnrichmentBatch) => Promise<VcsPanelWorkingTreeFileEnrichmentResult>
        >()
        .mockResolvedValueOnce({
          files: [
            {
              path: "new.ts",
              originalPath: "old.ts",
              status: "renamed",
              insertions: 1,
              deletions: 1,
            },
            {
              path: "notes.md",
              originalPath: null,
              status: "untracked",
              insertions: 4,
              deletions: 0,
            },
          ],
          hiddenPaths: ["old.ts"],
        })
        .mockReturnValueOnce(response.promise);
      const queue = createWorkingTreeEnrichmentQueue({
        enrich,
        onResult: (batch, result) => {
          enrichments = mergeWorkingTreeEnrichment(enrichments, batch, result);
        },
      });
      const request = [{ cwd: "/repo", paths: ["new.ts", "notes.md", "old.ts"] }];

      queue.request(request);
      await vi.runAllTimersAsync();
      const loaded = enrichments;

      // An unrelated tracked edit changes the raw snapshot but not the enrichment paths.
      enrichments = retainWorkingTreeEnrichments(enrichments, request);
      queue.request(request);
      await vi.advanceTimersByTimeAsync(50);
      expect(enrich).toHaveBeenCalledTimes(2);
      expect(enrichments).toBe(loaded);

      response.resolve({
        files: [
          {
            path: "new.ts",
            originalPath: "old.ts",
            status: "renamed",
            insertions: 2,
            deletions: 1,
          },
          {
            path: "notes.md",
            originalPath: null,
            status: "untracked",
            insertions: 5,
            deletions: 0,
          },
        ],
        hiddenPaths: ["old.ts"],
      });
      await vi.runAllTimersAsync();
      expect(enrichments.get("/repo")?.files.map((file) => file.insertions)).toEqual([2, 5]);
    });
  });
});

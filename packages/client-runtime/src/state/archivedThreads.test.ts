import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshots,
  makeArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";
import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const { snapshotsAtom } = createArchivedThreadSnapshots<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    getLiveShellAtom: () => Atom.make(EMPTY_SHELL_STATE),
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

it("keeps successful parent cascades unavailable until the archive snapshot catches up", () => {
  const environmentId = EnvironmentId.make("env-restoring");
  const otherEnvironmentId = EnvironmentId.make("env-unrelated");
  const parentId = ThreadId.make("parent");
  const childId = ThreadId.make("side-chat");
  const olderId = ThreadId.make("older-side-chat");
  const archivedAt = DateTime.makeUnsafe("2026-11-21T12:00:00Z");
  const sideChat = {
    ...v2ThreadShell,
    id: childId,
    archivedAt,
    lineage: { ...v2ThreadShell.lineage, parentThreadId: parentId, sideChat: true },
  };
  const earlierSideChat = {
    ...sideChat,
    id: olderId,
    archivedAt: DateTime.makeUnsafe("2026-11-20T12:00:00Z"),
  };
  const page = {
    schemaVersion: 1 as const,
    snapshotSequence: 4,
    projects: [v2Project],
    threads: [{ ...v2ThreadShell, id: parentId, archivedAt }, sideChat, earlierSideChat],
  };
  const cached = AsyncResult.success(page);
  const rawSnapshot = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, Error>>(cached),
  );
  const archive = createArchivedThreadSnapshots({
    getSnapshotAtom: rawSnapshot,
    getLiveShellAtom: () => Atom.make(EMPTY_SHELL_STATE),
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-parent-cascade",
  });
  const registry = AtomRegistry.make();
  const snapshots = archive.snapshotsAtom(
    makeArchivedThreadsEnvironmentKey([environmentId, otherEnvironmentId]),
  );
  const visibleIds = (environment: EnvironmentId) =>
    registry
      .get(snapshots)
      .snapshots.find((entry) => entry.environmentId === environment)
      ?.snapshot.threads.map(({ id }) => id);
  const sideChatRef = { environmentId, threadId: childId };
  try {
    expect(visibleIds(environmentId)).toContain(childId);
    archive.recordCascades(registry, "unarchive", [
      { environmentId, threadId: parentId, sequence: 5 },
    ]);
    registry.set(rawSnapshot(environmentId), AsyncResult.waiting(cached));
    expect(registry.get(snapshots).isLoading).toBe(true);
    expect(visibleIds(environmentId)).toEqual([olderId]);
    expect(visibleIds(otherEnvironmentId)).toContain(childId);
    expect(archive.hasPendingCascade(registry, [sideChatRef])).toBe(true);
    expect(archive.isDeleteBlocked(registry, sideChatRef, page.snapshotSequence)).toBe(true);

    registry.set(
      rawSnapshot(environmentId),
      AsyncResult.failure(Cause.fail(new Error("transient failure")), {
        previousSuccess: Option.some(cached),
      }),
    );
    expect(registry.get(snapshots).error).toBe("Failed to load archived threads.");
    expect(visibleIds(environmentId)).toEqual([olderId]);
    expect(archive.hasPendingCascade(registry, [sideChatRef])).toBe(true);

    const afterRestore = AsyncResult.success({
      ...page,
      snapshotSequence: 5,
      threads: [earlierSideChat],
    });
    registry.set(rawSnapshot(environmentId), afterRestore);
    expect(archive.hasPendingCascade(registry, [sideChatRef])).toBe(false);
    expect(archive.isDeleteBlocked(registry, sideChatRef, page.snapshotSequence)).toBe(true);
    expect(
      archive.isDeleteBlocked(
        registry,
        { ...sideChatRef, environmentId: otherEnvironmentId },
        page.snapshotSequence,
      ),
    ).toBe(false);
    registry.set(
      rawSnapshot(environmentId),
      AsyncResult.failure(Cause.fail(new Error("retry failed")), {
        previousSuccess: Option.some(afterRestore),
      }),
    );
    expect(archive.isDeleteBlocked(registry, sideChatRef, page.snapshotSequence)).toBe(true);
    registry.set(rawSnapshot(environmentId), AsyncResult.initial(true));
    expect(archive.isDeleteBlocked(registry, sideChatRef, page.snapshotSequence)).toBe(false);

    registry.set(
      rawSnapshot(environmentId),
      AsyncResult.success({ ...page, snapshotSequence: 6, threads: [sideChat, earlierSideChat] }),
    );
    expect(visibleIds(environmentId)).toEqual([childId, olderId]);
    expect(archive.hasPendingCascade(registry, [sideChatRef])).toBe(false);
    expect(archive.isDeleteBlocked(registry, sideChatRef, page.snapshotSequence)).toBe(false);
  } finally {
    registry.dispose();
  }
});

it("blocks a retained delete when the live shell alone has received the side-chat restore", () => {
  const environmentId = EnvironmentId.make("env-archive");
  const otherEnvironmentId = EnvironmentId.make("env-other");
  const sideChat = {
    ...v2ThreadShell,
    archivedAt: DateTime.makeUnsafe("2026-11-21T12:00:00Z"),
    lineage: { ...v2ThreadShell.lineage, parentThreadId: ThreadId.make("parent"), sideChat: true },
  };
  const archivedPage = {
    schemaVersion: 1 as const,
    snapshotSequence: 4,
    projects: [v2Project],
    threads: [sideChat],
  };
  const liveBefore = { ...v2ShellSnapshot, snapshotSequence: 4, threads: [] };
  const liveAfter = applyShellStreamEvent(liveBefore, {
    kind: "thread.updated",
    location: "active",
    sequence: 5,
    thread: { ...sideChat, archivedAt: null },
  });
  const archiveSnapshot = Atom.make(AsyncResult.success(archivedPage));
  const shellState = Atom.family((_id: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(EMPTY_SHELL_STATE),
  );
  const archive = createArchivedThreadSnapshots({
    getSnapshotAtom: () => archiveSnapshot,
    getLiveShellAtom: shellState,
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-live-restore",
  });
  const registry = AtomRegistry.make();
  const ref = { environmentId, threadId: sideChat.id };
  const live = { ...EMPTY_SHELL_STATE, status: "live" as const, snapshot: Option.some(liveAfter) };
  try {
    registry.set(shellState(otherEnvironmentId), live);
    registry.set(shellState(environmentId), { ...live, status: "synchronizing" });
    expect(archive.isDeleteBlocked(registry, ref, archivedPage.snapshotSequence)).toBe(false);

    registry.set(shellState(environmentId), live);
    expect(AsyncResult.getOrElse(registry.get(archiveSnapshot), () => null)).toBe(archivedPage);
    expect(archive.isDeleteBlocked(registry, ref, archivedPage.snapshotSequence)).toBe(true);

    registry.set(archiveSnapshot, AsyncResult.success({ ...archivedPage, snapshotSequence: 6 }));
    expect(archive.isDeleteBlocked(registry, ref, archivedPage.snapshotSequence)).toBe(false);
  } finally {
    registry.dispose();
  }
});

describe("archived delegated tasks follow their parent on another machine", () => {
  const parentEnvironmentId = EnvironmentId.make("env-parent");
  const taskEnvironmentId = EnvironmentId.make("env-task");
  const parentId = ThreadId.make("thread-parent");
  const page = (
    threads: OrchestrationV2ArchivedShellSnapshot["threads"],
  ): OrchestrationV2ArchivedShellSnapshot => ({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [v2Project],
    threads,
  });
  const taskPage = page([
    {
      ...v2ThreadShell,
      id: ThreadId.make("thread-task"),
      delegatedFrom: { environmentId: parentEnvironmentId, threadId: parentId, title: "p" },
    },
  ]);
  const archivedTaggedParent = page([{ ...v2ThreadShell, id: parentId, tags: ["private"] }]);

  it.each([
    { name: "archived tagged parent", parentPage: archivedTaggedParent, live: false, tasks: 0 },
    { name: "live visible parent", parentPage: page([]), live: true, tasks: 1 },
    { name: "parent page not loaded yet", parentPage: null, live: false, tasks: 0 },
    { name: "archive scoped to the task's machine", parentPage: undefined, live: false, tasks: 0 },
    {
      name: "only a third machine hides tags",
      parentPage: page([]),
      live: false,
      tasks: 0,
      parentTags: null,
    },
  ])("$name", ({ parentPage, live, tasks, parentTags = ["private"] }) => {
    const { snapshotsAtom } = createArchivedThreadSnapshots<Error>({
      getSnapshotAtom: (environmentId) =>
        Atom.make(
          environmentId === taskEnvironmentId
            ? AsyncResult.success(taskPage)
            : parentPage === null || parentPage === undefined
              ? AsyncResult.initial<OrchestrationV2ArchivedShellSnapshot, Error>(true)
              : AsyncResult.success(parentPage),
        ),
      getLiveShellAtom: () => Atom.make(EMPTY_SHELL_STATE),
      hiddenThreadTagsAtom: (environmentId) =>
        Atom.make(environmentId === parentEnvironmentId ? parentTags : null),
      hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
      liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> =>
        live ? [{ environmentId: parentEnvironmentId, threadId: parentId }] : [],
      ),
      // The parent's machine hides tags; a scoped archive learns that only from this flag.
      anyEnvironmentHidingAtom: Atom.make(true),
      labelPrefix: "test:archived-thread-snapshots",
    });
    const registry = AtomRegistry.make();
    const { snapshots } = registry.get(
      snapshotsAtom(
        makeArchivedThreadsEnvironmentKey(
          parentPage === undefined ? [taskEnvironmentId] : [parentEnvironmentId, taskEnvironmentId],
        ),
      ),
    );
    const taskSnapshot = snapshots.find((entry) => entry.environmentId === taskEnvironmentId);
    expect(taskSnapshot?.snapshot.threads.length).toBe(tasks);
    registry.dispose();
  });
});

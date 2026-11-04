import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { withCoordinatedThreadArchiveEntries } from "../components/threadArchive.logic";
import { useSidebarArchiveActions } from "./useSidebarArchiveActions";

const state = vi.hoisted(() => ({
  shells: new Map<string, EnvironmentThreadShell>(),
  hiddenKeys: new Set<string>(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toast: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, () => {}],
}));
vi.mock("../state/entities", () => ({
  readThreadShell: (ref: ScopedThreadRef) => state.shells.get(scopedThreadKey(ref)) ?? null,
  readHiddenThreadKeys: () => state.hiddenKeys,
}));
vi.mock("../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) }));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (notice: unknown) => notice,
}));

const environmentId = EnvironmentId.make("archive-env");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const refOf = (thread: EnvironmentThreadShell) => scopeThreadRef(thread.environmentId, thread.id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup() {
  state.shells.clear();
  state.hiddenKeys.clear();
  state.confirm.mockReset().mockResolvedValue(true);
  state.toast.mockClear();
  const recent = makeThreadFixture({
    environmentId,
    projectId: projectA,
    id: ThreadId.make("recent"),
    settledOverride: "settled",
  });
  const older = makeThreadFixture({
    environmentId,
    projectId: projectB,
    id: ThreadId.make("older"),
    settledOverride: "settled",
  });
  for (const thread of [recent, older]) state.shells.set(scopedThreadKey(refOf(thread)), thread);
  const scopesRef: { current: readonly OlderSettledScope[] } = {
    current: [{ environmentId, projectIds: [projectA, projectB] }],
  };
  const release = vi.fn();
  const archiveThread = vi.fn(async (_ref: ScopedThreadRef, opts?: { onArchived?: () => void }) => {
    opts?.onArchived?.();
    return AsyncResult.success(undefined);
  });
  const actions = (
    loadSettledThreads: Parameters<
      typeof useSidebarArchiveActions
    >[0]["loadSettledThreads"] = async () => ({ threads: [recent, older], release }),
  ) =>
    useSidebarArchiveActions({
      archiveThread,
      confirmThreadArchive: true,
      loadSettledThreads,
      settledScopesRef: scopesRef,
    });
  return { recent, older, scopesRef, release, archiveThread, actions };
}

it("waits for older targets and retains their rows through the real coordinated batch", async () => {
  const context = setup();
  const loaded = deferred<{ threads: EnvironmentThreadShell[]; release: () => void }>();
  const started = deferred<void>();
  const archived = deferred<void>();
  context.archiveThread.mockImplementation(async (_ref, opts) => {
    started.resolve();
    await archived.promise;
    opts?.onArchived?.();
    return AsyncResult.success(undefined);
  });
  const pending = context.actions(() => loaded.promise).archiveAllSettled();
  expect(context.archiveThread).not.toHaveBeenCalled();
  loaded.resolve({ threads: [context.recent, context.older], release: context.release });
  await started.promise;
  expect(context.release).not.toHaveBeenCalled();
  archived.resolve();
  await pending;
  expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([
    refOf(context.recent),
    refOf(context.older),
  ]);
  expect(context.release).toHaveBeenCalledOnce();
});

it("reports when loading finds no eligible settled threads", async () => {
  const context = setup();
  await context
    .actions(async () => ({ threads: [], release: context.release }))
    .archiveAllSettled();
  expect(context.archiveThread).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "info", title: "No settled threads to archive" }),
  );
  expect(context.release).toHaveBeenCalledOnce();
});

it("narrows the confirmation set when project scope changes while older threads load", async () => {
  const context = setup();
  const loaded = deferred<{ threads: EnvironmentThreadShell[]; release: () => void }>();
  const pending = context.actions(() => loaded.promise).archiveAllSettled();
  context.scopesRef.current = [{ environmentId, projectIds: [projectB] }];
  loaded.resolve({ threads: [context.recent, context.older], release: context.release });
  await pending;
  expect(state.confirm).toHaveBeenCalledWith("Archive all 1 settled thread?");
  expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([refOf(context.older)]);
});

it.each(["project scope", "visibility"])(
  "skips targets that leave %s after confirmation opens",
  async (change) => {
    const context = setup();
    const shown = deferred<void>();
    const confirmation = deferred<boolean>();
    state.confirm.mockImplementation(() => {
      shown.resolve();
      return confirmation.promise;
    });
    const pending = context.actions().archiveAllSettled();
    await shown.promise;
    if (change === "project scope") {
      context.scopesRef.current = [{ environmentId, projectIds: [projectB] }];
    } else {
      state.hiddenKeys.add(threadKey(refOf(context.recent)));
    }
    confirmation.resolve(true);
    await pending;
    expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([refOf(context.older)]);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  },
);

it("freezes visible confirmation targets after a reservation wait", async () => {
  const context = setup();
  const reservationStarted = deferred<void>();
  const releaseReservation = deferred<void>();
  const loaded = deferred<void>();
  const shown = deferred<void>();
  const confirmation = deferred<boolean>();
  const held = withCoordinatedThreadArchiveEntries({
    entries: [context.recent, context.older].map((thread) => ({
      threadKey: scopedThreadKey(refOf(thread)),
    })),
    run: async () => {
      reservationStarted.resolve();
      await releaseReservation.promise;
      return [];
    },
  });
  await reservationStarted.promise;
  state.confirm.mockImplementation(() => {
    shown.resolve();
    return confirmation.promise;
  });
  const pending = context
    .actions(async () => {
      loaded.resolve();
      return { threads: [context.recent, context.older], release: context.release };
    })
    .archiveAllSettled();
  await loaded.promise;
  state.hiddenKeys.add(threadKey(refOf(context.recent)));
  releaseReservation.resolve();
  await shown.promise;
  const message = state.confirm.mock.calls[0]?.[0];
  state.hiddenKeys.clear();
  confirmation.resolve(true);
  await Promise.all([pending, held]);
  expect(message).toBe("Archive all 1 settled thread?");
  expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([refOf(context.older)]);
  expect(context.release).toHaveBeenCalledOnce();
});

it("rechecks visibility before each mutation", async () => {
  const context = setup();
  context.archiveThread.mockImplementation(async (ref, opts) => {
    if (ref.threadId === context.recent.id) {
      state.hiddenKeys.add(threadKey(refOf(context.older)));
    }
    opts?.onArchived?.();
    return AsyncResult.success(undefined);
  });
  await context.actions().archiveAllSettled();
  expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([refOf(context.recent)]);
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
});

it("does not add unloaded targets when scope widens during loading", async () => {
  const context = setup();
  context.scopesRef.current = [{ environmentId, projectIds: [projectA] }];
  const loaded = deferred<{ threads: EnvironmentThreadShell[]; release: () => void }>();
  const pending = context.actions(() => loaded.promise).archiveAllSettled();
  context.scopesRef.current = [{ environmentId, projectIds: null }];
  loaded.resolve({ threads: [context.recent], release: context.release });
  await pending;
  expect(state.confirm).toHaveBeenCalledWith("Archive all 1 settled thread?");
  expect(context.archiveThread.mock.calls.map(([ref]) => ref)).toEqual([refOf(context.recent)]);
});

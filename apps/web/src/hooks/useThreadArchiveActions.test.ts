import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as { title: string; description?: string }[],
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../state/entities", () => ({ readThreadShell: () => ({ title: "Thread" }) }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title: string; description?: string }) => state.toasts.push(toast),
  },
}));

import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadArchiveActions, type ThreadArchiveEntry } from "./useThreadArchiveActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const entry = (environment: string, thread = "thread"): ThreadArchiveEntry => {
  const threadRef = {
    environmentId: EnvironmentId.make(environment),
    threadId: ThreadId.make(thread),
  };
  return { threadRef, threadKey: scopedThreadKey(threadRef) };
};
const primary = entry("primary");
const secondary = entry("secondary");
const options = { confirmationMessage: () => "Archive these threads?" };

function actions() {
  const archiveThread = vi.fn<Parameters<typeof useThreadArchiveActions>[0]["archiveThread"]>(
    async (_ref, callbacks) => {
      callbacks?.onArchived?.();
      return AsyncResult.success<undefined, never>(undefined);
    },
  );
  return {
    archiveThread,
    ...useThreadArchiveActions({ archiveThread, confirmThreadArchive: true }),
  };
}

beforeEach(() => {
  state.granted.clear();
  state.toasts.length = 0;
  state.confirm.mockReset().mockResolvedValue(true);
  useThreadSelectionStore.getState().clearSelection();
});

describe("shared archive permissions", () => {
  it("checks a denied secondary target even when the primary target is granted", async () => {
    state.granted.add("primary");
    const archive = actions();
    await archive.archiveCoordinatedEntries([primary, secondary], options);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(archive.archiveThread).not.toHaveBeenCalled();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.title).toBe("Thread action unavailable");
  });

  it("does not open confirmation when the target grant is already absent", async () => {
    const archive = actions();
    await archive.archiveCoordinatedEntries([secondary], options);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(archive.archiveThread).not.toHaveBeenCalled();
    expect(state.toasts).toHaveLength(1);
  });

  it("rechecks grants when a pending confirmation resolves", async () => {
    state.granted.add("secondary");
    const confirmation = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmation.promise);
    const archive = actions();
    const pending = archive.archiveCoordinatedEntries([secondary], options);
    expect(state.confirm).toHaveBeenCalledOnce();
    state.granted.delete("secondary");
    confirmation.resolve(true);
    await pending;
    expect(archive.archiveThread).not.toHaveBeenCalled();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.title).toBe("Thread action unavailable");
  });

  it("checks live grants after waiting behind an older canceled archive", async () => {
    state.granted.add("secondary");
    const confirmation = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmation.promise);
    const older = actions();
    const newer = actions();
    const first = older.archiveCoordinatedEntries([secondary], options);
    const second = newer.archiveCoordinatedEntries([secondary], options);
    expect(state.confirm).toHaveBeenCalledOnce();
    state.granted.delete("secondary");
    confirmation.resolve(false);
    await Promise.all([first, second]);
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(older.archiveThread).not.toHaveBeenCalled();
    expect(newer.archiveThread).not.toHaveBeenCalled();
    expect(state.toasts).toHaveLength(1);
  });

  it("archives once and clears the completed selection while retaining other rows", async () => {
    state.granted.add("secondary");
    useThreadSelectionStore.getState().toggleThread(secondary.threadKey);
    useThreadSelectionStore.getState().toggleThread(primary.threadKey);
    const archive = actions();
    await archive.archiveCoordinatedEntries([secondary], options);
    expect(archive.archiveThread).toHaveBeenCalledOnce();
    expect(archive.archiveThread.mock.calls[0]?.[0]).toEqual(secondary.threadRef);
    expect(useThreadSelectionStore.getState().selectedThreadKeys).toEqual(
      new Set([primary.threadKey]),
    );
    expect(state.toasts).toEqual([]);
  });
});

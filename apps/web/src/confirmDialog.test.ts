import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  cancelConfirmDialogsIn,
  completeConfirmDialogClose,
  readConfirmDialogState,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  setConfirmDialogContainerResolver,
  subscribeConfirmDialogHost,
  withConfirmDialogContainer,
} from "./confirmDialog";

const mountHost = () => subscribeConfirmDialogHost(() => {});

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("serializes concurrent confirmations, each in its requested or focused window", async () => {
    const unregister = mountHost();
    const detachedWindowBody = {} as HTMLElement;
    const focusedWindowBody = {} as HTMLElement;
    using _resolver = {
      [Symbol.dispose]: () => setConfirmDialogContainerResolver(null),
    };
    const first = requireConfirmation(
      requestConfirmDialog("Delete the project?", { initialFocus: "confirm" }),
    );
    setConfirmDialogContainerResolver(() => focusedWindowBody);
    const second = requireConfirmation(
      withConfirmDialogContainer(detachedWindowBody, () =>
        requestConfirmDialog("Delete the worktree too?"),
      ),
    );
    const third = requireConfirmation(requestConfirmDialog("Close the terminal?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
      initialFocus: "confirm",
      container: null,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
      container: detachedWindowBody,
      initialFocus: undefined,
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Close the terminal?",
      variant: "default",
      container: focusedWindowBody,
      initialFocus: undefined,
    });

    respondToConfirmDialog(true);
    await expect(third).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels a gone window's confirmations and shows the next one at once", async () => {
    const unregister = mountHost();
    const detachedWindowBody = {} as HTMLElement;
    const inDetached = () =>
      withConfirmDialogContainer(detachedWindowBody, () => requestConfirmDialog("Close it?"));
    const active = requireConfirmation(inDetached());
    const queuedMain = requireConfirmation(requestConfirmDialog("Archive the thread?"));
    const queuedDetached = requireConfirmation(inDetached());

    cancelConfirmDialogsIn(detachedWindowBody);

    await expect(Promise.all([active, queuedDetached])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Archive the thread?",
      variant: "default",
      container: null,
      initialFocus: undefined,
    });
    respondToConfirmDialog(true);
    await expect(queuedMain).resolves.toBe(true);
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = mountHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("has no host until one subscribes", () => {
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
    const unsubscribe = mountHost();
    expect(requestConfirmDialog("Continue?")).toBeDefined();
    unsubscribe();
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = mountHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});

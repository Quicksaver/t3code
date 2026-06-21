import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("vscode", () => ({}));

import {
  createConnectedWebviewDisposableReplacementState,
  replaceConnectedWebviewDisposable,
  routeFromUri,
} from "./extension.ts";

describe("routeFromUri", () => {
  it("opens the chat index for new thread resources", () => {
    expect(routeFromUri({ path: "/local/new" } as never)).toBe("/_chat/");
  });

  it("opens a specific thread route when the URI includes environment and thread ids", () => {
    expect(routeFromUri({ path: "/local/thread with spaces" } as never)).toBe(
      "/_chat/local/thread%20with%20spaces",
    );
  });
});

describe("replaceConnectedWebviewDisposable", () => {
  it("disposes the previous disposable and skips rendering when already disposed", async () => {
    const state = createConnectedWebviewDisposableReplacementState();
    const previousDispose = vi.fn();
    const render = vi.fn(async () => ({ dispose: vi.fn() }));
    state.current = { dispose: previousDispose };

    await replaceConnectedWebviewDisposable({
      isDisposed: () => true,
      state,
      render,
    });

    expect(previousDispose).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(state.current).toBeNull();
  });

  it("disposes a render result that resolves after the webview was disposed", async () => {
    const state = createConnectedWebviewDisposableReplacementState();
    let disposed = false;
    const dispose = vi.fn();
    let resolveRender: (disposable: { dispose: () => void }) => void = () => {};
    const renderPromise = new Promise<{ dispose: () => void }>((resolve) => {
      resolveRender = resolve;
    });

    const replacePromise = replaceConnectedWebviewDisposable({
      isDisposed: () => disposed,
      state,
      render: () => renderPromise,
    });

    disposed = true;
    resolveRender({ dispose });
    await replacePromise;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(state.current).toBeNull();
  });

  it("disposes the previous render result before assigning the next one", async () => {
    const state = createConnectedWebviewDisposableReplacementState();
    const previousDispose = vi.fn();
    const nextDisposable = { dispose: vi.fn() };
    state.current = { dispose: previousDispose };

    await replaceConnectedWebviewDisposable({
      isDisposed: () => false,
      state,
      render: async () => nextDisposable,
    });

    expect(previousDispose).toHaveBeenCalledTimes(1);
    expect(nextDisposable.dispose).not.toHaveBeenCalled();
    expect(state.current).toBe(nextDisposable);
  });

  it("lets render callbacks skip webview mutations after becoming stale", async () => {
    const state = createConnectedWebviewDisposableReplacementState();
    const firstDisposable = { dispose: vi.fn() };
    const secondDisposable = { dispose: vi.fn() };
    let assignedHtml = "";
    let renderCallCount = 0;
    let resolveFirst: () => void = () => {};
    let resolveSecond: () => void = () => {};
    const firstRender = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondRender = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const render = vi.fn(async (isCurrentRender: () => boolean) => {
      renderCallCount += 1;
      if (renderCallCount === 1) {
        await firstRender;
        if (isCurrentRender()) {
          assignedHtml = "first";
        }
        return firstDisposable;
      }
      await secondRender;
      if (isCurrentRender()) {
        assignedHtml = "second";
      }
      return secondDisposable;
    });

    const firstReplace = replaceConnectedWebviewDisposable({
      isDisposed: () => false,
      state,
      render,
    });
    const secondReplace = replaceConnectedWebviewDisposable({
      isDisposed: () => false,
      state,
      render,
    });

    resolveSecond();
    await secondReplace;
    expect(assignedHtml).toBe("second");
    expect(state.current).toBe(secondDisposable);

    resolveFirst();
    await firstReplace;

    expect(assignedHtml).toBe("second");
    expect(firstDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(secondDisposable.dispose).not.toHaveBeenCalled();
    expect(state.current).toBe(secondDisposable);
  });
});

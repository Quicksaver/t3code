import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useDetachedPanelStore } from "./detachedPanels/detachedPanelStore";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const tabA = browserMiniPlayerSource("tab-a");
const tabB = browserMiniPlayerSource("tab-b");

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useDetachedPanelStore.setState({ byName: {} });
});

describe("previewMiniPlayerStore", () => {
  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: null,
      width: null,
      lastInteraction: "drag",
    });
  });

  it("removes only the targeted thread lifecycle state", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refB, tabB);

    usePreviewMiniPlayerStore.getState().removeThread(refA);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBeNull();
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ source: tabB });
  });

  it("never floats a source that is open in its own window", () => {
    useDetachedPanelStore.getState().detach(refA, "browser:tab-a");
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBeNull();

    usePreviewMiniPlayerStore.getState().open(refA, tabB);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.source,
    ).toEqual(tabB);
  });
});

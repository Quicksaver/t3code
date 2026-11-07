import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  closedDetachedPanel,
  detachedPanelWindowName,
  selectThreadDetachedSurfaceIds,
  useDetachedPanelStore,
} from "./detachedPanelStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadKey = scopedThreadKey(ref);
const bounds = { x: 10, y: 20, width: 800, height: 600 };

beforeEach(() => {
  useDetachedPanelStore.setState({ byName: {} });
});

describe("detachedPanelStore", () => {
  it("forgets a closed surface's window but remembers its bounds for reopening", () => {
    const store = useDetachedPanelStore.getState();
    store.detach(ref, "terminal:1");
    store.detach(ref, "device:host:phone", bounds);
    store.setBounds(detachedPanelWindowName(threadKey, "terminal:1"), bounds);

    store.retainSurfaces(threadKey, new Set(["terminal:1"]));

    expect(
      selectThreadDetachedSurfaceIds(useDetachedPanelStore.getState().byName, threadKey),
    ).toEqual(["terminal:1"]);
    expect(closedDetachedPanel(threadKey, "terminal:1")).toEqual({ bounds });
    expect(closedDetachedPanel(threadKey, "device:host:phone")).toEqual({ bounds });
    expect(closedDetachedPanel(threadKey, "diff")).toBeUndefined();
  });

  it("moves a window to the surface that replaced it, unless that one has its own", () => {
    const store = useDetachedPanelStore.getState();
    store.detach(ref, "files", bounds);
    store.replaceSurface(threadKey, "files", "file:src");
    expect(useDetachedPanelStore.getState().byName).toEqual({
      [detachedPanelWindowName(threadKey, "file:src")]: {
        threadKey,
        surfaceId: "file:src",
        bounds,
      },
    });

    const ownBounds = { x: 0, y: 0, width: 500, height: 400 };
    store.detach(ref, "file:src/lib", ownBounds);
    store.replaceSurface(threadKey, "file:src", "file:src/lib");
    expect(useDetachedPanelStore.getState().byName).toEqual({
      [detachedPanelWindowName(threadKey, "file:src/lib")]: {
        threadKey,
        surfaceId: "file:src/lib",
        bounds: ownBounds,
      },
    });
  });
});

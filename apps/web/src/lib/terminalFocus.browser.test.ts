import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectActionThreadId } from "@t3tools/client-runtime/project-actions";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  consumePendingTerminalFocus,
  focusActivePanelTerminal,
  focusTerminal,
  focusTerminalViewport,
  registerTerminalFocusTarget,
} from "./terminalFocus";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

// The drawer's collapsed shape: a 0fr grid row that clips the viewport, which
// stays focusable, around a surface whose input refuses focus while hidden.
function mountClippedViewport() {
  const drawer = document.createElement("div");
  drawer.style.cssText = "display:grid;grid-template-rows:0fr;overflow:clip";
  const clip = document.createElement("div");
  clip.style.cssText = "min-height:0;overflow:clip";
  const mount = document.createElement("div");
  mount.tabIndex = -1;
  const input = document.createElement("textarea");
  mount.append(input);
  clip.append(mount);
  drawer.append(clip);
  document.body.append(drawer);
  const state = { visible: false };
  const surface = {
    focus() {
      if (state.visible) input.focus({ preventScroll: true });
    },
  };
  const focus = () =>
    focusTerminalViewport({ mount, surface, canOperate: true, visible: state.visible });
  return {
    input,
    state,
    focus,
    [Symbol.dispose]: () => drawer.remove(),
  };
}

describe("focusTerminalViewport", () => {
  it.each(["launch", "split"] as const)(
    "focuses the destination viewport after a remote action %s, even with a colliding source id",
    async (operation) => {
      const source = scopeThreadRef(EnvironmentId.make("source"), ThreadId.make(operation));
      const destination = {
        environmentId: EnvironmentId.make("destination"),
        projectId: ProjectId.make(operation),
        projectCwd: "/destination",
        environmentLabel: "Mac",
        label: "Run on Mac",
      };
      const target = scopeThreadRef(destination.environmentId, projectActionThreadId(destination));
      const panel = useRightPanelStore.getState();
      panel.openTerminal(source, "action", destination);
      const terminalId = operation === "split" ? "split" : "action";
      if (operation === "split") {
        const { activeSurfaceId } = selectThreadRightPanelState(
          useRightPanelStore.getState().byThreadKey,
          source,
        );
        panel.splitTerminal(source, activeSurfaceId!, terminalId);
      }
      using localViewport = mountClippedViewport();
      localViewport.state.visible = true;
      using _local = {
        [Symbol.dispose]: registerTerminalFocusTarget({
          threadRef: source,
          terminalId,
          focus: localViewport.focus,
        }),
      };

      focusActivePanelTerminal(source);

      using destinationViewport = mountClippedViewport();
      destinationViewport.state.visible = true;
      using _destination = {
        [Symbol.dispose]: registerTerminalFocusTarget({
          threadRef: target,
          terminalId,
          focus: destinationViewport.focus,
        }),
      };
      await expect.element(destinationViewport.input).toHaveFocus();
    },
  );

  it("keeps a request made while the drawer is hidden until it shows", () => {
    const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("hidden-drawer"));
    using viewport = mountClippedViewport();
    const unregister = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: viewport.focus,
    });
    using _unregister = { [Symbol.dispose]: unregister };

    focusTerminal(ref, "a");
    viewport.state.visible = true;
    consumePendingTerminalFocus(ref, "a");

    expect(document.activeElement).toBe(viewport.input);
  });
});

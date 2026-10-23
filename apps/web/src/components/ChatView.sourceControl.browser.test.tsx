import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { render } from "../../test/render";
import { usePanelPresence } from "../panelAnimations";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  normalizeSourceControlRightPanelPresence,
  useSourceControlRightPanelSurfaceState,
} from "./ChatView.sourceControl";

function PanelPresenceFixture({ supported }: { readonly supported: boolean }) {
  const [thread] = useState(() =>
    scopeThreadRef(EnvironmentId.make("presence-test"), ThreadId.make("thread")),
  );
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, thread),
  );
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, thread),
  );
  const {
    addSourceControlSurface,
    sourceControlAvailable,
    visibleActiveRightPanelSurface,
    visibleRightPanelSurfaces,
  } = useSourceControlRightPanelSurfaceState({
    activeThreadRef: thread,
    activeRightPanelSurface: activeSurface,
    gitCwd: "/repo",
    isGitRepo: true,
    panelSupported: supported,
    rightPanelSurfaces: panelState.surfaces,
  });
  const value = {
    activeSurface: visibleActiveRightPanelSurface,
    surfaces: visibleRightPanelSurfaces,
  };
  const presence = usePanelPresence(panelState.isOpen, value, false, "thread", 0);
  const rendered = normalizeSourceControlRightPanelPresence({
    activeSurface: presence.value?.activeSurface ?? null,
    surfaces: presence.value?.surfaces ?? [],
    sourceControlAvailable,
  });
  return (
    <>
      <button onClick={() => useRightPanelStore.getState().toggle(thread, "source-control")}>
        Toggle panel
      </button>
      <button onClick={addSourceControlSurface}>Open Version Control</button>
      {presence.present && (
        <section aria-label="Panel">
          {rendered.activeSurface?.kind ?? "No available surface"}
        </section>
      )}
    </>
  );
}

it("opens and updates panel presence without a render-phase loop", async () => {
  const previous = useRightPanelStore.getState();
  using _store = { [Symbol.dispose]: () => useRightPanelStore.setState(previous, true) };
  useRightPanelStore.setState({ byThreadKey: {} });
  await using screen = await render(<PanelPresenceFixture supported />);
  await screen.getByRole("button", { name: "Open Version Control" }).click();
  await expect
    .element(screen.getByRole("region", { name: "Panel" }))
    .toHaveTextContent("source-control");
  await screen.rerender(<PanelPresenceFixture supported={false} />);
  await expect
    .element(screen.getByRole("region", { name: "Panel" }))
    .toHaveTextContent("No available surface");
  await screen.getByRole("button", { name: "Toggle panel" }).click();
  await expect.element(screen.getByRole("region", { name: "Panel" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Open Version Control" }).click();
  await expect.element(screen.getByRole("region", { name: "Panel" })).not.toBeInTheDocument();
});

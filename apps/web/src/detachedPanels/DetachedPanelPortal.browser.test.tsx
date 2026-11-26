import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { SharedTooltipProvider, SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { render } from "../../test/render";
import { DetachedPanelPortal } from "./DetachedPanelPortal";

function createPanelDocument() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument!;
  const view = doc.defaultView!;
  const panelRoot = doc.createElement("div");
  const webviewRoot = doc.createElement("div");
  const portalRoot = doc.createElement("div");
  doc.body.append(panelRoot, webviewRoot, portalRoot);
  const detachedWindow = { name: "panel", window: view, panelRoot, webviewRoot, portalRoot };

  return {
    doc,
    view,
    panelRoot,
    renderPanel(children: ReactNode) {
      return render(
        <SharedTooltipProvider>
          <DetachedPanelPortal detachedWindow={detachedWindow} target="panelRoot">
            {children}
          </DetachedPanelPortal>
        </SharedTooltipProvider>,
      );
    },
    expectDescription(trigger: HTMLElement, description: string) {
      return vi.waitFor(() => {
        const id = trigger.getAttribute("aria-describedby");
        expect(id).toBeTruthy();
        const popup = doc.getElementById(id!);
        expect(popup?.textContent).toBe(description);
        expect(portalRoot.querySelector('[data-slot="tooltip-popup"]')).toBe(popup);
      });
    },
    [Symbol.dispose]: () => frame.remove(),
  };
}

it("links a shared tooltip in the detached document when a wrapped button receives keyboard focus", async () => {
  using panel = createPanelDocument();
  await using _screen = await panel.renderPanel(
    <SharedTooltipTrigger label="Detached description" render={<span />}>
      <button type="button">Detached action</button>
    </SharedTooltipTrigger>,
  );

  await userEvent.keyboard("{Tab}");
  expect(panel.doc.activeElement).toBe(panel.panelRoot.querySelector("button"));
  await panel.expectDescription(panel.panelRoot.querySelector("span")!, "Detached description");
});

it("restores an enclosing shared tooltip when the pointer leaves a nested detached trigger", async () => {
  using panel = createPanelDocument();
  await using _screen = await panel.renderPanel(
    <SharedTooltipTrigger label="Panel description" render={<div data-trigger="outer" />}>
      <SharedTooltipTrigger label="Action description" render={<button type="button" />}>
        Detached action
      </SharedTooltipTrigger>
    </SharedTooltipTrigger>,
  );
  const outer = panel.panelRoot.querySelector<HTMLElement>('[data-trigger="outer"]')!;
  const inner = panel.panelRoot.querySelector("button")!;
  const move = (
    trigger: HTMLElement,
    type: "pointerover" | "pointerout",
    relatedTarget?: HTMLElement,
  ) => {
    trigger.dispatchEvent(
      new panel.view.PointerEvent(type, {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: relatedTarget ?? null,
      }),
    );
  };

  move(outer, "pointerover");
  await panel.expectDescription(outer, "Panel description");
  move(outer, "pointerout", inner);
  await panel.expectDescription(inner, "Action description");
  move(inner, "pointerout", outer);
  await panel.expectDescription(outer, "Panel description");
});

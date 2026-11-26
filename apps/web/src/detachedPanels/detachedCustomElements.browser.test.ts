import { describe, expect, it } from "vite-plus/test";

import { mirrorCodeViewerElement } from "./detachedCustomElements";

const VIEWER_CSS = ":host { display: grid; }";

function defineMainViewer() {
  if (customElements.get("diffs-container")) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(VIEWER_CSS);
  customElements.define(
    "diffs-container",
    class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).adoptedStyleSheets = [sheet];
      }
    },
  );
}

describe("mirrorCodeViewerElement", () => {
  it("gives a detached window's code viewer its own copy of the viewer styles", () => {
    defineMainViewer();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    using _frame = { [Symbol.dispose]: () => frame.remove() };
    const target = frame.contentWindow as Window & typeof globalThis;
    // Rendered before the mirror runs, as the panel can be, with a bare shadow root.
    const early = target.document.createElement("diffs-container");
    early.attachShadow({ mode: "open" });
    target.document.body.append(early);

    mirrorCodeViewerElement(target);
    const viewer = target.document.body.appendChild(
      target.document.createElement("diffs-container"),
    );

    for (const element of [early, viewer]) {
      const [sheet] = element.shadowRoot?.adoptedStyleSheets ?? [];
      expect(sheet).toBeInstanceOf(target.CSSStyleSheet);
      expect(target.getComputedStyle(element).display).toBe("grid");
    }
  });
});

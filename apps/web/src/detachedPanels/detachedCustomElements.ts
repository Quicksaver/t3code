// The code viewer's element: `@pierre/diffs` defines it in this window's registry only.
const DIFFS_TAG_NAME = "diffs-container";

/**
 * Defines the code viewer's custom element in a detached panel window. React creates it through
 * that window's document, whose registry is separate, and constructable stylesheets cannot be
 * adopted across documents, so the window gets its own definition and copies of the sheets.
 */
export function mirrorCodeViewerElement(target: Window & typeof globalThis): void {
  const define = () => {
    const MainElement = window.customElements.get(DIFFS_TAG_NAME);
    if (MainElement === undefined || target.closed) return;
    if (target.customElements.get(DIFFS_TAG_NAME) !== undefined) return;
    const probe = document.createElement(DIFFS_TAG_NAME);
    const sheets = (probe.shadowRoot?.adoptedStyleSheets ?? []).map((sheet) => {
      const copy = new target.CSSStyleSheet();
      copy.replaceSync(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
      return copy;
    });
    const mainConnected = (MainElement.prototype as { connectedCallback?: () => void })
      .connectedCallback;
    target.customElements.define(
      DIFFS_TAG_NAME,
      class extends target.HTMLElement {
        constructor() {
          super();
          // An element rendered before this definition already has a bare shadow root.
          const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
          root.adoptedStyleSheets = sheets;
        }
        connectedCallback() {
          mainConnected?.call(this);
        }
      },
    );
  };
  define();
  // The viewer loads lazily, so its definition can arrive after the window opened.
  if (window.customElements.get(DIFFS_TAG_NAME) === undefined) {
    void window.customElements.whenDefined(DIFFS_TAG_NAME).then(define);
  }
}

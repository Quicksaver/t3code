import { describe, expect, it, vi } from "vite-plus/test";

import { mirrorDocumentStyles } from "./detachedWindows";

function makeTarget() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const target = frame.contentDocument!;
  return { target, [Symbol.dispose]: () => frame.remove() };
}

const mirroredStyles = (target: Document) =>
  [...target.head.querySelectorAll("style")].map((style) => style.textContent);

describe("mirrorDocumentStyles", () => {
  it("follows the source's styles and theme attributes as they change", async () => {
    using frame = makeTarget();
    const { target } = frame;
    const first = document.createElement("style");
    const second = document.createElement("style");
    first.textContent = ".detached-first { color: red; }";
    document.head.append(first);
    const stop = mirrorDocumentStyles(document, target);
    using _cleanup = {
      [Symbol.dispose]: () => {
        stop();
        first.remove();
        second.remove();
        document.documentElement.classList.remove("detached-theme");
      },
    };
    expect(mirroredStyles(target)).toContain(".detached-first { color: red; }");

    first.textContent = ".detached-first { color: blue; }";
    document.head.append(second);
    second.textContent = ".detached-second { color: green; }";
    document.documentElement.classList.add("detached-theme");
    await vi.waitFor(() => {
      const styles = mirroredStyles(target);
      expect(styles).toContain(".detached-first { color: blue; }");
      expect(styles).not.toContain(".detached-first { color: red; }");
      expect(styles.indexOf(".detached-second { color: green; }")).toBeGreaterThan(
        styles.indexOf(".detached-first { color: blue; }"),
      );
      expect(target.documentElement.classList.contains("detached-theme")).toBe(true);
    });

    second.remove();
    document.documentElement.classList.remove("detached-theme");
    await vi.waitFor(() => {
      expect(mirroredStyles(target)).not.toContain(".detached-second { color: green; }");
      expect(target.documentElement.classList.contains("detached-theme")).toBe(false);
    });
  });
});

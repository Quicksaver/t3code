import { describe, expect, it } from "vite-plus/test";

import { isEditableFocused } from "./editableFocus";

describe("isEditableFocused", () => {
  it("recognizes editable targets from a detached panel window's realm", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    using _frame = { [Symbol.dispose]: () => frame.remove() };
    const doc = frame.contentDocument!;
    const input = doc.body.appendChild(doc.createElement("input"));
    const label = doc.body.appendChild(doc.createElement("span"));

    expect(isEditableFocused(input)).toBe(true);
    expect(isEditableFocused(label)).toBe(false);
  });
});

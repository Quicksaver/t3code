import { describe, expect, it } from "vite-plus/test";

import { extractUserMessageContextState } from "./userMessageContext";

const terminalBlock = (label = "Terminal 1 line 1", output = "first failure") =>
  ["<terminal_context>", `- ${label}:`, `  1 | ${output}`, "</terminal_context>"].join("\n");

const elementBlock = [
  "<element_context>",
  "- <SubmitButton> (Button.tsx:12):",
  "  selector: button.submit",
  "</element_context>",
].join("\n");

const previewBlock = [
  "<preview_annotation>",
  "Preview annotation:",
  "Id: annotation_1",
  "Page: Example",
  "Targets: 1 selected element.",
  "</preview_annotation>",
].join("\n");

const reviewBlock = [
  '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
  "Keep this comment visible.",
  "```diff",
  "@@ -0,0 +47,2 @@",
  '+  it("keeps valid zero-usage snapshots", () => {',
  "+    expect(snapshot).not.toBeNull();",
  "```",
  "</review_comment>",
].join("\n");

describe("extractUserMessageContextState", () => {
  it("keeps ordinary text and literal tag-like examples visible", () => {
    const value = [
      "Explain this sample:",
      "",
      "<terminal_context>",
      "not generated context",
      "</terminal_context>",
    ].join("\n");

    const state = extractUserMessageContextState(value);

    expect(state.visibleText).toBe(value);
    expect(state.contextEntries).toEqual([]);
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text", "text"]);
    expect(state.contentParts.map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe(
      value,
    );
  });

  it("extracts a context-only element block", () => {
    const state = extractUserMessageContextState(elementBlock);

    expect(state.visibleText).toBe("");
    expect(state.elementContexts).toEqual([
      {
        header: "<SubmitButton> (Button.tsx:12)",
        body: "selector: button.submit",
      },
    ]);
    expect(state.contentParts.map((part) => part.kind)).toEqual(["element"]);
  });

  it.each([
    {
      name: "terminal, element, preview",
      blocks: [terminalBlock(), elementBlock, previewBlock],
      kinds: ["text", "terminal", "element", "preview"],
    },
    {
      name: "element, terminal",
      blocks: [elementBlock, terminalBlock()],
      kinds: ["text", "element", "terminal"],
    },
    {
      name: "preview, terminal, element",
      blocks: [previewBlock, terminalBlock(), elementBlock],
      kinds: ["text", "preview", "terminal", "element"],
    },
  ])("preserves $name send order", ({ blocks, kinds }) => {
    const state = extractUserMessageContextState(["Fix this interaction.", ...blocks].join("\n\n"));

    expect(state.visibleText).toBe("Fix this interaction.");
    expect(state.contentParts.map((part) => part.kind)).toEqual(kinds);
  });

  it("preserves repeated contexts of the same type", () => {
    const state = extractUserMessageContextState(
      [
        "Compare these failures.",
        terminalBlock("Terminal 1 line 1", "first failure"),
        terminalBlock("Terminal 2 line 2", "second failure"),
      ].join("\n\n"),
    );

    expect(state.terminalContexts.map((context) => context.header)).toEqual([
      "Terminal 1 line 1",
      "Terminal 2 line 2",
    ]);
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text", "terminal", "terminal"]);
  });

  it("uses the final standalone preview closer", () => {
    const value = [
      "Fix this annotated preview.",
      "",
      "<preview_annotation>",
      "Preview annotation:",
      "Id: annotation_1",
      "Page: Example",
      "Comment: literal closer follows",
      "</preview_annotation>",
      "inside the comment",
      "Targets: 1 selected element.",
      "</preview_annotation>",
    ].join("\n");

    const state = extractUserMessageContextState(value);

    expect(state.visibleText).toBe("Fix this annotated preview.");
    expect(state.previewAnnotations).toHaveLength(1);
    expect(state.previewAnnotations[0]?.targetSummary).toBe("1 selected element.");
  });

  it("suppresses a malformed trailing generated block", () => {
    const state = extractUserMessageContextState(
      [
        "Fix malformed context.",
        "",
        "<terminal_context>",
        "- Terminal 1 line 1:",
        "  1 | incomplete generated context",
      ].join("\n"),
    );

    expect(state.visibleText.trimEnd()).toBe("Fix malformed context.");
    expect(state.visibleText).not.toContain("incomplete generated context");
    expect(state.contextEntries).toEqual([]);
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text"]);
  });

  it("keeps review comments as text parts between generated contexts", () => {
    const state = extractUserMessageContextState(
      ["Review these changes.", terminalBlock(), reviewBlock, elementBlock].join("\n\n"),
    );

    expect(state.contentParts.map((part) => part.kind)).toEqual([
      "text",
      "terminal",
      "text",
      "element",
    ]);
    const reviewPart = state.contentParts[2];
    expect(reviewPart?.kind).toBe("text");
    if (reviewPart?.kind !== "text") throw new Error("Expected review comment text part");
    expect(reviewPart.text).toContain('<review_comment sectionId="turn:2"');
    expect(reviewPart.text).toContain("Keep this comment visible.");
    expect(state.visibleText).toContain("Keep this comment visible.");
  });

  it("keeps a trailing review comment after generated context", () => {
    const state = extractUserMessageContextState(
      ["Review these changes.", terminalBlock(), reviewBlock].join("\n\n"),
    );

    expect(state.contentParts.map((part) => part.kind)).toEqual(["text", "terminal", "text"]);
    const reviewPart = state.contentParts[2];
    expect(reviewPart?.kind).toBe("text");
    if (reviewPart?.kind !== "text") throw new Error("Expected trailing review comment text part");
    expect(reviewPart.text).toContain('<review_comment sectionId="turn:2"');
    expect(reviewPart.text).toContain("Keep this comment visible.");
  });

  it("does not parse review tags inside generated context bodies", () => {
    const value = [
      "Inspect terminal output.",
      "",
      "<terminal_context>",
      "- Terminal 1 line 1:",
      '  1 | <review_comment sectionId="turn:fake" filePath="fake.ts" startIndex="0" endIndex="0">',
      "  2 | This is terminal output, not a review card.",
      "  3 | </review_comment>",
      "</terminal_context>",
    ].join("\n");

    const state = extractUserMessageContextState(value);

    expect(state.visibleText).toBe("Inspect terminal output.");
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text", "terminal"]);
    expect(state.terminalContexts[0]?.body).toContain("<review_comment");
    expect(state.terminalContexts[0]?.body).toContain("not a review card");
  });

  it("suppresses review tags inside a malformed generated block", () => {
    const value = [
      "Inspect malformed terminal output.",
      "",
      "<terminal_context>",
      "- Terminal 1 line 1:",
      '  1 | <review_comment sectionId="turn:fake" filePath="fake.ts" startIndex="0" endIndex="0">',
      "  2 | This is terminal output, not a review card.",
      "  3 | </review_comment>",
    ].join("\n");

    const state = extractUserMessageContextState(value);

    expect(state.visibleText.trimEnd()).toBe("Inspect malformed terminal output.");
    expect(state.visibleText).not.toContain("fake.ts");
    expect(state.visibleText).not.toContain("not a review card");
    expect(state.contextEntries).toEqual([]);
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text"]);
  });

  it("ignores literal closing tags inside generated context output", () => {
    const value = [
      "Inspect terminal output.",
      "",
      "<terminal_context>",
      "- Terminal 1 line 1:",
      "  1 | </terminal_context>",
      "  2 | after literal closing tag",
      "</terminal_context>",
    ].join("\n");

    const state = extractUserMessageContextState(value);

    expect(state.visibleText).toBe("Inspect terminal output.");
    expect(state.terminalContexts[0]?.body).toContain("</terminal_context>");
    expect(state.terminalContexts[0]?.body).toContain("after literal closing tag");
    expect(state.contentParts.map((part) => part.kind)).toEqual(["text", "terminal"]);
  });
});

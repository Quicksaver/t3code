import { describe, expect, it } from "vite-plus/test";

import { planComposerControlledUpdate } from "./composer-editor-controlled-update";

describe("planComposerControlledUpdate", () => {
  it("refreshes skill metadata without moving a focused editor selection", () => {
    expect(
      planComposerControlledUpdate({
        previousSnapshot: { value: "$update", cursor: 7 },
        value: "$update",
        controlledCursor: 1,
        contextsChanged: false,
        skillsChanged: true,
        isFocused: true,
      }),
    ).toEqual({
      rewriteEditorState: false,
      refreshSkillMetadata: true,
      selectionCursor: null,
      snapshotCursor: 7,
    });
  });

  it("rewrites controlled text and restores its controlled selection", () => {
    expect(
      planComposerControlledUpdate({
        previousSnapshot: { value: "$update", cursor: 7 },
        value: "$update now",
        controlledCursor: 11,
        contextsChanged: false,
        skillsChanged: true,
        isFocused: true,
      }),
    ).toEqual({
      rewriteEditorState: true,
      refreshSkillMetadata: false,
      selectionCursor: 11,
      snapshotCursor: 11,
    });
  });

  it("still applies an intentional focused cursor-only update", () => {
    expect(
      planComposerControlledUpdate({
        previousSnapshot: { value: "hello", cursor: 5 },
        value: "hello",
        controlledCursor: 2,
        contextsChanged: false,
        skillsChanged: false,
        isFocused: true,
      }),
    ).toEqual({
      rewriteEditorState: false,
      refreshSkillMetadata: false,
      selectionCursor: 2,
      snapshotCursor: 2,
    });
  });
});

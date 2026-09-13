export interface ComposerControlledSnapshot {
  readonly value: string;
  readonly cursor: number;
}

export interface ComposerControlledUpdatePlan {
  readonly rewriteEditorState: boolean;
  readonly refreshSkillMetadata: boolean;
  readonly selectionCursor: number | null;
  readonly snapshotCursor: number;
}

export function planComposerControlledUpdate(input: {
  readonly previousSnapshot: ComposerControlledSnapshot;
  readonly value: string;
  readonly controlledCursor: number;
  readonly skillsChanged: boolean;
  readonly isFocused: boolean;
}): ComposerControlledUpdatePlan {
  const valueChanged = input.previousSnapshot.value !== input.value;
  const rewriteEditorState = valueChanged;
  const refreshSkillMetadata = input.skillsChanged && !rewriteEditorState;
  const preserveFocusedSelection = input.isFocused && refreshSkillMetadata;
  const snapshotCursor = preserveFocusedSelection
    ? input.previousSnapshot.cursor
    : input.controlledCursor;

  return {
    rewriteEditorState,
    refreshSkillMetadata,
    selectionCursor:
      rewriteEditorState ||
      (input.isFocused &&
        !preserveFocusedSelection &&
        input.previousSnapshot.cursor !== snapshotCursor)
        ? snapshotCursor
        : null,
    snapshotCursor,
  };
}

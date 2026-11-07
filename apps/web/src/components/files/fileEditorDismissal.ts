interface FileEditorDismissalOptions {
  root: HTMLElement;
  editor: {
    setSelections: (selections: []) => void;
  };
  isBlocked: () => boolean;
  onDismiss: () => void;
}

function dismissFileEditorInteraction({
  root,
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "root" | "editor" | "onDismiss">): void {
  onDismiss();
  editor.setSelections([]);

  const file = root.querySelector<HTMLElement>("diffs-container");
  // In a detached panel window the editor holds nodes from either realm: it creates some in the
  // main document and adopts them. Check the capability, not a realm's constructor.
  const activeElement = file?.shadowRoot?.activeElement as { blur?: unknown } | null | undefined;
  if (typeof activeElement?.blur === "function") (activeElement as HTMLElement).blur();
}

function isFileEditorFocused(root: HTMLElement): boolean {
  const file = root.querySelector<HTMLElement>("diffs-container");
  return file?.shadowRoot?.activeElement?.hasAttribute("data-content") === true;
}

export function installFileEditorDismissal({
  root,
  editor,
  isBlocked,
  onDismiss,
}: FileEditorDismissalOptions): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isBlocked() || !isFileEditorFocused(root)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };

  // A detached panel window delivers its own pointer and key events.
  const doc = root.ownerDocument;
  doc.addEventListener("pointerdown", handlePointerDown, true);
  doc.addEventListener("keydown", handleKeyDown, true);
  return () => {
    doc.removeEventListener("pointerdown", handlePointerDown, true);
    doc.removeEventListener("keydown", handleKeyDown, true);
  };
}

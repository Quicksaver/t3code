export type TerminalFocusOwner = "drawer" | "right-panel";

/** Leave denied shortcuts available to the host window or browser. */
export function claimTerminalShortcut(
  event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation">,
  input: {
    readonly focusOwner: TerminalFocusOwner | null;
    readonly drawerAvailable: boolean;
    readonly panelAvailable: boolean;
  },
): boolean {
  const available =
    input.focusOwner === "right-panel" ? input.panelAvailable : input.drawerAvailable;
  if (!available) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

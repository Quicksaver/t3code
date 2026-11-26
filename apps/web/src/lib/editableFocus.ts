const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/**
 * Includes focused descendants of open shadow roots, whose key events target the host. Matches by
 * shape, since a detached panel window's elements come from another realm.
 */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  let element =
    typeof (target as Partial<Element> | null)?.closest === "function" ? (target as Element) : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}

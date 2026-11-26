import type { DesktopDetachedPanelBounds } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { cancelConfirmDialogsIn } from "../confirmDialog";
import { mirrorCodeViewerElement } from "./detachedCustomElements";

// The desktop validates and clamps these against the connected displays.
const DEFAULT_WINDOW_SIZE = { width: 760, height: 680 } as const;

/** A detached panel window: a same-origin popup whose document this renderer draws into. */
export interface DetachedWindow {
  readonly name: string;
  readonly window: Window & typeof globalThis;
  /** Panel content renders here. */
  readonly panelRoot: HTMLElement;
  /** Hosted browser webviews render here, beside the panel that positions them. */
  readonly webviewRoot: HTMLElement;
  /** Floating UI (menus, tooltips, dialogs) renders here. */
  readonly portalRoot: HTMLElement;
}

interface OpenWindow extends DetachedWindow {
  readonly dispose: () => void;
}

const openWindows = new Map<string, OpenWindow>();
let snapshot: ReadonlyMap<string, DetachedWindow> = new Map();
const listeners = new Set<() => void>();

function publish() {
  snapshot = new Map(openWindows);
  for (const listener of listeners) listener();
}

function subscribeDetachedWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readDetachedWindows(): ReadonlyMap<string, DetachedWindow> {
  return snapshot;
}

export function useDetachedWindows(): ReadonlyMap<string, DetachedWindow> {
  return useSyncExternalStore(subscribeDetachedWindows, readDetachedWindows, readDetachedWindows);
}

/** Copies the attributes `source` has onto `target`, dropping ones it lost. */
function copyAttributes(source: Element, target: Element) {
  // Copied first: removing attributes while iterating the live map would skip some.
  for (const attribute of Array.from(target.attributes)) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of source.attributes) {
    if (target.getAttribute(attribute.name) !== attribute.value) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

const isStyleSource = (node: Node): node is HTMLStyleElement | HTMLLinkElement =>
  node instanceof HTMLStyleElement ||
  (node instanceof HTMLLinkElement && node.rel.split(/\s+/).includes("stylesheet"));

/**
 * Keeps `target`'s styles and theme attributes equal to `source`'s. Lazily loaded chunks,
 * theme changes and dev HMR all edit the main document after a detached window opens.
 */
export function mirrorDocumentStyles(source: Document, target: Document): () => void {
  const clones = new Map<Node, HTMLStyleElement | HTMLLinkElement>();
  const syncHead = () => {
    const sources = [...source.head.childNodes].filter(isStyleSource);
    const live = new Set<Node>(sources);
    for (const [node, clone] of clones) {
      if (live.has(node)) continue;
      clone.remove();
      clones.delete(node);
    }
    for (const node of sources) {
      const existing = clones.get(node);
      const current =
        existing &&
        (node instanceof HTMLStyleElement
          ? existing.textContent === node.textContent
          : (existing as HTMLLinkElement).href === node.href)
          ? existing
          : (target.importNode(node, true) as HTMLStyleElement | HTMLLinkElement);
      if (current !== existing) {
        existing?.remove();
        clones.set(node, current);
      }
      // Appending in source order keeps cascade order; moving an attached node does not reload it.
      target.head.append(current);
    }
  };
  const syncRoots = () => {
    copyAttributes(source.documentElement, target.documentElement);
    copyAttributes(source.body, target.body);
  };
  syncHead();
  syncRoots();
  const view = source.defaultView;
  const headObserver = view ? new view.MutationObserver(syncHead) : null;
  headObserver?.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const rootObserver = view ? new view.MutationObserver(syncRoots) : null;
  rootObserver?.observe(source.documentElement, { attributes: true });
  rootObserver?.observe(source.body, { attributes: true });
  return () => {
    headObserver?.disconnect();
    rootObserver?.disconnect();
  };
}

function windowFeatures(bounds: DesktopDetachedPanelBounds | null): string {
  const { width, height } = bounds ?? DEFAULT_WINDOW_SIZE;
  return bounds
    ? `left=${bounds.x},top=${bounds.y},width=${width},height=${height}`
    : `width=${width},height=${height}`;
}

function createRoot(document: Document, attribute: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(attribute, "");
  return element;
}

/** Opens the named window, or returns it when already open. Desktop only. */
export function openDetachedWindow(
  name: string,
  bounds: DesktopDetachedPanelBounds | null,
): DetachedWindow | null {
  const existing = openWindows.get(name);
  if (existing && !existing.window.closed) return existing;
  // Same-origin about:blank shares this realm's globals shape.
  const child = window.open("about:blank", name, windowFeatures(bounds)) as
    | (Window & typeof globalThis)
    | null;
  if (!child) return null;
  const doc = child.document;
  doc.title = "T3 Code";
  const stopMirroring = mirrorDocumentStyles(document, doc);
  mirrorCodeViewerElement(child);
  const panelRoot = createRoot(doc, "data-detached-panel-root");
  panelRoot.className = "flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground";
  const webviewRoot = createRoot(doc, "data-detached-webview-root");
  webviewRoot.className = "contents";
  const portalRoot = doc.body;
  doc.body.replaceChildren(panelRoot, webviewRoot);
  const forget = () => {
    const current = openWindows.get(name);
    if (current?.window !== child) return;
    current.dispose();
    openWindows.delete(name);
    publish();
  };
  child.addEventListener("pagehide", forget);
  openWindows.set(name, {
    name,
    window: child,
    panelRoot,
    webviewRoot,
    portalRoot,
    dispose: () => {
      stopMirroring();
      child.removeEventListener("pagehide", forget);
      cancelConfirmDialogsIn(portalRoot);
    },
  });
  publish();
  return openWindows.get(name) ?? null;
}

export function setDetachedWindowTitle(detachedWindow: DetachedWindow, title: string): void {
  detachedWindow.window.document.title = title;
}

/** Forgets the window first, so its portals unmount, then has the desktop close it. */
export function closeDetachedWindow(name: string): void {
  const open = openWindows.get(name);
  if (open) {
    open.dispose();
    openWindows.delete(name);
    publish();
  }
  void window.desktopBridge?.detachedPanels?.close(name);
}

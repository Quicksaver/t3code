import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly initialFocus: ConfirmDialogOptions["initialFocus"];
      readonly container: HTMLElement | null;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly initialFocus: ConfirmDialogOptions["initialFocus"];
      readonly container: HTMLElement | null;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly initialFocus: ConfirmDialogOptions["initialFocus"];
  readonly container: HTMLElement | null;
  readonly resolve: (confirmed: boolean) => void;
};

let requestContainer: HTMLElement | null = null;
let resolveDefaultContainer: (() => HTMLElement | null) | null = null;

/** Where a confirmation renders when its request names no container, such as the focused window. */
export function setConfirmDialogContainerResolver(
  resolver: (() => HTMLElement | null) | null,
): void {
  resolveDefaultContainer = resolver;
}

/**
 * Confirmations requested synchronously inside `run` render in `container`, such as a
 * detached panel window whose close the user asked for.
 */
export function withConfirmDialogContainer<T>(container: HTMLElement, run: () => T): T {
  const previous = requestContainer;
  requestContainer = container;
  try {
    return run();
  } finally {
    requestContainer = previous;
  }
}

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    resolvePendingConfirmations(false);
    publish(idleState);
  };
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (listeners.size === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      initialFocus: options?.initialFocus,
      container: requestContainer ?? resolveDefaultContainer?.() ?? null,
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      message,
      variant: pending.variant,
      initialFocus: pending.initialFocus,
      container: pending.container,
    });
  });

  return confirmation;
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    initialFocus: state.initialFocus,
    container: state.container,
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    message: next.message,
    variant: next.variant,
    initialFocus: next.initialFocus,
    container: next.container,
  });
}

/**
 * Cancels confirmations shown or waiting in `container`, such as a detached panel window that
 * hid or closed. Its dialog can no longer be answered or finish closing, so the queue advances now.
 */
export function cancelConfirmDialogsIn(container: HTMLElement): void {
  const cancelled = queuedConfirmations.filter((pending) => pending.container === container);
  queuedConfirmations = queuedConfirmations.filter((pending) => pending.container !== container);
  for (const pending of cancelled) pending.resolve(false);
  if (activeConfirmation?.container === container) {
    activeConfirmation.resolve(false);
    activeConfirmation = null;
    publish({
      status: "closing",
      message: state.status === "idle" ? "" : state.message,
      variant: state.status === "idle" ? "default" : state.variant,
      container,
      initialFocus: state.status === "idle" ? undefined : state.initialFocus,
    });
  }
  if (state.status === "closing" && state.container === container) completeConfirmDialogClose();
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  resolvePendingConfirmations(false);
  publish(idleState);
}

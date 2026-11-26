import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface Subscription {
  readonly callback: ResizeCallback;
  active: boolean;
}

interface Target {
  readonly observer: WindowObserver;
  readonly subscriptions: Set<Subscription>;
  waiting: Set<Subscription> | null;
  last: ResizeObserverEntry | null;
}

interface WindowObserver {
  readonly observer: ResizeObserver;
  targets: number;
}

// One observer per window: a detached panel window lays out, and reports sizes, on its own frames.
const observers = new Map<Window | typeof globalThis, WindowObserver>();
const targets = new Map<Element, Target>();

function observerFor(element: Element): WindowObserver {
  const view = element.ownerDocument.defaultView ?? globalThis;
  let windowObserver = observers.get(view);
  if (!windowObserver) {
    const Observer = view.ResizeObserver ?? ResizeObserver;
    windowObserver = { observer: new Observer(deliver), targets: 0 };
    observers.set(view, windowObserver);
  }
  return windowObserver;
}

function releaseTarget(element: Element, target: Target) {
  target.observer.observer.unobserve(element);
  target.observer.targets -= 1;
  if (target.observer.targets > 0) return;
  target.observer.observer.disconnect();
  for (const [view, windowObserver] of observers) {
    if (windowObserver === target.observer) observers.delete(view);
  }
}

function deliver(entries: readonly ResizeObserverEntry[]) {
  const batches = new Map<Subscription, ResizeObserverEntry[]>();
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) continue;
    let recipients = target.subscriptions;
    if (target.waiting) {
      // Re-observing for a new subscriber redelivers an unchanged size to everyone else too.
      const previous = target.last?.contentRect;
      if (
        previous?.width === entry.contentRect.width &&
        previous.height === entry.contentRect.height
      ) {
        recipients = target.waiting;
      }
      target.waiting = null;
    }
    target.last = entry;
    for (const subscription of recipients) {
      const batch = batches.get(subscription);
      if (batch) batch.push(entry);
      else batches.set(subscription, [entry]);
    }
  }
  if (batches.size === 0) return;
  flushSync(() => {
    for (const [subscription, batch] of batches) {
      if (!subscription.active) continue;
      try {
        subscription.callback(batch);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });
}

/** Flushes callbacks together before paint; ordinary React updates would leave a stale frame. */
export function observeResize(
  elements: Element | readonly Element[],
  callback: ResizeCallback,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const subscription: Subscription = { callback, active: true };
  const observed: readonly Element[] = Array.isArray(elements) ? elements : [elements as Element];
  for (const element of observed) {
    const target = targets.get(element);
    if (!target) {
      const windowObserver = observerFor(element);
      windowObserver.targets += 1;
      targets.set(element, {
        observer: windowObserver,
        subscriptions: new Set([subscription]),
        waiting: null,
        last: null,
      });
      windowObserver.observer.observe(element);
      continue;
    }
    target.subscriptions.add(subscription);
    if (!target.last) continue;
    (target.waiting ??= new Set()).add(subscription);
    target.observer.observer.unobserve(element);
    target.observer.observer.observe(element);
  }
  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    for (const element of observed) {
      const target = targets.get(element);
      if (!target?.subscriptions.delete(subscription)) continue;
      target.waiting?.delete(subscription);
      if (target.subscriptions.size > 0) continue;
      targets.delete(element);
      releaseTarget(element, target);
    }
  };
}

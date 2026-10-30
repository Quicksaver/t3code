import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualizerOptions,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

// Publish measurements as an external-store snapshot so the compiler never caches the mutable instance.
function createVirtualList() {
  const listeners = new Set<() => void>();
  let snapshot: {
    readonly rows: readonly VirtualItem[];
    readonly height: number;
    readonly count: number;
    readonly getItemKey: VirtualizerOptions<HTMLElement, HTMLDivElement>["getItemKey"] | null;
  } = {
    rows: [],
    height: 0,
    count: 0,
    getItemKey: null,
  };
  const publish = () => {
    const rows = virtualizer.getVirtualItems();
    const height = virtualizer.getTotalSize();
    const { count, getItemKey } = virtualizer.options;
    if (
      snapshot.rows === rows &&
      snapshot.height === height &&
      snapshot.count === count &&
      snapshot.getItemKey === getItemKey
    )
      return;
    snapshot = { rows, height, count, getItemKey };
    for (const listener of listeners) listener();
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => null,
    estimateSize: () => 30,
    observeElementOffset,
    observeElementRect,
    scrollToFn: elementScroll,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => virtualizer._didMount(),
    commit: () => virtualizer._willUpdate(),
    update: (options: Partial<VirtualizerOptions<HTMLElement, HTMLDivElement>>) => {
      virtualizer.setOptions({ ...virtualizer.options, ...options });
      virtualizer._willUpdate();
      publish();
    },
    measureElement: virtualizer.measureElement,
  };
}

type SourceControlVirtualListProps<T> = {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
};

/** Lists fill their section's content while sharing its existing scroll viewport. */
export function SourceControlVirtualList<T>({
  items,
  getKey,
  renderItem,
}: SourceControlVirtualListProps<T>) {
  const getItemKey = (index: number) => getKey(items[index]!);
  return (
    <SourceControlVirtualListContent
      items={items}
      getItemKey={getItemKey}
      renderItem={renderItem}
    />
  );
}

function SourceControlVirtualListContent<T>({
  items,
  getItemKey,
  renderItem,
}: Omit<SourceControlVirtualListProps<T>, "getKey"> & {
  readonly getItemKey: (index: number) => string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState<number | null>(null);
  const getScrollElement = useStableCallback(
    () => listRef.current?.closest<HTMLElement>("[data-source-control-section-content]") ?? null,
  );
  const [list] = useState(createVirtualList);
  const [snapshot, setSnapshot] = useState(list.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish external virtualizer measurements before the browser paints.
  useLayoutEffect(() => list.subscribe(() => setSnapshot(list.getSnapshot())), [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attach and detach the external virtualizer with the mounted DOM.
  useLayoutEffect(() => list.mount(), [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize virtualizer options after the shared scroll container is measured.
  useLayoutEffect(() => {
    list.update({
      count: items.length,
      enabled: scrollMargin !== null,
      getScrollElement,
      // Attaching a nested list must start from the shared viewport's current position.
      initialOffset: () => getScrollElement()?.scrollTop ?? 0,
      getItemKey,
      scrollMargin: scrollMargin ?? 0,
    });
  }, [list, items.length, getScrollElement, getItemKey, scrollMargin]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Commit measurements after DOM layout, including measurement-only scroll compensation.
  useLayoutEffect(() => {
    list.commit();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe DOM geometry changes that move this list inside its shared scroller.
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = getScrollElement();
    if (!list || !scroller) return;

    const updateMargin = () => {
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          scroller.clientTop +
          scroller.scrollTop,
      );
    };
    updateMargin();

    // Headers, sibling lists and expanded commits can move this list without resizing it.
    const elements: HTMLElement[] = [];
    for (let element: HTMLElement | null = list; element; element = element.parentElement) {
      elements.push(element);
      if (element === scroller) break;
    }
    return observeResize(elements, updateMargin);
  }, [getScrollElement]);

  const measurementsCurrent = snapshot.count === items.length && snapshot.getItemKey === getItemKey;
  return (
    <div ref={listRef} className="relative" style={{ height: snapshot.height }}>
      {snapshot.rows
        .filter((row) => row.index < items.length)
        .map((row) => (
          <div
            key={getItemKey(row.index)}
            data-index={row.index}
            ref={measurementsCurrent ? list.measureElement : undefined}
            className="absolute left-0 top-0 w-full pb-0.5"
            style={{ transform: `translateY(${row.start - (scrollMargin ?? 0)}px)` }}
          >
            {renderItem(items[row.index]!)}
          </div>
        ))}
    </div>
  );
}

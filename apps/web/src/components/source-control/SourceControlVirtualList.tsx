import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualizerOptions,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

// Publish measurements as an external-store snapshot so the compiler never caches the mutable instance.
function createVirtualList() {
  const listeners = new Set<() => void>();
  let snapshot: { readonly rows: readonly VirtualItem[]; readonly height: number } = {
    rows: [],
    height: 0,
  };
  const publish = () => {
    const rows = virtualizer.getVirtualItems();
    const height = virtualizer.getTotalSize();
    if (snapshot.rows === rows && snapshot.height === height) return;
    snapshot = { rows, height };
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
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useStableCallback(
    () => listRef.current?.closest<HTMLElement>("[data-source-control-section-content]") ?? null,
  );
  const [list] = useState(createVirtualList);
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  useLayoutEffect(() => list.mount(), [list]);
  useLayoutEffect(() => {
    list.update({
      count: items.length,
      enabled: true,
      getScrollElement,
      initialOffset: () => getScrollElement()?.scrollTop ?? 0,
      getItemKey,
      scrollMargin,
    });
  }, [list, items.length, getScrollElement, getItemKey, scrollMargin]);

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

  return (
    <div ref={listRef} className="relative" style={{ height: snapshot.height }}>
      {snapshot.rows
        .filter((row) => row.index < items.length)
        .map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={list.measureElement}
            className="absolute left-0 top-0 w-full pb-0.5"
            style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
          >
            {renderItem(items[row.index]!)}
          </div>
        ))}
    </div>
  );
}

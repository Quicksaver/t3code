import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

function useItemKey<T>(items: readonly T[], getKey: (item: T) => string) {
  return (index: number) => getKey(items[index]!);
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
  "use no memo"; // TanStack Virtual exposes a mutable instance that React Compiler cannot memoize.

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [mounted, setMounted] = useState(false);
  const getScrollElement = useStableCallback(
    () => listRef.current?.closest<HTMLElement>("[data-source-control-section-content]") ?? null,
  );
  const getItemKey = useItemKey(items, getKey);
  // This component opts out of compilation above; the mutable instance stays local.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: items.length,
    // Attaching scrolls the shared viewport to the initial offset, so a list mounted by
    // expanding a row must attach after mount and start from the viewport's position.
    enabled: mounted,
    getScrollElement,
    initialOffset: () => getScrollElement()?.scrollTop ?? 0,
    getItemKey,
    estimateSize: () => 30,
    overscan: 6,
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
  });

  useLayoutEffect(() => setMounted(true), []);

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
    <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute left-0 top-0 w-full pb-0.5"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          {renderItem(items[row.index]!)}
        </div>
      ))}
    </div>
  );
}

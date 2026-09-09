import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react";
import type { ReactNode } from "react";

/** Large tree leaves get a bounded viewport; selection and expansion remain owned by the panel. */
export function SourceControlVirtualList<T>({
  items,
  getKey,
  renderItem,
}: {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
}) {
  if (items.length <= 40) {
    return (
      <div className="space-y-0.5">
        {items.map((item) => (
          <div key={getKey(item)}>{renderItem(item)}</div>
        ))}
      </div>
    );
  }
  return (
    <LegendList<T>
      data={items}
      extraData={renderItem}
      keyExtractor={getKey}
      renderItem={({ item }: LegendListRenderItemProps<T>) => (
        <div className="pb-0.5">{renderItem(item)}</div>
      )}
      estimatedItemSize={30}
      drawDistance={180}
      style={{ height: 420, maxHeight: "60vh" }}
      maintainVisibleContentPosition
      recycleItems={false}
    />
  );
}

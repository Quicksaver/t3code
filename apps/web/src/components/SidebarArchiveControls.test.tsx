import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarArchiveAllButton } from "./SidebarArchiveControls";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";

function clickEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

async function render(element: Parameters<typeof create>[0]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

describe("SidebarArchiveAllButton in a section header", () => {
  it("stays beside the toggle and keeps its identity until an in-flight batch completes", async () => {
    const onToggle = vi.fn();
    const onArchiveAll = vi.fn();
    const header = (expanded: boolean, archivableCount: number, isArchiving: boolean) => (
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={onToggle}
        trailing={
          <SidebarArchiveAllButton
            archivableCount={archivableCount}
            isArchiving={isArchiving}
            onArchiveAll={onArchiveAll}
          />
        }
      >
        Settled
      </CollapsibleSectionHeader>
    );
    const renderer = await render(header(false, 3, false));
    try {
      const [toggle, archiveAll] = renderer.root.findAllByType("button");
      expect(toggle!.findAllByType("button")).toEqual([toggle]);

      const event = clickEvent();
      archiveAll!.props.onClick(event);
      expect(onArchiveAll).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(onToggle).not.toHaveBeenCalled();

      // Every archivable row has left the shelf while the batch is in flight.
      await act(async () => {
        renderer.update(header(true, 0, true));
      });
      expect(renderer.root.findAllByType("button")).toEqual([toggle, archiveAll]);
      // Still focusable while busy: unavailable through ARIA, not `disabled`.
      expect(archiveAll!.props.disabled).toBeUndefined();
      expect(archiveAll!.props["aria-disabled"]).toBe(true);

      await act(async () => {
        renderer.update(header(true, 0, false));
      });
      expect(renderer.root.findAllByType("button")).toEqual([toggle]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

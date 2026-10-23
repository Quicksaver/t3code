import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarArchiveAllButton } from "./SidebarArchiveControls";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";

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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (node: ReactNode) => act(() => root.render(node));
    await render(header(false, 3, false));
    try {
      const [toggle, archiveAll] = container.querySelectorAll("button");
      expect(toggle!.contains(archiveAll!)).toBe(false);

      archiveAll!.focus();
      await act(() => archiveAll!.click());
      expect(onArchiveAll).toHaveBeenCalledOnce();
      expect(onToggle).not.toHaveBeenCalled();

      // Every archivable row has left the shelf while the batch is in flight.
      await render(header(true, 0, true));
      expect([...container.querySelectorAll("button")]).toEqual([toggle, archiveAll]);
      expect(document.activeElement).toBe(archiveAll);
      // Still focusable while busy: unavailable through ARIA, not `disabled`.
      expect(archiveAll!.disabled).toBe(false);
      expect(archiveAll!.getAttribute("aria-disabled")).toBe("true");

      await render(header(true, 0, false));
      expect([...container.querySelectorAll("button")]).toEqual([toggle]);
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

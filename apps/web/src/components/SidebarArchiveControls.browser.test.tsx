import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarArchiveAllButton } from "./SidebarArchiveControls";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";

describe("SidebarArchiveAllButton in a section header", () => {
  it("can archive a shelf whose settled threads have not loaded yet", async () => {
    const onArchiveAll = vi.fn();
    // This isolated shelf action has no navigation.
    await using screen = await render(
      <SidebarArchiveAllButton
        archivableCount={0}
        hasUnloadedThreads
        isArchiving={false}
        onArchiveAll={onArchiveAll}
      />,
      { router: false },
    );
    await screen.getByRole("button", { name: "Archive all settled threads" }).click();
    expect(onArchiveAll).toHaveBeenCalledOnce();
  });

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
    // The header has no navigation; only its toggle and trailing action are under test.
    await using screen = await render(header(false, 3, false), { router: false });
    const { container } = screen;
    const [toggle, archiveAll] = container.querySelectorAll("button");
    expect(toggle!.contains(archiveAll!)).toBe(false);

    archiveAll!.focus();
    await act(() => archiveAll!.click());
    expect(onArchiveAll).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();

    // Every archivable row has left the shelf while the batch is in flight.
    await screen.rerender(header(true, 0, true));
    expect([...container.querySelectorAll("button")]).toEqual([toggle, archiveAll]);
    expect(document.activeElement).toBe(archiveAll);
    // Still focusable while busy: unavailable through ARIA, not `disabled`.
    expect(archiveAll!.disabled).toBe(false);
    expect(archiveAll!.getAttribute("aria-disabled")).toBe("true");

    await screen.rerender(header(true, 0, false));
    expect([...container.querySelectorAll("button")]).toEqual([toggle]);
  });
});

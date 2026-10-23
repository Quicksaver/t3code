import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { SourceControlVirtualList } from "./SourceControlVirtualList";
import "~/index.css";

function FileList({ files }: { readonly files: readonly string[] }) {
  return (
    <div data-source-control-section-content className="h-30 overflow-y-auto">
      <SourceControlVirtualList
        items={files}
        getKey={(file) => file}
        renderItem={(file) => <div>{file}</div>}
      />
    </div>
  );
}

it("updates virtual rows when the file identities and count change", async () => {
  await using screen = await render(<FileList files={["before.ts"]} />);
  await expect.element(screen.getByText("before.ts")).toBeVisible();
  await screen.rerender(<FileList files={["after.ts", "added.ts"]} />);
  await expect.element(screen.getByText("after.ts")).toBeVisible();
  await expect.element(screen.getByText("added.ts")).toBeVisible();
  await expect.element(screen.getByText("before.ts")).not.toBeInTheDocument();
});

it("preserves a surviving row's focus when an earlier row is removed", async () => {
  const list = (files: readonly string[]) => (
    <div data-source-control-section-content style={{ height: 120, overflowY: "auto" }}>
      <SourceControlVirtualList
        items={files}
        getKey={(file) => file}
        renderItem={(file) => <button>{file}</button>}
      />
    </div>
  );
  await using screen = await render(list(["a", "b", "c"]));
  await expect.element(screen.getByRole("button", { name: "c", exact: true })).toBeVisible();
  const button = screen.getByRole("button", { name: "c", exact: true }).element();
  button.focus();
  await screen.rerender(list(["b", "c"]));
  expect(screen.getByRole("button", { name: "c", exact: true }).element()).toBe(button);
  expect(document.activeElement).toBe(button);
});

const rows = Array.from({ length: 30 }, (_, index) => `row-${index}`);

it("retries scroll compensation after a measured row grows above a bottom viewport", async () => {
  await using screen = await render(
    <div
      data-source-control-section-content
      style={{ height: 120, overflowY: "auto", overflowAnchor: "none" }}
    >
      <SourceControlVirtualList
        items={rows}
        getKey={(row) => row}
        renderItem={(row) => (
          <div data-row={row} style={{ height: "calc(30px - 0.125rem)" }}>
            {row}
          </div>
        )}
      />
    </div>,
  );
  const scroller = screen.container.querySelector<HTMLElement>(
    "[data-source-control-section-content]",
  )!;
  await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(800));
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect.element(screen.getByText("row-29", { exact: true })).toBeVisible();
  // Measurements can replace estimates while the bottom rows attach.
  await vi.waitFor(() => expect(scroller.querySelector('[data-row="row-24"]')).not.toBeNull());
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
  });
  const before = scroller.scrollTop;
  const row = scroller.querySelector<HTMLElement>('[data-row="row-24"]')!;
  expect(row.getBoundingClientRect().bottom).toBeLessThan(scroller.getBoundingClientRect().top);
  row.style.height = "calc(90px - 0.125rem)";
  await vi.waitFor(() => expect(scroller.scrollTop).toBe(before + 60));
});

it("keeps the shared viewport position when a second list attaches", async () => {
  const list = (expanded: boolean) => (
    <div
      data-source-control-section-content
      style={{ height: 120, overflowY: "auto", overflowAnchor: "none" }}
    >
      <SourceControlVirtualList
        items={rows}
        getKey={(row) => row}
        renderItem={(row) => <div style={{ height: "calc(30px - 0.125rem)" }}>{row}</div>}
      />
      {expanded && (
        <SourceControlVirtualList
          items={["nested"]}
          getKey={(row) => row}
          renderItem={(row) => <div style={{ height: "calc(30px - 0.125rem)" }}>{row}</div>}
        />
      )}
    </div>
  );
  await using screen = await render(list(false));
  const scroller = screen.container.querySelector<HTMLElement>(
    "[data-source-control-section-content]",
  )!;
  await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(800));
  await act(() => {
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() => expect(scroller.scrollTop).toBe(300));
  await screen.rerender(list(true));
  expect(scroller.scrollTop).toBe(300);
});

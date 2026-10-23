import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { SourceControlVirtualList } from "./SourceControlVirtualList";

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

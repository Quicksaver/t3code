import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SubagentControlBar } from "./SubagentControlBar";

describe("SubagentControlBar", () => {
  it("renders a running child with its stop control", () => {
    const markup = renderToStaticMarkup(
      <SubagentControlBar
        title="Inspect composer integration"
        status="running"
        startedAt="2026-08-27T10:00:00.000Z"
        completedAt={null}
        stopping={false}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Subagent - Inspect composer integration");
    expect(markup).toContain("Working for");
    expect(markup).toContain(">Stop</button>");
  });

  it("renders terminal status without the stop control", () => {
    const markup = renderToStaticMarkup(
      <SubagentControlBar
        title="Completed audit"
        status="completed"
        startedAt="2026-08-27T10:00:00.000Z"
        completedAt="2026-08-27T10:00:02.000Z"
        stopping={false}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Subagent - Completed audit");
    expect(markup).toContain("Completed in 2.0s");
    expect(markup).not.toContain(">Stop</button>");
  });
});

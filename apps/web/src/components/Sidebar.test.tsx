import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SubagentCountButton, SubagentRunningTooltipRow } from "./Sidebar";

describe("SubagentCountButton", () => {
  it("renders a running count that opens the Agents panel without disclosure", () => {
    const markup = renderToStaticMarkup(
      <SubagentCountButton count={2} threadTitle="Root thread" onOpen={() => undefined} />,
    );

    expect(markup).toContain('data-testid="sidebar-v2-subagent-indicator"');
    expect(markup).toContain('aria-label="Open 2 running subagents for Root thread"');
    expect(markup).not.toContain("lucide-chevron-right");
    expect(markup).not.toContain("aria-expanded");
  });
});

describe("SubagentRunningTooltipRow", () => {
  it("renders the same running count in its own tooltip row", () => {
    const markup = renderToStaticMarkup(<SubagentRunningTooltipRow count={2} />);

    expect(markup).toContain('data-testid="sidebar-v2-tooltip-subagent-indicator"');
    expect(markup).toContain("lucide-bot");
    expect(markup).toContain("2 subagents running");
  });

  it("uses a singular label and follows the row indicator's zero-count condition", () => {
    expect(renderToStaticMarkup(<SubagentRunningTooltipRow count={1} />)).toContain(
      "1 subagent running",
    );
    expect(renderToStaticMarkup(<SubagentRunningTooltipRow count={0} />)).toBe("");
  });
});

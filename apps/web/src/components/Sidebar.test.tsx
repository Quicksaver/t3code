import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/openPullRequestLink", () => ({
  useOpenPrLink: () => vi.fn(() => false),
}));

vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => [],
}));

vi.mock("./ProjectFavicon", () => ({
  ProjectFavicon: () => <span data-testid="project-favicon" />,
}));

vi.mock("./ThreadStatusIndicators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadStatusIndicators")>()),
  useLinkedThreadPullRequest: () => null,
}));

import { SidebarThreadRow, SubagentCountButton, SubagentRunningTooltipRow } from "./Sidebar";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeSettledPinnedThread(): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-settled-pinned"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Settled pinned thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    latestTurn: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    archivedAt: null,
    settledOverride: "settled",
    settledAt: "2026-08-27T09:00:00.000Z",
    pinnedAt: "2026-08-27T08:30:00.000Z",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

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

describe("SidebarThreadRow", () => {
  it("keeps the pin marker before adjacent un-settle and archive controls", () => {
    const markup = renderToStaticMarkup(
      <SidebarThreadRow
        thread={makeSettledPinnedThread()}
        variant="slim"
        variantAction="unsettle"
        settlementSupported
        snoozeSupported={false}
        pinningSupported
        isPinned
        snoozeWakeLabelText={null}
        wokeAt={null}
        isActive={false}
        openPullRequestsInRightPanel={false}
        jumpLabel={null}
        currentEnvironmentId={localEnvironmentId}
        environmentMachine="server"
        environmentLabel={null}
        projectCwd={null}
        projectFaviconPath={null}
        projectIcon={null}
        projectTitle="Project"
        projectDisplayName="Project"
        providerEntryByInstanceId={new Map()}
        timestampFormat="locale"
        onThreadClick={vi.fn()}
        onThreadActivate={vi.fn()}
        onStartRename={vi.fn()}
        onRenameTitleChange={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        isRenaming={false}
        renamingTitle=""
        onContextMenu={vi.fn()}
        onSettle={vi.fn()}
        onUnsettle={vi.fn()}
        onArchive={vi.fn()}
        onSnooze={vi.fn()}
        onUnsnooze={vi.fn()}
        onUnpin={vi.fn()}
        onAcknowledgeWoke={vi.fn()}
        trailingDecoration={null}
        subagentCount={0}
        changeRequestSnapshot={null}
        onChangeRequestSnapshot={vi.fn()}
      />,
    );

    const pinIndex = markup.indexOf('aria-label="Unpin thread"');
    const statusSlotIndex = markup.indexOf("group/sidebar-slim-status-slot");
    const unsettleIndex = markup.indexOf('aria-label="Un-settle thread"');
    const archiveIndex = markup.indexOf('aria-label="Archive thread"');

    expect(markup).toContain('data-testid="sidebar-row-slim"');
    expect(pinIndex).toBeGreaterThan(-1);
    expect(statusSlotIndex).toBeGreaterThan(pinIndex);
    expect(unsettleIndex).toBeGreaterThan(statusSlotIndex);
    expect(archiveIndex).toBeGreaterThan(unsettleIndex);
  });
});

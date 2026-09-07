import { renderToStaticMarkup } from "react-dom/server";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AgentsPanel, resolveAgentRowNavigation } from "./AgentsPanel";

function makeAgentActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "task.started",
    summary: "Agent started",
    payload: {
      taskId: "provider-child-1",
      title: "Provider nickname",
      agentKind: "agent",
    },
    turnId: null,
    createdAt: "2026-08-07T09:00:00.000Z",
  };
}

function makeTaskActivity(
  id: string,
  kind: "task.started" | "task.completed",
  payload: Record<string, unknown>,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt,
  };
}

describe("AgentsPanel child conversation links", () => {
  it("uses the persisted child title and exposes navigation for a resolved agent", () => {
    const model = deriveAgentPanelModel({ agents: foldSubagentActivities([makeAgentActivity()]) });
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        titleByAgentId={new Map([["provider-child-1", "Generated child title"]])}
        onOpenAgent={() => undefined}
      />,
    );

    expect(markup).toContain("Generated child title");
    expect(markup).not.toContain("Provider nickname");
    expect(markup).toContain('aria-label="Open Generated child title"');
  });

  it("invokes resolved navigation with the provider agent id", () => {
    const onOpenAgent = vi.fn();
    const navigation = resolveAgentRowNavigation(
      { id: "provider-child-1", title: "Provider nickname" },
      {
        titleByAgentId: new Map([["provider-child-1", "Generated child title"]]),
        onOpenAgent,
      },
    );

    navigation.onOpen?.();

    expect(navigation.title).toBe("Generated child title");
    expect(onOpenAgent).toHaveBeenCalledWith("provider-child-1");
  });

  it("keeps the provider title and no navigation when the child is unresolved", () => {
    const navigation = resolveAgentRowNavigation(
      { id: "provider-child-1", title: "Provider nickname" },
      { titleByAgentId: new Map(), onOpenAgent: vi.fn() },
    );
    const model = deriveAgentPanelModel({ agents: foldSubagentActivities([makeAgentActivity()]) });
    const markup = renderToStaticMarkup(
      <AgentsPanel model={model} titleByAgentId={new Map()} onOpenAgent={vi.fn()} />,
    );

    expect(navigation).toEqual({ title: "Provider nickname", onOpen: null });
    expect(markup).toContain("Provider nickname");
    expect(markup).not.toContain('aria-label="Open Provider nickname"');
  });

  it("keeps resolved agents noninteractive when navigation is disabled", () => {
    const model = deriveAgentPanelModel({ agents: foldSubagentActivities([makeAgentActivity()]) });
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        titleByAgentId={new Map([["provider-child-1", "Generated child title"]])}
        onOpenAgent={null}
      />,
    );

    expect(markup).toContain("Generated child title");
    expect(markup).not.toContain('aria-label="Open Generated child title"');
  });

  it("renders live branches before finished branches and indents nested agents", () => {
    const model = deriveAgentPanelModel({
      agents: foldSubagentActivities([
        makeTaskActivity(
          "finished-start",
          "task.started",
          {
            taskId: "finished",
            title: "Finished direct",
            agentKind: "agent",
            agentPath: "/root/finished",
          },
          "2026-08-07T09:00:00.000Z",
        ),
        makeTaskActivity(
          "parent-start",
          "task.started",
          {
            taskId: "parent",
            title: "Finished parent",
            agentKind: "agent",
            agentPath: "/root/parent",
          },
          "2026-08-07T09:00:01.000Z",
        ),
        makeTaskActivity(
          "direct-start",
          "task.started",
          {
            taskId: "direct",
            title: "Running direct",
            agentKind: "agent",
            agentPath: "/root/direct",
          },
          "2026-08-07T09:00:02.000Z",
        ),
        makeTaskActivity(
          "child-start",
          "task.started",
          {
            taskId: "child",
            title: "Running nested child",
            taskType: "local_agent",
            agentKind: "agent",
            agentId: "parent",
            agentPath: "/root/parent/child",
          },
          "2026-08-07T09:00:03.000Z",
        ),
        makeTaskActivity(
          "finished-completed",
          "task.completed",
          { taskId: "finished", status: "completed", agentKind: "agent" },
          "2026-08-07T09:00:04.000Z",
        ),
        makeTaskActivity(
          "parent-completed",
          "task.completed",
          { taskId: "parent", status: "completed", agentKind: "agent" },
          "2026-08-07T09:00:05.000Z",
        ),
      ]),
    });
    const markup = renderToStaticMarkup(<AgentsPanel model={model} />);

    const parentIndex = markup.indexOf("Finished parent");
    const childIndex = markup.indexOf("Running nested child");
    const directIndex = markup.indexOf("Running direct");
    const finishedIndex = markup.indexOf("Finished direct");
    expect(parentIndex).toBeGreaterThan(-1);
    expect(parentIndex).toBeLessThan(childIndex);
    expect(childIndex).toBeLessThan(directIndex);
    expect(directIndex).toBeLessThan(finishedIndex);
    expect(markup.match(/padding-left:0\.75rem/g)).toHaveLength(1);
  });
});

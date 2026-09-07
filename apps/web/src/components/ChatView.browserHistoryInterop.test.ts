import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationThreadParentRelation,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readPreparedConnection } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn<() => { httpBaseUrl: string } | null>(() => null),
}));

vi.mock("~/state/session", () => ({ readPreparedConnection }));

import {
  recordVisitForThread,
  resetBrowserHistoryForTests,
  useBrowserHistoryStore,
} from "../browserHistoryStore";
import { derivePhysicalProjectKey } from "../logicalProject";
import type { Project } from "../types";
import { registerChatViewThreadProject } from "./ChatView.browserHistoryInterop";
import { deriveAgentChildConversationByProviderId } from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeSubagentRelation(input: {
  rootThreadId: ThreadId;
  providerThreadId: string;
}): Extract<OrchestrationThreadParentRelation, { kind: "subagent" }> {
  return {
    kind: "subagent",
    rootThreadId: input.rootThreadId,
    parentThreadId: input.rootThreadId,
    parentTurnId: TurnId.make("parent-turn"),
    parentItemId: ProviderItemId.make("parent-item"),
    parentActivitySequence: 1,
    providerThreadId: input.providerThreadId,
    titleSeed: "Child task",
    depth: 1,
    startedAt: "2026-08-07T00:00:00.000Z",
    completedAt: null,
    status: "running",
  };
}

describe("ChatView child conversation browser-history interop", () => {
  beforeEach(() => {
    readPreparedConnection.mockReturnValue(null);
    resetBrowserHistoryForTests();
  });

  it("records an Agents-panel child under the canonical logical project", () => {
    const rootThreadId = ThreadId.make("root-thread");
    const childThreadId = ThreadId.make("child-thread");
    const providerThreadId = "provider-child-thread";
    const childConversation = deriveAgentChildConversationByProviderId({
      activeThread: { environmentId, id: rootThreadId },
      threadShells: [
        {
          environmentId,
          id: childThreadId,
          title: "Persisted child title",
          parentRelation: makeSubagentRelation({ rootThreadId, providerThreadId }),
        },
      ],
    }).get(providerThreadId);
    expect(childConversation).toBeDefined();

    const staleProject = makeProject({
      id: ProjectId.make("project-stale"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonicalProject = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    registerChatViewThreadProject({
      threadRef: childConversation!.threadRef,
      activeProject: staleProject,
      projects: [staleProject, canonicalProject],
      settings: groupingSettings,
      primaryEnvironmentId: environmentId,
    });
    const childRef = childConversation!.threadRef;
    recordVisitForThread(childRef, "http://localhost:5173/dashboard", 1234);

    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({
      [repositoryIdentity.canonicalKey]: [
        { url: "http://localhost:5173/dashboard", lastVisitedAt: 1234 },
      ],
    });
    expect(useBrowserHistoryStore.getState().byProjectKey).not.toHaveProperty(
      derivePhysicalProjectKey(staleProject),
    );
  });
});

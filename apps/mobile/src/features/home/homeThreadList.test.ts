import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildHomeProjectScopes,
  buildHomeProjectTitleIndex,
  buildHomeThreadGroups,
  sortHomeProjectScopes,
} from "./homeThreadList";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

const NOW = Date.parse("2026-06-29T00:00:00.000Z");

function subagentRelation(input: {
  readonly rootThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly sequence: number;
  readonly status?: "running" | "completed" | "errored" | "interrupted" | "stopped";
  readonly depth?: number;
}) {
  return {
    kind: "subagent" as const,
    rootThreadId: input.rootThreadId,
    parentThreadId: input.parentThreadId,
    parentTurnId: TurnId.make("turn-parent"),
    parentItemId: ProviderItemId.make(`item-${input.sequence}`),
    parentActivitySequence: input.sequence,
    providerThreadId: `provider-child-${input.sequence}`,
    titleSeed: "Inspect child work",
    depth: input.depth ?? 1,
    startedAt: `2026-06-01T00:00:0${input.sequence}.000Z`,
    completedAt: input.status && input.status !== "running" ? "2026-06-01T00:01:00.000Z" : null,
    status: input.status ?? "running",
  };
}

function makePendingTask(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly messageId: string;
  readonly title: string;
  readonly createdAt?: string;
}): PendingNewTask {
  const creation = {
    projectId: input.projectId,
    projectTitle: "Queued project",
    projectCwd: `/workspaces/${input.projectId}`,
    workspaceMode: "local" as const,
    branch: null,
    worktreePath: null,
  };
  const message = {
    environmentId: input.environmentId,
    threadId: ThreadId.make(`pending-thread-${input.messageId}`),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.title,
    attachments: [],
    creation,
    createdAt: input.createdAt ?? "2026-06-04T00:00:00.000Z",
  };
  return {
    message,
    creation,
    title: input.title,
  };
}

function buildGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: Partial<Parameters<typeof buildHomeThreadGroups>[0]> = {},
) {
  return buildHomeThreadGroups({
    projects,
    threads,
    environmentId: null,
    searchQuery: "",
    projectSortOrder: "updated_at",
    threadSortOrder: "updated_at",
    projectGroupingMode: "repository",
    now: NOW,
    ...overrides,
  });
}

describe("buildHomeThreadGroups", () => {
  it("builds one v2 scope for the same repository across environments", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "t3code",
        repositoryIdentity,
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.title).toBe("t3code");
    expect(scopes[0]?.projects).toEqual(projects);
    expect(scopes[0]?.projectRefs).toEqual(
      projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    );
  });

  it("routes stale duplicate project refs through the canonical repository group", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const local = makeProject({
      id: ProjectId.make("project-local"),
      environmentId: localEnvironmentId,
      title: "t3code",
      workspaceRoot: "/workspaces/t3code",
      repositoryIdentity,
    });
    const stale = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-stale"),
      title: "t3code",
      workspaceRoot: "/remote/t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const canonicalRemote = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-canonical-remote"),
      title: "t3code",
      workspaceRoot: "/remote/t3code/",
      repositoryIdentity,
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const projects = [local, stale, canonicalRemote];
    const staleThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-stale-project-ref"),
      projectId: stale.id,
      title: "Still visible",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });
    const groups = buildGroups(projects, [staleThread]);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.projects.map((project) => project.id)).toEqual([
      local.id,
      canonicalRemote.id,
    ]);
    expect(scopes[0]?.projectRefs.map((projectRef) => projectRef.projectId)).toEqual([
      local.id,
      stale.id,
      canonicalRemote.id,
    ]);
    expect(buildHomeProjectTitleIndex(scopes)).toEqual(
      new Map([
        [`${localEnvironmentId}:${local.id}`, "t3code"],
        [`${remoteEnvironmentId}:${stale.id}`, "t3code"],
        [`${remoteEnvironmentId}:${canonicalRemote.id}`, "t3code"],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([staleThread.id]);
    expect(groups[0]?.newThreadTarget?.id).toBe(canonicalRemote.id);
  });

  it("keeps an active terminal subagent path inside a canonicalized project group", () => {
    const environmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const stale = makeProject({
      environmentId,
      id: ProjectId.make("project-stale"),
      title: "Old project shell",
      workspaceRoot: "/remote/t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      environmentId,
      id: ProjectId.make("project-canonical"),
      title: "T3 Code",
      workspaceRoot: "/remote/t3code/",
      repositoryIdentity,
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const root = makeThread({
      environmentId,
      id: ThreadId.make("thread-root"),
      projectId: stale.id,
      title: "Root",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
    const terminalChild = makeThread({
      environmentId,
      id: ThreadId.make("thread-terminal-child"),
      projectId: stale.id,
      title: "Terminal child",
      updatedAt: "2026-06-04T00:00:00.000Z",
      parentRelation: subagentRelation({
        rootThreadId: root.id,
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });

    const group = buildGroups([stale, canonical], [root, terminalChild], {
      activeThreadKey: scopedThreadKey(environmentId, terminalChild.id),
    })[0];

    expect(group?.projects.map((project) => project.id)).toEqual([canonical.id]);
    expect(group?.threads.map((thread) => thread.id)).toEqual([root.id, terminalChild.id]);
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual([root.id, terminalChild.id]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, terminalChild.id))).toBe(1);
    expect(group?.newThreadTarget?.id).toBe(canonical.id);
  });

  it("keeps repository identity from an older duplicate when the freshness winner lacks it", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-with-identity"),
        title: "t3code",
        workspaceRoot: "/remote/t3code",
        repositoryIdentity,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-fresh"),
        title: "t3code",
        workspaceRoot: "/remote/t3code/",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.representative.id).toBe(ProjectId.make("project-local"));
    expect(scopes[0]?.projects.map((project) => project.id)).toContain(
      ProjectId.make("project-remote-fresh"),
    );
    expect(scopes[0]?.projectRefs).toHaveLength(3);
  });

  it("sorts v2 project scopes by their grouped thread activity", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const olderProject = makeProject({
      environmentId,
      id: ProjectId.make("project-older"),
      title: "Older project",
    });
    const newerProject = makeProject({
      environmentId,
      id: ProjectId.make("project-newer"),
      title: "Newer project",
    });
    const scopes = buildHomeProjectScopes({
      projects: [newerProject, olderProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [
          makeThread({
            environmentId,
            id: ThreadId.make("thread-older-project"),
            projectId: olderProject.id,
            title: "Most recently active",
            updatedAt: "2026-06-03T00:00:00.000Z",
          }),
          makeThread({
            environmentId,
            id: ThreadId.make("thread-newer-project"),
            projectId: newerProject.id,
            title: "Less recently active",
            updatedAt: "2026-06-02T00:00:00.000Z",
          }),
        ],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([olderProject.id, newerProject.id]);
  });

  it("sorts invalid project creation timestamps after valid ones", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const invalidProject = makeProject({
      environmentId,
      id: ProjectId.make("project-invalid"),
      title: "A invalid timestamp",
      createdAt: "invalid",
    });
    const validProject = makeProject({
      environmentId,
      id: ProjectId.make("project-valid"),
      title: "Z valid timestamp",
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [invalidProject, validProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "created_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([validProject.id, invalidProject.id]);
  });

  it("uses the freshest member when a grouped scope has no activity", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const olderMember = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-older-member"),
      title: "t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
      repositoryIdentity,
    });
    const newerMember = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-newer-member"),
      title: "t3code",
      updatedAt: "2026-06-03T00:00:00.000Z",
      repositoryIdentity,
    });
    const otherProject = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-other"),
      title: "other",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [olderMember, newerMember, otherProject],
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      })[0]?.key,
    ).toBe(scopes.find((scope) => scope.projects.length === 2)?.key);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });

  it("uses the physical project title for a singleton scope", () => {
    const project = makeProject({
      environmentId: EnvironmentId.make("environment-1"),
      id: ProjectId.make("project-1"),
      title: "local-worktree-name",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        displayName: "codething-mvp",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:pingdotgg/t3code.git",
        },
      },
    });

    const scopes = buildHomeProjectScopes({
      projects: [project],
      environmentId: null,
      projectGroupingMode: "repository",
    });
    const groups = buildGroups(
      [project],
      [
        makeThread({
          environmentId: project.environmentId,
          id: ThreadId.make("thread-1"),
          projectId: project.id,
          title: "Thread",
        }),
      ],
    );

    expect(scopes[0]?.title).toBe("local-worktree-name");
    expect(groups[0]?.title).toBe("local-worktree-name");
  });

  it("sorts the newest thread first regardless of snapshot order", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("thread-old"),
        projectId: project.id,
        title: "Older thread",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-new"),
        projectId: project.id,
        title: "Newer thread",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    ];

    expect(buildGroups([project], threads)[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-new",
      "thread-old",
    ]);
  });

  it("supports independent project and thread creation-time sorting", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const olderProject = makeProject({
      environmentId,
      id: ProjectId.make("project-older"),
      title: "Older project",
    });
    const newerProject = makeProject({
      environmentId,
      id: ProjectId.make("project-newer"),
      title: "Newer project",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("old-created"),
        projectId: olderProject.id,
        title: "Updated recently",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("new-created"),
        projectId: olderProject.id,
        title: "Created recently",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("newest-project-thread"),
        projectId: newerProject.id,
        title: "Newest project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }),
    ];

    const groups = buildGroups([olderProject, newerProject], threads, {
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "separate",
    });

    expect(groups.map((group) => group.representative.id)).toEqual([
      "project-newer",
      "project-older",
    ]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual(["new-created", "old-created"]);
  });

  it("filters both projects and threads to one environment", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "Local",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "Remote",
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId: project.environmentId,
        id: ThreadId.make(`thread-${project.id}`),
        projectId: project.id,
        title: project.title,
      }),
    );

    const groups = buildGroups(projects, threads, { environmentId: remoteEnvironmentId });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.representative.environmentId).toBe(remoteEnvironmentId);
    expect(groups[0]?.threads.map((thread) => thread.environmentId)).toEqual([remoteEnvironmentId]);
  });

  it("matches web repository, repository-path, and separate grouping modes", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const repositoryIdentity = {
      canonicalKey: "github.com/t3tools/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:t3tools/t3code.git",
      },
      provider: "github",
      owner: "t3tools",
      name: "t3code",
      displayName: "T3 Code",
      rootPath: "/workspaces/t3code",
    };
    const projects = [
      makeProject({
        environmentId,
        id: ProjectId.make("project-web"),
        title: "Web",
        workspaceRoot: "/workspaces/t3code/apps/web",
        repositoryIdentity,
      }),
      makeProject({
        environmentId,
        id: ProjectId.make("project-mobile"),
        title: "Mobile",
        workspaceRoot: "/workspaces/t3code/apps/mobile",
        repositoryIdentity,
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId,
        id: ThreadId.make(`thread-${project.id}`),
        projectId: project.id,
        title: project.title,
      }),
    );

    expect(buildGroups(projects, threads, { projectGroupingMode: "repository" })).toHaveLength(1);
    expect(
      buildGroups(projects, threads, { projectGroupingMode: "repository_path" }).map(
        (group) => group.title,
      ),
    ).toEqual(["Mobile", "Web"]);
    expect(
      buildGroups(projects, threads, { projectGroupingMode: "separate" }).map(
        (group) => group.title,
      ),
    ).toEqual(["Mobile", "Web"]);
  });

  it("default view shows only threads from the last 5 days", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("recent-1"),
        projectId: project.id,
        title: "Today",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("recent-2"),
        projectId: project.id,
        title: "Within window",
        updatedAt: "2026-06-25T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("old"),
        projectId: project.id,
        title: "Two weeks ago",
        updatedAt: "2026-06-14T00:00:00.000Z",
      }),
    ];

    const group = buildGroups([project], threads)[0];
    // Default view trims to recent threads...
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual(["recent-1", "recent-2"]);
    // ...while full history stays available for the expanded view.
    expect(group?.threads.map((thread) => thread.id)).toEqual(["recent-1", "recent-2", "old"]);
  });

  it("falls back to the most recent 3 threads when none are within 5 days", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map(
      (day, index) =>
        makeThread({
          environmentId,
          id: ThreadId.make(`thread-${index}`),
          projectId: project.id,
          title: `Thread ${index}`,
          updatedAt: `${day}T00:00:00.000Z`,
        }),
    );

    const group = buildGroups([project], threads)[0];
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual([
      "thread-4",
      "thread-3",
      "thread-2",
    ]);
    expect(group?.threads).toHaveLength(5);
  });

  it("does not apply the recency window while searching", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map(
      (day, index) =>
        makeThread({
          environmentId,
          id: ThreadId.make(`thread-${index}`),
          projectId: project.id,
          title: `Thread ${index}`,
          updatedAt: `${day}T00:00:00.000Z`,
        }),
    );

    const group = buildGroups([project], threads, { searchQuery: "T3 Code" })[0];
    // Search reaches the full history rather than the 3-thread fallback.
    expect(group?.recentThreads).toHaveLength(5);
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual(
      group?.threads.map((thread) => thread.id),
    );
  });

  it("includes a thread matched by message content", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const thread = makeThread({
      environmentId,
      id: ThreadId.make("thread-content"),
      projectId: project.id,
      title: "Unrelated title",
    });

    const groups = buildGroups([project], [thread], {
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
    });

    expect(groups[0]?.threads.map((candidate) => candidate.id)).toEqual(["thread-content"]);
  });

  it("targets quick new threads at the group member with the newest thread", () => {
    const laptopEnv = EnvironmentId.make("environment-laptop");
    const desktopEnv = EnvironmentId.make("environment-desktop");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const laptopProject = makeProject({
      environmentId: laptopEnv,
      id: ProjectId.make("project-laptop"),
      title: "t3code",
      repositoryIdentity,
    });
    const desktopProject = makeProject({
      environmentId: desktopEnv,
      id: ProjectId.make("project-desktop"),
      title: "t3code",
      repositoryIdentity,
    });
    const threads = [
      makeThread({
        environmentId: laptopEnv,
        id: ThreadId.make("thread-laptop"),
        projectId: laptopProject.id,
        title: "Older laptop thread",
        updatedAt: "2026-06-27T00:00:00.000Z",
      }),
      makeThread({
        environmentId: desktopEnv,
        id: ThreadId.make("thread-desktop"),
        projectId: desktopProject.id,
        title: "Newest desktop thread",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }),
    ];

    // Aggregated into one group by repository; the quick new-thread target
    // must follow the newest thread (desktop), not the arbitrary first member.
    const groups = buildGroups([laptopProject, desktopProject], threads);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projects).toHaveLength(2);
    expect(groups[0]?.newThreadTarget?.environmentId).toBe(desktopEnv);
    expect(groups[0]?.newThreadTarget?.id).toBe(desktopProject.id);
  });

  it("keeps running subagents under their parent thread", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const parent = makeThread({
      environmentId,
      id: ThreadId.make("thread-parent"),
      projectId: project.id,
      title: "Parent",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const child = makeThread({
      environmentId,
      id: ThreadId.make("thread-child"),
      projectId: project.id,
      title: "Child",
      updatedAt: "2026-06-03T00:00:00.000Z",
      parentRelation: subagentRelation({
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        sequence: 1,
      }),
    });

    const group = buildGroups([project], [child, parent])[0];

    expect(group?.threads.map((thread) => thread.id)).toEqual(["thread-parent", "thread-child"]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, child.id))).toBe(1);
  });

  it("hides terminal subagents unless they are in the active route path", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const parent = makeThread({
      environmentId,
      id: ThreadId.make("thread-parent"),
      projectId: project.id,
      title: "Parent",
    });
    const child = makeThread({
      environmentId,
      id: ThreadId.make("thread-child"),
      projectId: project.id,
      title: "Child",
      parentRelation: subagentRelation({
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        sequence: 1,
        status: "completed",
      }),
    });

    expect(buildGroups([project], [parent, child])[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-parent",
    ]);

    const activeGroup = buildGroups([project], [parent, child], {
      activeThreadKey: scopedThreadKey(environmentId, child.id),
    })[0];
    expect(activeGroup?.threads.map((thread) => thread.id)).toEqual([
      "thread-parent",
      "thread-child",
    ]);
    expect(activeGroup?.recentThreads.map((thread) => thread.id)).toEqual([
      "thread-parent",
      "thread-child",
    ]);
  });

  it("does not promote a running descendant when its terminal parent is hidden", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const root = makeThread({
      environmentId,
      id: ThreadId.make("thread-root"),
      projectId: project.id,
      title: "Root",
    });
    const terminalParent = makeThread({
      environmentId,
      id: ThreadId.make("thread-terminal-parent"),
      projectId: project.id,
      title: "Terminal parent",
      parentRelation: subagentRelation({
        rootThreadId: root.id,
        parentThreadId: root.id,
        sequence: 1,
        status: "completed",
      }),
    });
    const runningDescendant = makeThread({
      environmentId,
      id: ThreadId.make("thread-running-descendant"),
      projectId: project.id,
      title: "Running descendant",
      parentRelation: subagentRelation({
        rootThreadId: root.id,
        parentThreadId: terminalParent.id,
        sequence: 2,
        depth: 2,
      }),
    });

    const group = buildGroups([project], [root, terminalParent, runningDescendant])[0];

    expect(group?.threads.map((thread) => thread.id)).toEqual([
      "thread-root",
      "thread-running-descendant",
    ]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, runningDescendant.id))).toBe(2);
  });

  it("rebases matching child depth when search filters out its parent", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const parent = makeThread({
      environmentId,
      id: ThreadId.make("thread-parent"),
      projectId: project.id,
      title: "Parent",
    });
    const child = makeThread({
      environmentId,
      id: ThreadId.make("thread-child"),
      projectId: project.id,
      title: "Needle child",
      parentRelation: subagentRelation({
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        sequence: 1,
      }),
    });

    const group = buildGroups([project], [parent, child], { searchQuery: "needle" })[0];

    expect(group?.threads.map((thread) => thread.id)).toEqual(["thread-child"]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, child.id))).toBe(0);
  });

  it("keeps matching child depth relative to matching parent search results", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const parent = makeThread({
      environmentId,
      id: ThreadId.make("thread-parent"),
      projectId: project.id,
      title: "Needle parent",
    });
    const child = makeThread({
      environmentId,
      id: ThreadId.make("thread-child"),
      projectId: project.id,
      title: "Needle child",
      parentRelation: subagentRelation({
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        sequence: 1,
      }),
    });

    const group = buildGroups([project], [parent, child], { searchQuery: "needle" })[0];

    expect(group?.threads.map((thread) => thread.id)).toEqual(["thread-parent", "thread-child"]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, parent.id))).toBe(0);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, child.id))).toBe(1);
  });

  it("keeps pending tasks grouped without changing subagent thread lineage", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const parent = makeThread({
      environmentId,
      id: ThreadId.make("thread-parent"),
      projectId: project.id,
      title: "Parent",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const child = makeThread({
      environmentId,
      id: ThreadId.make("thread-child"),
      projectId: project.id,
      title: "Child",
      updatedAt: "2026-06-03T00:00:00.000Z",
      parentRelation: subagentRelation({
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        sequence: 1,
      }),
    });
    const pendingTask = makePendingTask({
      environmentId,
      projectId: project.id,
      messageId: "message-pending",
      title: "Queued new task",
    });

    const group = buildGroups([project], [child, parent], { pendingTasks: [pendingTask] })[0];

    expect(group?.pendingTasks.map((task) => task.message.messageId)).toEqual(["message-pending"]);
    expect(group?.threads.map((thread) => thread.id)).toEqual(["thread-parent", "thread-child"]);
    expect(group?.threadDepths.get(scopedThreadKey(environmentId, child.id))).toBe(1);
  });

  it("surfaces pending tasks even when no thread shell is available", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const pendingTask = makePendingTask({
      environmentId,
      projectId: ProjectId.make("project-offline"),
      messageId: "message-offline",
      title: "Offline queued task",
    });

    const group = buildGroups([], [], { pendingTasks: [pendingTask] })[0];

    expect(group?.representative.title).toBe("Queued project");
    expect(group?.pendingTasks.map((task) => task.message.messageId)).toEqual(["message-offline"]);
    expect(group?.threads).toEqual([]);
    expect(group?.threadDepths.size).toBe(0);
    expect(group?.recentThreads).toEqual([]);
    expect(group?.newThreadTarget).toBeNull();
  });
});

import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "./state/models.ts";
import {
  launchProjectAction,
  projectActionThreadId,
  remoteProjectActionGroups,
} from "./projectActions.ts";

const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const script: ProjectScript = {
  id: "same-id",
  name: "Run",
  command: "echo destination",
  icon: "play",
  runOnWorktreeCreate: false,
};
const project = (
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
): EnvironmentProject => ({
  environmentId,
  id: ProjectId.make(id),
  title: "Project",
  workspaceRoot,
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/owner/repo.git",
    },
    provider: "github",
    owner: "owner",
    name: "repo",
    displayName: "repo",
    rootPath: workspaceRoot,
  },
  defaultModelSelection: null,
  scripts: [script],
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
});
const local = project(localId, "local-project", "E:/local");
const remote = project(remoteId, "remote-project", "/remote/checkout");
const input = {
  project: local,
  projects: [local, remote],
  grouping: {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  },
  environments: [
    {
      environmentId: localId,
      label: "Windows",
      connected: true,
      settings: DEFAULT_SERVER_SETTINGS,
    },
    {
      environmentId: remoteId,
      label: "MacBookPro",
      connected: true,
      settings: DEFAULT_SERVER_SETTINGS,
    },
  ],
};

describe("remote project actions", () => {
  it("uses logical identity and destination checkout even with colliding script ids", () => {
    expect(remoteProjectActionGroups(input)).toEqual([
      {
        environmentId: remoteId,
        environmentLabel: "MacBookPro",
        projectId: remote.id,
        projectCwd: remote.workspaceRoot,
        scripts: [script],
      },
    ]);
    expect(
      remoteProjectActionGroups({
        ...input,
        grouping: { ...input.grouping, sidebarProjectGroupingMode: "separate" },
      }),
    ).toEqual([]);
    expect(
      remoteProjectActionGroups({
        ...input,
        projects: [local, { ...remote, repositoryIdentity: null }],
      }),
    ).toEqual([]);
  });

  it("omits offline, inaccessible, empty and scratch destinations", () => {
    expect(
      remoteProjectActionGroups({
        ...input,
        environments: input.environments.map((env) => ({ ...env, connected: false })),
      }),
    ).toEqual([]);
    expect(
      remoteProjectActionGroups({
        ...input,
        environments: input.environments.map((env) => ({ ...env, settings: null })),
      }),
    ).toEqual([]);
    expect(
      remoteProjectActionGroups({ ...input, projects: [local, { ...remote, scripts: [] }] }),
    ).toEqual([]);
    expect(remoteProjectActionGroups({ ...input, project: { ...local, isScratch: true } })).toEqual(
      [],
    );
  });

  it("opens and writes only in the destination namespace and runtime context", async () => {
    const target = remoteProjectActionGroups(input)[0]!;
    const open = vi.fn(async () => ({ _tag: "Success" as const }));
    const write = vi.fn(async () => ({ _tag: "Success" as const }));
    await launchProjectAction(target, script, "action-id", { open, write });
    expect(open).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: projectActionThreadId(target),
        terminalId: "action-id",
        cwd: "/remote/checkout",
        worktreePath: null,
        env: { T3CODE_PROJECT_ROOT: "/remote/checkout" },
        cols: 100,
        rows: 28,
      },
    });
    expect(write).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: projectActionThreadId(target),
        terminalId: "action-id",
        data: expect.stringContaining(script.command),
      },
    });
  });

  it.each(["disconnected", "permission denied", "checkout missing"])(
    "does not write or fall back after %s",
    async (message) => {
      const failure = { _tag: "Failure" as const, message };
      const open = vi.fn(async () => failure);
      const write = vi.fn(async () => ({ _tag: "Success" as const }));
      expect(
        await launchProjectAction(remoteProjectActionGroups(input)[0]!, script, "action-id", {
          open,
          write,
        }),
      ).toBe(failure);
      expect(open).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
    },
  );
});

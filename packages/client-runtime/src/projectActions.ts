import {
  ThreadId,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ServerSettings,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import type { EnvironmentProject } from "./state/models.ts";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "./state/projectGrouping.ts";

export interface ProjectActionDestination {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
}

export interface RemoteProjectActionGroup extends ProjectActionDestination {
  readonly scripts: ReadonlyArray<ProjectScript>;
}

export function remoteProjectActionGroups(input: {
  readonly project: EnvironmentProject | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly grouping: ProjectGroupingSettings;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
    readonly settings: ServerSettings | null;
  }>;
}): ReadonlyArray<RemoteProjectActionGroup> {
  const { project } = input;
  if (!project || project.isScratch) return [];
  const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.grouping);
  return input.environments
    .flatMap((environment) => {
      if (
        environment.environmentId === project.environmentId ||
        !environment.connected ||
        !environment.settings
      )
        return [];
      const destination = input.projects.find(
        (candidate) =>
          candidate.environmentId === environment.environmentId &&
          deriveLogicalProjectKeyFromSettings(candidate, input.grouping) === logicalKey,
      );
      if (!destination) return [];
      const scripts = resolveProjectScripts(environment.settings, destination);
      return scripts.length === 0
        ? []
        : [
            {
              environmentId: destination.environmentId,
              environmentLabel: environment.label,
              projectId: destination.id,
              projectCwd: destination.workspaceRoot,
              scripts,
            },
          ];
    })
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
}

// Terminals need a stable destination-owned namespace even when that project has no threads.
export function projectActionThreadId(destination: ProjectActionDestination) {
  return ThreadId.make(`project-actions:${destination.projectId}`);
}

export async function launchProjectAction<
  OpenResult extends { readonly _tag: string },
  WriteResult,
>(
  destination: ProjectActionDestination,
  script: ProjectScript,
  terminalId: string,
  commands: {
    readonly open: (target: {
      environmentId: EnvironmentId;
      input: TerminalOpenInput;
    }) => Promise<OpenResult>;
    readonly write: (target: {
      environmentId: EnvironmentId;
      input: TerminalWriteInput;
    }) => Promise<WriteResult>;
  },
) {
  const threadId = projectActionThreadId(destination);
  const opened = await commands.open({
    environmentId: destination.environmentId,
    input: {
      threadId,
      terminalId,
      cwd: destination.projectCwd,
      worktreePath: null,
      env: projectScriptRuntimeEnv({
        project: { cwd: destination.projectCwd },
        worktreePath: null,
      }),
      cols: 100,
      rows: 28,
    },
  });
  if (opened._tag !== "Success") return opened;
  return commands.write({
    environmentId: destination.environmentId,
    input: { threadId, terminalId, data: projectScriptTerminalInput(script.command) },
  });
}

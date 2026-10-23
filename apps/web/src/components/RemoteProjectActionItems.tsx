import { useAtomValue } from "@effect/atom-react";
import {
  launchProjectAction,
  remoteProjectActionGroups,
  type RemoteProjectActionGroup,
} from "@t3tools/client-runtime/project-actions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScriptIcon } from "./projectScriptEditor";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuItemLabel, MenuSeparator } from "./ui/menu";
import { toastManager } from "./ui/toast";

export function useRemoteProjectActions(environmentId: EnvironmentId, projectId: ProjectId) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  return remoteProjectActionGroups({
    project:
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      ) ?? null,
    projects,
    grouping,
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connected: environment.connection.phase === "connected",
      settings: environment.serverConfig?.settings ?? null,
    })),
  });
}

export function RemoteProjectActionItems(props: {
  group: RemoteProjectActionGroup;
  threadRef: ScopedThreadRef;
  separated: boolean;
  density: "touch" | "default";
}) {
  const { group, threadRef } = props;
  const canRun = useAtomValue(terminalEnvironment.open.permissionAtom(group.environmentId));
  const open = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const run = async (script: ProjectScript) => {
    const terminalId = `action-${randomUUID()}`;
    const result = await launchProjectAction(group, script, terminalId, { open, write });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not run ${script.name} on ${group.environmentLabel}`,
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    useRightPanelStore.getState().openTerminal(threadRef, terminalId, {
      environmentId: group.environmentId,
      environmentLabel: group.environmentLabel,
      projectId: group.projectId,
      projectCwd: group.projectCwd,
      label: `${script.name} · ${group.environmentLabel}`,
    });
  };
  return (
    <>
      {props.separated && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>From {group.environmentLabel}</MenuGroupLabel>
        {group.scripts.map((script) => (
          <MenuItem
            key={script.id}
            density={props.density}
            disabled={!canRun}
            onClick={() => void run(script)}
          >
            <ScriptIcon icon={script.icon} className="size-4" />
            <MenuItemLabel>{projectScriptMenuLabel(script)}</MenuItemLabel>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}

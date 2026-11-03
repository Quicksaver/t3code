import type { EnvironmentId } from "@t3tools/contracts";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import {
  launchProjectAction,
  projectActionThreadId,
  remoteProjectActionGroups,
  type RemoteProjectActionGroup,
} from "@t3tools/client-runtime/project-actions";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectScript } from "@t3tools/contracts";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

const actionPermissions = Atom.family((key: string) => {
  const ids: ReadonlyArray<EnvironmentId> = JSON.parse(key);
  return Atom.make(
    (get) => new Set(ids.filter((id) => get(terminalEnvironment.open.permissionAtom(id)))),
  );
});

export function useRemoteProjectActions(project: EnvironmentProject | null) {
  const projects = useProjects();
  const environments = useWorkspaceEnvironments();
  const configs = useServerConfigs();
  const grouping = useMobileProjectGroupingSettings();
  const navigation = useNavigation();
  const groups = remoteProjectActionGroups({
    project,
    projects,
    grouping,
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      connected: environment.connectionState === "connected" && environment.isEnabled,
      settings: configs.get(environment.environmentId)?.settings ?? null,
    })),
  });
  const permissionKey = JSON.stringify(groups.map((group) => group.environmentId));
  const permissions = useAtomValue(actionPermissions(permissionKey));
  const open = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const run = async (group: RemoteProjectActionGroup, script: ProjectScript) => {
    const terminalId = `action-${uuidv4()}`;
    const result = await launchProjectAction(group, script, terminalId, { open, write });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          `Could not run ${script.name} on ${group.environmentLabel}`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    navigation.navigate("ThreadTerminal", {
      environmentId: String(group.environmentId),
      threadId: String(projectActionThreadId(group)),
      terminalId,
      projectActionProjectId: String(group.projectId),
      projectActionLabel: `${script.name} · ${group.environmentLabel}`,
    });
  };
  return {
    groups: groups.map((group) => ({ ...group, canRun: permissions.has(group.environmentId) })),
    run,
  };
}

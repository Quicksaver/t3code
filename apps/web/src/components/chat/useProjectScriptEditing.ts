import type { useEnvironments } from "../../state/environments";
import type {
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  EnvironmentId,
} from "@t3tools/contracts";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  saveProjectScriptWithKeybinding,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  buildProjectScriptSettingsPatch,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  releaseClaimedRoles,
} from "../../projectScripts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Write script settings before reconciling shortcuts in environment keybindings. */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly environments: ReadonlyMap<
    string,
    ReturnType<typeof useEnvironments>["environments"][number]
  >;
}) {
  const { environmentId, project, scripts, environments: inputEnvironments } = input;
  const allProjects = useProjects();
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const persistProjectScripts = async (input: {
    projectId: ProjectId;
    previousScripts: ReadonlyArray<ProjectScript>;
    nextScripts: ReadonlyArray<ProjectScript>;
    keybinding: NewProjectScriptInput["keybinding"];
    keybindingCommand: KeybindingCommand | null;
  }): Promise<AtomCommandResult<void, unknown>> => {
    const destinationId = environmentId;
    return saveProjectScriptWithKeybinding({
      environmentId: destinationId,
      keybinding: input.keybinding,
      keybindingCommand: input.keybindingCommand,
      isDeletingScript: !input.nextScripts.some(
        (script) => commandForProjectScript(script.id) === input.keybindingCommand,
      ),
      readKeybindings: (destinationId) =>
        appAtomRegistry.get(serverEnvironment.configValueAtom(destinationId))?.keybindings ?? [],
      canWriteSettings: (destinationId) =>
        readEnvironmentScope(destinationId, AuthSettingsWriteScope),
      saveProject: async () =>
        mapAtomCommandResult(
          await updateProjectScriptSettings({
            environmentId: destinationId,
            input: {
              patch: buildProjectScriptSettingsPatch({
                environmentId: destinationId,
                projectId: input.projectId,
                scripts: input.nextScripts,
                environments: inputEnvironments,
              }),
            },
          }),
          () => undefined,
        ),
      saveKeybinding: async (keybindingRule) => {
        const scriptId = input.keybindingCommand
          ? projectScriptIdFromCommand(input.keybindingCommand)
          : null;
        if (!keybindingRule && !input.previousScripts.some((script) => script.id === scriptId)) {
          return AsyncResult.success(undefined);
        }
        const destination = inputEnvironments.get(destinationId)?.serverConfig;
        if (!destination) return AsyncResult.success(undefined);
        const destinationSettings = destination.settings;
        const retainedElsewhere =
          !input.nextScripts.some((script) => script.id === scriptId) &&
          (destinationSettings.defaultProjectScripts.some((script) => script.id === scriptId) ||
            Object.entries(destinationSettings.projectSettingsOverrides).some(
              ([projectId, entry]) =>
                projectId !== input.projectId &&
                entry.defaultProjectScripts?.some((script) => script.id === scriptId),
            ) ||
            allProjects.some(
              (other) =>
                other.environmentId === destinationId &&
                other.id !== input.projectId &&
                resolveProjectScripts(destinationSettings, other).some(
                  (script) => script.id === scriptId,
                ),
            ));
        if (!keybindingRule && retainedElsewhere) return AsyncResult.success(undefined);

        const previousRules = (destination.keybindings ?? []).flatMap((binding) => {
          if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
          const previous = decodeProjectScriptKeybindingRule({
            keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
            command: input.keybindingCommand,
          });
          return previous ? [previous] : [];
        });
        const previous = previousRules.at(-1);
        for (const rule of keybindingRule ? previousRules.slice(0, -1) : previousRules) {
          const result = await removeKeybinding({
            environmentId: destinationId,
            input: rule,
          });
          if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
        }
        return keybindingRule
          ? mapAtomCommandResult(
              await upsertKeybinding({
                environmentId: destinationId,
                input:
                  previous && previous.key !== keybindingRule.key
                    ? { ...keybindingRule, replace: previous }
                    : keybindingRule,
              }),
              () => undefined,
            )
          : AsyncResult.success(undefined);
      },
    });
  };
  const saveProjectScript = async (
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextId = nextProjectScriptId(
      input.name,
      scripts.map((script) => script.id),
    );
    const nextScript = buildProjectScript(nextId, input);
    const nextScripts = [
      ...scripts.map((script) => releaseClaimedRoles(script, input)),
      nextScript,
    ];

    return persistProjectScripts({
      projectId: project.id,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };
  const updateProjectScript = async (
    scriptId: string,
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const existingScript = scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
    }

    const updatedScript = buildProjectScript(existingScript.id, input);
    const nextScripts = scripts.map((script) =>
      script.id === scriptId ? updatedScript : releaseClaimedRoles(script, input),
    );

    return persistProjectScripts({
      projectId: project.id,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };
  const deleteProjectScript = async (
    scriptId: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextScripts = scripts.filter((script) => script.id !== scriptId);

    const deletedName = scripts.find((s) => s.id === scriptId)?.name;

    const result = await persistProjectScripts({
      projectId: project.id,
      previousScripts: scripts,
      nextScripts,
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Deleted action "${deletedName ?? "Unknown"}"`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    return result;
  };
  return {
    saveProjectScript: useStableCallback(saveProjectScript),
    updateProjectScript: useStableCallback(updateProjectScript),
    deleteProjectScript: useStableCallback(deleteProjectScript),
  };
}

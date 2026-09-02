import type {
  EnvironmentId,
  ProviderInteractionMode,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type { ProviderWorkspaceSkillsState } from "@t3tools/client-runtime/state/provider-workspace-skills";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getProviderSkillsForSlashMenu } from "@t3tools/client-runtime/providerSkills";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useComposerPathSearch } from "../../state/queries";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";
import { buildComposerSkillItems } from "./thread-composer-skill-items";

export function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

export function resolveComposerWorkspaceSkillMenu(input: {
  readonly trigger: ComposerTrigger | null;
  readonly workspaceSkills: ProviderWorkspaceSkillsState | undefined;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
}) {
  const lookupActive = input.trigger?.kind === "skill";
  return {
    skills: input.workspaceSkills?.skills ?? input.fallbackSkills,
    lookupActive,
    isLoading: lookupActive ? (input.workspaceSkills?.isPending ?? false) : false,
    error: lookupActive ? (input.workspaceSkills?.error ?? null) : null,
  };
}

/** Shared autocomplete for thread composers and unsent new-task drafts. */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  projectCwd,
  selectedProviderStatus,
  workspaceSkills,
  hasThread,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
  onWorkspaceSkillsLookupActiveChange,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly workspaceSkills?: ProviderWorkspaceSkillsState;
  readonly hasThread: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  readonly onWorkspaceSkillsLookupActiveChange?: (active: boolean) => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage.length]);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    setSelection(composerSelectionAtEnd(draftMessage));
  }, [draftMessage, ownerKey]);

  const trigger = useMemo(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, selection]);
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const workspaceSkillMenu = resolveComposerWorkspaceSkillMenu({
    trigger,
    workspaceSkills,
    fallbackSkills: selectedProviderStatus?.skills ?? [],
  });
  useLayoutEffect(() => {
    onWorkspaceSkillsLookupActiveChange?.(workspaceSkillMenu.lookupActive);
    return () => onWorkspaceSkillsLookupActiveChange?.(false);
  }, [onWorkspaceSkillsLookupActiveChange, workspaceSkillMenu.lookupActive]);

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const allBuiltIn = [
        {
          id: "cmd:model",
          type: "slash-command" as const,
          command: "model",
          label: "/model",
          description: "Switch model",
        },
        {
          id: "cmd:plan",
          type: "slash-command" as const,
          command: "plan",
          label: "/plan",
          description: "Switch to plan mode",
        },
        {
          id: "cmd:default",
          type: "slash-command" as const,
          command: "default",
          label: "/default",
          description: "Switch to default mode",
        },
      ];
      const builtIn = allBuiltIn.filter(
        (item) =>
          item.command.includes(q) &&
          (item.command === "model" || onUpdateInteractionMode !== undefined),
      );

      // A provider expands a slash command only when it opens the whole
      // message; elsewhere it arrives as literal text. Built-ins apply
      // locally and skills insert a `$` mention the server dispatches from
      // any position, so only provider commands are position-gated.
      const providerCommands: ComposerCommandItem[] = [];
      const expandableCommands =
        trigger.rangeStart === 0 ? (selectedProviderStatus?.slashCommands ?? []) : [];
      for (const command of expandableCommands) {
        if (!command.name.toLowerCase().includes(q)) continue;
        // Codex feedback uploads an existing thread's session and logs.
        if (
          !hasThread &&
          selectedProviderStatus?.driver === "codex" &&
          command.name === "feedback"
        ) {
          continue;
        }
        providerCommands.push({
          id: `pcmd:${command.name}`,
          type: "provider-slash-command",
          command,
          label: `/${command.name}`,
          description: command.description ?? "",
        });
      }

      const skillItems = getProviderSkillsForSlashMenu(selectedProviderStatus?.skills ?? [], true)
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...builtIn, ...providerCommands, ...skillItems];
    }

    if (trigger.kind === "skill") {
      return buildComposerSkillItems(workspaceSkillMenu.skills, trigger.query);
    }

    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [
    hasThread,
    onUpdateInteractionMode,
    pathSearch.entries,
    selectedProviderStatus,
    trigger,
    workspaceSkillMenu.skills,
  ]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;

      if (
        item.type === "slash-command" &&
        (item.command === "plan" || item.command === "default")
      ) {
        const result = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: result.cursor, end: result.cursor });
        onChangeDraftMessage(result.text);
        onUpdateInteractionMode?.(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement = `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      }

      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        replacement,
      );
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [draftMessage, onChangeDraftMessage, onUpdateInteractionMode, trigger],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    isLoading: trigger?.kind === "path" ? pathSearch.isPending : workspaceSkillMenu.isLoading,
    error: workspaceSkillMenu.error,
    onSelect,
  };
}

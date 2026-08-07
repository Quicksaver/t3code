import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  type ProviderWorkspaceSkillsState,
  type ProviderWorkspaceSkillsTarget,
} from "@t3tools/client-runtime/state/provider-workspace-skills";
import { useMemo, useRef } from "react";

import type { ChatMessage } from "../types";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveProviderInstanceSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { hasInlineSkillToken } from "../components/chat/skillInlineTokens";
import { useProviderWorkspaceSkills } from "./providerWorkspaceSkillsState";

const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];

export function timelineMessagesHaveCompleteSkillReference(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>,
  cache?: WeakMap<object, boolean>,
): boolean {
  return messages.some((message) => {
    if (message.role !== "user") return false;
    const cached = cache?.get(message);
    if (cached !== undefined) return cached;
    const hasSkillReference = hasInlineSkillToken(message.text);
    cache?.set(message, hasSkillReference);
    return hasSkillReference;
  });
}

export function timelineProviderInstancePreferenceOrder(input: {
  readonly sessionProviderInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelInstanceId: ProviderInstanceId | null | undefined;
  readonly composerDraftInstanceId: ProviderInstanceId | null | undefined;
  readonly projectDefaultInstanceId: ProviderInstanceId | null | undefined;
}): ReadonlyArray<ProviderInstanceId | null | undefined> {
  return [
    input.sessionProviderInstanceId,
    input.threadModelInstanceId,
    input.composerDraftInstanceId,
    input.projectDefaultInstanceId,
  ];
}

export interface TimelineProviderWorkspaceSkillsInput {
  readonly environmentId: EnvironmentId;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly sessionProviderInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelInstanceId: ProviderInstanceId | null | undefined;
  readonly composerDraftInstanceId: ProviderInstanceId | null | undefined;
  readonly projectDefaultInstanceId: ProviderInstanceId | null | undefined;
  readonly cwd: string | null;
  readonly connectionAvailable: boolean;
  readonly messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>;
}

type TimelineProviderWorkspaceSkillsProviderInput = Pick<
  TimelineProviderWorkspaceSkillsInput,
  | "providerStatuses"
  | "settings"
  | "lockedProvider"
  | "sessionProviderInstanceId"
  | "threadModelInstanceId"
  | "composerDraftInstanceId"
  | "projectDefaultInstanceId"
>;

function resolveTimelineProviderWorkspaceSkillsProvider(
  input: TimelineProviderWorkspaceSkillsProviderInput,
): Pick<ProviderWorkspaceSkillsTarget, "instanceId" | "fallbackSkills"> {
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(input.providerStatuses),
      input.settings,
    ),
  );
  const providerStatus =
    resolveProviderInstanceSelection({
      entries,
      preferredInstanceIds: timelineProviderInstancePreferenceOrder(input),
      lockedDriverKind: input.lockedProvider,
      lockedInstanceId: input.sessionProviderInstanceId ?? input.threadModelInstanceId ?? null,
    }).entry?.snapshot ?? null;

  return {
    instanceId: providerStatus?.instanceId ?? null,
    fallbackSkills: providerStatus?.skills ?? EMPTY_PROVIDER_SKILLS,
  };
}

export function resolveTimelineProviderWorkspaceSkillsTarget(
  input: TimelineProviderWorkspaceSkillsInput,
  skillReferenceCache?: WeakMap<object, boolean>,
): ProviderWorkspaceSkillsTarget {
  const provider = resolveTimelineProviderWorkspaceSkillsProvider(input);

  return {
    environmentId: input.environmentId,
    instanceId: provider.instanceId,
    cwd: input.cwd,
    enabled: timelineMessagesHaveCompleteSkillReference(input.messages, skillReferenceCache),
    connectionAvailable: input.connectionAvailable,
    fallbackSkills: provider.fallbackSkills,
  };
}

export function useTimelineProviderWorkspaceSkills(
  input: TimelineProviderWorkspaceSkillsInput,
): ProviderWorkspaceSkillsState {
  const {
    environmentId,
    providerStatuses,
    settings,
    lockedProvider,
    sessionProviderInstanceId,
    threadModelInstanceId,
    composerDraftInstanceId,
    projectDefaultInstanceId,
    cwd,
    connectionAvailable,
    messages,
  } = input;
  const skillReferenceCacheRef = useRef(new WeakMap<object, boolean>());
  const provider = useMemo(
    () =>
      resolveTimelineProviderWorkspaceSkillsProvider({
        providerStatuses,
        settings,
        lockedProvider,
        sessionProviderInstanceId,
        threadModelInstanceId,
        composerDraftInstanceId,
        projectDefaultInstanceId,
      }),
    [
      composerDraftInstanceId,
      lockedProvider,
      projectDefaultInstanceId,
      providerStatuses,
      sessionProviderInstanceId,
      settings,
      threadModelInstanceId,
    ],
  );
  const enabled = useMemo(
    () => timelineMessagesHaveCompleteSkillReference(messages, skillReferenceCacheRef.current),
    [messages],
  );
  const target = useMemo<ProviderWorkspaceSkillsTarget>(
    () => ({
      environmentId,
      instanceId: provider.instanceId,
      cwd,
      enabled,
      connectionAvailable,
      fallbackSkills: provider.fallbackSkills,
    }),
    [connectionAvailable, cwd, enabled, environmentId, provider],
  );

  return useProviderWorkspaceSkills(target);
}

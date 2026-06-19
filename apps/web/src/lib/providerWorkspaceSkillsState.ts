import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

export interface ProviderWorkspaceSkillsTarget {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsState {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly isPending: boolean;
  readonly error: string | null;
}

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

function targetKey(target: Omit<ProviderWorkspaceSkillsTarget, "fallbackSkills">): string | null {
  if (
    !target.enabled ||
    target.environmentId === null ||
    target.instanceId === null ||
    target.cwd === null ||
    target.cwd.trim().length === 0
  ) {
    return null;
  }
  return `${target.environmentId}:${target.instanceId}:${target.cwd.trim()}`;
}

export function resolvePendingProviderWorkspaceSkills(input: {
  readonly currentKey: string | null;
  readonly nextKey: string;
  readonly currentSkills: ReadonlyArray<ServerProviderSkill>;
}): ReadonlyArray<ServerProviderSkill> {
  return input.currentKey === input.nextKey && input.currentSkills.length > 0
    ? input.currentSkills
    : EMPTY_SKILLS;
}

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      cwd: target.cwd?.trim() || null,
      enabled: target.enabled,
    }),
    [target.cwd, target.enabled, target.environmentId, target.instanceId],
  );
  const key = targetKey(stableTarget);
  const query = useEnvironmentQuery(
    key !== null && stableTarget.environmentId !== null && stableTarget.instanceId !== null
      ? serverEnvironment.providerSkills({
          environmentId: stableTarget.environmentId,
          input: {
            instanceId: stableTarget.instanceId,
            cwd: stableTarget.cwd!,
          },
        })
      : null,
  );

  const previousFallbackSkillsRef = useRef(target.fallbackSkills);
  useEffect(() => {
    if (previousFallbackSkillsRef.current === target.fallbackSkills) return;
    previousFallbackSkillsRef.current = target.fallbackSkills;
    if (key !== null) query.refresh();
  }, [key, query, target.fallbackSkills]);

  if (key === null) {
    return { skills: target.fallbackSkills, isPending: false, error: null };
  }
  return {
    skills: query.data?.skills ?? EMPTY_SKILLS,
    isPending: query.isPending,
    error: query.error,
  };
}

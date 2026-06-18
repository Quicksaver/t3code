import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

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

export function invalidateProviderWorkspaceSkills(): void {
  // Workspace skill requests are now owned by the environment query cache.
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
  const previousResolvedSkillsRef = useRef<{
    readonly key: string | null;
    readonly skills: ReadonlyArray<ServerProviderSkill>;
  }>({ key: null, skills: target.fallbackSkills });
  const query = useEnvironmentQuery(
    key === null ||
      stableTarget.environmentId === null ||
      stableTarget.instanceId === null ||
      stableTarget.cwd === null
      ? null
      : serverEnvironment.listProviderSkills({
          environmentId: stableTarget.environmentId,
          input: {
            instanceId: stableTarget.instanceId,
            cwd: stableTarget.cwd,
          },
        }),
  );

  useEffect(() => {
    if (key === null) {
      previousResolvedSkillsRef.current = { key: null, skills: target.fallbackSkills };
      return;
    }
    if (query.data?.skills) {
      previousResolvedSkillsRef.current = { key, skills: query.data.skills };
    }
  }, [key, query.data?.skills, target.fallbackSkills]);

  const previousResolvedSkills = previousResolvedSkillsRef.current;
  const skills =
    key === null
      ? target.fallbackSkills
      : (query.data?.skills ??
        (query.isPending
          ? resolvePendingProviderWorkspaceSkills({
              currentKey: previousResolvedSkills.key,
              nextKey: key,
              currentSkills: previousResolvedSkills.skills,
            })
          : EMPTY_SKILLS));

  return {
    skills,
    isPending: query.isPending,
    error: query.error,
  };
}

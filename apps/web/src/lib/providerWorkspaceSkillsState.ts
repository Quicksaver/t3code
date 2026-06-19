import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

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

interface InternalProviderWorkspaceSkillsState extends ProviderWorkspaceSkillsState {
  readonly key: string | null;
}

const cache = new Map<string, ReadonlyArray<ServerProviderSkill>>();
const CACHE_MAX_ENTRIES = 100;
const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

function setCachedSkills(key: string, skills: ReadonlyArray<ServerProviderSkill>): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, skills);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

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
  cache.clear();
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
  const fallbackSkillsRef = useRef(target.fallbackSkills);
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
  const skillsAtom =
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
        });
  const skillQuery = useEnvironmentQuery(skillsAtom);
  const [state, setState] = useState<InternalProviderWorkspaceSkillsState>(() => ({
    key,
    skills: target.fallbackSkills,
    isPending: false,
    error: null,
  }));

  useEffect(() => {
    fallbackSkillsRef.current = target.fallbackSkills;
    if (key === null) {
      setState({ key: null, skills: target.fallbackSkills, isPending: false, error: null });
    }
  }, [key, target.fallbackSkills]);

  useEffect(() => {
    if (
      key === null ||
      stableTarget.environmentId === null ||
      stableTarget.instanceId === null ||
      stableTarget.cwd === null
    ) {
      setState({ key, skills: fallbackSkillsRef.current, isPending: false, error: null });
      return;
    }

    const cached = cache.get(key);
    if (cached && skillQuery.isPending) {
      setState({ key, skills: cached, isPending: false, error: null });
      return;
    }

    if (skillQuery.data) {
      setCachedSkills(key, skillQuery.data.skills);
      setState({ key, skills: skillQuery.data.skills, isPending: false, error: null });
      return;
    }

    if (skillQuery.error) {
      setState({
        key,
        skills: EMPTY_SKILLS,
        isPending: false,
        error: skillQuery.error,
      });
      return;
    }

    setState((current) => ({
      key,
      skills: resolvePendingProviderWorkspaceSkills({
        currentKey: current.key,
        nextKey: key,
        currentSkills: current.skills,
      }),
      isPending: skillQuery.isPending,
      error: null,
    }));
  }, [
    key,
    skillQuery.data,
    skillQuery.error,
    skillQuery.isPending,
    stableTarget.cwd,
    stableTarget.enabled,
    stableTarget.environmentId,
    stableTarget.instanceId,
  ]);

  return {
    skills: state.skills,
    isPending: state.isPending,
    error: state.error,
  };
}

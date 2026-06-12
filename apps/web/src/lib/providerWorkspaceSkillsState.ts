import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  subscribeProviderInvalidations,
} from "../environments/runtime";

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

const cache = new Map<string, ReadonlyArray<ServerProviderSkill>>();

function targetKey(target: Omit<ProviderWorkspaceSkillsTarget, "fallbackSkills">): string | null {
  if (
    !target.enabled ||
    target.environmentId === null ||
    target.instanceId === null ||
    target.cwd === null
  ) {
    return null;
  }
  return `${target.environmentId}:${target.instanceId}:${target.cwd}`;
}

export function invalidateProviderWorkspaceSkills(): void {
  cache.clear();
}

subscribeProviderInvalidations(invalidateProviderWorkspaceSkills);

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      cwd: target.cwd,
      enabled: target.enabled,
    }),
    [target.cwd, target.enabled, target.environmentId, target.instanceId],
  );
  const key = targetKey(stableTarget);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [state, setState] = useState<ProviderWorkspaceSkillsState>(() => ({
    skills: target.fallbackSkills,
    isPending: false,
    error: null,
  }));

  useEffect(
    () => subscribeEnvironmentConnections(() => setConnectionVersion((version) => version + 1)),
    [],
  );

  useEffect(() => {
    if (
      key === null ||
      stableTarget.environmentId === null ||
      stableTarget.instanceId === null ||
      stableTarget.cwd === null
    ) {
      setState({ skills: target.fallbackSkills, isPending: false, error: null });
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      setState({ skills: cached, isPending: false, error: null });
      return;
    }

    const connection = readEnvironmentConnection(stableTarget.environmentId);
    if (!connection) {
      setState({
        skills: target.fallbackSkills,
        isPending: false,
        error: "Remote connection is not ready.",
      });
      return;
    }

    let cancelled = false;
    setState((current) => ({
      skills: current.skills.length > 0 ? current.skills : target.fallbackSkills,
      isPending: true,
      error: null,
    }));
    void connection.client.server
      .listProviderSkills({
        instanceId: stableTarget.instanceId,
        cwd: stableTarget.cwd,
      })
      .then((result) => {
        if (cancelled) return;
        cache.set(key, result.skills);
        setState({ skills: result.skills, isPending: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          skills: target.fallbackSkills,
          isPending: false,
          error: error instanceof Error ? error.message : "Failed to list provider skills.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    connectionVersion,
    key,
    stableTarget.cwd,
    stableTarget.enabled,
    stableTarget.environmentId,
    stableTarget.instanceId,
    target.fallbackSkills,
  ]);

  return state;
}

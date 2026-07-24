import {
  prepareProviderWorkspaceSkillsTarget,
  resolveProviderWorkspaceSkillsQuery,
  type ProviderWorkspaceSkillsSnapshot,
  type ProviderWorkspaceSkillsState,
  type ProviderWorkspaceSkillsTarget,
} from "@t3tools/client-runtime/state/provider-workspace-skills";
import { useEffect, useMemo, useRef } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const preparedTarget = useMemo(
    () => prepareProviderWorkspaceSkillsTarget(target),
    [
      target.connectionAvailable,
      target.cwd,
      target.enabled,
      target.environmentId,
      target.instanceId,
    ],
  );
  const query = useEnvironmentQuery(
    preparedTarget.queryTarget !== null
      ? serverEnvironment.providerSkills(preparedTarget.queryTarget)
      : null,
  );

  const previousWorkspaceSkillsRef = useRef<ProviderWorkspaceSkillsSnapshot | null>(null);
  const resolution = resolveProviderWorkspaceSkillsQuery({
    target: preparedTarget,
    query,
    fallbackSkills: target.fallbackSkills,
    current: previousWorkspaceSkillsRef.current,
  });
  useEffect(() => {
    previousWorkspaceSkillsRef.current = resolution.snapshot;
  }, [resolution.snapshot]);
  return resolution.state;
}

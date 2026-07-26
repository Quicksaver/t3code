import {
  ServerProviderSkillsListError,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProviderSkill,
  type ServerProviderSkillsListInput,
  type ServerProviderSkillsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

export interface ProviderWorkspaceSkillsTarget {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly connectionAvailable?: boolean;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsState {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface PreparedProviderWorkspaceSkillsTarget {
  readonly targetKey: string | null;
  readonly key: string | null;
  readonly unavailable: boolean;
  readonly queryTarget: {
    readonly environmentId: EnvironmentId;
    readonly input: ServerProviderSkillsListInput;
  } | null;
}

export interface ProviderWorkspaceSkillsQueryView {
  readonly data: ServerProviderSkillsListResult | null;
  readonly error: string | null;
  readonly errorCause: Cause.Cause<unknown> | null;
  readonly isPending: boolean;
}

export interface ProviderWorkspaceSkillsQueryResolution {
  readonly snapshot: ProviderWorkspaceSkillsSnapshot | null;
  readonly state: ProviderWorkspaceSkillsState;
}

export interface ProviderWorkspaceSkillsSnapshotInput {
  readonly currentKey: string | null;
  readonly nextKey: string;
  readonly currentSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsResolutionInput extends ProviderWorkspaceSkillsSnapshotInput {
  readonly nextSkills: ReadonlyArray<ServerProviderSkill> | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly unavailable?: boolean;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsSnapshot {
  readonly key: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export const EMPTY_PROVIDER_WORKSPACE_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
export const PROVIDER_WORKSPACE_SKILLS_UNAVAILABLE_MESSAGE =
  "Reconnect this environment to refresh workspace skills.";

const isServerProviderSkillsListError = Schema.is(ServerProviderSkillsListError);

export function providerWorkspaceSkillsTargetKey(
  target: Omit<ProviderWorkspaceSkillsTarget, "fallbackSkills">,
): string | null {
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

export function prepareProviderWorkspaceSkillsTarget(
  target: ProviderWorkspaceSkillsTarget,
): PreparedProviderWorkspaceSkillsTarget {
  const cwd = target.cwd?.trim() || null;
  const targetKey = providerWorkspaceSkillsTargetKey({
    environmentId: target.environmentId,
    instanceId: target.instanceId,
    cwd,
    enabled: true,
  });
  const key = target.enabled ? targetKey : null;
  const unavailable = key !== null && target.connectionAvailable === false;
  const queryTarget =
    key !== null &&
    !unavailable &&
    target.environmentId !== null &&
    target.instanceId !== null &&
    cwd !== null
      ? {
          environmentId: target.environmentId,
          input: {
            instanceId: target.instanceId,
            cwd,
          },
        }
      : null;
  return { targetKey, key, unavailable, queryTarget };
}

function providerSkillsListErrorDetail(error: unknown): {
  readonly detail: string | null;
} | null {
  if (!isServerProviderSkillsListError(error)) return null;
  return {
    detail:
      typeof error.detail === "string" && error.detail.trim().length > 0 ? error.detail : null,
  };
}

export function formatProviderWorkspaceSkillsError(input: {
  readonly error: string | null;
  readonly cause: Cause.Cause<unknown> | null;
}): string | null {
  if (input.error === null) return null;
  if (input.cause === null) return input.error;

  const providerError = providerSkillsListErrorDetail(Cause.squash(input.cause));
  if (providerError === null || providerError.detail === null) return input.error;
  if (input.error.includes(providerError.detail)) return input.error;
  return `${input.error} ${providerError.detail}`;
}

export function resolvePendingProviderWorkspaceSkills(
  input: ProviderWorkspaceSkillsSnapshotInput,
): ReadonlyArray<ServerProviderSkill> {
  return input.currentKey === input.nextKey && input.currentSkills.length > 0
    ? input.currentSkills
    : EMPTY_PROVIDER_WORKSPACE_SKILLS;
}

/**
 * Query result arrays are readonly cache values, so these helpers preserve references
 * and rely on callers to keep them immutable.
 */
export function resolveProviderWorkspaceSkills(
  input: ProviderWorkspaceSkillsResolutionInput,
): ReadonlyArray<ServerProviderSkill> {
  if (input.unavailable === true) {
    const currentSkills = resolvePendingProviderWorkspaceSkills(input);
    return currentSkills.length > 0 ? currentSkills : input.fallbackSkills;
  }
  // AsyncResult failures can retain a previous success for stale-while-revalidate.
  // A failed workspace refresh must still fall back to the provider snapshot rather
  // than keeping a stale workspace's skills selectable.
  if (input.error !== null) return input.fallbackSkills;
  if (input.nextSkills !== null) {
    return input.nextSkills.length > 0 ? input.nextSkills : input.fallbackSkills;
  }
  if (!input.isPending) return EMPTY_PROVIDER_WORKSPACE_SKILLS;
  // Do not use the provider-wide fallback while the workspace lookup is pending:
  // it can contain repo-local skills discovered for a different cwd. This also
  // keeps disconnected clients from presenting unverified workspace metadata.
  return resolvePendingProviderWorkspaceSkills(input);
}

export function resolveNextProviderWorkspaceSkillsSnapshot(input: {
  readonly key: string | null;
  readonly skills: ReadonlyArray<ServerProviderSkill> | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly inactive?: boolean;
  readonly unavailable?: boolean;
  readonly current: ProviderWorkspaceSkillsSnapshot | null;
}): ProviderWorkspaceSkillsSnapshot | null {
  if (input.key === null) return null;
  const current = input.current?.key === input.key ? input.current : null;
  if (input.inactive === true) {
    return current;
  }
  if (input.unavailable === true) {
    return current;
  }
  if (input.error !== null) return null;
  if (input.skills === null) return input.isPending ? current : null;
  if (input.isPending) return current;
  return current?.skills === input.skills ? current : { key: input.key, skills: input.skills };
}

export function resolveProviderWorkspaceSkillsQuery(input: {
  readonly target: PreparedProviderWorkspaceSkillsTarget;
  readonly query: ProviderWorkspaceSkillsQueryView;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
  readonly current: ProviderWorkspaceSkillsSnapshot | null;
}): ProviderWorkspaceSkillsQueryResolution {
  const querySkills = input.query.data?.skills ?? null;
  const snapshot = resolveNextProviderWorkspaceSkillsSnapshot({
    key: input.target.targetKey,
    skills: querySkills,
    isPending: input.query.isPending,
    error: input.query.error,
    inactive: input.target.key === null,
    unavailable: input.target.unavailable,
    current: input.current,
  });

  if (input.target.key === null) {
    return {
      snapshot,
      state: {
        skills: input.fallbackSkills,
        isPending: false,
        error: null,
      },
    };
  }

  return {
    snapshot,
    state: {
      skills: resolveProviderWorkspaceSkills({
        nextKey: input.target.key,
        nextSkills: querySkills,
        isPending: input.query.isPending,
        error: input.query.error,
        unavailable: input.target.unavailable,
        currentKey: input.current?.key ?? null,
        currentSkills: input.current?.skills ?? EMPTY_PROVIDER_WORKSPACE_SKILLS,
        fallbackSkills: input.fallbackSkills,
      }),
      isPending: input.target.unavailable ? false : input.query.isPending,
      error: input.target.unavailable
        ? PROVIDER_WORKSPACE_SKILLS_UNAVAILABLE_MESSAGE
        : formatProviderWorkspaceSkillsError({
            error: input.query.error,
            cause: input.query.errorCause,
          }),
    },
  };
}

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderSkillsListError,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSkillsListInput,
  type ServerProviderSkillsListResult,
  type ServerProviderState,
  type ServerSettings,
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

export interface ProviderInstanceSelectionEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly status: ServerProviderState;
}

export interface ServerProviderInstanceSelectionEntry extends ProviderInstanceSelectionEntry {
  readonly snapshot: ServerProvider;
}

export interface ProviderInstanceSelectionResolution<
  Entry extends ProviderInstanceSelectionEntry = ProviderInstanceSelectionEntry,
> {
  readonly requestedDriverKind: ProviderDriverKind;
  readonly lockedContinuationGroupKey: string | null;
  readonly entry: Entry | undefined;
}

export const EMPTY_PROVIDER_WORKSPACE_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
export const PROVIDER_WORKSPACE_SKILLS_UNAVAILABLE_MESSAGE =
  "Reconnect this environment to refresh workspace skills.";

const isServerProviderSkillsListError = Schema.is(ServerProviderSkillsListError);

export function resolveProviderInstanceEnabledFromSettings(
  provider: Pick<ServerProvider, "driver" | "enabled" | "instanceId">,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): boolean {
  const explicitInstance = settings.providerInstances?.[provider.instanceId];
  if (explicitInstance) {
    return explicitInstance.enabled ?? true;
  }

  const isDefault = provider.instanceId === defaultInstanceIdForDriver(provider.driver);
  if (!isDefault) {
    return false;
  }

  const legacyProviders = settings.providers as Readonly<
    Record<string, { readonly enabled?: boolean } | undefined>
  >;
  return legacyProviders[provider.driver]?.enabled ?? provider.enabled;
}

export function deriveProviderInstanceSelectionEntries(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): ReadonlyArray<ServerProviderInstanceSelectionEntry> {
  return providers.map((snapshot) => ({
    instanceId: snapshot.instanceId,
    driverKind: snapshot.driver,
    continuationGroupKey: snapshot.continuation?.groupKey,
    enabled: resolveProviderInstanceEnabledFromSettings(snapshot, settings),
    isAvailable: snapshot.availability !== "unavailable",
    status: snapshot.status,
    snapshot,
  }));
}

const isSelectableProviderInstanceEntry = (entry: ProviderInstanceSelectionEntry): boolean =>
  entry.enabled && entry.isAvailable;

function resolveSelectableProviderInstanceEntry<Entry extends ProviderInstanceSelectionEntry>(
  entries: ReadonlyArray<Entry>,
  instanceId: ProviderInstanceId | undefined,
): Entry | undefined {
  if (instanceId !== undefined) {
    const requested = entries.find((entry) => entry.instanceId === instanceId);
    if (requested && isSelectableProviderInstanceEntry(requested)) {
      return requested;
    }
  }
  return (
    entries.find((entry) => isSelectableProviderInstanceEntry(entry) && entry.status === "ready") ??
    entries.find((entry) => isSelectableProviderInstanceEntry(entry) && entry.status !== "error")
  );
}

/**
 * Keep every client surface on the same provider instance when a persisted
 * selection becomes disabled, unavailable, or incompatible with a live
 * continuation lock.
 */
export function resolveProviderInstanceSelection<
  Entry extends ProviderInstanceSelectionEntry,
>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly preferredInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  readonly lockedDriverKind: ProviderDriverKind | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): ProviderInstanceSelectionResolution<Entry> {
  const explicitInstanceId = input.preferredInstanceIds.find(
    (instanceId): instanceId is ProviderInstanceId =>
      instanceId !== null && instanceId !== undefined,
  );
  const requestedDriverKind =
    input.lockedDriverKind ??
    input.entries.find((entry) => entry.instanceId === explicitInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey =
    input.lockedDriverKind && input.lockedInstanceId
      ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
          ?.continuationGroupKey ?? null)
      : null;
  const isCompatible = (entry: Entry): boolean =>
    (!input.lockedDriverKind || entry.driverKind === input.lockedDriverKind) &&
    (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey);

  for (const instanceId of input.preferredInstanceIds) {
    if (!instanceId) continue;
    const entry = input.entries.find(
      (candidate) =>
        candidate.instanceId === instanceId &&
        isSelectableProviderInstanceEntry(candidate) &&
        isCompatible(candidate),
    );
    if (entry) {
      return { requestedDriverKind, lockedContinuationGroupKey, entry };
    }
  }

  const compatibleEntries = input.entries.filter(isCompatible);
  const requestedDriverEntries = compatibleEntries.filter(
    (entry) => entry.driverKind === requestedDriverKind,
  );
  return {
    requestedDriverKind,
    lockedContinuationGroupKey,
    entry:
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined) ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined),
  };
}

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
    const inactiveSkills =
      snapshot !== null && snapshot.skills.length > 0 ? snapshot.skills : input.fallbackSkills;
    return {
      snapshot,
      state: {
        skills: inactiveSkills,
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

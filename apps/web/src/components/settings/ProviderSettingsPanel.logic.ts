// Keep upstream provider-specific imports source-compatible while the fork's
// Providers and Magi screens share the environment-neutral implementation.
export {
  buildEnvironmentOptions as buildProviderEnvironmentOptions,
  classifyEnvironmentSettingsAccess as classifyProviderEnvironmentAccess,
  isEnvironmentSettingsAvailable as isProviderSettingsEnvironmentAvailable,
  resolveSelectedEnvironmentId as resolveSelectedProviderEnvironmentId,
} from "./EnvironmentSettingsPanel.logic";

export type {
  EnvironmentOperateAccess as ProviderOperateAccess,
  EnvironmentOptionLike as ProviderEnvironmentOptionLike,
  EnvironmentSettingsAccess as ProviderEnvironmentAccess,
} from "./EnvironmentSettingsPanel.logic";

import {
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  type ServerSettings,
  AuthProvidersManageScope,
} from "@t3tools/contracts";
import * as EnvironmentSettings from "./EnvironmentSettingsPanel.logic";
export const resolvePrimaryOperateAccess = (
  input: Parameters<typeof EnvironmentSettings.resolvePrimaryOperateAccess>[0],
) =>
  EnvironmentSettings.resolvePrimaryOperateAccess({
    ...input,
    requiredScope: AuthProvidersManageScope,
  });
export const resolveRemoteOperateAccess = (
  input: Parameters<typeof EnvironmentSettings.resolveRemoteOperateAccess>[0],
) =>
  EnvironmentSettings.resolveRemoteOperateAccess({
    ...input,
    requiredScope: AuthProvidersManageScope,
  });

/**
 * The patch for one instance's project override, following the envelope
 * replacement rule for `projectSettingsOverrides`: the returned entry
 * replaces the project's whole override set, and `null` removes it.
 * `value: undefined` resets that single instance back to inheriting the
 * environment's enablement, leaving any other overridden keys untouched.
 *
 * `providerInstances` is always sent explicitly, even as `{}`, because the
 * server keeps a stored `providerInstances` map when an incoming entry omits
 * the key (so older clients that don't know the field cannot wipe it by
 * editing another setting). Omitting it here would undo the very clear this
 * function means to make.
 */
/** Every checkout of a project on one environment shares the same choice. */
export function buildProviderInstanceOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectIds: readonly ProjectId[],
  instanceId: ProviderInstanceId,
  value: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const patch: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const projectId of projectIds) {
    const current = settings.projectSettingsOverrides[projectId];
    const instances = { ...current?.providerInstances };
    const instance = { ...instances[instanceId] };
    if (value === undefined) delete instance.enabled;
    else instance.enabled = value;
    if (Object.keys(instance).length > 0) instances[instanceId] = instance;
    else delete instances[instanceId];

    const { providerInstances: _omit, ...rest } = current ?? {};
    const nextEntry: ProjectSettingsOverrides = { ...rest, providerInstances: instances };
    patch[projectId] =
      Object.keys(rest).length === 0 && Object.keys(instances).length === 0 ? null : nextEntry;
  }
  return patch;
}

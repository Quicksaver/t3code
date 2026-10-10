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

import { AuthProvidersManageScope } from "@t3tools/contracts";
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

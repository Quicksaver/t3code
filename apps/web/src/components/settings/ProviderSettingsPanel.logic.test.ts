import { describe, expect, it } from "vite-plus/test";

import {
  buildEnvironmentOptions,
  classifyEnvironmentSettingsAccess,
  isEnvironmentSettingsAvailable,
  resolvePrimaryOperateAccess as resolveEnvironmentPrimaryOperateAccess,
  resolveRemoteOperateAccess as resolveEnvironmentRemoteOperateAccess,
  resolveSelectedEnvironmentId,
} from "./EnvironmentSettingsPanel.logic";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

describe("provider settings logic compatibility", () => {
  it("aliases every runtime export to the shared environment implementation", () => {
    expect(buildProviderEnvironmentOptions).toBe(buildEnvironmentOptions);
    expect(classifyProviderEnvironmentAccess).toBe(classifyEnvironmentSettingsAccess);
    expect(isProviderSettingsEnvironmentAvailable).toBe(isEnvironmentSettingsAvailable);
    expect(resolvePrimaryOperateAccess).toBe(resolveEnvironmentPrimaryOperateAccess);
    expect(resolveRemoteOperateAccess).toBe(resolveEnvironmentRemoteOperateAccess);
    expect(resolveSelectedProviderEnvironmentId).toBe(resolveSelectedEnvironmentId);
  });
});

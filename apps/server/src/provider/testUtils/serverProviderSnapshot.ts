import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export const makeServerProviderSnapshot = (
  input: Partial<ServerProvider> & {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  },
): ServerProvider => ({
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...input,
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
  T3HostDisplayPreferencesSchema,
  T3HostLocalEnvironmentBootstrapSchema,
} from "./ipc.ts";

const decodeHostDisplayPreferences = Schema.decodeUnknownSync(T3HostDisplayPreferencesSchema);
const decodeHostLocalEnvironmentBootstrap = Schema.decodeUnknownSync(
  T3HostLocalEnvironmentBootstrapSchema,
);

const basePreferences = {
  showOpenInPicker: false,
  showCheckoutModeIndicator: false,
  showBranchSelector: false,
  enableTerminal: false,
  enableSourceControlPanel: false,
};

describe("T3HostDisplayPreferencesSchema", () => {
  it("accepts unset and in-range thread conversation widths", () => {
    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: null,
      }).threadConversationMaxWidthPx,
    ).toBeNull();

    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MIN_WIDTH_PX,
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MIN_WIDTH_PX);

    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MAX_WIDTH_PX,
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MAX_WIDTH_PX);
  });

  it("rejects out-of-range thread conversation widths", () => {
    expect(() =>
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MIN_WIDTH_PX - 1,
      }),
    ).toThrow();

    expect(() =>
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MAX_WIDTH_PX + 1,
      }),
    ).toThrow();
  });
});


describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("T3HostLocalEnvironmentBootstrapSchema", () => {
  it("accepts host-injected VS Code bootstraps with environment id and bearer token", () => {
    expect(
      decodeHostLocalEnvironmentBootstrap({
        environmentId: "environment-desktop",
        label: "Local VS Code",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        bearerToken: "bearer-token",
      }),
    ).toEqual({
      environmentId: "environment-desktop",
      label: "Local VS Code",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      bearerToken: "bearer-token",
    });
  });
});

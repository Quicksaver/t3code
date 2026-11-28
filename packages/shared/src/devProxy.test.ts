import { describe, expect, it } from "vite-plus/test";
import { resolveDevProxyTarget } from "./devProxy.ts";

describe("development proxy target", () => {
  it.each([
    [undefined, "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
    ["::1", "[::1]"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"],
    ["100.64.0.2", "100.64.0.2"],
  ])("reaches the backend bound to %s", (host, expected) => {
    expect(resolveDevProxyTarget("13773", "ws://ignored:1234", host)).toBe(
      `http://${expected}:13773/`,
    );
  });

  it("retains desktop websocket origin and removes its path and credentials fragment", () => {
    expect(resolveDevProxyTarget(undefined, "wss://localhost:1443/ws?x=1#token", undefined)).toBe(
      "https://localhost:1443/",
    );
    expect(resolveDevProxyTarget(undefined, "invalid", undefined)).toBeUndefined();
  });
});

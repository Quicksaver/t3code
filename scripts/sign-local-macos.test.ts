import type { SignOptions } from "@electron/osx-sign";
import { afterEach, expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";
import signLocalMac from "./sign-local-macos.ts";

vi.mock("./sign-macos.ts", () => ({ default: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("replaces the builder placeholder with the selected certificate and retains entitlements", async () => {
  const identity = "A".repeat(40);
  vi.stubEnv("T3CODE_MACOS_LOCAL_SIGNING_IDENTITY", identity);
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "-",
    type: "distribution",
    optionsForFile: () => ({ entitlements: "/tmp/entitlements.plist", hardenedRuntime: true }),
  } satisfies SignOptions;
  await signLocalMac(options);
  expect(sign).toHaveBeenCalledExactlyOnceWith({ ...options, identity, type: "development" });
});

it.each([undefined, "", "-", "Apple Development", "A".repeat(39)])(
  "refuses to fall back to ad-hoc signing with identity %s",
  async (identity) => {
    vi.stubEnv("T3CODE_MACOS_LOCAL_SIGNING_IDENTITY", identity);
    await expect(signLocalMac({ app: "/tmp/T3 Code.app", identity: "-" })).rejects.toThrow(
      "certificate selected by the build preflight",
    );
    expect(sign).not.toHaveBeenCalled();
  },
);

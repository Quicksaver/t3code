import { describe, expect, it } from "vitest";

import { isLoopbackRemoteAddress } from "./http.ts";

describe("local peer HTTP helpers", () => {
  it("accepts only concrete loopback remote addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.10.20.30")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);

    expect(isLoopbackRemoteAddress("localhost")).toBe(false);
    expect(isLoopbackRemoteAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

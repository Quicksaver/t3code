import { describe, expect, it } from "@effect/vitest";

import { sanitizeErrorCause } from "./ErrorCause.ts";

describe("sanitizeErrorCause", () => {
  it("sanitizes Error values through the bounded record projection", () => {
    const cause = Object.assign(new Error("probe failed"), {
      code: "E_PROBE",
      detail: "bounded detail",
    });

    expect(sanitizeErrorCause(cause)).toEqual({
      name: "Error",
      message: "probe failed",
      detail: "bounded detail",
      code: "E_PROBE",
    });
  });

  it("does not expose unknown object fields", () => {
    expect(
      sanitizeErrorCause({
        message: "safe message",
        stdout: "private process output",
        nested: { path: "/private/workspace" },
      }),
    ).toEqual({ message: "safe message" });
  });
});

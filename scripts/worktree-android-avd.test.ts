import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  resolveCommandInvocation,
  withoutQuickBoot,
  worktreeAvdName,
} from "./worktree-android-avd.ts";

describe("worktree-android-avd", () => {
  it.effect("derives a stable filesystem-safe name from the worktree path", () =>
    Effect.gen(function* () {
      const worktree = "Projects/t3code.worktrees/feature one";
      expect(worktreeAvdName(worktree)).toMatch(/^T3_feature-one_[a-f0-9]{10}$/);
      if (yield* HostProcess.isWindows) {
        expect(worktreeAvdName(worktree)).toBe(worktreeAvdName(worktree.toLowerCase()));
      }
    }),
  );

  it("disables every Quick Boot input idempotently", () => {
    const configured = withoutQuickBoot(
      "fastboot.forceFastBoot=yes\nfirstboot.bootFromLocalSnapshot=yes\nhw.ramSize=2G\n",
    );
    expect(configured).toContain("fastboot.forceColdBoot=yes\n");
    expect(configured).toContain("fastboot.forceFastBoot=no\n");
    expect(configured).toContain("firstboot.bootFromLocalSnapshot=no\n");
    expect(configured).toContain("firstboot.saveToLocalSnapshot=no\n");
    expect(withoutQuickBoot(configured)).toBe(configured);
  });

  it("runs Windows batch tools through an explicit command shell", () => {
    expect(
      resolveCommandInvocation(
        "C:\\Android SDK\\avdmanager.bat",
        ["create", "avd", "--name", "T3_main"],
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Android SDK\\avdmanager.bat",
        "create",
        "avd",
        "--name",
        "T3_main",
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("runs native executables directly", () => {
    expect(resolveCommandInvocation("avdmanager", ["list"], "linux", "/bin/sh")).toEqual({
      args: ["list"],
      command: "avdmanager",
    });
  });
});

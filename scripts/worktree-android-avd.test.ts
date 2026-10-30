import { describe, expect, it } from "vite-plus/test";

import {
  resolveCommandInvocation,
  withoutQuickBoot,
  worktreeAvdName,
} from "./worktree-android-avd.ts";

describe("worktree-android-avd", () => {
  it("derives a stable filesystem-safe name from the worktree path", () => {
    expect(worktreeAvdName("E:\\Projects\\t3code.worktrees\\feature one")).toMatch(
      /^T3_feature-one_[a-f0-9]{10}$/,
    );
    expect(worktreeAvdName("E:\\Projects\\t3code.worktrees\\feature one")).toBe(
      worktreeAvdName("e:\\projects\\t3code.worktrees\\feature one"),
    );
  });

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

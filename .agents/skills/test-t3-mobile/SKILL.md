---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, and mobile pairing against isolated development state.
---

# Test T3 Mobile

Load `$worktrees` for exact-source staging and runtime ownership. Acquire the runtime host's `mobile` lease before native preparation or device interaction, including preparation that only reuses a cache. Follow `$worktrees` when preparing before a pooled device reservation. Keep the upstream Device panel and returned AgentDevice command as the automation path. Release the lease after owned device sessions and processes are closed.

## Open the device

Call `device_list`, then `device_open` with the selected host and device IDs. T3 boots the device and shows its live stream in the Device panel. Follow its returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs` on every operation. Use `device_screenshot` to inspect the screen. On Windows the command is a `.cmd` shim, and `cmd.exe` splits its arguments at every unquoted `&`, including deep-link queries; for such arguments run `node` with the `agent-device-launcher.mjs` beside the shim, followed by the same arguments.

A session name and an Android serial are separate identities. Emulator serials can be recycled after shutdown. If opening reports an existing session, inspect its recorded device identity and owner before recovery. Close only a session proven to belong to this task or a terminated task; do not clear the shared session directory or stop the device daemon. After closing it, reopen through `device_open` and retain the newly returned command and target arguments.

If a snapshot reports a missing helper or instrumentation failure while claiming the helper is current, retain the session's request log, verify the helper package on that exact device, and reopen a fresh owned session once. Let AgentDevice install its own helper. A repeated failure is an automation blocker; do not reinstall the T3 app to repair the automation helper.

A Settings snapshot proves device control only. Application verification requires launching the intended T3 binary, pairing its isolated backend, and exercising the requested flow. If T3 exits before JavaScript, collect its native crash trace and resolved build dependencies before changing Metro or package versions.

If T3 device tools or the selected device are unavailable, report the blocker and stop verification. Do not install or switch to another automation system.

## Prepare the native client

On Windows, finish source installs and stop this task's backend, Metro, and other Node watchers in the target checkout before native preparation, including rebuilds during verification. Retain their captured PIDs and confirm their processes and listeners have exited. A non-watch backend can also keep a loaded native dependency such as `bufferutil` locked while pnpm replaces `node_modules`. Keep the checkout idle until the complete `ensure` command succeeds, including every install, prebuild, and Gradle stage. Start backend, fixture scripts, and Metro afterward; a listening server or completed intermediate install is not this completion criterion.

If preparation fails with a pnpm rename `EPERM`, retain the exact path and inspect this task's captured process tree for remaining consumers before retrying the same helper. Stop only confirmed owned consumers and await any previous preparation process's exit. A native Expo prebuild exit such as `3221226505` (`0xC0000409`) is a separate failure: retain its stage, executable, exit code, and full output. After restoring an idle checkout, allow one retry through `ensure`; if the crash repeats, collect Expo debug output and any Windows crash report and report a preparation blocker. The exit code alone does not identify the faulty dependency or justify changing application package versions.

Use the current helper from that host's `main` checkout and explicitly select the source being tested:

```bash
node "<main-worktree>/scripts/mobile-native-client.ts" ensure <ios|android> <device-id> --worktree "<checkout-being-tested>"
```

On Windows, pass the selected device's actual ADB serial. The helper normalizes dependencies before fingerprinting, then reuses an installed client or local/shared artifact before building. Cache misses use `worktree-android-build.ts assemble --abi <abi>` without a device, preserving short CMake staging, dependency ordering, and the bounded Ninja retry. After assembly the helper installs the APK on the selected serial. `x86_64` and `arm64-v8a` caches are distinct. Direct `worktree-android-build.ts build --device <avd-name>` remains a separate Expo build/install path. Follow `$worktrees` to provision a worktree-owned AVD when needed.

For a pooled device, `ensure <ios|android> --prepare --worktree "<checkout-being-tested>"` can fetch or build the artifact before reserving the device. Hold the preparation host's `mobile` lease for that command; a pooled device reservation does not replace host capacity. Android preparation defaults to `x86_64`; add `--abi arm64-v8a` for an ARM target. Install into the owned AgentDevice session with the same ABI and source checkout, using `ensure <ios|android> --session <session> --worktree "<checkout-being-tested>"` from that session's directory. `--metro <url>` also opens the client. Session cache misses may build, including EAS simulator builds when Xcode is unavailable.

Mobile verification includes a needed native build unless the user prohibits it. Treat build/cache output and session installation as separate milestones; begin application verification only after installation succeeds.

## Use an isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the repository root, retain its terminal session, and read the actual backend port from the dev-runner output. Use the worktree's ignored `.t3` state. Never run against `~/.t3/userdata`. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared [SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Launch T3 Code Dev

Cached iOS simulator clients use `com.t3tools.t3code.dev` with full capabilities; the helper forces `T3CODE_IOS_PERSONAL_TEAM=0`. Set that flag to `0` for Metro as well. Reduced-capability Personal Team builds use the separate local native build and matching Metro setup in [Mobile Apple Development Team](../../../FORK.md#mobile-apple-development-team).

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging to this checkout with the matching configuration. Open its printed development-client URL with AgentDevice `open com.t3tools.t3code.dev <url>` and all returned target arguments. The device must be able to reach both Metro and the isolated backend. Append `&disableAutoLaunch=1&disableFab=1` to the development-client URL query when developer chrome would obscure screenshots or taps; the SDK 58 dev client applies these preferences before the app loads.

## Pair and verify

Use the helper from the repository root, with the returned executable and target arguments stored in `agent_device_command` and the Bash array `agent_device_target_args`:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential and opens T3 Code Dev's existing pairing route through AgentDevice. For a backend on the device host, use `http://127.0.0.1:<server-port>` on iOS or `http://10.0.2.2:<server-port>` on Android. For a remote backend, use its reachable origin.

Confirm the intended projects appear, exercise the affected flow, and capture evidence. Retain the app and environment while iterating. At teardown, remove the disposable connection, close the AgentDevice session, call `device_close`, and stop only your backend and Metro processes. Preserve the helper-managed native artifact cache; it is reusable across worktrees.

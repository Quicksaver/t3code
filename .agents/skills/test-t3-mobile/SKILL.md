---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, and mobile pairing against isolated development state.
---

# Test T3 Mobile

Load `$worktrees` for exact-source staging and runtime ownership. Acquire the selected device host's `mobile` lease before native preparation or device interaction. Keep the upstream Device panel and returned AgentDevice command as the automation path. Release the lease after owned device sessions and processes are closed.

## Open the device

Call `device_list`, then `device_open` with the selected host and device IDs.
T3 boots the device and shows its live stream in the Device panel. Follow its
returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs`
on every operation. Use `device_screenshot` to inspect the screen.

A session name and an Android serial are separate identities. Emulator serials can be recycled after shutdown. If opening reports an existing session, inspect its recorded device identity and owner before recovery. Close only a session proven to belong to this task or a terminated task; do not clear the shared session directory or stop the device daemon. After closing it, reopen through `device_open` and retain the newly returned command and target arguments.

If a snapshot reports a missing helper or instrumentation failure while claiming the helper is current, retain the session's request log, verify the helper package on that exact device, and reopen a fresh owned session once. Let AgentDevice install its own helper. A repeated failure is an automation blocker; do not reinstall the T3 app to repair the automation helper.

A Settings snapshot proves device control only. Application verification requires launching the intended T3 binary, pairing its isolated backend, and exercising the requested flow. If T3 exits before JavaScript, collect its native crash trace and resolved build dependencies before changing Metro or package versions.

If T3 device tools or the selected device are unavailable, report the blocker
and stop verification. Do not install or switch to another automation system.

## Prepare the native client

On Windows, stop this task's backend, Metro, and other Node watchers in the target checkout before native preparation, including rebuilds during verification. Preparation can replace `node_modules`; active watchers can hold package directories open and cause pnpm rename failures. Start those processes after `ensure` succeeds.

Use the current helper from that host's `main` checkout and explicitly select the source being tested:

```bash
node "<main-worktree>/scripts/mobile-native-client.ts" ensure <ios|android> <device-id> --worktree "<checkout-being-tested>"
```

On Windows, pass the selected emulator's actual ADB serial. The helper resolves its AVD name and delegates the complete build to the worktree wrapper, preserving short CMake staging, dependency preparation, and the bounded Ninja retry. Follow `$worktrees` to provision a worktree-owned AVD when needed.

This reuses a matching native client or builds and installs one. Authorized
mobile verification includes that build step unless the user prohibits it.

## Use an isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the
repository root, retain its terminal session, and read the actual backend port
from the dev-runner output. Use the worktree's ignored `.t3` state. Never run
against `~/.t3/userdata`. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Launch T3 Code Dev

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging
to this checkout. Open its printed development-client URL with AgentDevice
`open com.t3tools.t3code.dev <url>` and all returned target arguments.
The device must be able to reach both Metro and the isolated backend.
Append `&disableAutoLaunch=1&disableFab=1` to the development-client URL query
when developer chrome would obscure screenshots or taps; the SDK 58 dev client
applies these preferences before the app loads.

## Pair and verify

Use the helper from the repository root, with the returned executable and target
arguments stored in `agent_device_command` and the Bash array
`agent_device_target_args`:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential and opens T3 Code Dev's existing pairing route
through AgentDevice. For a backend on the device host, use
`http://127.0.0.1:<server-port>` on iOS or `http://10.0.2.2:<server-port>`
on Android. For a remote backend, use its reachable origin.

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Retain the app and environment while iterating. At teardown, remove
the disposable connection, close the AgentDevice session, call `device_close`,
and stop only your backend and Metro processes.

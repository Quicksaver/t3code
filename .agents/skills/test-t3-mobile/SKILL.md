---
name: test-t3-mobile
description: Launch and test T3 Code Mobile on an iOS Simulator or Android Emulator against disposable local T3 environments, including Metro and dev-client reuse, native rebuild decisions, per-client pairing, seeded projects, semantic UI control, screenshots, and iOS serve-sim streaming. Use after mobile UI or native changes, when reproducing phone or tablet behavior, pairing an emulator to isolated state, or verifying mobile behavior on macOS, Linux, or Windows.
---

# Test T3 Mobile

Run one focused, end-to-end mobile verification pass against disposable T3 state. Use the sibling [`test-t3-app`](../test-t3-app/SKILL.md) skill as the detailed reference for pairing-token semantics and SQLite fixtures.

Command examples use POSIX shell syntax. On Windows, use PowerShell equivalents: set variables with `$env:NAME = "value"` and use an explicit temporary directory from `[System.IO.Path]::GetTempPath()`. Keep simple remote commands on one line. For multi-step commands containing control flow or script blocks, create a task-owned `.ps1`, run it with `pwsh -NoProfile -File <path>`, and remove it afterward; do not stream those scripts through non-interactive stdin or rely on backtick continuation. Use `$env:ANDROID_HOME\platform-tools\adb.exe` when `adb` is not already on `PATH`.

## Select a viable platform

Inspect the host and the affected code before launching processes:

- For representative native verification, either iOS or Android is sufficient. When both the Mac iOS runtime and Windows Android runtime are viable, follow the paired opportunistic-acquisition protocol in [`worktrees`](../worktrees/SKILL.md). Enter both host-local mobile queues and use whichever platform acquires first.
- When the change is platform-specific, test only that platform. When the requirement explicitly covers both platforms, register independent platform requests but follow `$worktrees` opportunistic scheduling: run the first acquisition, cancel the other pending request, then re-enter its queue after releasing the first platform. Hold only one platform lease at a time.
- After iOS wins or is specifically required, follow the global `$ios-simulator` skill and the repository's [`ios-debugger-agent`](../ios-debugger-agent/SKILL.md); load [`ios-simulator-browser`](../ios-simulator-browser/SKILL.md) when live streaming is available.
- After Android wins or is specifically required, follow the global `$android-emulator` skill on the selected emulator host.

Do not treat unavailable iOS tooling as a blocker when Android is a valid representative target.
Do not start native preparation, Metro, a backend, a simulator or emulator, or application interaction for a paired representative request until its coordinator has selected that platform as the winner and cancelled the other host's request.

## Choose the lightest valid launch path

- For JavaScript, TypeScript, or asset-only changes, reuse a compatible installed development client and start Metro. Do not rebuild native code merely to load a new bundle.
- For native source, native dependencies, entitlements, config plugins, or generated project changes, rebuild the affected platform.
- Use `vp run ios:dev`, or `vp run android:dev` on macOS or Linux, only when an Expo clean prebuild is actually required; these commands regenerate the native project in the selected worktree. On Windows, use the Android build wrapper below instead.
- On macOS, run every direct CocoaPods command and Expo clean prebuild with `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8` in that process's environment. Prefix the command when it runs through a new SSH invocation because a prior remote export does not persist. For example: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 vp run ios:dev`.
- For a native Android rebuild on Windows, first use `$worktrees` to ensure and launch the worktree-owned AVD. Then run `node scripts\worktree-android-build.ts build --worktree '<windows-worktree>' --device '<avd-name>'` from Windows main. This is the complete native-build operation: it performs the ordinary install and clean prebuild first, configures a short ownership-marked CMake staging path for that worktree, prepares and verifies short dependency paths from both the workspace root and `apps/mobile`, then resolves and invokes Expo directly with the bundler disabled. Do not run `vp run android:dev`, `vp exec expo run:android`, another install, or another prebuild inside this sequence. Use the exact AVD name returned by the AVD helper; continue using the retained `emulator-<port>` serial for every direct ADB command. Start Metro separately with `--max-workers 2` and wait for its listening URL before opening the dev-client deep link.
- If the user requested no native rebuild and no compatible app is installed, reuse an existing compatible `.app` or `.apk` artifact when available. Otherwise report the missing dev client instead of silently rebuilding.

The development identity on both platforms is:

- App: `T3 Code Dev`
- Bundle/package identifier: `com.t3tools.t3code.dev`
- URL scheme: `t3code-dev`

Bundle or package presence proves the correct variant, not native compatibility. Reuse it only when the current changes did not alter its Expo SDK, native dependencies, config plugins, entitlements, generated project, or native source. A runtime error that reports different JavaScript and native React Native versions, or different JavaScript and C++ Worklets versions, proves that client is incompatible. Stop retrying Metro or clearing caches. Rebuild from the selected worktree when authorized; otherwise locate a known-compatible artifact or report the missing client.

## Isolate iOS application state

Mobile capacity limits host load, but it does not isolate the installed development client's database. Reusing one simulator across a worktree wave can accumulate stale environment records, consume a valid pairing credential, and leave a later test reconnecting to unrelated dead backends.

When the selected simulator already contains unrelated environments, or when several worktree tests will run in sequence, create a task-owned disposable simulator before launching the app:

1. Resolve the compatible source app with `xcrun simctl get_app_container <source-udid> com.t3tools.t3code.dev app`.
2. Copy that `.app` with `ditto` into a task-owned directory from `mktemp -d`. Do not uninstall, erase, or otherwise modify the source simulator.
3. Read the source device type and iOS runtime identifiers from `xcrun simctl list devices -j`, `xcrun simctl list devicetypes -j`, and `xcrun simctl list runtimes -j`.
4. Create a uniquely named device with `xcrun simctl create <name> <device-type-identifier> <runtime-identifier>`, boot that exact returned UDID, wait with `xcrun simctl bootstatus <udid> -b`, and install the copied app with `xcrun simctl install <udid> <copied-app>`.
5. Use only the disposable UDID for XcodeBuildMCP defaults, app launch, screenshots, logs, and serve-sim.

Installing the copied compatible app on a newly created simulator gives the test a clean application data container without a native rebuild. Treat ten minutes from the initial boot as the readiness deadline, not an initial delay. As soon as `xcrun simctl bootstatus <udid> -b` succeeds, install and launch the app, then attempt a semantic snapshot immediately. If the snapshot contains only the status bar, use bounded `wait_for_ui` attempts or refreshed snapshots while the simulator continues becoming ready. If it remains status-bar-only for 60 seconds after `bootstatus` completed, shut down and boot the same UDID once, then resume readiness checks. Continue as soon as a usable semantic tree appears; report a readiness failure only when the total ten-minute deadline expires.

At teardown, terminate the app, stop every process using that device, shut down the exact task-owned UDID, delete only that UDID with `xcrun simctl delete <udid>`, and remove the copied app directory. Never delete a pre-existing simulator. When the existing app state is itself the subject of the test, reuse the original simulator instead and remove only the environment created by the test.

## Start one disposable T3 environment

Run backend commands from the repository root. Use the ignored, worktree-local `.t3` directory or create a fresh directory with the host OS's temporary-directory mechanism. For Android verification with Metro on Windows, place the disposable backend state and seeded project in the system temporary directory outside the worktree; Metro's Windows fallback watcher can exit when server cache files are atomically replaced inside the watched repository tree. An explicit base directory stores state in `<base-dir>/userdata`; never point testing at shared `~/.t3` state.

Seed a small number of meaningful Git projects before starting the backend:

```bash
node apps/server/src/bin.ts project add <git-workspace> \
  --base-dir <base-dir> \
  --title <project-title>
```

Running `project add` before the backend starts gives it exclusive offline database access. If a backend is already running, wait until it is ready so the CLI dispatches through the live server; never run offline mutations concurrently with the server.

Use direct SQLite mutation only for disposable projection fixtures. Follow `test-t3-app` and stop the backend before writing.

Start a headless backend after seeding:

```bash
node apps/server/src/bin.ts serve \
  --host 127.0.0.1 \
  --port <server-port> \
  --base-dir <base-dir> \
  --no-browser
```

Use these client origins:

- iOS Simulator: `http://127.0.0.1:<server-port>`
- Android Emulator: `http://10.0.2.2:<server-port>`
- Physical device: bind the backend to `0.0.0.0` and use the host's reachable LAN origin

Enter the complete `http://` origin to make the test transport explicit. Bare IP addresses default to HTTP, while bare hostnames default to HTTPS. When testing web and mobile together, run `vp run dev --home-dir <base-dir> --host 127.0.0.1` instead and do not launch a second backend over the same base directory.

## Start or reuse Metro safely

Run Metro from `apps/mobile`.

1. Inspect any process on the intended Metro port and its `/status` response. Reuse it only when it is healthy, belongs to this worktree, and matches `APP_VARIANT=development`, `--dev-client`, and scheme `t3code-dev`. For iOS, also require `EXPO_OFFLINE=1` in that process's environment; otherwise use a free port and start an isolated Metro.
2. Never kill another worktree's Metro. Use a free explicit port when necessary.
3. `vp run dev:client` currently includes `--clear`; reserve it for an intentional cache reset. For routine verification on the standard port or another free port, retain the complete development identity without clearing:

   ```bash
   APP_VARIANT=development vp exec expo start \
     --dev-client \
     --scheme t3code-dev \
     --lan \
     --port <metro-port>
   ```

   In PowerShell, set `$env:APP_VARIANT = "development"` first and then run the `vp exec expo start ...` command without the leading assignment.

   For iOS verification, also set `EXPO_OFFLINE=1` in the Metro process from its first start. The isolated local workflow has all dependencies installed and does not need Expo's online manifest lookup. For example: `EXPO_OFFLINE=1 APP_VARIANT=development vp exec expo start --dev-client --scheme t3code-dev --lan --port <metro-port>`.

4. Open the exact development-client URL for the selected device and confirm the loaded bundle belongs to this worktree and Metro port.

Do not clear Metro's cache routinely in a serialized worktree wave. Cache keys include the project inputs, while `--clear` forces every worker to recompile thousands of modules and can add several minutes without improving isolation. Restart once with `--clear` only after evidence of a stale or corrupt transform cache.

### iOS launch

Use `ios-debugger-agent` to select one UDID and set these XcodeBuildMCP session defaults:

- Workspace: `<repo>/apps/mobile/ios/T3CodeDev.xcworkspace`
- Scheme: `T3CodeDev`
- Configuration: `Debug`
- Simulator ID: the selected UDID
- Bundle ID: `com.t3tools.t3code.dev`

Keep `persist: false` and leave `derivedDataPath` unset. XcodeBuildMCP derives worktree-specific DerivedData from the selected workspace path. When Windows source is staged on the Mac, reuse a deterministic temporary worktree path for the same originating worktree so its DerivedData remains reusable after the source checkout is removed.

Each concurrent iOS verification needs its own XcodeBuildMCP server process/session and disposable simulator UDID. Before the first semantic action, set that session's simulator and bundle defaults and call `session_show_defaults` to verify them.

Check the installed client with:

```bash
xcrun simctl get_app_container <simulator-udid> com.t3tools.t3code.dev app
xcrun simctl openurl <simulator-udid> <printed-dev-client-url>
```

Open the exact printed dev-client URL, accept the iOS confirmation prompt, and refresh the semantic snapshot. Before minting a one-time pairing credential, clear any Expo developer menu or floating Tools overlay through its semantic close control and refresh the snapshot again. If the overlay has no actionable close control, reopen the same dev-client URL once and repeat the snapshot. Continue to pairing only after the product UI is semantically reachable; do not tap through the overlay by coordinates.

### Android launch

After acquiring Windows mobile capacity, use `$worktrees` to provision the selected worktree's persistent Android 16/API 36 AVD. Launch that exact AVD with `-no-snapshot`, discover its actual ADB serial, and do not reuse another worktree's device.

Select one running emulator serial from `adb devices` and check the installed client:

```bash
adb -s <emulator-serial> shell pm path com.t3tools.t3code.dev
adb -s <emulator-serial> reverse tcp:<metro-port> tcp:<metro-port>
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d '<printed-dev-client-url>' \
  com.t3tools.t3code.dev
```

Do not start, stop, erase, or reconfigure an emulator owned by another task. Track and later stop only processes owned by this test.

After first launch or a deep link, inspect for an Expo developer menu or floating Tools overlay. If it obscures the target, dismiss it or relaunch the registered deep link, then refresh the UI hierarchy before tapping.

## Pair each client once

Use the bundled helper from the repository root. It issues a fresh credential against the running backend's exact base directory, opens the existing Add Environment route with the credential in an encoded query parameter, and asks that route to connect once:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  ios <simulator-udid> <server-port> <base-dir>

.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  android <emulator-serial> <server-port> <base-dir>
```

Run only the command for the selected platform. The helper uses `http://127.0.0.1:<server-port>` for iOS and `http://10.0.2.2:<server-port>` for Android. Pass a fifth argument only when testing a non-development URL scheme.

The helper opens this registered route:

```text
t3code-dev://connections/new?pairingUrl=<encoded-pairing-url>&autoConnect=1
```

The Add Environment route owns the behavior: `pairingUrl` prefills its normal host and token inputs, while `autoConnect=1` submits once in development builds and returns to Home after success. Without `autoConnect`, the same route only prefills the form for manual inspection.

Do not enter pairing hosts or tokens through simulator keyboard automation. Xcode's semantic typer sends HID-style key events through the simulator's active keyboard state, which can corrupt uppercase tokens and punctuation even when the host Mac uses a U.S. input source. The one-shot route is the deterministic pairing path. Use the visible form only as a fallback, and paste credentials rather than typing them character by character.

Verify the expected seeded projects appear before exercising the affected flow.

After entering the host, inspect the field value before entering or submitting the one-time token. XcodeBuildMCP text entry can map punctuation through the host's active keyboard layout, and a layout change can make a previously useful key substitution become literal text. If direct text entry does not render the exact origin, clear the field and use the simulator pasteboard instead:

```bash
printf '%s' '<mobile-origin>' | xcrun simctl pbcopy <simulator-udid>
```

Long-press the focused Host field through XcodeBuildMCP, refresh the semantic snapshot, and tap the exposed **Paste** action by element reference. Confirm that the rendered value is exact before entering the token. Do not guess replacement punctuation, use coordinates, or spend the token while the host is wrong.

Pairing credentials are secret, short-lived, and single-use. Create a different credential for every simulator, emulator, physical device, or browser. If an attempt fails, issue a new credential rather than retrying the old one. Do not expose tokens in screenshots, commits, or final responses.

## Drive and observe the affected flow

### iOS

Use `snapshot_ui` and current element references from XcodeBuildMCP for taps and typing. Stream the same UDID through `ios-simulator-browser` so the user can watch in T3 Code when the host supports it. Use the stream as a visual feed rather than a reason to switch to fragile browser coordinates.

### Android

Prefer semantic Android automation exposed by the current agent host. Otherwise inspect the current hierarchy with `adb shell uiautomator dump`, target stable resource IDs, content descriptions, text, or bounds, and use scoped `adb shell input` actions. Refresh the hierarchy after navigation. Capture the final state with `adb exec-out screencap -p`.

Android does not use serve-sim. Use a browser-compatible Android mirror when the host already provides one; otherwise return focused emulator screenshots as evidence rather than installing unrelated streaming infrastructure during verification.

When serve-sim is opened or inspected in an already-running shared T3 Code
desktop instance, follow `$worktrees` and acquire its desktop runtime slot
before navigating the host. Keep the mobile slot while the mobile runtime is
active, but release the desktop slot immediately after stream evidence is
captured. Never let a mobile stream navigate a shared host concurrently with a
web pairing or preview interaction.

## Verify and clean up

Exercise only the affected flow on one representative device unless the change specifically concerns platform, OS version, or screen size. Before finishing:

1. Confirm the app connected to the intended disposable environment instead of merely rendering an empty disconnected state.
2. Capture the relevant final state.
3. Remove the disposable environment from T3 Code Dev, or delete the task-owned disposable simulator that contained it.
4. Remove any `adb reverse` rule created for this test with `adb -s <emulator-serial> reverse --remove tcp:<metro-port>`.
5. Stop only the serve-sim, Metro, backend, emulator, and log processes started by this test.
6. Remove only base directories and temporary Git repositories deliberately created for this test. Preserve them when they contain useful reproduction evidence.

Keep local verification focused. Do not turn this workflow into a full repository test run.

## Troubleshoot predictable failures

- **Old UI or an old error appears:** verify Metro's worktree, variant, URL, and port before diagnosing the app.
- **The environment remains empty:** verify the platform-specific HTTP origin, use a fresh token, and confirm project seeding used the identical base directory.
- **A second client cannot pair:** pairing tokens are single-use; issue another token.
- **The pairing form opens but does not connect:** confirm the deep link uses the existing `connections/new` route, includes `autoConnect=1`, and carries a freshly minted encoded `pairingUrl`.
- **Pairing text changes case or punctuation:** do not retry semantic typing. Use `scripts/pair-client.sh`; the simulator keyboard layout and HID input path are not reliable for credentials.
- **React Native or Worklets reports different JavaScript and native versions:** follow the definitive compatibility rule in **Choose the lightest valid launch path**.
- **iOS Metro returns a non-JSON manifest beginning with unrelated text:** stop only the affected Metro process and restart it once with `EXPO_OFFLINE=1`, the same worktree, development identity, and port. Use the exact printed dev-client URL.
- **A disposable iOS simulator snapshot contains only the status bar:** follow the active ten-minute readiness deadline in **Isolate iOS application state**. Attempt readiness immediately, restart the same UDID once after the defined 60-second condition, and continue as soon as the semantic tree is usable.
- **iOS semantic actions fail:** set explicit XcodeBuildMCP defaults and refresh with `snapshot_ui`.
- **iOS reports another worktree path:** verify that the session selected the intended workspace and did not inherit an explicit DerivedData override. Start a fresh per-job MCP session when defaults are contaminated.
- **Android cannot reach Metro:** verify `adb reverse` for the exact Metro port and relaunch the development-client URL.
- **Android cannot reach the backend:** use `10.0.2.2`, not `127.0.0.1`, for the Android Emulator.
- **Expo logs `ERR_NOT_AVAILABLE_IN_DEV_CLIENT`:** treat the update-check error as non-blocking only when the intended Metro bundle loads and the tested flow succeeds. Preserve it in the captured logs; do not rebuild solely because it appeared.

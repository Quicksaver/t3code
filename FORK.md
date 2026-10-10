# Custom Branch Changes

> Keep this file readable for humans: do not hard-wrap prose lines; let editors wrap long lines visually. Keep headings, lists, tables, and code blocks structurally formatted.
> Keep these notes a reflection of the current implementation status. History records, such as merge, ports, and update notes, are not meant for this file.
> Each top-level section declares its active worktree branch. `none` means no active worktree owns that section, and subsections inherit the parent section's branch.

## Upstream Baseline

The fork integration boundary is the attached `base/main` control branch, with its Windows worktree at `E:\Projects\t3code.worktrees\base-main`. It advances only by fast-forward to the selected `upstream/main` commit. Each worktree update squashes the assigned branch, including `base/fork`, on its old upstream base, then rebases it onto that control commit while preserving upstream tracking. The completed branch carries one combined customization commit, in addition to follow-up fixes and documentation, directly above the control commit, or equals it if no customizations remain. Customization commits stay on their assigned branches.

For diagnosing existing verification failures, obtain native control results through the main checkout's `scripts/worktree-baseline.ts` `ensure` command; agents must not install or run checks in the control worktree directly. If an earlier failure prevented the relevant test from running, use the helper's `--test <repository-relative-file>` option for separately cached evidence. The helper fingerprints the control commit, host/toolchain, temporary directory, and test selection, and serializes producers sharing the control checkout. A failure seen in a fork worktree is pre-existing only when the same failure appears in the corresponding same-host control check. An unexecuted control check is missing evidence, not a reason to change fork code. Matching environment failures remain recorded without changing `base/main`.

## Fork Documentation And Worktree Orchestration

**Worktree branch:** `none`

`AGENTS.md` points implementation and evaluation work at this file. A task that only orchestrates worktree subagents follows its invoked skill instructions without loading unrelated documentation. Each feature or fix worktree keeps its branch-only contract in `BRANCH_DETAILS.md`, alongside accessory referenced documentation. These files are purposefully git-ignored through the repository's `.git/info/exclude`, not `.gitignore`. `base/fork`, and therefore `main`, consolidates `BRANCH_DETAILS.md` material here and tracks copies of the accessory documentation, but never tracks the branch-specific `BRANCH_DETAILS.md` files themselves. A newly created worktree restores its ignored files from `base/fork`: the branch's section here seeds `BRANCH_DETAILS.md`, and the accessory copies are copied in. A new accessory document joins that exclude block and gains a `base/fork` copy.

Recreate local `main` for each assembly. Feature and fix branches are read-only inputs; mirror `FORK.md` and `AGENTS.md` into `base/fork` as integration documentation changes. Rewind `main` to its latest upstream base, fast-forward to `base/main`, then apply all `base/fork` commits or fast-forward `main` to `base/fork` when equivalent. Cherry-pick each remaining worktree branch's commits onto `main` in turn. Complete its integration glue, focused validation, and affected `FORK.md` updates on `main` before applying the next branch. Reassess these notes against current branch implementations and documentation. Keep documentation with the glue it describes, in the cherry-pick commit for conflict resolutions or in the same follow-up integration commit for subsequent work.

The composed WebSocket RPC factory exceeds TypeScript's inference depth when its service requirements are inferred through `RpcGroup.toLayer`. `apps/server/src/ws.ts` checks the factory service union and each handler's remaining requirements against concrete mapped interfaces before constructing the layer. Update those interfaces when a handler introduces an uncaptured service. `runServer` declares its filesystem, path, and configuration requirements while deriving startup errors from the server layer, so compiler inference cannot leak `any` into the CLI service boundary.

The repository-local orchestration skills divide responsibilities as follows:

- `$worktrees` is the worker contract for exact-worktree execution, same-host control comparison, runtime leases, cross-host source transfer, Android and iOS isolation, and owned teardown.
- `$spawn-worktree` dispatches one worker to one absolute worktree path with only its branch task and required skills. It requires the worker to read that worktree's git-ignored `BRANCH_DETAILS.md`, supervises runtime ownership without leaking orchestration context into the child prompt, and performs exact-worktree lease cleanup only after the worker is terminal.
- `$spawn-worktrees` inventories active non-`main` worktrees and dispatches through `$spawn-worktree`, explicitly excluding the `base/main` control worktree and worktrees whose branch section here is marked `(Currently Inactive)` from worker tasks.
- `$update-worktree` squashes and rebases one assigned branch at the control boundary, assesses only the interaction between incoming upstream work and that branch's customizations, and adds adaptations and documentation as follow-ups on top.
- `$update-worktrees` first fetches upstream and fast-forwards a clean attached `base/main` to the selected `upstream/main` boundary. Only after verifying that exact control state does it dispatch the individual branch updates; it does not mutate the other worktrees itself.
- `$rebuild-main` rebuilds only local `main` from the control boundary and `base/fork`, then applies each remaining worktree branch with its integration glue and `FORK.md` updates before proceeding to the next. Feature and fix branches are read-only throughout this workflow; `base/fork` receives the mirrored documentation commits.
- `$babysit-worktrees` delegates each branch's pull-request comments through `$babysit`, then invokes `$rebuild-main` when fixes were produced. `$update-prs` delegates pull-request publication through `$pr` without doing branch work in the orchestrator.
- `$update-unattended` sequences the full maintenance run: update all worktrees, integrate them, push tracked branches, synchronize the Windows and Mac checkouts, and build the configured Windows, macOS, and Android artifacts. Its per-platform command recipes remain authoritative in that skill.

A branch section whose heading is marked `(Currently Inactive)` and that names a worktree branch describes a deferred branch. Its worktree stays in place, but worktree orchestration skips it until the mark is removed: it is not updated, its pull request is not checked or babysat, and `$rebuild-main` does not integrate it. `$spawn-worktrees` enforces the exclusion; the other orchestration skills dispatch through it.

Every repository-local skill above includes matching `agents/openai.yaml` metadata for its user-facing name, description, and invocation policy. Keep that metadata paired with the corresponding `SKILL.md` when a skill is renamed, added, or removed.

Primary files:

- `AGENTS.md`
- `.agents/skills/worktrees/SKILL.md`
- `.agents/skills/spawn-worktree/SKILL.md`
- `.agents/skills/spawn-worktrees/SKILL.md`
- `.agents/skills/update-worktree/SKILL.md`
- `.agents/skills/update-worktrees/SKILL.md`
- `.agents/skills/rebuild-main/SKILL.md`
- `.agents/skills/babysit-worktrees/SKILL.md`
- `.agents/skills/update-prs/SKILL.md`
- `.agents/skills/update-unattended/SKILL.md`

## Published Database Compatibility

**Worktree branch:** `none`

The installed Windows and Mac databases use the published fork migration IDs 1 through 68 in `effect_sql_migrations`. Preserve those migrations, including the historical lineage columns and archive glue, when assembling main even after retiring the subagent-threading UI and runtime. Their schema remains part of existing databases; retaining it does not re-enable that customization. Magi native-owner uniqueness is published at ID 68. Migration tests use this fork numbering when preparing pre-upgrade state. Standalone branch migrations are represented by this existing schema and must not reuse its published IDs. Upstream's `docs/internals/legacy-orchestration-migration.md` recommends a separate fork migration table because the migrator compares IDs only; on 2026-10-04 the fork chose to keep the shared ledger with a post-68 tail for the orchestration V2 rebuild and to evaluate a separate fork ledger later as its own change. Verify upgrades against isolated databases, never by migrating live userdata during development.

Upstream seeds `statev2.sqlite` once by copying `state.sqlite`, ledger included, and the migrator runs only IDs above the newest recorded one. Main therefore registers upstream's post-V1 migrations, and the standalone branch migrations that follow them, after the published tail:

| Main ID | Name                               | Source                                                                                             |
| ------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| 69      | `OrchestrationV2`                  | upstream `055_OrchestrationV2.ts`                                                                  |
| 70      | `RemoveRedundantProjectionIndexes` | upstream `056_RemoveRedundantProjectionIndexes.ts`                                                 |
| 71      | `ThreadStorageLifecycle`           | Conversation Data Savings `057_ThreadStorageLifecycle.ts`, through `071_ThreadStorageLifecycle.ts` |
| 72      | `MagiV2Projections`                | Magi `057_MagiProjections.ts`                                                                      |
| 73      | `MagiV2ArmClearingAndParticipants` | main-only `073_MagiV2ArmClearingAndParticipants.ts`                                                |
| 74      | `ScheduledTaskWebhooks`            | upstream `057_ScheduledTaskWebhooks.ts`                                                            |
| 75      | `WebhookRelayDeliveries`           | upstream `058_WebhookRelayDeliveries.ts`                                                           |
| 76      | `McpAppModelContext`               | upstream `059_McpAppModelContext.ts`                                                               |
| 77      | `ThreadSnapshotWindowIndexes`      | upstream `060_ThreadSnapshotWindowIndexes.ts`                                                      |

`apps/server/src/persistence/Migrations.ts` imports the upstream files under these IDs without renaming them and exports `PUBLISHED_FORK_MIGRATION_ID` and `ORCHESTRATION_V2_MIGRATION_ID`. A published fork database runs only this tail. An upstream ledger has its exact divergent markers at 35 through 54 removed before the canonical fork replay from 35; upstream's own 33 and 34 markers stay and appear in upstream's divergence warning. Upstream V2 is not idempotent, so its markers at 55 through 58 are held aside, the replay runs through 68, and they are recorded at 69, 70, 74, and 75 with their original timestamps, all in one transaction. Missing fork migrations between relocated markers run before the later marker is recorded, so an upstream webhook or MCP App ledger cannot skip the fork cold-storage and Magi schema. Published fork ledgers may already contain the full tail through 77. Rebuilds preserve all these IDs and migration bodies; startup applies only migrations above the recorded tail. Upstream snapshot marker 60 relocates to 77 with its original timestamp. Upstream MCP App marker 59 relocates to 76 with its original timestamp during upstream-ledger replay. Upstream's `reconcileV2PreviewMigration` still converts V2 preview ledgers into that upstream shape first; it imports the published `066_PullRequestFilesViewed.ts` and `067_ProjectionThreadsAutoSettleDisabledAt.ts` and runs when the requested range reaches 69. Tests that need an upstream ledger use `seedUpstreamLedger` from `apps/server/src/persistence/upstreamMigrationLedger.testFixtures.ts`, which records upstream's ledger over the fork V1 schema; `reconcileV2PreviewMigration.test.ts` covers preview and released upstream V2 ledgers, and `LegacyV1Cutover.integration.test.ts` expects the 33, 34, and site-local 41 divergence.

## Installed Profile Startup Compatibility

**Worktree branch:** `base/fork`

The compatibility implementations and focused regression tests live in `base/fork`, so rebuilding `main` carries them forward before feature branches are integrated.

Upstream commit `de34391427` (`feat(orchestrator): introduce new orchestrator`) made the former event-store boundary for historical `thread.created` events with the retired `parentRelation.kind = "subagent"` lineage unnecessary, so `base/fork` carries none. No path decodes a stored V1 thread event against current contracts:

- `packages/contracts` no longer defines a V1 `thread.created` payload; the only `thread.created` schemas are the V2 domain events in `packages/contracts/src/orchestrationV2.ts`.
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` reads through `readApplicationRows`, which selects only `aggregate_kind = 'project'` rows and `application_event_version = 2` thread rows. `rowToApplicationStoredEvent` decodes them with `rowToProjectEvent` or `rowToV2StoredEvent`, and agent replay, replay stats, and latest-sequence queries are likewise restricted to version 2.
- `apps/server/src/persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts` marks existing rows as version 1 through the new column's default and copies only `orchestration_v2_events` payloads, as opaque JSON. Earlier migrations rewrite V1 payloads with SQLite JSON functions, not contract decoding.
- `apps/server/src/persistence/initializeV2Database.ts` seeds `statev2.sqlite` with a worker-thread `VACUUM INTO` copy of `state.sqlite`, retaining every table and the published migration ledger without blocking the server event loop.
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` builds V2 threads and transcripts from `projection_threads` and the other projection tables. Its `orchestration_events` queries test only for version-2 rows, so retired subagent threads arrive as ordinary conversations.
- `compactEventStore` in `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` reads only the sequence, version, kind, stream, and type columns of V1 rows, then deletes rows whose transcript import has finished, without decoding payloads.

The shipped web and desktop connection cache has already reached IndexedDB version 7, including archive-time thread-cache eviction. Preserve that version floor when integrating standalone branches. Requesting an older version prevents cache access even when the server and its SQLite database are healthy. IndexedDB opens lazily and recovers closed connections, while the desktop catalog can load independently through its secure bridge. The version-7 upgrade hook stays inside the guarded open path, and regression coverage exercises thread-cache reads as well as catalog loading. Verify upgrades with an existing client profile as well as server data.

Focused regression coverage:

```sh
vp test run apps/web/src/connection/storage.test.ts
```

## Local Rust Toolchain Overrides

**Worktree branch:** `none`

Rust toolchain selection for desktop artifact builds is machine-local setup, not mergeable branch state. The native resource monitor currently requires Rust `1.95.0`, while the host's global default may remain on another version. Install the required toolchain alongside the global default, then persist directory overrides for the main checkout and the shared linked-worktree parent:

```sh
rustup toolchain install 1.95.0 --profile minimal
rustup override set --path /Users/luismiguelsousa/Sites/t3code 1.95.0
rustup override set --path /Users/luismiguelsousa/Sites/t3code.worktrees 1.95.0
```

The main override applies only to the main checkout. The `t3code.worktrees` override applies to all current and future linked worktrees beneath that directory. These overrides persist across shell and application sessions, and every worktree reuses the one installed toolchain.

Re-evaluate both overrides whenever the project's minimum supported Rust version changes or the host's global Rust version changes. A directory override takes precedence over the global default, so a global update alone does not change the toolchain used in these directories. If the project needs a new pinned version, install it once and set both overrides again with that version. If the global default becomes suitable and a separate project pin is no longer wanted, remove both overrides:

```sh
rustup override unset --path /Users/luismiguelsousa/Sites/t3code
rustup override unset --path /Users/luismiguelsousa/Sites/t3code.worktrees
```

After setting, updating, or removing the overrides, verify `rustup show active-toolchain` from the main checkout and from one representative linked worktree.

## Development Worktree Isolation And Sharing

**Worktree branch:** `none`

Load `$worktrees`.

The fork retains upstream's worktree-local development state, stable preferred port selection, single-origin browser development, and Tailscale sharing while preserving the small amount of host-local runtime coordination still needed for desktop and mobile verification.

Expected behavior:

- A linked Git worktree defaults development state to its own ignored `<worktree>/.t3/userdata`, even when the parent environment exports `T3CODE_HOME`. An explicit `--home-dir` still wins. The main checkout retains the implicit `~/.t3/dev` default, and submodules are not treated as linked worktrees.
- Worktrees derive a stable preferred port offset from their path. The dev runner advances the server and web ports together when either required port is occupied, and it skips web ports blocked by the Fetch standard. The printed `[dev-runner]` ports are authoritative.
- Browser `dev` and `dev:web` modes are single-origin. They omit baked `VITE_HTTP_URL` and `VITE_WS_URL` values and mark that intent explicitly so repository environment files cannot revive them. Vite proxies backend paths through the shared prefix list and uses `resolveDevProxyTarget` with `T3CODE_HOST`: an unset host keeps upstream's `localhost` default, wildcard binds map to the matching loopback family, and concrete addresses remain concrete. The shared prefix list includes `/mcp` alongside `/api`, `/ws`, `/oauth` and `/.well-known`, preserving upstream's origin policy so OAuth metadata names the browser's public origin.
- `vp run dev --share` publishes the selected web port through `tailscale serve`, builds pairing and development URLs from the tailnet origin, clears stale mappings before sharing, and removes the owned mapping when the runner exits. Its local proxy target uses `localhost` so the operating system can select the Vite listener's IPv4 or IPv6 loopback address; focused fixtures assert the exact serve target instead of baking in one host's path or address semantics. Sharing is unsupported for desktop mode and has no effect for server-only mode.
- `$test-t3-app` recognizes the older-worktree failure where Tailscale proxies `127.0.0.1` while Vite listens on `::1`: a healthy loopback origin plus a shared 502 triggers exact-mapping replacement with a `localhost` target and bare-origin verification, not repeated application restarts or premature token consumption.
- Development authentication accepts configured remote origins, scopes browser session cookie names by port, and gives startup pairing credentials a 24-hour lifetime so concurrent or remotely shared worktrees do not overwrite each other's browser sessions.
- The dev runner defaults Node HTTP headers to 64 KiB and preserves an explicitly configured `NODE_OPTIONS` header limit. Port-scoped worktree cookies still share a hostname and accumulate across ports; the default Node 16 KiB limit can reject those requests before Vite routes them.
- Browser development leaves Vite HMR origin-derived so tailnet and LAN clients connect back to the page origin. Desktop development remains explicitly pinned to `127.0.0.1`; its HMR configuration continues to honor an explicit `VITE_DEV_SERVER_URL`, including HTTPS and non-default ports. Server-only backend URLs and the default Vite listener also retain IPv4 loopback behavior.
- Web servers have no runtime queue. Worktree-local state, path-derived preferred ports, and the actual ports printed by `dev-runner` let independent worktrees run concurrently. Integrated web UI automation still holds the selected host's desktop lease, regardless of browser driver.
- Verification workers record and remove their exact disposable state directories, temporary repositories, source snapshots, and linked worktrees after owned processes stop and leases are released. Worktree-owned Android AVDs and ordinary path-keyed Xcode DerivedData remain reusable.
- The fork extends upstream `$test-t3-app` with collaborative-preview routing for worktree web servers, including direct environment-port navigation when the preview has a verified route and `--share` fallback for Windows or other tailnet consumers.
- Each assigned worktree remains authoritative on its host. Typechecks and automated tests run directly there with the repository's normal host-native commands and need no verification lease or source snapshot. Failures are compared with the cached upstream-control result produced on the same host before they are treated as branch regressions.

Primary files:

- `packages/shared/src/devHome.ts`
- `packages/shared/src/devProxy.ts`
- `scripts/dev-runner.ts`
- `scripts/lib/dev-share.ts`
- `apps/web/vite.config.ts`
- `apps/server/src/auth/EnvironmentAuthPolicy.ts`
- `apps/server/src/auth/SessionStore.ts`
- `apps/server/src/config.ts`
- `.agents/skills/test-t3-app/SKILL.md`

Focused regression coverage:

```sh
vp test run packages/shared/src/devProxy.test.ts
```

## Mobile Testing Harness Reliability And Isolation

**Worktree branch:** `none`

Mobile verification uses upstream's Device panel and the exact AgentDevice command and target arguments returned by `device_open`. Host-local mobile leases still cover native preparation, device interaction, Metro/backend lifetime, and teardown. Concurrent jobs select distinct devices and test their assigned checkout or exact-source remote snapshot.

`mobile-native-client.ts ensure` owns native compatibility records and build selection. On Windows it resolves the selected emulator serial to an AVD name, then delegates the complete build to `worktree-android-build.ts`. The wrapper preserves the ordered install, clean prebuild, short CMake staging, hoisted dependency preparation, direct Expo build, and one bounded Ninja retry. Worktree-owned API 36 AVDs remain reusable and are opened through the Device panel.

On iOS, the native-client helper owns the simulator build/install and scoped temporary DerivedData. The Device panel owns streaming and screenshots. Pair through the mobile skill's deep-link helper; this avoids keyboard-layout changes to a typed host URL. On Windows the returned AgentDevice command is upstream's `.cmd` shim, which `cmd.exe` runs by re-parsing the whole command line, so an unquoted `&` in a deep-link query ends the command early; no batch-file change can prevent that. The pairing helper and any `&`-bearing argument therefore run the `agent-device-launcher.mjs` beside the shim with `node` instead. Close owned AgentDevice sessions and Device panels before releasing leases, and remove temporary source worktrees afterward.

Android native builds constrain fbjni to the installed React Native catalog exposed by Expo, so a library's wildcard cannot select a binary incompatible with React Native's packaged C++ runtime. The policy contains no dependency version and follows catalog upgrades automatically. The Expo plugin applies it to normal and distribution builds; main's Windows wrapper copies the same policy into each target's generated Android project without modifying that feature branch. Native-client compatibility fingerprints include the wrapper's policy so an older APK cannot be reused after the policy changes.

Metro excludes the worktree's `.t3` directory itself and its descendants with either path separator. The watcher must not enter runtime state, where atomic cache writes can remove a file between discovery and watch registration. Windows native preparation runs before the test backend and Metro start so their watchers cannot hold dependency directories open during installation.

Primary files:

- `.agents/skills/test-t3-mobile/SKILL.md`
- `.agents/skills/test-t3-mobile/scripts/pair-client.sh`
- `.agents/skills/worktrees/SKILL.md`
- `scripts/mobile-native-client.ts`
- `scripts/worktree-runtime-slot.ts`
- `scripts/worktree-android-build.ts`
- `scripts/worktree-android-dependencies.ts`
- `scripts/worktree-android-avd.ts`

## Multi-Environment Verification

**Worktree branch:** `none`

The verification suite can combine results from the Windows Desktop and the MacBook Pro. A platform requirement selects the host for that check; it does not by itself make the check unavailable or require a project-specific testing skill change.

Expected behavior:

- Run typechecks and automated tests directly in the assigned worktree on its current host. Obtain that host's native cached upstream-control result before changing code for a failure. Path, permission, process, filesystem, or locale failures that also appear in the same-host control manifest are upstream behavior for that environment, not fork regressions.
- Run iPhone Simulator checks on the MacBook Pro. When the initiating checkout is on another machine, connect through `ssh macbook-pro` and transfer its code, including uncommitted changes, as a task-owned source snapshot in an isolated Mac worktree. Build that snapshot rather than an unrelated pre-existing Mac checkout; no commit or push is required. When the suite is already running on the Mac against the intended local checkout or worktree, use it directlyâ€”do not SSH to the same machine or create a redundant copy.
- Run Xcode, CocoaPods, Metro, the backend, and simulator-facing services on the Mac, using Mac paths and an explicit simulator UDID. Keep simulator-facing endpoints on `127.0.0.1`; the Mac cannot reach its own Tailscale Serve or MagicDNS endpoint through self-hairpin routing. The selected Mac Device-panel host must be connected and its device tools available.
- Run Android Emulator checks on the Windows Desktop. When the initiating checkout is on another machine, connect through `ssh windows-desktop` and transfer its code, including uncommitted changes, as a task-owned source snapshot in an isolated Windows worktree. Build that snapshot rather than an unrelated pre-existing Windows checkout; no commit or push is required. When the suite is already running on Windows against the intended local checkout or worktree, use it directlyâ€”do not SSH to the same machine or create a redundant copy.
- Headless Android verification is available over SSH through Windows Hypervisor Platform and ADB; the Android 16/API 36 x86_64 AVD has completed a full boot through the MacBook Pro-to-Windows SSH path. Run Gradle, Metro, the backend, and emulator-facing services on Windows with Windows paths. Use `10.0.2.2` for emulator-to-host backend traffic and ADB port reversal for Metro. Drive the selected emulator through the Device panel's returned AgentDevice command, and capture evidence with `device_screenshot`.
- Treat results as host-scoped evidence. A successful macOS permission assertion can complement but does not erase the expected Windows mode-reporting mismatch, and a mobile pass applies only to the exact local checkout or transferred snapshot that was tested.
- Runtime leases are machine-local. Acquire and release them on the host running desktop or mobile interaction, following `$worktrees`; commands issued over SSH use the destination host's main and worktree paths. Non-interactive web checks need no lease, while integrated web UI automation uses the browser host's desktop lease.

This section is the shared routing policy for full verification runs. Keep platform availability and expected outcomes here instead of duplicating them in individual test skills.

## SSH Device Host Commands

**Worktree branch:** `fix/ssh-device-host-commands`

SSH bootstrap and device commands send their shell scripts through stdin to `sh -s`, so a Windows PowerShell login shell cannot reinterpret POSIX quoting, variables, or the Node version check. Command input is supplied inside that script with `printf %b`, escaping backslashes, carriage returns, and NUL bytes so quotes, line breaks, CRLF, NUL, and the absence of a trailing newline arrive byte-for-byte. Bootstrap opts into the Node version check with the named `nodeBootstrap` option. The stdin transport wraps the generated Node script. Local SSH fixtures use the upstream `HostProcess.Platform` service; generated scripts still use the remote Node process.

SSH device hosts use one npm invocation path for connection probes and pinned tool installation. Windows runs `npm-cli.js` through the selected Node executable, checking beside Node before PATH directories and preserving paths and arguments containing spaces. Non-interactive POSIX setup appends fallback tool directories so an existing Node/npm pair keeps priority. Bootstrap restores fallback-directory precedence if the selected Node is missing or older than 22, then applies the configured SDK and JVM paths so their tools keep priority. Ordinary device commands do not repeat that version probe. Unsupported-runtime errors include the detected version and executable path. Missing npm, launch failures, signals, and nonzero process exits retain distinct diagnostics, with a bounded stdout fallback when stderr is empty.

Primary files:

- `apps/server/src/device/sshDeviceScript.ts`
- `apps/server/src/device/SshDeviceHost.ts`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/sshDeviceScript.test.ts apps/server/src/device/SshDeviceHost.test.ts
```

Regression coverage executes bootstrap and device-command payloads through the native login shell, including PowerShell on Windows, and checks quoted arguments, exact stdin, and failure propagation. Native Windows subprocess coverage checks paths containing spaces, npm PATH fallback, probe and install dispatch, missing npm, and actual npm failure diagnostics. POSIX-only shell and lifecycle fixtures require a POSIX host; their bodies do not execute on Windows. The supported/old-Node PATH case is one `it.effect.each` table, as upstream's `t3code/no-test-in-loop` lint rule forbids declaring tests inside loops. The supported/old-Node PATH-selection and SDK/JVM precedence cases were additionally verified with isolated Git Bash shell fixtures on Windows. Over a real Mac-to-Windows SSH connection, the previous payloads failed the probe with a false missing-npm error and silently dropped a quoted device command; the current payloads return the probe result and deliver the argument and stdin byte-for-byte.

## SSH Android SDK Capability

**Worktree branch:** `fix/ssh-android-sdk-capability`

SSH host probes require SDK Platform-Tools, Android Emulator, and the latest SDK Command-line Tools before reporting Android available, matching local hosts. Tools must be regular files and executable on POSIX; executable symlinks remain supported. Inspection failures report Android unavailable while retaining iOS. The probe resolves `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the platform's default SDK location, exports the resolved SDK for the hub, and reports which component is missing. An adb-only host reports Android unavailable without disabling iOS. The shell prelude uses the same SDK resolution before every command, so an explicit `ANDROID_SDK_ROOT` is not shadowed by an incomplete default directory. No Windows `LOCALAPPDATA` default is inferred when the SSH shell cannot provide it. On main, the SDK fixtures share `SshDeviceScript` with the login-shell cases and invoke its environment-prelude function before running the probe.

Primary files:

- `apps/server/src/device/sshDeviceScript.ts`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/sshDeviceScript.test.ts
```

Capability fixtures are one `it.each` case per missing SDK component (Platform-Tools, Android Emulator, Command-line Tools) plus a complete SDK, each asserting iOS stays available. POSIX lifecycle fixtures provide a complete SDK, because adb on PATH alone no longer enables Android; their bodies do not execute on Windows. Over a real SSH connection to an adb-only Mac (Homebrew adb, no Android Emulator or SDK directory), the previous probe reported Android available, after which `emulator -list-avds` exits 127; the current probe reports the missing Platform-Tools and keeps iOS available.

## Device Discovery Retention

**Worktree branch:** `fix/device-discovery-retention`

When a host's Android tools are available but `emulator -list-avds` fails, the shared service retains devices returned by the hub instead of failing the whole listing, and reports the command, exit code, and a diagnostic tail of at most 2000 characters alongside any hub discovery errors. Local timeouts and missing exit codes are failures; timeouts report exit 124. Successful enumeration still adds unbooted AVDs without duplicating running or repeated entries; a successful refresh clears prior warnings. Local and SSH hosts use the same behavior. On main, SSH commands retain the byte-preserving stdin transport and opt into `keepErrorOutputTail` on the same request, so retention diagnostics do not replace the login-shell fix. Command stdin stays inside `remoteDeviceCommand`; assigning it directly to the SSH request would replace the generated shell prelude.

Web and desktop show labeled ready-host diagnostics in bounded, scrollable views in the Device panel, setup wizard, and Integrations; SSH settings and the Tools drawer bound their diagnostic text too. Android creation guidance is withheld only when no Android device exists and the optional `androidDiscoveryIncomplete` flag reports an AVD enumeration failure. Successful empty enumeration keeps creation advice even when an unrelated iOS diagnostic remains. Mobile ignores the optional flag and retains its inventory behavior; agents use the shared device service and wire contract.

List and retry capture the attempt sequence and host instance before readiness. Lifecycle-serialized publication guards both successful and failed terminal outcomes and readiness status writes, so stale failures cannot replace newer discovery. Accepted failures advance the watermark; disabled support and host replacement reject late publication. Successful local refresh restores both legacy and per-host ready status and clears diagnostics.

Primary files:

- `apps/server/src/device/DeviceService.ts`
- `apps/web/src/components/device/DevicePanel.tsx`
- `apps/web/src/components/device/DeviceSetup.tsx`
- `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/DeviceMultiHost.test.ts apps/server/src/device/DeviceService.test.ts apps/server/src/device/sshDeviceScript.test.ts apps/web/src/components/settings/IntegrationsSettings.test.tsx
```

`DeviceMultiHost.test.ts` covers local and SSH retention, stale successful and failed refreshes, readiness ordering, host replacement, and local recovery through Deferred-controlled service tests. Other fixtures cover bounded command output, preserved iOS and physical Android results, and AVD deduplication. Setup-guidance tests cover Android-specific enumeration warnings, unrelated iOS warnings, recovery, and retained Android devices. Historical web captures used labeled fixtures and older guidance; they do not establish current integrated discovery, streaming, native visibility, or separate SSH-settings and Tools flows.

## Pairing Token Navigation

**Worktree branch:** `base/fork`

An open pairing page accepts each new pairing link delivered to it, so a desktop or preview host can pair again without a reload or a second window.

Expected behavior:

- The primary pairing route watches for later URL-fragment changes while it remains mounted. Navigating an already-loaded `/pair` document to `/pair#token=...` claims each new token once, removes the secret fragment, and runs the normal pairing exchange without requiring a reload or a second desktop window. Multiple tokens received while an exchange is pending are serialized, and the submitting state remains active until every queued exchange settles.

Primary files:

- `apps/web/src/components/auth/PairingRouteSurface.logic.ts`
- `apps/web/src/components/auth/PairingRouteSurface.tsx`

Focused regression coverage:

```sh
vp test run apps/web/src/components/auth/PairingRouteSurface.logic.test.ts
```

## Development Desktop Isolation

**Worktree branch:** `base/fork`

Worktree development desktops start from their own Electron profile.

Upstream commit `3b5d476eb` (`fix(desktop): stop overwriting a custom dock icon on launch`) owns preserving packaged macOS dock icons in `apps/desktop/src/app/DesktopAppIdentity.ts` by assigning the runtime PNG icon only to unpackaged apps. The branch composes its isolated desktop user-data path with that behavior; it does not override the upstream icon policy.

Upstream commit `de34391427` (`feat(orchestrator): introduce new orchestrator`) owns Electron profile selection in `apps/desktop/src/app/DesktopUserData.ts`: packaged builds use the separate `t3code-v2` profile, seeding Windows `Local State` from the earlier profile, while development keeps an existing `T3 Code (Dev)` profile. Both the Clerk bridge and app identity resolve the profile through that helper before Electron is ready. The branch adds only an explicit override ahead of that selection.

Expected behavior:

- `dev:desktop` derives `T3CODE_DESKTOP_USER_DATA_DIR=<resolved base dir>/userdata/electron` whenever the runner has an explicit base directory. Desktop configuration resolves that override to an absolute path, and `DesktopUserData.resolveUserDataPath` returns it before any legacy-profile probe or upstream profile selection, so the Clerk bridge's profile lock and app identity use the same isolated directory. This keeps an isolated worktree dev desktop from reusing an installed or earlier development profile whose incompatible IndexedDB schema can prevent the renderer from starting. Packaged/default startup remains unchanged when no override is supplied, and packaged macOS startup preserves the bundle or user-customized dock icon while unpackaged development still assigns the runtime PNG icon.

Primary files:

- `apps/desktop/src/app/DesktopUserData.ts`
- `apps/desktop/src/app/DesktopConfig.ts`
- `apps/desktop/src/app/DesktopEnvironment.ts`
- `scripts/dev-runner.ts`

Focused regression coverage:

```sh
vp test run scripts/dev-runner.test.ts apps/desktop/src/app/DesktopAppIdentity.test.ts apps/desktop/src/app/DesktopEnvironment.test.ts apps/desktop/src/app/DesktopClerk.test.ts
```

## Windows Expo Widgets Layout Registry

**Worktree branch:** `base/fork`

Android builds run expo-widgets' `:expo-widgets:generateExpoWidgetsLayoutRegistry` Gradle task, which bundles the widget initial layouts through the package's `layout-registry.metro.config.js`. That resolver treats only specifiers beginning with `/`, `\`, `./`, or `../` as files and substitutes Metro's empty module for every other name. Metro resolves the empty module through the same resolver by its absolute path, which on Windows begins with a drive letter, so the resolver substitutes the empty module again until the stack overflows (`RangeError: Maximum call stack size exceeded` through `ModuleResolver._getEmptyModule`). The generated layout imports are absolute paths as well, so the same rule would also have emptied the widget layouts. macOS paths begin with `/`, so iOS and Mac-hosted Android builds are unaffected; every Windows Android build, including unmodified `base/main`, fails without the fix.

Upstream's `patches/expo-widgets@58.0.11.patch` gains one hunk that also treats `path.isAbsolute` specifiers as files. That covers Windows drive-letter and UNC paths and leaves POSIX behavior unchanged. `pnpm-lock.yaml` records the resulting patch hash. When upstream changes or drops this patch, keep the hunk unless Expo's resolver already recognizes Windows absolute paths. Retire it once a released expo-widgets version fixes the resolver; the fix is small and general enough to propose to Expo.

Standalone feature branches carry upstream's patch without this hunk. Main's Windows Android wrapper applies the same check to the target worktree's installed `layout-registry.metro.config.js` after dependency preparation, without modifying that branch. It replaces the file rather than editing it, so pnpm's store hardlinks stay untouched, skips a resolver that already accepts absolute paths, and reports one whose file check it no longer recognizes. Retire the wrapper step together with the hunk.

Primary files:

- `patches/expo-widgets@58.0.11.patch`
- `pnpm-lock.yaml`
- `scripts/worktree-android-build.ts`

`scripts/worktree-android-build.test.ts` covers the wrapper step; the patched dependency itself has no automated regression test. On Windows, a native-client Android build that passes `:expo-widgets:generateExpoWidgetsLayoutRegistry` and embeds a non-empty `SubscriptionUsage` layout proves it.

## Worktree Runtime And Native Baseline Coordination

**Worktree branch:** `none`

The fork keeps host-local coordination for interactive desktop and mobile verification. Source checks run directly in each assigned worktree without a lease, while one deterministic script per host owns native verification of that host's upstream control branch. Shared orchestration changes stay on `main` and `base/fork`; standalone feature branches use the current main helpers against their own source. The native-client helper accepts `--worktree`, keeps fingerprinting and builds in that target, and resolves its Android preparation helpers beside itself.

Expected behavior:

- `scripts/worktree-runtime-slot.ts` exposes `mobile` capacity two and `desktop` capacity one on each host. Version 1-3 state migrates to the version 4 shape and obsolete web holders or requests are discarded. Command-line acquisition and release require a request id; interrupted acquisition cancels that request and releases a matching near-simultaneous holder.
- `scripts/worktree-baseline.ts` computes host-native upstream-control install, typecheck, and bounded-test results once for an exact commit and host/toolchain fingerprint. It invokes pnpm through the Windows command processor on Windows and directly on macOS or Linux. Concurrent cache misses on one host coalesce behind one producer. The script alone operates that host's control worktree and writes logs and the manifest atomically under ignored `.t3/research/worktree-baselines`; interrupted and out-of-memory runs are not cached.
- Baseline waiters leave a live producer's lock and reclamation directory untouched. Startup and failed-task fixtures drain their owned asynchronous work before removing temporary files.
- Android preparation resolves Expo and autolinking in a fresh Node process after dependency installation, so changing to a hoisted layout cannot retain the previous process's module-resolution cache.
- Staged macOS helper checkouts link their entire `.t3` directory to the persistent main coordinator directory. Linking only the ledger file fails when the coordinator atomically replaces it. Teardown unlinks the helper's directory link and preserves the canonical coordinator.
- Candidate workers run source checks normally in their assigned worktrees without a lease. Before changing code or tests for a failure, they compare its exact output with the same-host control manifest and logs. Shared host-specific and locale failures remain unchanged.
- Web servers have no runtime queue. Each worktree uses its own ignored `.t3` state and reads the actual server and web ports from `[dev-runner]`. Integrated UI automation, including standalone browser fallbacks, uses the selected host's desktop lease.
- Workers enter every ready desktop and mobile queue concurrently, run the first eligible acquisition, cancel their other requests, and re-enter the remaining queues after releasing the winner. Each worker holds one runtime lease at a time except while a mobile stream briefly uses a desktop renderer.
- Representative mobile verification races the Windows Android and macOS iOS hosts. Integrated web UI verification uses an available Browser renderer, explicitly pinned to its actual host and protected by that host's desktop lease. Record the renderer separately from the environment serving the application. Request-scoped cancellation safely releases a losing near-simultaneous acquisition. Queue age never triggers cancellation, replacement, reprioritization, or coordinated handoff.
- The host-local capacities permit two Android and two iOS verifications simultaneously across the fleet. Desktop permits one interaction block per renderer host at a time.
- `node "<main-worktree>/scripts/mobile-native-client.ts" ensure android <adb-serial> --worktree "<assigned-worktree>"` is the Windows operator entrypoint. It prepares hoisted dependencies before fingerprinting, reuses an already prepared layout, and delegates builds to `scripts/worktree-android-build.ts`. The wrapper orders the normal install and no-install Expo clean prebuild before `scripts/worktree-android-dependencies.ts`, then patches the generated app Gradle file to use Android Gradle's `buildStagingDirectory` at `<worktree-drive>:\.t3code-android-cxx\<worktree-hash>`. That short path prevents app-level CMake object paths from crossing Windows' 260-character boundary; a canonical-worktree ownership marker keeps every staging cache isolated. The same generated block passes `-DCMAKE_OBJECT_PATH_MAX=250` to the app's CMake, and a marked `subprojects` block the wrapper appends to the generated root `build.gradle` gives every `com.android.library` module its own staging subdirectory and the same argument, because libraries such as React Native Reanimated configure separate CMake projects beneath the worktree's `node_modules`. Both blocks are rewritten after every clean prebuild, so no generated file needs hand editing. AGP passes 1024, so CMake otherwise names objects for sources outside a module's CMake directory, such as React Native Gesture Handler 3's `../shared/shadowNodes`, after their mangled absolute path, and Ninja rejects the resulting build-relative path as longer than 260 characters regardless of the staging root. At CMake's Windows default of 250, CMake hashes those names to fit beneath the short staging root. Retire the app and library arguments when AGP stops overriding the limit or the long object paths leave the app's autolinked and the libraries' own CMake projects. The wrapper uses the target checkout's Expo and React Native autolinking results to discover native source directories and validates their paths. It resolves Expo from `apps/mobile` before calling it directly, so Vite+ cannot invalidate the prepared layout before Gradle. On the exact Ninja dirty-manifest failure it waits for the failed build to exit, removes only generated `.cxx`, CMake intermediates, and the contents of that worktree's marked staging directory, revalidates, and retries once. The retry keeps the canonical worktree path rather than substituting a drive whose removal can corrupt an active Gradle build. `scripts/worktree-android-dependencies.ts` removes stale package-level dependency links only inside the selected Windows worktree and performs the frozen worktree-local hoisted install. The ordinary pnpm content store remains tool-managed and no virtual store or native staging directory is shared between worktrees. Windows Android verification keeps its disposable backend state and seeded project outside Metro's watched worktree because atomic cache replacement can otherwise terminate Metro's fallback file watcher on a transient path.
- `scripts/worktree-android-avd.ts` lazily provisions one persistent API 36 AVD per canonical Windows worktree. It invokes Windows batch SDK tools through an explicit command shell, refuses to install a missing system image without authorization, records ownership, disables Quick Boot snapshot load/save, and supports verified removal before the owning Git worktree is deleted.
- macOS creates a deterministic temporary linked worktree for Windows-originated source, including uncommitted changes. Concurrent transfers use request-specific refs and bundle files, fetch with `--no-write-fetch-head`, and verify the exact expected `HEAD` and dirty-state manifest before requesting runtime capacity. The native-client helper removes its scoped temporary DerivedData after build/install.
- Each iOS verification selects a distinct simulator through the Device panel and retains its exact AgentDevice target arguments. The native-client helper owns native compatibility and build/install.
- Mobile host races materialize exact source state on both candidates before acquisition. The first eligible host to acquire wins; the losing request exits before runtime work starts.

Primary files:

- `.agents/skills/spawn-worktree/SKILL.md`
- `.agents/skills/worktrees/SKILL.md`
- `.agents/skills/test-t3-app/SKILL.md`
- `.agents/skills/test-t3-mobile/SKILL.md`
- `scripts/worktree-runtime-slot.ts`
- `scripts/worktree-runtime-slot.test.ts`
- `scripts/worktree-baseline.ts`
- `scripts/worktree-baseline.test.ts`
- `scripts/worktree-android-build.ts`
- `scripts/worktree-android-build.test.ts`
- `scripts/worktree-android-dependencies.ts`
- `scripts/worktree-android-dependencies.test.ts`
- `scripts/worktree-android-avd.ts`
- `scripts/worktree-android-avd.test.ts`

Focused regression coverage:

```sh
vp test run scripts/worktree-runtime-slot.test.ts scripts/worktree-baseline.test.ts scripts/worktree-android-build.test.ts scripts/worktree-android-dependencies.test.ts scripts/worktree-android-avd.test.ts scripts/mobile-native-client.test.ts
```

## Installable Build Commands

Use these commands from the repository root when producing local installable artifacts for this customized branch.

### Desktop App

Build a macOS arm64 DMG using the same desktop artifact path used for this branch:

```sh
pnpm run dist:desktop:dmg:arm64
```

Build a local macOS arm64 DMG, then hand the install step to Terminal.app so it can finish after the running T3 Code app quits:

```sh
scripts/install-desktop-dmg-from-t3.zsh
```

The macOS `dist:desktop:dmg` commands use `--local-signing` to sign the application and its helpers with an Apple Development certificate during packaging, before creating the DMG and updater ZIP. The build selects the sole valid Apple Development identity, or the exact certificate SHA-1 specified by `T3CODE_MACOS_SIGNING_IDENTITY` in the environment or root `.env`. Missing or ambiguous identities fail the build. Keep that identity consistent across builds so macOS retains Keychain and protected-folder permissions. These local builds do not require notarization or the release passkey provisioning profile; the separate `--signed` release pipeline and Windows builds retain their existing behavior. An SSH session may be unable to access the login keychain even when the same signing operation works in the logged-in macOS session.

The macOS handoff selects the newest arm64 DMG under `release`, launches a separately titled Terminal tab, and mounts the image read-only in a task-owned temporary directory. Before quitting the installed app, it requires a valid certificate signature and checks compatibility with an existing certificate-signed installation. It replaces only `/Applications/T3 Code (Alpha).app`, preserves and verifies the build's signature, detaches the image, relaunches the app, and closes the owned Terminal window. It never repairs or ad-hoc signs an application. Moving from the previous ad-hoc builds may require one final authorization round. Stale mount cleanup is limited to the script's `t3-code-dmg.*` temporary directories.

Build a local Windows x64 installer, then hand the install step to a temporary per-user scheduled task so it can finish after the running T3 Code app and its terminal process tree quit:

```powershell
pnpm run dist:desktop:win:x64
scripts/install-desktop-exe-from-t3.ps1
```

The Windows handoff selects the newest x64 installer under `release` and starts one interactive-user scheduled task at the caller's current elevation level so installation survives shutdown of the originating T3 Code terminal and can close an elevated desktop process. Before closing the app it verifies the desktop process by PID, start time, and executable path to prevent PID-reuse mistakes. It waits for every process using that exact executable path, force-stops only those matching processes after the graceful deadline, runs the selected installer silently, and unregisters the one-time task. The task writes a temporary transcript, and a failed update attempts to restart the exact previous executable.

### Mobile App

Build the installable Android preview APK locally, avoiding the EAS cloud worker queue, then install it directly over USB:

```sh
cd apps/mobile
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH="/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH" EAS_SKIP_AUTO_FINGERPRINT=1 EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 pnpm dlx eas-cli@latest build --profile preview -p android --local --output ./build/android/t3-code-preview.apk
adb install -r ./build/android/t3-code-preview.apk
```

Upload the local APK to EAS when a shareable install link is needed:

```sh
cd apps/mobile
pnpm dlx eas-cli@latest upload -p android --build-path ./build/android/t3-code-preview.apk --non-interactive
```

This branch carries local conversation-rendering and orchestration changes that are not assumed to exist upstream. Keep this file current when changing local behavior so future upstream updates can preserve the intended UX, and so these patches can be removed when upstream covers the same behavior.

## Subagent Lifecycle Cascade

**Worktree branch:** `fix/subagent-lifecycle-cascade`

Upstream archives, unarchives, and deletes one thread at a time. Subagent threads, both T3-delegated tasks and provider-native subagents projected with `relationshipToParent: "subagent"`, are created unarchived and are never touched by their parent's lifecycle. Clients hide them from navigation, so they disappear with an archived or deleted parent while remaining active in the data: their provider sessions stay attached and their records stay live.

This branch makes a conversation's lifecycle propagate to its subagent descendants. Archiving archives every descendant subagent and detaches its provider sessions, unarchiving restores them, and deleting deletes them. The cascade follows `lineage.parentThreadId` through nested subagents and stops at forks, which are independent conversations.

- `thread.archive`, `thread.unarchive` and `thread.delete` stay single-thread commands. Whenever the thread has eligible direct subagent children, including deleted intermediates for deletion, the command commits a `subagent-threads.cascade` outbox effect (`operation: archive | unarchive | delete`) in the same transaction, even when every child already looks done: a pending cascade from an earlier command has not reached the projection yet, and a child already in the state can have subagents that are not. Project removal does not cascade; it already deletes every project thread itself.
- The effect worker runs `cascadeSubagentLifecycle`: it lists direct children, excluding deleted records for archive and unarchive but including them for deletion, whose `lineage.parentThreadId` is the thread and whose `relationshipToParent` is `subagent`. A child short of the target state gets the same command with id `<parent command id>:subagent:<child id>`, and that command commits the child's own cascade effect. A child already in the state is not changed, but the runner walks into its subagents in-process with the same derived ids. Forks are never listed, so the cascade stops there; a fork's own lifecycle reaches its own subagents.
- Retry safety: the parent command replays through its receipt, the outbox effect is replay-safe after process loss, and child command ids are stable so accepted child commands replay instead of repeating over a newer independent change. Children already in the target state are not re-commanded, and a rejected child command is ignored when a re-read shows the child already reached the state. A stored rejection would replay forever, so the runner reads receipts (`CommandReceiptStoreV2.getByCommandId`) and uses the derived id, or after a rejection `<id>:retry:1`, `:retry:2`, ... in order, taking the first that is unused or accepted. That effective id is both the child's dispatched id and the prefix of its subagents' ids, so the in-process walk and the child's own cascade share receipts even after a recovery.
- Running subagents: each child receives exactly the command a client would send, so it is handled like the parent. Archive cancels queued runs and detaches live provider sessions (which interrupts running provider work) with MCP credential revocation; delete cancels every active run and pending request and detaches sessions. Provider-native subagents normally have no sessions of their own; the parent's detach already stops them.
- Unarchive restores every archived subagent descendant, including one archived independently earlier. Archive and unarchive skip deleted descendants and their branches. Deletion traverses already-deleted intermediates without redispatching them to reach surviving descendants, including when failed dispatch recovery re-reads a deleted child.
- Late children: `delegated_task.request` is rejected while the parent is archived or deleted, and a provider-native `app_thread.created` for a subagent is written under the parent's thread lock and inherits the parent's persisted `archivedAt`/`deletedAt` (the adapter's copy of the parent can predate the archive). So a child reported while the parent's sessions are still detaching starts archived or deleted instead of escaping the finished cascade.
- Codex publishes the approval node and item before its pending runtime request across command, file-change, permission, MCP elicitation, and legacy paths. Immediate responses can settle all records; the adapter regression waits on a Deferred rather than event-loop timing.
- Child lookup (`ProjectionStore.getSubagentChildThreads`) filters on the parent's `project_id` (indexed and immutable, inherited by subagents) before reading lineage from `payload_json`, so no migration is needed.
- Clients: web Settings â†’ Archived and the mobile archive screen omit a subagent whose parent is archived in the same snapshot, so a cascaded archive is one row; a subagent archived on its own while its parent is active stays listed so it can be restored.

Primary files:

- `apps/server/src/orchestration-v2/SubagentLifecycleCascade.ts` (effect builder, cascade runner with in-process walk and receipt-resolved command ids)
- `apps/server/src/orchestration-v2/Orchestrator.ts` (`dispatchThreadMutation` archive/unarchive, `thread.delete` case)
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` (`cascadeToSubagents`)
- `apps/server/src/orchestration-v2/EffectOutbox.ts`, `EffectWorker.ts`, `ProjectionStore.ts`, `ProviderEventIngestor.ts`, `runtimeLayer.ts`
- `apps/web/src/components/settings/ArchiveSettings.logic.ts`, `apps/mobile/src/features/archive/archivedThreadList.ts`, `packages/client-runtime/src/state/archivedThreadList.ts`
- `docs/user/thread-sidebar.md`

Focused tests: From `apps/server`: `vp test run src/orchestration-v2/runtimeLayer.test.ts -t "subagent|delegated work|lifecycle change"`, `vp test run src/orchestration-v2/SubagentLifecycleCascade.test.ts`, and `vp test run src/orchestration-v2/ProviderEventIngestor.test.ts -t "after its parent was archived"`. From `apps/mobile`: `vp test run src/features/archive/archivedThreadList.test.ts`.

On main, each child command goes through `ThreadManagementService.dispatch`, the cold-storage gate: a cascaded unarchive restores a cold subagent before unarchiving it, and a cascaded delete purges it without restoring. Subagents archived under an archived parent are no longer kept hot as referenced by a live parent, so they move to cold storage. Magi's owner-lifecycle cascade to participant threads still runs and overlaps this one harmlessly, since the second command finds the participant already in the target state; its delete path still cancels the owner's runs and removes their `magi_*` rows. Main's reworked archive lists apply the branch's listing rule through `isListedArchivedThread` in `packages/client-runtime/src/state/archivedThreadList.ts`, used by `ArchiveSettings.logic.ts` and the mobile `archivedThreadList.ts`.

## Archive Settings UX

**Worktree branch:** `feat/archive-settings-ux`

The settings Archive panel uses a dense layout so large archives remain scannable. The native mobile Archived Threads screen mirrors the same information hierarchy and behavior with mobile-native project sections, swipe actions, long-press menus, and header controls.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- In global Settings scope, the Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible, while active rows returned in those snapshots remain excluded from archive content and empty-state counts. Partial environment failures remain visible above successfully loaded project groups with their error and a keyboard- and screen-reader-accessible retry action. A total failure does not also render a misleading empty archive state, while a search miss over successfully loaded archives still shows the no-match state beside a partial-failure alert, and retry reloads every configured environment. Web environment, project, and checkout Settings scopes narrow fetched environments and filter both archived project shells and threads before grouping, empty-state counts, search, and bulk actions.
- Web project headers show environment labels whenever multiple environments are configured and keep a sole remote environment labeled, while a sole primary environment remains implicit. Their `ProjectFavicon` receives the complete archived snapshot project record with environment identity through its `project` prop, so the saved title, icon override, favicon path, and workspace root stay together and configured emoji or Lucide icons and automatic fallback icons match current upstream project lists. Native project sections render the snapshot favicon or configured project icon and pair visible environment labels with the environment's machine-kind glyph. Native header controls can filter the archive to all environments or one configured environment, and each environment option carries the same machine-kind symbol as upstream's shared settings environment filter. Upstream's compact iOS mail-search toolbar (used at iPhone widths) drops menu item icons, so the icons show only where the regular header menu renders; the branch deliberately leaves upstream `ScreenHeader` unchanged. The Archive screen keeps its own `ScreenHeader` menu rather than upstream's `SettingsEnvironmentFilterHeader`, because both write the native stack header items and the shared filter would split search, environment, sort, and Android refresh controls.
- Native Settings uses the upstream `Connections`, `Interface`, `Automations`, `Projects & threads`, `Server settings`, and `App` section order in both local-only and T3 Connect-configured modes. The shared `SettingsIndexSections` exposes `Archived Threads` under `Projects & threads` in both modes. `Connections` shows `Environments` in both modes and adds `T3 Account` and `Notifications` when T3 Connect is configured. Upstream `apps/mobile/src/Stack.tsx` registers the customized Archive screen through the v5 native-navigation screen builder in the header-owning settings content stack and keeps the legacy `SettingsWaitlist` alias pointed at `SettingsAuth` in the outer auth stack.
- Web Settings search includes `Archived threads`; selecting that result opens the customized Archive panel and focuses its persistent archive search field, regardless of whether the archive is loading, empty, filtered, or populated.
- Native `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx` uses upstream `ScreenHeader`, `SettingsScreenContent`, a non-collapsable root, and `LegendList`. `ScreenHeader` and `SettingsScreenContent` supply the settings frame. The Archive screen mounts the non-collapsable root, list, pull-to-refresh control, and Android header refresh action. The customization retains inline archive search, environment filtering, all four Archived/Created sort choices in the shared header menu, and sortable project columns without remounting the list during search.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Each term must appear in the title as written (no fuzzy subsequence matching), because matching-scoped bulk actions act on exactly those results. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and rank partial matches by distinct matched-token count before the earliest token position. Phrase and all-token scores remain bounded within their relevance tiers so a long-title position penalty cannot demote a stronger match below a weaker tier. Search auto-opens matching project groups while active. Native incremental search updates the existing list without remounting it for every keystroke, preserving scroll position and transient row state.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Native project-section ordering follows the selected archive sort field and direction. Archived snapshots carry V2 thread shells whose timestamps are decoded `DateTime` values, so both surfaces present them through upstream's `presentThreadShell` (directly on web, through `scopeThreadShell` on native) and sort and display the resulting ISO strings without an invalid-timestamp fallback.
- Native read-only rows retain their rounded layout without swipe or long-press actions, and project action menus are disabled. The Archive route checks each target environment's task permission before row or project confirmation. Its action executor checks that permission again before dispatch and preserves the failed result and suppressed-alert failure message for bulk summaries. Native row and bulk actions share collision-safe per-thread reservations and action-executor identity keys, reserve bulk targets before confirmation, expose busy state only after confirmation, disable overlapping swipe/menu controls while reserved, and distinguish rows skipped because the same thread action is already in progress from commands that actually fail. In `apps/mobile/src/features/home/useThreadListActions.ts`, reservation keys remain JSON tuples while lifecycle dismissal uses `scopedThreadKey` to match the identity registered by both live rows and `ArchivedThreadsScreen.tsx`. This keeps exit animations ahead of mutations without weakening action deduplication.
- Web row and project actions in `apps/web/src/components/settings/ArchiveSettings.tsx` dispatch the `threadEnvironment.unarchive` and `threadEnvironment.delete` commands through upstream `useOrchestrationCommand`, so the Archive panel owns archived-snapshot refresh timing without extending the shared `useThreadActions` interface. Row and project restores recheck task permission before invalidating the affected thread's Archive Undo and dispatch using its scoped thread identity, leaving other action kinds and environments untouched. Cancelled project restores and restores denied after permission is revoked retain Undo. Archive row and project controls subscribe to each target environment's task permission; retained callbacks and project actions recheck that grant before opening confirmations. Read-only connections can still browse, search, and sort. Successful row actions refresh the affected environment immediately. Project actions reserve collision-safe per-thread locks before confirmation, expose busy state only for threads owned by actions that have started after confirmation, disable overlapping controls while mutations run, give explicit feedback for rejected duplicates, and refresh the affected environment once after the bulk attempt instead of between concurrent mutations. Successful raw deletes use the same `permanentlyDiscardComposerDraft` operation as live-thread deletion, releasing image and file/video uploads before clearing every draft reference, and clear the thread's persisted terminal UI state, without coupling Archive actions to the rest of the live-thread delete lifecycle.
- Web project and conversation titles use the shared `text-xs` size, while metadata uses `text-2xs`. Conversation rows show only the relative archived and created ages inline with the title by default; the web panel refreshes those ages once a minute because they never show seconds. On web row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern. Native rows keep both age columns visible and expose the same actions through swipe gestures and the standard long-press context menu. Native rows use upstream's `grouped-card` surface and pass it explicitly to the unmodified shared `ThreadSwipeable`.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first. Web delete actions respect the shared `confirmThreadDelete` client setting, while native keeps its standard guarded delete flow.
- Restoring an archived thread that has since been deleted fails instead of succeeding. This is upstream V2 behavior: `dispatchThreadMutation` in `apps/server/src/orchestration-v2/Orchestrator.ts` rejects every thread mutation on a deleted thread after command receipts are checked, so the branch carries no server changes.
- Archived-row context-menu action IDs and presentation metadata come from shared Archive settings logic. Unarchive uses the archive-restore icon, Delete uses the trash icon and destructive styling, and `separatorBefore` distinguishes permanent deletion from restoration in both the web fallback and Electron native menu.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete` on web and remain explicitly guarded on native; unarchive bulk actions remain guarded on both surfaces, and partial failures surface as not-fully-completed feedback instead of implying every archived thread failed.
- Web single and project delete confirmations use the shared themed dialog's destructive variant, while project unarchive confirmations keep the default variant.
- Shared archive search ranking, timestamps, sort state, and action locks live in `packages/client-runtime/src/state/archivedThreadList.ts`. Platform-specific grouping and project bulk-action concurrency remain in `apps/web/src/components/settings/ArchiveSettings.logic.ts` on web and `apps/mobile/src/features/archive/archivedThreadList.ts` on native so the dense Archive behavior stays covered without growing the React components. Web project groups retain the complete archived-snapshot project shell plus environment identity so the customized header can read shell metadata directly without a reduced field projection. Project groups expose and reuse collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, preserve the completed success/failure/skipped outcome counts, show incomplete-operation feedback, and surface the underlying exception messages instead of only a generic aggregate error. The Archive surfaces refresh only the affected environment after bulk unarchive/delete attempts, even when the action runner throws. Native bulk actions suppress per-row alerts but collect each command failure message through the action executor's `onFailure` option and append the distinct messages to the aggregate summary.
- The user guide documents Archive as a reversible thread-lifecycle action, covers the web, desktop, and mobile controls and safeguards, and explains that search scopes project bulk actions to visible matches. The guide states that Unarchive returns a thread to the live list with its pre-archive settled, snoozed, or pinned state; because snooze placement is derived from the current time, a snooze that ended while archived does not resume. The guide and internal glossary distinguish settled threads, which remain live in the thread list's `Settled` section and return to the active list when un-settled or new work begins, from archived threads, which leave the thread list for Archive until restored or deleted. The glossary also distinguishes Archive from permanent deletion, and the documentation index links the guide.

Primary files:

- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/ArchiveSettings.test.tsx`
- `apps/web/src/components/settings/ArchiveSettings.logic.ts`
- `apps/web/src/components/settings/ArchiveSettings.logic.test.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/lib/composerDraftUploads.test.ts`
- `apps/web/src/lib/composerDraftUploads.store.test.ts`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/home/useThreadListActions.ts`
- `docs/user/archive.md`
- `docs/internals/glossary.md`
- `docs/README.md`

On main, both Archive lists apply the lifecycle cascade listing rule through the shared archivedThreadIds and isListedArchivedThread helpers: a child archived with its parent is hidden, while an independently archived child remains restorable. The mobile cascade regression cases use the shared parsed-search input and sort state alongside ranked search and sort coverage. SettingsPanels delegates Archive to the dedicated component instead of retaining its obsolete inline list. Cold-storage upload tests keep their real upload-queue fixture in composerDraftUploads.archive.test.ts, separate from the permanent-delete mocks in composerDraftUploads.test.ts. Lifecycle-hook mocks provide both archive upload release and permanent draft discard; archive-success fixtures grant task permission, while permission tests retain their per-environment checks.

## Conversation Data Savings

**Worktree branch:** `feat/conversation-data-savings`

Archived conversations move out of the active database (`userdata/statev2.sqlite`) into gzip chunks in `userdata/archivev2.sqlite`, and come back whenever something reads or changes them. `apps/server/src/orchestration-v2/ThreadColdStorage.ts` owns every transition and runs each one under the thread's `ThreadCommandExecutor` lock, so it is serialized with command dispatch for that thread.

Pre-cold-storage binaries cannot read histories already moved into `archivev2.sqlite`. Unarchive needed conversations with a cold-capable version before downgrading; `docs/user/background-service.md` says so. The pre-V2 branch stored V1 bundles in `archive.sqlite`; this code never opens that file, and no recovery path exists for those bundles.

- What moves: the thread's run, attempt, node, provider-turn, runtime-request, message, plan, turn-item, turn-item-position, checkpoint and context-handoff projection rows; its event stream (including copied V1 events) except the `thread.*` lifecycle events and the newest event; the V1 rows of a migrated conversation that V2 no longer reads once its transcript is imported (messages, activities, proposed plans, turns, pending approvals and legacy command receipts); and its attachment files, including pages published by the `html_render` tool and captured MCP App documents. Provider logs and their numeric rotations are deleted, never stored; upstream's `terminal.cleanup` already deletes terminal history on archive.
- What stays hot: the thread shell row, its `thread.*` events (so shell replay, projection rebuilds and `afterSequence` resumes still see archive, unarchive and delete), the newest event of the stream (so later events keep a unique `stream_version`), V2 command receipts, the V1 thread, pull-request and session rows (shell import and repair, and the settings migration, read them), provider sessions and bindings, subagent links and context transfers.
- V1 rows: `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadTables.ts` lists the moved V1 tables beside the importer, and the cold move runs the importer's transcript hydration first, so an archived pre-V2 conversation leaves `statev2.sqlite` like any other. Upstream's `V1ImportBoundary.test.ts` keeps V1 table names inside the legacy directory and lists the files allowed to import from it; the branch adds `ThreadColdStorage.ts` to that list.
- Archived shells derive activity fields (latest run, latest user message, latest user-authored message, item counts, status) from child rows. Before moving rows, the service freezes the computed shell into `thread_archive_manifests.shell_json`, and `ProjectionStore.getShellSnapshot`/`getThreadShell` overlay those derived fields for cold threads. `storageCleanup.ts` therefore keeps the same inactivity clock for archived worktrees, and the Archive list keeps its rows unchanged.
- Eligibility: a thread stays hot (`kept-hot`) while it has a non-terminal run, while a fork reads from it (an undeleted fork, or a deleted fork not yet purged, through any chain of forks), or while it is a subagent child of a live parent (result recovery reads its runs). The final `moving` transaction rechecks runs and references, so a run or fork that appeared while the bundle was written keeps the thread hot.
- Leases: `withHot(threadId, use)` runs a read or command against hot rows and holds an in-memory lease while it runs. A hot thread takes its lease without the thread lock; a cold thread, a move in progress, or an unarchive goes through the lock, so it waits for any move and restores first. A move or purge starts only when no lease is held (otherwise its effect requeues itself after `RECOLD_DELAY_MS`) and reserves the thread against new leases while it runs; both checks are synchronous steps, so a lease and a move or purge never overlap. Nested leases on a hot thread never take the lock.
- Archive: the `thread.archive` handler in `Orchestrator.ts` queues a durable `thread.cold-archive` effect after the provider detaches and `terminal.cleanup`; per-thread effects run in order. The effect hydrates any pending V1 transcript first and writes the complete bundle in commits of about 2 MB. A main-only transaction then rechecks eligibility and marks the manifest `moving`, which hands the thread's reads and shell overlay to the bundle; the hot rows go afterwards in commits of at most 500 rows, then its attachment files and provider logs, and only then is it marked `cold`, so an interrupted cleanup resumes from `moving`. Attached WAL databases do not commit atomically together, so the bundle is always complete before rows go. Bundle chunks are deleted in short commits too, each counting its deleted rows inside the same transaction, header last. Every archive and purge starts on a fresh event-loop turn and yields between commits, so convergence of a large archive never holds the loop for one whole conversation.
- Restore: `ThreadManagementService` runs reads (snapshots, paged history, full-text search, records with fields, the WebSocket thread subscription's snapshot or replay through `withThreadReadable`) and dispatched commands (one lease per thread the command reads) inside `withHot`. A restore first checks the bundle header and version, failing the read and keeping the manifest when the bundle is missing or newer. It marks the manifest `moving` (so an interrupted restore is finished as a move by startup reconcile), writes attachment files outside any transaction, then inserts rows one page of chunks per commit with `INSERT OR IGNORE` against the current columns (newer hot rows win, older bundles survive compatible migrations), and in a final commit marks the manifest `restored` and queues a delayed re-cold effect (`RECOLD_DELAY_MS`, two minutes). Readers keep waiting until that commit. Clients therefore never see a cold thread as missing, and the client's not-found parking and retry backoff need no cold-storage handling.
- Attachments: `AssetAccess` asks `ensureAttachmentHot` before signing or serving an attachment; when the file is missing it finds the bundle chunk by file name (indexed `kind`) and restores that conversation. A file a concurrent move removes right after that check gets one more restore before the request counts as not found. Inline tool-output image signing and serving also take a `withHot` lease around the stored turn-item read, so screenshots remain available after archive and after a re-cold between signing and serving. `server.ts` merges `ThreadColdStorage.layerWithReconcile` into the runtime for this, so routes resolve the live service.
- Unarchive: dispatching `thread.unarchive` restores the thread and cancels any queued re-cold so later effects for the active thread are not held behind it. After the command, failed or not, `scheduleArchive` queues a cold-archive effect off the command's path: it drops the bundle (in short commits) and manifest of the unarchived thread, or moves a still-archived thread back. Free pages are reclaimed by that effect's compaction, not on the unarchive path. Deletion skips restore entirely, and shell-only record reads (`getThreadRecords(id, [])`) never restore.
- Delete: `planThreadDeletion` (shared by `thread.delete` and project removal, including the CLI) ends with a `thread.storage-purge` effect. While a fork still reads the deleted thread (checked after the purge reserves the thread) the purge waits; the fork's own purge queues the source's purge again, and startup reconcile retries it. A fork's purge also queues a cold-archive for an archived source it kept hot. Otherwise it removes attachment files listed in the bundle and the messages, provider logs, the cold bundle, the moved tables (including the V1 rows), provider threads, bindings, subagent links, launch workflows and `provider_session_runtime` rows, and provider sessions with no binding left whose owner is this thread or already purged, rediscovered on every attempt so an interrupted purge cannot strand one. It keeps the deleted shell row, its `thread.*` events, V2 command receipts and outbox rows, which `storageCleanup.ts` worktree-on-delete cleanup and projection replay depend on.
- Startup: building `ThreadColdStorage.layerWithReconcile` starts `reconcile`, parked until activation (`forkParked`), so it always runs against the live service; startup code outside the orchestration layer would resolve the keep-hot default instead. It queues cold-archive effects for archived threads without a manifest, left `restored`, stopped `moving`, or `kept-hot` (the blocker may be gone), and for unarchived threads that still have a manifest; and purges for deleted threads not yet `purged`. It skips threads with unsettled lifecycle effects and uses one identity per startup, so work whose earlier effect failed for good runs again. Upgraded databases converge without migration-time queueing.
- Compaction never runs a full `VACUUM` on the server connection; that rewrites the whole file synchronously. Space is reclaimed with `incremental_vacuum` in steps of `RECLAIM_CHUNK_PAGES`, one event-loop turn each, whenever the lifecycle queue has no due work (a backlog reuses free pages meanwhile; delayed re-colds do not hold it back). This needs `auto_vacuum = INCREMENTAL`, which SQLite only changes through a full rewrite, so the branch sets it where a rewrite already happens or the file is new: `persistence/Sqlite.ts` sets it before creating a fresh database, and `initializeV2Database.ts` makes the one-time V1 to V2 copy with `VACUUM INTO` from an incremental-mode source connection in a worker thread (replacing upstream's main-thread `backup`), so the copy is compacted, incremental, and off the event loop. A database already on V2 in `NONE` mode is never converted: freed pages are reused but the file does not shrink. The remaining per-commit stall is the WAL fsync (about 70 ms per commit on a Windows SSD under the default `synchronous = FULL`); `synchronous = NORMAL` would remove it but changes upstream's durability for every write.
- Migration `061_ThreadStorageLifecycle` follows upstream `060_ThreadSnapshotWindowIndexes` and creates `thread_archive_manifests`. The bundle tables live in `archivev2.sqlite` and are created by the service. Earlier development builds of branch migration 057 also created a write-only `thread_storage_maintenance` table; databases that ran them (this worktree's sandbox, `fork/main`) keep that harmless table.
- `apps/server/scripts/t3-sqlite-state.ts` derives both database paths from the shared server configuration and accepts `--database archive` for bundle queries. Archive and restore behavior should use application commands rather than direct bundle writes.
- `ThreadColdStorage` is a `Context.Reference` whose default keeps everything hot; `server.ts` provides `ThreadColdStorage.layerWithReconcile` next to `ResourceCleanupService.layer` and merges it into the runtime, so thread management, the effect executor and asset routes resolve the live service. `ThreadColdStorage.layer` is the service without startup reconciliation, for tests. `docs/internals/overview.md` ("Archived conversation storage") records the cross-component constraints.

`McpAppRequests.resolveApp` reads the raw stored item through `ThreadManagementService.withThreadReadable`, preserving its captured app reference while restoring a cold conversation and leasing the lookup. Model-context updates can therefore resolve a cold app without starting or requiring a provider session. Cold-storage coverage verifies restoration and persisted model context with the session service unavailable.

MCP App model-context rows stay hot during archive and are removed by permanent storage purge with a thread-scoped predicate, alongside the other purge-only rows. The purge test verifies that archive retains the context and deletion removes it.

Known limits: commands that bypass `ThreadManagementService` and dispatch straight to the orchestrator on an archived thread (pull-request link sync, internal workers) see the cold thread's shell only; they touch thread payload fields, not conversation rows. A `kept-hot` thread is re-evaluated when it is archived again, when the last fork keeping it hot is purged, or at the next startup.

`apps/server/src/orchestration-v2/ThreadColdStorage.test.ts` covers move, shell overlay, read restore and re-cold, unarchive followed by the bundle drop, stream versions after cold-time events, the V1 rows of a migrated conversation, eligibility, purge, reconcile (including retries after failed effects and kept-hot re-evaluation), startup convergence when the live service is built, compaction in bounded steps that let the event loop run, resuming an interrupted `moving` move, an interrupted restore finished as a move, a move and a purge deferred by a lease, a fork admitted during a move, the reference recheck before `moving`, a missing bundle, cold attachment restore, HTML tool-page bytes and turn-item round trips, deferred fork-source purges and the archived fork source moved cold after its last fork, leftover attachment files, shared provider sessions, and bundle restores across column changes. `apps/server/src/persistence/initializeV2Database.test.ts` covers the V1 copy's auto-vacuum mode for each source mode. `ThreadManagementService.test.ts` covers the read, command, delete and unarchive gates.

### Client cache consistency

Persisted web and mobile thread details are fast-paint caches, not an archive source of truth, and archived details are never cached (`shouldPersistThread` in `packages/client-runtime/src/state/threads.ts`). A `thread.archived` detail event, an authoritative archived detail snapshot (socket or HTTP), successful local archive acknowledgement, or shell removal evicts the persisted detail through `packages/client-runtime/src/state/threadCache.ts`. The archive command in `packages/client-runtime/src/state/threadCommands.ts` (`archiveThreadAndEvictCache`) evicts after the interruptible server command and keeps the handoff masked from cancellation; it holds the thread's cache state across dispatch and skips the eviction when a revival (an authoritative unarchive) moved the generation meanwhile. Per-thread cache generations, eviction tombstones, and write locks prevent queued or finalizer writes (V2's `runCachePersistence` queue carries the generation) from recreating the snapshot. A failed disk removal keeps a body-free tombstone even with no subscriber retaining the state, until a later removal succeeds or the thread is revived. Shell additions and `thread.unarchived` events revive the cache while invalidating only writes captured during the tombstoned generation. `thread.archived` and `thread.unarchived` are per-item boundaries in the detail event batches so these effects run around them. Web IndexedDB migration version 5 and mobile SQLite migration version 2 each clear legacy thread-detail caches once.

The five-minute `ThreadResumeCache` retains the archive generation and eviction listener after its detail subscription closes; eviction clears the warm body and blocks stale republishing, while body-free deletion tombstones are retained. Detail subscriptions check resume-cache ownership, so an obsolete subscription cannot clear its successor's cache or tombstone. Shell synchronization (`packages/client-runtime/src/state/shell.ts`) diffs authoritative snapshots: removed threads are evicted (failed removals stay pending and retry while the thread stays absent) and added threads are revived; the set diff is skipped when the thread ids are unchanged and nothing is pending. On each authoritative snapshot it also lists the saved details (`EnvironmentCacheStore.listThreadIds`, implemented by the web IndexedDB and mobile SQLite stores; IndexedDB listing uses the shared connection handle and retries once after a silent close) and evicts those whose thread is not in the active list and has no live cache state, so details stranded by a failed removal before a restart, or with an empty shell cache, are still removed. Shell resubscription uses upstream's cursor resume unchanged; cold storage keeps lifecycle events hot so a resume still observes archive and unarchive.

A thread that an applied shell item removed from the active list (`thread.removed`, or an archive-location update) and that is active again at the end of the same batch gets `restoreCachedThread`, which always bumps its generation, so a late archive acknowledgement for it skips eviction. Reconciliation of saved details skips only threads with an open detail subscription (`retainLiveCachedThread`), not warm or command retainers.

The server also coalesces shell events per thread within a window (`coalesceShellApplicationEvents` in `ws.ts`), so an archive and an unarchive can arrive as one active update with no removal. Each applied authoritative active observation (an active `thread.updated` newer than the snapshot, or an authoritative snapshot listing the thread) records its sequence in the thread's cache state without touching the persistence generation; every archive eviction passes the archive's sequence (the acknowledgement's receipt sequence, the detail stream's `thread.archived` event sequence, or an archived detail snapshot's sequence) and, under the eviction lock, skips eviction when a newer active observation exists; a thread evicted by a sequenced archive is revived when a later active observation arrives, even after its detail closed. Deletions and shell-membership removals pass no sequence and are never revived this way (shell removals revive through the membership paths instead). An eviction retried on a tombstone never weakens its marker: an unsequenced one stays unsequenced and otherwise the greater archive sequence is kept, so a late older acknowledgement cannot make a newer archive or a deletion revivable. Archive receipts, detail sequences and shell sequences all come from `orchestration_events.sequence`. An authoritative snapshot lower than the applied shell snapshot means the server's sequence space was replaced: it advances a per-environment epoch, drops recorded active observations, and marks old eviction sequences older than any new one, so a thread the new snapshot lists as active is revived; an archive acknowledgement dispatched before the reset, or a detail archive eviction applied before it and still waiting on the cache permit, skips its eviction, since its sequence is not comparable. Known limit: a reset that lands while an admitted eviction is already removing the saved detail can revive that tombstone early, which costs a cache miss until the next save.

Coverage: `packages/client-runtime/src/state/threads-sync.test.ts`, `threads-atoms.test.ts`, `shell-sync.test.ts`, `threadCommands.archive.test.ts`, `apps/web/src/connection/storage.test.ts`, and the mobile storage/database tests. Protocol-only tests build sessions through `packages/client-runtime/src/rpc/testUtils/rpcSession.ts`.

### Client archive surfaces

The web Archive panel tracks each in-flight unarchive by environment-scoped thread key, because unarchive restores the conversation before the server acknowledges the command: `apps/web/src/components/settings/SettingsPanels.tsx` disables that row's button and context menu and shows `Unarchiving`. Mobile needs no branch state: upstream's swipe actions (`withThreadDismissal` in `apps/mobile/src/features/home/thread-dismissal.ts`) collapse the archived row until the command settles, and the action executor ignores repeated taps for the same thread. Upstream's failed-unarchive path shows an error but leaves the collapsed row hidden until the Archive screen refreshes; that is upstream behavior, unchanged by this branch.

On mobile, threads on a settlement-capable server offer Settle instead of Archive, so archiving from a phone goes through another client or an agent's thread-lifecycle MCP tool; the mobile Archive screen still unarchives and permanently deletes cold threads.

Unsent composer drafts remain local when their thread is archived. Archive releases only the draft's image uploads (`releaseArchivedComposerDraftUploads` in `apps/web/src/lib/composerDraftUploads.ts`): images keep their bytes in the draft and upload again when it reopens, while a draft file's upload can be its only byte copy after a reload (`file: null` with `uploadedAttachmentId`), so file uploads, completed or in flight, are kept; the pending-upload sweep bounds leftovers. Discarding a draft still releases everything. `apps/web/src/hooks/useThreadActions.ts` calls the archive release after a successful local archive acknowledgement, and `apps/web/src/threadRemovalCleanupObserver.tsx` (mounted once in `AppRoot.tsx`, covering web and desktop) runs one reconciliation per shell change and, for each thread an authoritative live shell stopped listing (archives by another client), releases those uploads and clears `previewStateStore` and `previewMiniPlayerStore` state. It uses `apps/web/src/authoritativeThreadLifecycle.ts`, which keeps the last authoritative per-environment baseline while a shell synchronizes and discards it when the environment leaves the catalog.

### Integration on main

On main, the standalone `061_ThreadStorageLifecycle` schema is represented by published ID 71 (see Published Database Compatibility). Published fork migrations 35, 41, and 47 already created `thread_archive_manifests` and `thread_storage_maintenance` for pre-V2 cold storage, so `071_ThreadStorageLifecycle.ts` renames existing tables to `legacy_v1_thread_archive_manifests` and `legacy_v1_thread_storage_maintenance` before creating the V2 schema. Its published schema already represents the standalone branch migration, so the branch migration is not registered again; nothing reads the legacy tables. The pre-V2 `archive.sqlite` bundles they describe are not migrated: those conversations keep their hot shells but have no transcript under V2, so unarchive needed conversations with a pre-V2 build before installing this design. `071_ThreadStorageLifecycle.test.ts` covers the rename.

`apps/server/src/persistence/initializeV2Database.ts` diverges from upstream on main as on the branch: the one-time copy is a worker-thread `VACUUM INTO` instead of upstream's main-thread `backup`. `VACUUM INTO` copies every table, so the published fork ledger (1 through 68) arrives intact and `Migrations.ts` then normalizes the copied ledger and applies its unapplied tail through 77, exactly as with `backup`. Merge upstream changes to that file into this version rather than taking theirs. `initializeV2Database.test.ts` seeds the V1 source at fork ID 68.

The integrated web Archive route uses `ArchiveSettings.tsx` from the Archive customization, including its scoped snapshots, partial-load errors, project icons, row reservations, and permanent-delete cleanup. Its row reservations, held from the unarchive dispatch until the command settles, supersede the cold-storage branch's in-flight unarchive state in the upstream `SettingsPanels.tsx` panel, which main does not carry. Mobile retains the Archive customization's screens, shared row reservations, and refresh ownership; its awaitable `unarchiveThread` already covers the cold-storage branch's change. Composer-draft upload helpers use the Archive customization's `composerDraftUploads.ts`, which already contains the cold-storage branch's `releaseComposerDraftUploads`; its archive and permanent-delete test files keep their distinct mock setups, and `useThreadActions.ts` imports both `permanentlyDiscardComposerDraft` for deletion and `releaseArchivedComposerDraftUploads` for archive acknowledgement. The web connection cache keeps the published IndexedDB version 7, whose upgrade already clears legacy thread-detail caches, instead of the branch's version 5.

The subagent lifecycle and cold-storage effects share the outbox and worker on main. Keep both effect schemas and both replay-safe entries when resolving these files; cascaded commands use the same thread-management restore and purge gates as direct commands. The IndexedDB upgrade keeps one guarded cache-eviction hook at published version 7. Cold-storage log cleanup resolves the extracted `@t3tools/provider-core/server/ProviderEventLoggers` service shared by the server runtime.

The archive-upload and lifecycle-hook fixtures supply the current upstream environment-scope grant so they exercise cleanup through the real permission check. Migration 76 tests cover both a published fork through 75 and an upstream ledger through 59, retaining MCP App context, cold manifests, cleared Magi arms, and the original migration timestamps. Historical cutover coverage uses the upstream nominal SQLite, replay-harness, and provider-registry layer APIs; the frozen published migration bodies are unchanged.

## Magi Consensus Orchestration

**Worktree branch:** `feat/magi-consensus-orchestration`

Magi is a fork feature for provider-neutral, weighted consensus owned by one T3 conversation and built on Orchestration V2. A user can arm the next message from the Magi panel, and an agent can start a run when the user explicitly asks for Magi. Each conversation owns at most one nonterminal run. Participants are ordinary V2 child conversations. `MAGI.md` is the detailed product contract, architecture record, restrictions, and verification reference.

### References

- `MAGI.md` defines the feature contract.
- `docs/magi/example_prompts/MAGI_ARBITRATOR_CODE_REVIEW.md` defines the review-and-fix arbitration example.
- `docs/magi/example_prompts/MAGI_ARBITRATOR_PLAN_REFINEMENT.md` defines the document-refinement example.
- `docs/magi/example_prompts/MAGI_PERSONALITY_CODE_REVIEWER.md` defines the participant rubric for the code-review example.
- `docs/magi/THREAT_MODEL.md` records the trust boundaries.
- `docs/user/magi.md` is the shipped user guide, linked from `docs/README.md`.

### Current server behavior

- `MagiService.ts` owns the consensus workflow, arm delivery, persistence, lifecycle recovery, subscriptions, and context artifacts. It uses V2 thread management, provider adapters, pure deterministic id derivation, project/settings services, and text generation. `server.ts` provides it with the runtime dependencies. Participant ids use `IdAllocator.derive.delegatedTaskThread` without requiring or providing an allocator service.
- Magi and `context_read` require the `orchestration` capability and `scope.thread`. OAuth clients have no owning conversation and receive a bounded `MagiValidationError` with `invalid-protocol-state`. The service accepts `McpThreadCaller`, containing `threadId`, `providerInstanceId`, and `providerSessionId`. Provider-native subagents share their parent's credential.
- The current run is the caller's newest active run on its provider instance. Control and replay use the owning run identity, including retries of stopped runs. A completed owner gets at most one control continuation for unfinished Magi work. Lifecycle recovery pauses failed, interrupted, or cancelled driving runs and resumes eligible completed-owner continuations.
- A service-scoped deliberation fiber survives MCP cancellation. A short run lock and deliberation claim prevent duplicate fan-out without making lifecycle handlers wait for participant completion. Startup recovers nonterminal runs and pending cleanup.
- Run audiences follow `subagent` lineage from the owner to its ancestors, stopping at forks and cycles. `listRuns`, active counts, and subscriptions use the persisted audiences. Ancestors see `Subagent: <owner title>`; only the owner's agent controls the run. Subscription setup precedes the initial snapshot.
- Participant turn 1 uses `delegated_task.request` and disposes completion delivery. Later turns, retries, repairs, and `/compact` use queued messages with deterministic ids. Waiting follows stored `run.updated` events, and replies come from `subagentResultForRun`.
- Participant token totals include the provider turns of each dispatched participant run and retry. `turnTokenUsage` takes precedence over live `tokenUsage`; absent usage remains unknown.
- Participants receive the initiating-task envelope and read-only instruction, including passing that instruction to their subagents. The arbitrator alone performs authorized actions. Prompt restraint is not a filesystem sandbox.
- `MagiParticipantPolicy.ts` detects a participant subtree through subagent lineage and indexed participant membership. It denies nested Magi starts, top-level creation, launch, and fork. Mutating thread tools may target only strict descendants of the participant. Delegation and read tools remain available. `t3_thread_update` and `delete_scheduled_task` remain outside this confinement.
- `threadAccess.ts` applies participant gates only when `scope.thread` exists. OAuth clients retain upstream runtime ceilings and explicit-target requirements. Launch, creation, fork, send, attachments, interrupt, pending-request, queue, merge-back, and organize handlers retain their upstream authorization checks before reaching services.
- Scheduling uses the service's effective binding rule. An omitted `bindToCurrentThread` binds only in the caller's project; an explicitly different project defaults to a fresh thread and is denied to participants. Thread callers resolve update targets through the unfiltered scheduler and check their existing binding and any requested replacement; running a task checks its current binding. OAuth scheduling goes through the service's approved ceiling. Magi and context handlers share capability-first caller validation in `requireMagiCaller`.
- Evidence is finished command, dynamic-tool, file-change, file-search, and web-search activity from the owner's current run. Artifact snapshots are granted to individual participant conversations before dispatch. `context_read` joins grants on the caller's thread.
- Arm revisions survive disarm and consumption. Arming requires idle state. `sendArmedMessage` coordinates attachment and dispatch with acceptance-aware retry and interruption cleanup. Native maintenance commands `/compact` and `/logout` skip arm attachment. An accepted arm is delivered as a `magi-arm` context reference, and remembered panel configuration changes only when a user-armed run starts.
- Structured replies use the final fenced response and require a nonempty rationale. Stored responses remain decodable. Arbitration validates settled stances, exclusive decision sets, candidate fingerprints, and normalized assessments. Recorded actions change the candidate and require reassessment. Issued but unrecorded action batches are visible for reconciliation and never automatically replayed.
- Main migrations 72 and 73 create `magi_arms`, `magi_runs`, `magi_run_audiences`, `magi_run_participants`, `magi_context_artifacts`, and `magi_context_grants`. Existing V1 Magi data is not imported. Owner deletion removes its arms, runs, artifacts, and participant conversations.

### Current clients

Client-runtime exposes `threadRuns` and `runDetail` subscriptions without polling, draft/launch `magiArm`, and shared presentation helpers for states, elapsed time, participants, duplicate configuration, and unrecorded action batches. The shared command policy supplies both client and server scopes for all four Magi mutation RPCs. Web and mobile disable server arm changes without `orchestration:operate`, cancel pending synchronization when that grant is lost, and recheck it before queued writes. Cancellation reconciles optimistic arm state after outstanding writes settle, including unchanged server snapshots and grants restored without a newer user intent. An untouched panel loads the server arm configuration independently of write permission. A shared edit tracker acknowledges only the edit sent by a successful own write, so an older completion cannot erase a newer edit. Canceled synchronization follows the authoritative server arm, while newer unsent form edits survive and are labeled separately from its saved configuration. Those edits are never automatically submitted by reconciliation. Local draft arms remain available.

Web keeps the Magi right panel, shortcut `G`, and active-run badges on its launcher and tab. The right-panel toggle has no Magi count. The timeline shows the conversation's own newest run. Lineage lists that conversation's own runs; selecting one opens the panel and expands it through a session-only reveal request. The panel's history also includes descendant-owned runs. `/settings/magi` provides personalities and provider/model configuration, autosaves changed fields, shows retryable load failures, and retains provider settings search and restore-default controls.

Mobile opens the Magi sheet from the header menu. Android retains terminal, git, and merge-back as ordinary header actions with upstream responsive overflow placement; Magi alone is explicitly menu-only. Run detail has audit screens and links to participant conversations; history includes descendant-owned runs. The arm queue serializes arm/disarm, preserves edits during the first arm request, synchronizes armed configuration, and reconciles rejected operations to server state. Queries run only while visible. Draft and outbox arms survive their send paths.

Both clients show the prompt and current candidate in initially collapsed disclosures, participant weights, the read-only/provider-sharing explanations, idle gating, duplicate configuration, paged history, and outstanding action reconciliation. Web uses the run header's state; mobile retains its Status row. Mobile has no Lineage menu, so its run history stays reachable through the sheet.

### Integration on main

- Main retains the published Magi schema at migration IDs 48 through 50, archive glue at 51, and convergence at 60 in `effect_sql_migrations`. Migration 68 replaces conversation-wide active-run uniqueness with per-native-owner uniqueness while preserving existing runs.
- The standalone branch adds `061_MagiProjections` creating only the `magi_*` tables. On main it runs at ID 72 under the name `MagiV2Projections` (see Published Database Compatibility), frozen at the body the installed databases applied; main-only ID 73 `MagiV2ArmClearingAndParticipants` carries the branch's later schema (nullable arm columns so a disarm keeps the row's revision, and `magi_run_participants` backfilled from run snapshots). Fold further branch schema changes into a new main-only migration rather than editing 72: ID 48 already records `MagiProjections`, and the legacy Magi normalizer removes that name at any other ID. Its tables do not collide with the V1 `projection_magi_*` tables; the V1 Magi tables and columns from IDs 48 through 68 are not migrated and stay unused under V2. `061_MagiProjections.test.ts` verifies the combined main IDs 72 and 73.
- The migration registry retains the installed bodies and accumulates readonly loader results through a mutable replay list before relocating webhook and MCP App markers. Tests derive the expected migration tail from the registry and exercise both installed-fork and upstream-webhook ledgers.
- The updated standalone schema is identical to main's published 72 plus 73; no Magi schema work is pending; the new upstream snapshot-window indexes run at 77. The scheduling handler uses the current `bindToCurrentThread` rule when validating replacement targets, alongside its existing-target check.
- The Version Control branch's `rightPanelSurfaceActions.ts` descriptor owns the Magi launcher entry: shortcut `G`, singleton, last in both launchers, after Device, with a `badge` field that turns `activeMagiRunCount` into the entry's `badgeCount`. `RightPanelTabs.tsx` passes the Magi props into that descriptor, renders the badge on the empty-state entry and the Magi tab, and adds the Magi tab title and icon. `ServerSettingsPatch` carries both the Version Control `sourceControl` key and Magi's `magi` key. `RightPanelTabs.test.tsx` covers the Magi entry's availability and badge.
- Owner archive, unarchive, and delete cascades dispatch through `ThreadManagementService`, so Conversation Data Savings gates them like any command: archived participants move cold with their owner, unarchive restores them, and delete purges them without a restore. Participant reads during a run go through `getThreadRecords`, which restores a cold participant and re-colds it later. The `magi_*` tables, including selected evidence artifacts, stay in `statev2.sqlite` and are not part of cold bundles. The ordinary subagent cascade also reaches participants; command receipts make repeated lifecycle requests harmless, while Magi retains ownership of run cancellation and audit-record deletion.

### Dev-server testing

When verifying Magi in a dev server, use these participant settings:

- Codex: GPT-5.6 Luna, low reasoning, standard service tier
- Claude: Sonnet 5, low reasoning, the current upstream fixed context
- Cursor: Grok 4.6, low reasoning, standard service tier

## Default Sidebar Archive Controls

**Worktree branch:** `feat/sidebar-v2-archive-controls`

The default sidebar preserves archive as a separate lifecycle from settle without changing upstream's archive rule. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus. Archive eligibility requires upstream's `threadRuntimeCanArchive(thread.runtime)` and the target environment's `AuthOrchestrationOperateScope` everywhere: the settled-row button, root context menus in the default sidebar and chat header, the default sidebar's multi-select `Archive (N)`, and `Archive all`. Upstream's archive command detaches the provider session and stops leftover background work, so the branch adds no background-work guard. The row archive button stays visible but disabled while upstream blocks archiving, with upstream's "Cannot archive while the provider is active." copy. Read-only connections omit settled-row lifecycle controls and keep their status timestamps visible on hover. Archive all subscribes to grants for every settled environment and counts only writable, idle threads. Shared archive coordination checks all pending targets before confirmation and again after it; upstream's archive command rechecks the grant at each mutation. Selected-thread and root menus retain upstream's permission checks. Nested subagent rows continue to omit root lifecycle actions. The legacy sidebar, `threadActionMenu.logic.ts`, and `useThreadActions.ts` are upstream-owned and unmodified.

The collapsible `Settled` shelf header includes an `Archive all` action alongside its expansion control. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination and pinned threads that upstream classifies as settled, and remains available when the list begins with settled conversations. Individual default-sidebar and chat-header actions, the default sidebar's selected-thread action, and `Archive all` honor the shared archive-confirmation setting, use the existing archive command and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove each archived row from any active selection as soon as it archives (so a row restored by Undo and reselected mid-batch keeps its selection), and report failures without implying that completed archive work was rolled back. These actions share one process-wide reservation pool keyed by the environment-scoped thread identity and coordinate their targets from confirmation through mutation. Each flow synchronously queues every target behind that thread's current holder in start order, so waits only point at older flows and cannot form a cycle; an uncontested flow still starts synchronously. A queued thread is omitted when its own predecessor archived it successfully or intentionally skipped it after a live eligibility re-check, and retried when the predecessor canceled or failed, instead of racing or silently dropping the later request. A flow's first own completion of a thread detaches that thread's queue from later lookups, even when a waiter queued behind it holds the entry, so a fresh request for it (for example after Undo while the rest of the batch runs) starts a new queue immediately, while flows already queued behind it still omit it through the completion they awaited. Inherited and repeated completions and final cleanup remove only this flow's own entry, so they never drop a newer queue. Completed archives and intentional eligibility skips are published to waiters even if a later mutation or navigation throws. Bulk flows re-check upstream's runtime rule after coordination and confirmation, while `Archive all` additionally re-checks settled-partition membership from the live thread shell (still settled and not snoozed) within the rendered project scope before each mutation, so a stale or unmounted sidebar cannot archive a thread that left the shelf. Entries that started a run or were un-settled while a flow waited are skipped without aborting the remaining confirmed batch, and the user is warned about the skipped entries.

`SidebarArchiveControls.tsx` owns the fork-specific settled-row controls and the `Archive all` button, while `SidebarArchiveControls.logic.ts` owns sidebar-only filtering and the live settled-membership rule over upstream's runtime check. `threadArchive.logic.ts` owns outcomes and their user notices (`getArchiveOutcomeNotices`), the skip-aware `archiveEligibleThreadEntries` batch helper (distinct from upstream's `archiveSelectedThreadEntries`, which the legacy sidebar keeps), and process-wide reservation coordination. `useThreadArchiveActions.ts` owns shared confirmation, coordination orchestration, toast delivery for those notices, individual archive actions, and selection cleanup for the default sidebar and chat header. `useSidebarArchiveActions.ts` adds selected-thread live rechecks and all-settled membership policy to that shared lifecycle. `Sidebar.tsx` retains the archive integration points in the upstream-owned row and list surfaces without changing their module exports. The upstream `buildThreadActionMenuItems` builder owns root-menu composition, including the archive entry, its label, position, and `isRunning` disabled state. `Sidebar.tsx` and `useThreadActionMenu.ts` route the menu's archive choice through `useThreadArchiveActions.ts`. Upstream auto-settle settings remain available in the same menus. Successful archives retain upstream's per-thread Undo notices, including when invoked by a bulk flow. Undo waits for the restored live shell before returning to the archived thread when archiving moved the reader to a draft; the fork's outcome reporting still distinguishes an archive failure from a later navigation failure.

Upstream's shared `CollapsibleSectionHeader` (`apps/web/src/components/ui/collapsible-section-header.tsx`) owns the shelf header look and accepts no `className`; its `accessory` renders inside the toggle button. The fork adds a `trailing` slot that, only when supplied, wraps the toggle in a flex row and renders the slot outside the button, so `Archive all` is never a nested button. Other callers without `trailing` keep upstream's DOM. The sidebar's `SidebarSectionHeader` passes `Archive all` through that slot.

Shared lifecycle-button classes keep settle, un-settle, and archive affordances aligned with the upstream row surface tokens while upstream snooze and wake controls retain their own shelf semantics. The fork-owned settled-row component preserves upstream's styled un-settle tooltip and uses the same tooltip primitive for the archive button's enabled and disabled status copy instead of a native `title` attribute. The slim settled status slot mirrors upstream's `focus-visible` crossfade so its timestamp yields to both lifecycle buttons instead of remaining underneath them, while Woke stays visible and the controls move into flow beside it. Disabled archive controls remain focusable, expose `aria-disabled`, retain pointer targeting for the styled explanation tooltip, stop row or shelf propagation, and never dispatch the archive action. Their cursor and hover tone communicate the unavailable state. An in-flight `Archive all` uses `aria-disabled` and `aria-busy` rather than `disabled`, so it keeps keyboard focus, and the hook's in-flight guard ignores repeat activations; it remains mounted after every archivable row has left the list, and the sidebar keeps the Settled header in its list, and holds back its empty-state copy, while the batch runs even when every partition is empty. The surrounding row structure, including row-level tooltip wrapping outside the archive control, row sizing, settled pin markers, pinned-thread sorting and dragging, filtering, un-settled-thread re-entry ordering, and decorative environment/provider status semantics, remains upstream-owned. Upstream title-search mode uses separate navigation-only result rows and temporarily replaces the normal lifecycle list; clearing search restores the settled shelf header and row archive controls.

Branch tests follow the upstream standard of exercising logic and observable behavior rather than static markup or wiring. `threadArchive.logic.test.ts` covers batch outcomes, outcome notices, and reservation coordination (waiting, omission, retry, sibling queueing, start-order queueing that cannot deadlock, release on completion, detaching a completed queue from fresh requests while earlier waiters still omit it, and publication on failure) without polling: the coordinator reserves and starts uncontested runs synchronously, and later starts are awaited through explicit signals. `SidebarArchiveControls.logic.test.ts` covers the `Archive all` live re-check against a stale rendered settled set across a newly started run, an un-settled, a snoozed, and a vanished thread, plus the project-scope bound and mixed-permission settled-thread filtering. `SidebarArchiveControls.test.tsx` renders `SidebarArchiveAllButton` in the shared header's `trailing` slot with `react-test-renderer` and asserts that it stays outside the toggle, dispatches without toggling, and keeps both button identities, with the busy button still focusable, through an in-flight batch with no archivable rows left until completion. The Settled header's retention in the sidebar's inline list builder, row layout, and tooltip copy have no dedicated tests. `docs/user/thread-sidebar.md` documents settled-row archive and `Archive all` in its settle section.

Primary files:

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/SidebarArchiveControls.tsx`
- `apps/web/src/components/SidebarArchiveControls.logic.ts`
- `apps/web/src/components/SidebarArchiveControls.logic.test.ts`
- `apps/web/src/components/SidebarArchiveControls.test.tsx`
- `apps/web/src/components/threadArchive.logic.ts`
- `apps/web/src/components/threadArchive.logic.test.ts`
- `apps/web/src/components/ui/collapsible-section-header.tsx`
- `apps/web/src/hooks/useSidebarArchiveActions.ts`
- `apps/web/src/hooks/useThreadActionMenu.ts`
- `apps/web/src/hooks/useThreadArchiveActions.ts`
- `apps/web/src/hooks/useThreadArchiveActions.test.ts`
- `docs/user/thread-sidebar.md`

On main, every sidebar and chat-header archive, including bulk and Archive all, goes through useThreadActions.archiveThread, so cache eviction and pending-upload release apply before server cold storage. The Archive panel uses its own row reservations; both paths reach the same lifecycle commands and preserve subagent cascading.

The upstream thread-action permission and Undo fixtures mock both integrated draft-cleanup exports: archive releases regenerable uploads, while permanent deletion discards the draft. Their tests retain the upstream permission and Undo behaviors through the integrated archive path.

## Version Control Panel Work

**Worktree branch:** `feat/version-control-panel-work`

The first-class Version Control panel includes a singleton right-panel surface, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, and Version Control panel RPC/contracts. On web, a logical project shared across environments renders one complete panel instance for each connected environment, with the active environment first and remote instances using the existing server-icon and environment-label treatment. `buildSourceControlEnvironmentOption` in `apps/web/src/components/ChatView.sourceControl.ts` is the shared constructor for the environment option consumed by both toolbar routing and the federated Source Control panel. Snapshots, status subscriptions, fetches, diffs, editor launches, and Git mutations stay routed through each instance's environment and cwd. Project-script saves use the destination environment’s settings capabilities and preserve its existing project overrides. A normal ahead-branch push starts immediately while snapshots of the other connected environments are read alongside it. Only after the push succeeds, a peer whose current branch has a clean working tree, no local commits ahead of its upstream, and tracks the same normalized remote branch is fetched, rechecked, and fast-forwarded. Peers that changed locally, changed upstreams, disconnected, or failed are left alone, and peer failures cannot misreport the completed source push as failed. Servers advertise the panel through the optional `sourceControlPanel` environment capability; web availability, the federated peer list, and the mobile Version Control entry points require it, and the mobile Version Control and diff routes mount their request-producing controllers only while it is advertised (covering deep links, restored routes, and reconnects to an older server), so older servers never receive `vcs.panel.*` requests. Disconnected environments are omitted, failures remain isolated to their per-panel retry state, and only the active instance may update active-thread source-control metadata or open its standalone File surface. `SourceControlEnvironmentPanel.tsx` names this active-only capability `activeThreadRef`; the active panel uses it for File-surface openings and `PublishRepositoryDialog` link routing, while foreign panels receive `null`. The shared `apps/web/src/rightPanelStore.ts`, `RightPanelTabs.tsx`, and `ChatView.sourceControl.ts` integration keeps singleton Source Control and multi-tab pull-request surfaces as peers: `normalizeSourceControlRightPanelPresence` applies repository availability to both live and retained right-panel presence, removes only Source Control, preserves pull-request and File tabs, and falls back to the first remaining visible surface when an unavailable Source Control tab was active. `apps/web/src/components/rightPanelSurfaceActions.ts` is the canonical add-surface descriptor for availability, activation, shortcut, empty-state and menu order, and disabled presentation (short hints in the empty-state launcher, full reasons in the add menu); `RightPanelTabs.tsx` derives both launcher action lists from one memoized snapshot of those inputs and uses the same actions for keyboard activation. Version Control uses shortcut `V`, appears directly after Diff in both the empty-panel launcher and the compact add-surface menu. The thread details panel's Changes row is a split control: the row still opens the Diff surface, and its dropdown offers Changes or Version Control, which `ChatView` wires to `addSourceControlSurface` only while the surface is available (the choice is disabled otherwise). Browser session/runtime-tab resolution, audio state, and mute-menu behavior remain isolated in `apps/web/src/components/rightPanelBrowserTabState.ts`, so background preview mini-player lifecycle changes and right-panel browser-surface reconciliation must leave the Source Control surface open, visible, active, and present exactly once.

The shared `DiffPanel` file tree is in-panel navigation: selecting a tree entry reveals that file inside the diff. The explicit filename primary action is routed through `apps/web/src/diffFileActions.ts` and reuses the thread's default right-panel File surface. Persisted attachment tabs retain their attachment identity and payload when the file-tab migration runs for existing installs. Source Control file previews for a foreign sibling worktree retain their explicit cwd, so the same relative path in two worktrees remains available in separate File tabs.

Web source-control rows use the rich-tooltip presentation and timing shared with the default web sidebar in `apps/web/src/components/Sidebar.tsx`, including its `ThreadHoverCardPopup` glass card from `apps/web/src/components/ThreadHoverCard.tsx`; the branch defines no tooltip variant of its own. The opt-in legacy sidebar remains isolated in `apps/web/src/components/LegacySidebar.tsx` and does not define this convention. Working tree, file, branch, commit, stash, and remote cards expose their full paths or refs and relevant status, timestamp, identity, URL, and line-change details without covering the row. Clickable tree and file rows use the pointer cursor alongside their keyboard button semantics. Federated environment headers expose their complete cwd through the shared styled tooltip primitive rather than the browser-native `title` attribute. File cards use trigger-scoped virtual anchors while retaining a common panel-aligned left edge. Nested action buttons keep their terse label tooltips and preserve the parent rich card only for the nested trigger in that same row, so unrelated tooltips elsewhere are unaffected.

VCS status ignores internal `.git/` watcher events before refreshing local status. Background activity keeps lightweight current-upstream status refreshes separate from the Version Control panel's broader fetch-all-remotes work. `apps/server/src/utils/CanonicalPath.ts` owns native-first canonicalization for existing paths. `GitVcsDriverCore.ts` uses it for Git common-directory cache identity, `GitManager.ts` uses the same path identity for status caches and worktree comparisons, and `VcsStatusBroadcaster.ts` keys direct and sibling-worktree watchers on it so one directory never holds two watchers. The portable filesystem path and then the original input remain fallbacks, so Windows long and 8.3 aliases for a repository and its linked worktrees share cache and worktree identity without making missing paths fatal. The normal Git interval retains the shared `performance`, `balanced`, and `battery-saver` values of 15 seconds, 30 seconds, and disabled, while the panel-specific all-remotes interval uses one minute, five minutes, and disabled respectively. Automatic panel fetches run only while a panel retains Git-ref demand and the owning environment's shared lock, low-power, battery, visibility, and activity policy allows the work. A host lock alone does not pause them while a foreground client retains that cwd's demand, so remote use of a locked machine keeps remote refs fresh; `apps/server/src/sourceControl/SourceControlPanelFetchPolicy.ts` owns that panel-only exception and leaves the shared policy unchanged. `SourceControlPanelService.fetchAllRemotes` applies the policy gate and refreshes VCS status after a fetch that ran, and every other successful panel mutation forks its status refresh from the service, so `apps/server/src/ws.ts` panel handlers only decode, call one service method, and map errors. Opening the web panel and focusing the mobile route refresh their local snapshots immediately. On subsequent web focus, an enabled panel interval first makes the interval-aware, policy-gated fetch request and then refreshes the local snapshot once; a zero interval skips the network request and refreshes locally immediately. Panel fetch-all requests use `--no-auto-gc` so periodic refreshes cannot repeatedly restart failed repacks. Automatic and explicit panel fetches share the existing non-interactive Git credential environment, so background refreshes cannot open credential dialogs. Explicit Fetch uses the same safeguard and remains available to connections with source-control write access, bypassing the interval cache. The previous omitted custom default migrates through the new balanced default, with its conservative cadence preserved by the panel-specific value; an explicitly persisted five-minute upstream-status override remains an override instead of being reclassified by value. Settings search indexes the individual Source Control controls: stable writing controls anchor to their rows, while discovery-dependent Git intervals and provider-avatar controls route to the panel's stable Source Control section.

`apps/server/src/sourceControl/SourceControlPanelService.ts` requests repository status with `includePullRequest: false` and `refreshUpstream: false`. `GitManager.ts` still returns local and remote synchronization state for the repository summary, but skips the provider-backed PR lookup because panel snapshots always project `pr` to `null`. The shared VCS status stream retains its normal PR behavior. Actionable rows discover the PR of each local branch with a remote-tracking ref, either its upstream or a same-named branch on any configured remote (covering a push without `-u` or an upstream unset after publishing), through the same cached `GitManager.branchPullRequest` lookup as the conversation sidebar, including head-repository validation and in-flight request reuse. Discovery does not scan or cap repository-wide PR lists. Automatic GitHub discovery uses the shared API repository locator, preserving a configured GitHub default repository and fork-parent selection instead of binding searches to the push fork at `origin`. The returned PR repository identifies the configured remote whose base branch is compared; only open PRs with a local branch behind that target produce rows. Each such row carries the PR and reuses the sidebar badge beside the ahead/behind counters, including its status tooltip, in-app navigation, and modifier-click behavior. While a web or desktop item action runs and its snapshot refreshes, its hover controls are replaced by an always-visible action label using the conversation sidebar's Working indicator. Labels identify the operation, such as Committing, Stashing, Undoing, or Rebasing, and remain scoped to the affected item. Provider-backed change-request and commit-avatar lookups for Actionable rows remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows. These background reads share the provider-and-host cooldown used by pull-request services. Panel reads and GitHub adapter requests use the same normalized host key, including an explicit non-default enterprise port, so a pause applies to the matching endpoint without suppressing another port on that host. The first classified rate-limit response records the provider reset time or fallback backoff, and later panel reads skip the provider until that pause expires while retaining Git-derived content and avatar fallbacks. Provider adapters retain their provider-specific raw-state normalization, while resolved Git pull requests and panel `VcsStatusChangeRequest` schemas in `packages/contracts/src/git.ts` share the canonical `ChangeRequestState` from `packages/contracts/src/sourceControl.ts`.

Forgejo/Gitea change requests participate in Actionable branch discovery across configured remotes. Its provider returns no commit avatar, so panel rows retain their avatar fallback. GitCafe also returns no commit avatar and is excluded from avatar preferences. Its panel listing accepts an absent head selector for repository-wide history while preserving supplied head identity, source repository, pagination, and limit constraints.

GitHub head-specific discovery uses the upstream `GitHubSourceControlProvider` batched GraphQL path and default repository selection. Repository-wide panel history and commit avatars use the same provider's authenticated GraphQL and REST transport, resolving the repository from the selected remote and retaining the provider context's API host, including non-default enterprise ports. The removed `GitHubCli` modules are not restored.

The mobile Version Control and file-diff routes use the shared `ScreenHeader`. Version Control closes back to the active thread. The diff returns to Version Control with an explicit back action in split layouts and the shared in-content header on Android. Compact iOS presents the diff as another modal, dismissed by gesture with no visible back control: `VersionControlDiff` omits `presentation`, and native-stack treats a route without one that follows the full-screen Version Control modal as a modal. Neither route shows a sidebar action.

Repository-convention message generation uses one repository-context policy reader for generic Git actions and panel commit/stash actions. Panel commit and stash generation applies the registered checkout project’s writer and writing-style overrides, falling back to the main checkout’s project for unregistered sibling worktrees. Both paths resolve the effective writer from the current provider snapshot and fall back to the configured text-generation model when the dedicated writer is disabled or not usable. They read recent commit subjects and `AGENTS.md`; Claude writers also read `CLAUDE.md`.

Version Control and source-control provider failures should preserve structured causes when normalized for panel RPC errors. GitLab, GitHub, Forgejo/Gitea, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing structured process failures into generic strings. Web and mobile panels derive mutation availability from their destination connection's source-control write grant. Read-only connections retain snapshot, diff, branch, stash, and remote inspection; mutation buttons, menus, and confirmation entry points are disabled. Mobile Publish remote choices also follow this grant while its Cancel action remains available unless a mutation is running. Web mutations reconcile VCS status and an authoritative panel snapshot after both success and failure before preserving a mutation error, so conflict-producing or partially applied operations remain visible. Web Source Control mutation confirmations use the shared themed `LocalApi` dialog with the destructive variant and never fall back to a native `window.confirm`; commit branch-name entry likewise uses a themed `Dialog` and `Input` instead of native `window.prompt`. Shift-click forced sync confirms first and names the side it overwrites: force push and publish replace the remote branch, and a reset to the upstream discards local commits, plus uncommitted changes when that branch is checked out. Diverged rows keep the explicit dialog choice, and a forced sync that would only fetch skips the prompt; `forcedBranchSyncConfirmation` in `SourceControlPanel.logic.ts` owns that decision. Azure DevOps commit-avatar lookups route through the organization encoded by the repository remote and use the stable Commits Get API version.

Panel mutations that can change refs invalidate both shared ref-cache layers in finalizers: `apps/server/src/sourceControl/SourceControlPanelActions.ts` and `SourceControlPanelService.ts` call the non-failing `GitVcsDriver.invalidateRefs` boundary for the shared server `listRefs` snapshot, while matching commands in `packages/client-runtime/src/state/vcs.ts` invalidate shared client ref state through `onSettled`. This applies after successful, failed, interrupted, or partially applied commit, branch, fetch, and remote mutations. Fetch-all is the one result-aware case: `onSettled` receives the command exit, and a `false` result (the server's background policy skipped the fetch) leaves client ref state alone. Working-tree staging/unstaging/discard, stash operations, diffs, comparisons, and other read/display-only operations remain excluded. Cache invalidation supplements the existing authoritative panel/status reconciliation and never replaces or masks the original mutation result.

Thread source-control metadata update failures should surface on the thread without overwriting unrelated thread errors, and successful source-control updates should clear only the source-control metadata error for that thread. `apps/web/src/components/ChatView.sourceControl.ts` resolves the visible banner with local thread errors ahead of source-control metadata errors and the V2 runtime's persisted `lastError` behind them; the banner keeps upstream's `usage_limit` error class only when the session error is the one shown. Dismissing a banner clears only its owning local or source-control error; persisted session errors are masked for the current UI session, so a lower-priority error remains available after the dismissed banner is gone. Metadata writes go through the V2 `thread.metadata.update` command, which has no expected-branch compare-and-swap, so the client keeps no branch-observation guard: writes are serialized per thread and only the newest request enqueued for a thread applies. A superseded request skips its write, and a request that finishes after a newer one was enqueued resolves as stale, so neither its success nor its failure changes the thread's metadata error. Grouped-project navigation retargets an open singleton Source Control surface to the active draft/thread environment and effective repository cwd, while metadata errors remain scoped to the originating environment/thread key and are pruned when that context is no longer retained.

Selected commits reconcile the real index in an interruption-safe success finalizer before temporary-index cleanup. Generation and commit execution remain cancellable; cleanup cancellation must not leave a completed commit staged again. If reconciliation fails after the commit is durable, report that the commit exists, stop before push, and provide a shell-quoted, bounded index recovery command rather than inviting another commit. A stash pop whose apply succeeded but removal failed reports that distinction and warns against reapplying.

Persisted right-panel state is at storage version 15. Upstream's v14 removed the Agents surface; the branch's tuple file-surface ids, preserved attachment tabs, and environment-owned terminal targets migrate at v15 so stores already written at upstream v14 still run the branch migration. `migratePersistedRightPanelState` is version-independent and covers both.

Required edge cases: the current default branch remains a valid default compare ref and retains that stable base in its own branch details, status-derived default branch names such as `develop` are preferred over hardcoded `main`/`master` guesses, compare-history pagination queries the selected comparison range, branch pull/fetch parsing handles slashful remotes and remote-looking local branch names without treating slashless local upstreams as remote refs, fetch-before-sync refreshes the authoritative snapshot before choosing the same action's push/pull/diverged result and does not fetch an unchanged branch twice, the panel and composer share live Git status with a per-environment checkout fallback remembered for the current session, known non-Git projects disable the Source Control action and hide any retained surface while status reloads, and unseen checkouts assume Git until VCS status resolves, diverged normal merge sync is available only for the current branch, checked-out branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, sibling worktree watchers run only while a panel holds `git-refs` demand for that cwd and keep root Actionable rows live while skipping stale/prunable worktree paths, working-tree refreshes that race an authoritative full snapshot cannot retain pre-mutation branch/remote/stash data, failed full snapshots release the in-flight full-refresh barrier so later working-tree refreshes can remain incremental, queued web refreshes still drain when the active refresh fails or is interrupted, duplicate web and mobile actions with the same key are synchronously suppressed while the first mutation remains in flight, web and mobile stash actions carry the selected immutable SHA beside the positional ref and reject shifted or missing selections, requests without a SHA keep acting on the positional ref, a running web stash action disables actions on every stash, mobile stash creation and apply/pop/drop exclude each other synchronously, app-owned stash mutations serialize by canonical Git common directory across linked worktrees, branch sync and undo operations for checked-out branches target the owning worktree cwd, upstream remote identity keeps local-to-local tracking separate from remote pairing and sync, local and remote deletion preserve the selected identity when names collide and reject a missing target without crossing into the other kind, checkout and deletion remain rejected by both the client and server for branches checked out in a worktree whose directory exists, a local branch still registered to a worktree whose directory is gone (`prunable` in `git worktree list --porcelain`) is pruned through the shared workflow before the delete, local branch deletion runs through upstream's `GitWorkflowService.deleteLocalBranch` after `localBranchDeleteRefusal` refuses a branch Git still lists in a non-prunable worktree (naming its path, even when forced) and a non-forced delete of a branch not merged into its resolvable upstream or else HEAD (with a surface-neutral force-delete hint; web appends its Shift-click hint and mobile offers a Force delete choice), cwd-scoped working-tree enrichment avoids cross-worktree file-detail reuse, a fallback File surface uses its own cwd and reveal metadata, selected-file commits omit pathspecs after staging, commit-hook output only enriches a failed Git result and never interrupts a still-running commit, merge refs are passed after `--`, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, empty working-tree diffs use the full-file fallback only for paths Git currently lists as untracked in panel-cwd-relative form, Review patches disable user-configured diff rendering, merged staged-plus-unstaged row stats are summed, collapsed mobile remotes hide their branch rows, mobile conflict-only rows open the working-tree diff side, sibling mobile working trees are not marked expansion-initialized until they become current, failed mobile branch/stash details replace loading placeholders with errors, invalid mobile branch and stash dates are omitted instead of appearing as recent activity, and late-month relative dates do not fall through to `0 years ago`.

Working-tree snapshots keep every changed path visible but defer expensive untracked-file stats and temporary-index rename detection to a batched enrichment RPC. Web and mobile queue every eligible file in the snapshot, including collapsed and offscreen working trees, so totals are independent of row rendering. Untracked rows carry no content identity, so mobile revalidates enrichment on every accepted snapshot read, even an unchanged one: a read with the same cwd/path identities as a traversal still in progress coalesces into one follow-up pass instead of restarting it, while a changed path set restarts and drops in-flight results; each batch replaces the rows it requested, failed batches retry on the next accepted read, and results for paths that remain eligible stay visible across unrelated snapshot changes until replaced. An unmounted controller neither starts snapshot reads nor accepts one still in flight, so it never starts enrichment. Keep this work separate from the initial snapshot and retain bounded batches. Git diff paths are converted from repository-relative to panel-cwd-relative before joining status rows, so panels opened below the repository root retain their line counts.

`SOURCE_CONTROL.md` contains the detailed implementation requirements.

Primary reference:

- `SOURCE_CONTROL.md`

On main, the shared launcher descriptor combines Version Control with Magi: V follows Diff and G follows Device, with the Magi active-run badge carried through the memoized actions. ServerSettingsPatch includes both sourceControl and magi. The right-panel store retains cwd-aware File tabs and Magi run reveal requests together; preview reconciliation must preserve both singleton surfaces.

The core WebSocket handler group retains all twelve Magi RPCs and its armed-message/launch wrappers, while the Version Control handlers remain in their separate group to keep compiler inference bounded. Both Magi and panel destination-grant tests remain in the shared command-permission suite. ChatView's terminal launcher checks the effective destination project and grants alongside the Magi launcher in both panel layouts.

Combined launcher coverage checks Magi availability, keyboard activation, and its active-run badge independently of Version Control. Combined close/reopen and dismissed-device coverage uses cwd-aware file identities; migration fixtures keep their literal legacy identities. Preserve Magi run-reveal requests when adopting the cwd-aware File signature, and retain the core RPC group's armed-message and armed-launch wrappers when splitting panel handlers.

## Conversation Rendering Power Safeguards (Currently Inactive)

**Worktree branch:** `none`

The fork previously tested lower-power conversation rendering safeguards, but they are intentionally inactive in the current implementation. Commit `41ca48494b46da7213bb28f4bc0621bb58fbf7c7` introduced them; the implementation has since been reversed while retaining this summary for future reference.

Inactive behavior retained here as a reference:

- The inactive animation safeguard limited the shared `status-pulse` animation to three iterations and the default Sidebar working-text animation to two iterations. The current implementation again runs both animations for the full working state.
- The inactive syntax-highlighting safeguard rendered fenced code in a streaming assistant message as plain `<pre><code>` content while the block was growing, then highlighted and cached the final content after the message settled. The current implementation again invokes Shiki for streaming partial blocks.
- The default Sidebar's existing `motion-reduce:animate-none` handling remains authoritative; the finite iteration bound complements rather than replaces that accessibility behavior.

Primary files:

- `apps/web/src/components/ChatMarkdown.tsx`
- `apps/web/src/index.css`

## Mobile EAS Project Ownership

**Worktree branch:** `none`

This branch points the mobile Expo/EAS project at the local `quicksaver` owner instead of upstream's `pingdotgg` owner so installable internal mobile builds can be produced without requiring access to the upstream Expo organization.

Expected behavior:

- `apps/mobile/app.config.ts` uses `owner: "quicksaver"` for EAS project ownership.
- `apps/mobile/app.config.ts` uses EAS project id `c65ac46d-6488-49af-b61e-ab9bef78f96e`.
- `apps/mobile/app.config.ts` uses OTA updates URL `https://u.expo.dev/c65ac46d-6488-49af-b61e-ab9bef78f96e`, matching the local EAS project id.

Upstream update rule:

If upstream changes the mobile EAS project metadata, preserve the local `quicksaver` owner, project id, and matching OTA updates URL unless this branch intentionally switches back to the upstream Expo organization or to a new local EAS project. Re-check this triplet before resolving conflicts in `apps/mobile/app.config.ts`, because mixing upstream and fork values can make local builds fail authorization or route OTA updates to the wrong Expo project.

Primary file:

- `apps/mobile/app.config.ts`

## Mobile Apple Development Team

**Worktree branch:** `none`

This branch points local iOS development signing at Apple team `6JGX8M7Z3L` instead of upstream's T3 Tools team. This is local-development glue, independent of the Version Control panel customization and the Expo/EAS project ownership above.

Expected behavior:

- `apps/mobile/app.config.ts` uses `ios.appleTeamId: "6JGX8M7Z3L"` so Expo prebuild/run commands and generated Xcode projects select the fork owner's Apple team.
- Personal Team development builds set `T3CODE_IOS_PERSONAL_TEAM=1` and use `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.quicksaver.t3code.dev` so the local bundle id does not collide with upstream's registered identifiers.
- The existing Personal Team build mode omits unsupported app-group, widget, share-extension, push, and native Sign in with Apple capabilities; this reduction is local-development glue and must not change full-capability EAS/release builds.
- Physical-device builds use a valid Apple Development certificate, its private key, and an Xcode-managed development provisioning profile for team `6JGX8M7Z3L`.
- Simulator builds intentionally use Xcode's ad-hoc `Sign to Run Locally` identity. They validate the Personal Team project/configuration path, but do not exercise the physical-device certificate or provisioning profile.

Apply the Personal Team values to both Metro and the native build. Expo serves the development manifest from Metro, so starting Metro without these values would report the full-capability configuration to JavaScript even though the native binary was built without App Groups and extensions.

In one terminal:

```sh
cd apps/mobile
T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.quicksaver.t3code.dev vp run dev:client
```

Then build/run from another terminal with the same values:

```sh
cd apps/mobile
T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.quicksaver.t3code.dev vp run ios:dev
```

Upstream update rule:

If upstream changes the mobile Apple team id or Personal Team build path, preserve team `6JGX8M7Z3L`, the `com.quicksaver.t3code.dev` local development bundle id, and the reduced-capability Personal Team behavior unless the fork intentionally moves to another Apple team. Keep this ownership override separate from Version Control panel documentation and behavior.

Primary file:

- `apps/mobile/app.config.ts`

## Preview screenshots while locked or display asleep

**Worktree branch:** `fix/preview-background-screenshots`

The standalone worktree is `E:/Projects/t3code.worktrees/preview-background-screenshots`, at HEAD `206e4d9b54b4a43625c903b4da1a4ef55c92831f`, preserving customization baseline `a7accb8e27e43b1d4c5f9d937ac98e3a987d6274` directly above fixed `base/main` `c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e`. The clean source branch tracks `origin/fix/preview-background-screenshots`; `base/main` remains its comparison base. Discarded warmup `PreviewOperationError` is now best effort, so final native readback can still succeed. Destroyed/replaced guests, interruption and final-readback failures retain their existing behavior. Historical native proof below remains attributed to its original source.

Status is VALID for the surviving native still-image rendering, occlusion, throttling, and readiness customization. Incoming agent browser automation moved to the environment server; server-browser CDP supersedes the deleted desktop agent snapshot and takeover work. The warmup repair preserves unique rendering ownership shared with recording and PiP. The historical native proof applies to ordinary native desktop preview tabs; it is not current-base native or server-browser CDP proof.

Current Windows locked/display-off proof compares the exact fixed base at 2/6 fresh captures with the unchanged final at 6/6 across shown, minimized and hidden controls, in 58 to 88 ms. Both original preloaded native guests survived the human transition from unlocked/display-on. Every request preserved guest identity and restored prior throttling. All ten new PNGs were independently decoded and hashed after teardown.

WTS locked and same-session LogonUI observations agreed with passive display-off observations before and after each request, with 90 agreeing session/root samples during the batch. Input desktop remained Default and is not used alone to establish lock. No capture wake was observed, subject to sampling and notification limits. This supplements the prior exact-source Mac locked/display-off base 4/6 to final 6/6 result and Windows unlocked/display-off base 1/6 to final 6/6 result; the two extra PiP checks per host also passed. No Mac repeat was needed.

Current integrated validation passes 118 Manager/native IPC tests and desktop typecheck. The warmup regression verifies final saved pixels after three failed discarded captures; persistent final errors still propagate and restore throttling. Full React/broker/MCP traversal and live-recording coexistence are not newly verified. Two native readbacks, best-effort fallback freshness and small performance samples remain limitations; this is not an exhaustive state matrix.

Current manual proof and resource accounting are in [result.md](E:/Projects/t3code.worktrees/preview-background-screenshots/.piz/proof/preview-background-screenshots-desktop-windows-20261008T101809Z-4b019d13/result.md). [Prior Windows/Mac exact-source proof](E:/Projects/t3code.worktrees/preview-background-screenshots/.piz/proof/native-fixed26285-20261008T072418Z/result.md) retains its original state attribution.

Terminal accounting confirms all 14 owned PIDs absent, owned listeners closed, the exact lease/request released, and owned guests, tabs and passive observers gone. No owned streams, mappings or scheduled jobs were created. Cold builds, isolated profiles and proof remain inventoried; prior proof is preserved.

Main applies the native still-image customization directly above the current upstream architecture. Deleted desktop agent automation and its snapshot-control permits stay deleted; environment-server automation continues through upstream CDP. Native proof above remains attributed to its original source and hosts; integrating source does not establish a new installed-build or locked-state result. Optional broader proof remains unverified and prepared offline. Agents and helpers must perform no sleep, wake, display, lock, unlock, power, security, extra assertion, or scheduled OS operation.

The tracked accessory note is [PREVIEW_SCREENSHOTS.md](PREVIEW_SCREENSHOTS.md).

## Preview recording startup without foreground focus

**Worktree branch:** `fix/preview-background-recording-start`

The standalone worktree is `E:/Projects/t3code.worktrees/preview-background-recording-start`, at HEAD `e53a132d4e30d8092865935c660ca7b41357e3f6` above fixed `base/main` `c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e`. The clean source branch tracks `origin/fix/preview-background-recording-start`; `base/main` remains its comparison base. Its three published commits preserve requester-bound native acquisition and page-frame fallback, release the previous source and subscription before repeated START, and clean up exact-request ownership when guest registration fails. Failed registration releases recording-only state and requests detached renderer termination while preserving the original error, healthy replacement subscriptions and PiP. Historical locked/display-off proof below retains its original source attribution.

Status is RETAINED. Historical exact-final native locked/display-off START proof passed on both Windows and Mac at its recorded source. Current branch native START/STOP and cancellation proof is limited to Windows and its recorded minimized-window conditions; it does not re-establish locked/display-off behavior. Requester-bound source selection and production page-frame fallback remain applicable. Incoming agent browser automation moved to the environment server and supersedes old desktop agent registration. Repeated START deliberately does not queue a tab-only renderer STOP, which could retire the replacement source. No server-browser CDP proof was produced.

Both exact-final guests were preloaded while independently unlocked/display-on and produced changing native control video. Production STOP ended control tracks and cleared active IDs before the human transitions. Fresh START while locked/display-off reached real native `NotReadableError`, then recorded changing production fallback video from the same original guest. Windows decoded 3.921300 seconds and Mac 3.920400 seconds, with agreeing sampled locked/off intervals. These passes are sufficient current mechanism AFTER evidence.

Exact fixed BASE `26285ab` rejected native START on both hosts without fallback. Mac locked/off observations only bracket its 59.678 ms rejection, with zero interior samples and a 208.326 ms bracket gap; continuous off-state qualification remains unverified. The earlier Windows attempt observed both displays change ON before actual acquisition while WTS stayed locked. That historical locked/display-ON rejection remains unqualified for strict locked/OFF comparison, with immutable `allQualified=false` proof and an unknown ON-transition cause.

A fresh strict Windows BASE `26285ab` retry on 2026-10-08 now closes that comparison gap. The same original preloaded guest WC3/frame7:4/fixture `3cef7125-70c9-4427-a38a-fde87d143b28` first produced decoded changing unlocked/display-ON native control video, then production STOP ended its tracks and cleared active IDs before READY. One real START ran from 12:19:24.273950 UTC to final STOP at 12:19:25.119334 UTC. All 26 interior samples and 28 including brackets agreed on WTS process/console lock and both displays OFF, with a maximum gap of 41.203857 ms. Real native `getDisplayMedia` rejected `NotReadableError: Could not start video source` at 12:19:25.099-.101 UTC, without fallback or locked video.

The 2 ms native rejection has zero interior state samples and agreeing locked/OFF brackets 31.0 ms apart; no continuous between-sample observation is claimed. Actual `capturePage` at 12:19:25.059-.097 UTC resolved a nonempty 1920x1200 image with two agreeing interior locked/OFF samples. Readable input desktop `Default` is an independent observation, not the lock predicate. The requester default-session grant callback was not directly observed; the control's source ID and unchanged native binding support guest identity without claiming a directly observed grant for the rejection.

No presentation or focus call occurred after READY, and no display-ON notification appeared through observer shutdown. The earlier unexplained wake did not recur; its historical cause remains unknown. Candidate `91ff79d` and both Mac results remain current with their original qualifications and were not replayed.

Final STOP and normal guest cleanup passed. Both candidate concurrent START/STOP pairs fulfilled with zero-byte artifacts, proving cleanup rather than cancellation rejection. Base error attempts did not run those pairs. Fallback rebind/private-end rejection and continuation through a transition during active recording remain unproved. Mac uses independently compiled unchanged recording exports in the production-preloaded requester; full app broker/UI coverage is outside this proof.

Retained verification passed 163 focused tests, desktop/web typechecks, scoped lint and builds, with inherited warnings. Earlier normal-state base/candidate controls retain their actual states: Windows unlocked/display-off and Mac unlocked/display-on. Passing product checks were not repeated during the manual batch. Observed external Mac assertions are separate from system-sleep evidence.

Current strict Windows BASE proof and terminal accounting are in the [retry terminal report](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/windows-base-strict-retry-20261008T115504Z-a6cffa2c/terminal-report.md), [final accounting](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/windows-base-strict-retry-20261008T115504Z-a6cffa2c/final-accounting.json) and [preservation receipt](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/windows-base-strict-retry-20261008T115504Z-a6cffa2c/preservation.json). The [earlier phased report](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/preloaded-locked-20261008T101823Z-f3f3849c/terminal-report.md) preserves candidate AFTER, Mac BASE and the failed Windows BASE attempt. [Prior controls and accounting](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/reassess-26285ab-20261008/documentation-finalization/terminal-report.md) and the [cold manual-batch plan](E:/Projects/t3code.worktrees/preview-background-recording-start/.piz/proof/reassess-26285ab-20261008/documentation-finalization/cold-manual-batch-plan.md) remain source-attributed records. The strict Windows BASE locked/OFF gap is closed.

Terminal reports clear owned runtimes, guests, streams, observers, bounded watchers, listeners, mappings and leases/requests on both hosts. Fresh Windows accounting also clears all owned temporary source/helper staging and preserves main environment targets. Preservation verified all 3423 copied files and archive members, with archive SHA256 `3422ae2947ecb27d0bcad3f33d46d1e6fe630feb3f56df82e0bbf4c53d48b623`. Temporary source/helper checkouts and transfers/refs were removed after preservation and hash verification. Verified proof/build/profile archives remain cold and inventoried. Owned-resource cleanup does not assert closure of the earlier unidentified external Mac probe tab, which was not attributed or touched.

Main composes requester-bound recording, native acquisition and page-frame fallback with the still-image rendering consumers. The Manager fixture retains both the still-image paint controls and the authoritative recording guests, sharing one VM import for their isolated execution tests. Deleted desktop agent automation stays deleted. Native proof above remains attributed to its original source and hosts; integrating source does not establish a new installed-build or locked-state result. No manual recording step or automatic retry is armed. Optional broader proof remains unverified and prepared offline. Agents and helpers must perform no sleep, wake, display, lock, unlock, power, security, extra assertion, or scheduled OS operation.

The tracked accessory note is [PREVIEW_RECORDING_START.md](PREVIEW_RECORDING_START.md). Its current-source section records the pinned branch and tracking; locked/display-off results remain under the historical 26285ab proof section.

## Actionable preview capture failure diagnostics

**Worktree branch:** `fix/preview-capture-diagnostics`

The standalone worktree is `E:/Projects/t3code.worktrees/preview-capture-diagnostics`, at HEAD `104d61b2b1da9417b8879c92f0137b35b083ddd4` above customization baseline `94e03f4dc89c924807797ccf8825b48d1e2d03f3` and fixed `base/main` `c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e`. The clean source branch tracks `origin/fix/preview-capture-diagnostics`; `base/main` remains its comparison base. The capture-message helper is private, removing its unused-export lint defect without changing diagnostics. Historical locked-state proof below retains its original source attribution.

Status is VALID ADAPTED. Current branch Windows proof covers native tagged failures, renderer decoding, actionable fixture toast presentation, real screenshot and recording, and cleanup. Historical actual locked/off acquisition-error diagnostics and same-original-guest retry retain their recorded source attribution. Incoming agent browser automation moved to the environment server and supersedes old desktop agent/broker propagation. Surviving diagnostics preserve safe typed native screenshot/recording failures through IPC and the direct primary cause through the recording wrapper/UI. Capture, fallback, permissions, power behavior and server-browser CDP are outside this customization; no new CDP proof was produced.

Chronology is fixed `26285ab` to rebased/adapted source and reviewed `85593b3e2f313db3e58ed1ac88fc55c273ca4639`, including the generic-cleanup correction. Genuine locked/display-off Windows `getDisplayMedia` then rejected with `NotReadableError / Could not start video source` after native source grant, but the actual production toast remained generic. That reproduced defect justified the small `14f3cbc` formatter fix. It recognizes the reached `NotReadableError` DOMException only for `capture-media-stream`, including the producer's explicitly stored primary cause if cleanup also fails. It adds unlock/display-on/retry guidance while preserving native name/message, stored causes, generic cleanup wording and recording behavior. The follow-up passed 35 focused recording tests, web typecheck and targeted lint, then actual exact-final actionable-toast, cleanup and retry proof.

The completed HIGH review applies to `85593b3`, with support 14, opposition 0 and unclear 0 in run `b88da309-260a-4c3d-bbf2-965e48de2522`; all three configured participants consumed the artifacts. Its prior 58 focused tests and 32 review-correction checks keep their original attribution. That approval is distinct from `14f3cbc` focused/runtime proof. The user expressly skipped a new Magi review for the small fix; none was launched.

The actual final toast directs the user to unlock the capture host, turn its display on and retry, and retains `NotReadableError: Could not start video source`. The native PNG catches the toast entering, with complete text retained in actual DOM. Native arm succeeded; the real OS DOMException came from media acquisition. Cleanup STOP succeeded without leaving active targets. The same original guest then passed the parent-coordinated unlocked/display-on retry, without app, guest, profile or source replacement. Its nonempty 37,160-byte H264 recording decoded to fixture pixels identical to BEFORE and control, SHA256 `917e81bceb7640041a79b1a569dc00e650bfba93e085e3debb747e305f3dffeb`; both acquired tracks ended and global active IDs/targets were empty.

Current chronology, actual toast and recovery proof are in [assessment.md](E:/Projects/t3code.worktrees/preview-capture-diagnostics/.piz/proof/preview-capture-diagnostics-desktop-windows-20261008T104035Z-63adf2bb/assessment.md), with the [actual toast PNG](E:/Projects/t3code.worktrees/preview-capture-diagnostics/.piz/proof/preview-capture-diagnostics-desktop-windows-20261008T104035Z-63adf2bb/ui.png). [Actual OS BEFORE at reviewed 85593](E:/Projects/t3code.worktrees/preview-capture-diagnostics/.piz/proof/preview-capture-diagnostics-desktop-windows-20261008T101830Z-4af4cd60/assessment.md) and [prior review assessment](E:/Projects/t3code.worktrees/preview-capture-diagnostics/.piz/proof/native-step5-high-v2-20261008/assessment.md) preserve the separate source pins.

Earlier closed-tab native proof belongs to `27046dab` and carries forward only along its unchanged reachable path. That controlled lifecycle failure remains separate from real OS acquisition rejection. Its Windows BEFORE toast is partial and first empty Windows AFTER recording is excluded. Current WTS/display samples independently bracket locked/off failure and unlocked/on recovery; they do not establish system sleep, and parent/host clock offset remains unmeasured. Other permission, acquisition and native-timeout categories remain unverified. No Mac runtime repeat was needed once Windows reproduced the required error.

Terminal accounting clears owned processes, tabs, streams, sessions, listeners, mappings, watchers and the exact lease/request. Prior proof and reviews are byte-preserved. Cold build/profile archives, stopped private profiles and earlier inventoried checkouts/helper transfers/caches remain retained; the metadata task does not operate them. No manual step remains for the reproduced acquisition diagnostic.

Main includes the native recording IPC error encoder, primary recording diagnostic and video-source acquisition guidance. A reached `NotReadableError` during stream acquisition explains unlocking the capture host, turning its display on and retrying; unrelated cleanup failures retain generic wording. The native diagnostic contracts compose with screenshot rendering and requester-bound recording; deleted desktop agent automation stays removed. Integrated acquisition tests use the requester-bound getUserMedia path and drive page-frame fallback through its first frame; fallback canvas rejection carries the real DOMException into the producer error, and a fresh fallback frame proves retry. Generic acquisition and native-arm cases use the same current media path. Environment-server automation retains upstream CDP diagnostics. Native proof above remains attributed to its original source and hosts; integrating source does not establish a new installed-build or locked-state result. Optional broader proof remains unverified and prepared offline. Agents and helpers must perform no sleep, wake, display, lock, unlock, power, security, extra assertion, or scheduled OS operation.

The tracked accessory note is [PREVIEW_CAPTURE_DIAGNOSTICS.md](PREVIEW_CAPTURE_DIAGNOSTICS.md). Its current-source section separates native tagged-failure and recording proof from historical locked/display-off acquisition proof.

## Upstream Update Guidance

When updating from upstream, keep these local behaviors unless upstream has an equivalent implementation:

1. Version Control remains a singleton beside pull-request, File, Device, Magi, and preview/browser state. Preserve its native route, federated panels, coordinated clean-peer fast-forward after push, cwd-correct File routing, context-keyed state, subscription-acknowledged metadata queue, request-scoped errors, retryable mobile fetches, process-shared caches, and transport-safe error wrapping unless `upstream/main` is equivalent; use `SOURCE_CONTROL.md` as the source of truth.
2. Version Control idle-power safeguards retain native-first canonical path identity, exact 15-second, 30-second, or disabled Git status intervals, one-minute, five-minute, or disabled all-remotes intervals, shared lock and power/visibility/activity gating, ignored `.git` churn, batched ignored-path classification, batched snapshot-wide enrichment, and explicit Fetch.
3. Version Control checked-out branch labels preserve worktree paths through porcelain-first parsing and old-Git fallbacks; sync and undo target the owning checkout, while checkout and deletion stay disabled for branches owned by an existing worktree; deletion prunes stale registrations whose worktree directory is gone.
4. Thread source-control metadata update failures remain visible without clearing unrelated thread errors.
5. Mobile EAS owner, project id, and OTA updates URL remain pointed at the same local Expo project used for installable preview builds unless deliberately changed.
6. Mobile iOS development signing remains pointed at Apple team `6JGX8M7Z3L` unless deliberately changed.
7. Source Control default branch detection honors the status-reported default branch before falling back to `main` or `master`.
8. Pending-task edit/submit helpers keep edited queued tasks from being resurrected after deletion/delivery, keep edit-session ownership from racing across reopen/exit, persist unsendable cleared edits instead of sending stale text after restart, and avoid reusing stale queued workspace metadata when a pending task is retargeted.
9. Source-control metadata writes are serialized per thread and only the newest enqueued request applies, so stale Git-action results cannot overwrite newer branch/worktree metadata; V2's `thread.metadata.update` has no expected-branch compare-and-swap.
10. Desktop and mobile verification retain host-local capacities and request-scoped cross-host racing. Web servers remain unconstrained, while integrated web UI automation uses one desktop slot on its browser host.
11. Persisted generation-aware Git ref caching and mutation invalidation, interruption-safe preview listener acknowledgements, listener-specific projections, exact known-server polling cadence, incremental Version Control snapshots, and common-directory fetch deduplication retain their branch ownership unless upstream is equivalent.
12. Core projection migrations preserve published ids 33 through 68, ensure lineage before the id-34 root backfill, normalize only exact divergent markers before canonical replay, and register upstream and branch migrations after 68 as listed under Published Database Compatibility. All migrations use `effect_sql_migrations`; migration 60 removes the abandoned experimental Magi ledger after restoring any missing canonical Magi rows.
13. Worktree-local dev state, single-origin browser proxying, Tailscale sharing, and browser-safe port selection remain integrated with the fork's IPv4 desktop/server paths, explicit desktop HMR URL handling, and desktop/mobile runtime coordination.
14. Mobile verification uses the Device panel and exact AgentDevice target arguments, deep-link pairing, and host-local leases. Windows native-client builds retain the worktree wrapper's short-path and dependency-order safeguards.
15. Preview cleanup follows authoritative archive/delete/unarchive and generation-aware shell lifecycle signals, while background mini-player presentation remains independent from the singleton Source Control surface.
16. An open pairing page accepts each new pairing link delivered to it and serializes tokens that arrive while an exchange is pending.
17. Archive remains distinct from settle and root-only in the default Sidebar and chat header, using upstream's `threadRuntimeCanArchive` eligibility; the Legacy Sidebar stays upstream-owned. One process-wide coordinator holds reservations from confirmation through mutation; `Archive all` covers the complete settled scope, including paged and pinned-settled rows. Waiters receive completed successes and eligibility skips while failed, cancelled, and unattempted work stays retryable.
18. Mobile Git checkout failures remain visible and retryable, while interrupt-only outcomes stay silent.
19. The documented finite working-indicator and deferred streaming Shiki safeguards are currently inactive; retain this summary for future evaluation.
20. Provider-neutral Magi remains reconciled against `MAGI.md` on orchestration V2: participants stay ordinary V2 child conversations confined to their subtree, its run state stays in the `magi_*` tables registered after the published ledger, owner lifecycle cascades go through `ThreadManagementService`, and the right-panel entry stays in the shared add-surface descriptor.

## Retirement Criteria

These local patches can be removed when upstream provides the equivalent, superseding, or overriding behavior.

When retiring the local changes, remove the corresponding tests; expect upstream behavior to be tested by upstream incoming tests as well; we do not test or concern ourselves with validating upstream.

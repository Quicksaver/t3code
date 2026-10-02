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

The repository-local orchestration skills divide responsibilities as follows:

- `$worktrees` is the worker contract for exact-worktree execution, same-host control comparison, runtime leases, cross-host source transfer, Android and iOS isolation, and owned teardown.
- `$spawn-worktree` dispatches one worker to one absolute worktree path with only its branch task and required skills. It requires the worker to read that worktree's git-ignored `BRANCH_DETAILS.md`, supervises runtime ownership without leaking orchestration context into the child prompt, and performs exact-worktree lease cleanup only after the worker is terminal.
- `$spawn-worktrees` inventories active non-`main` worktrees and dispatches through `$spawn-worktree`, explicitly excluding the `base/main` control worktree from worker tasks.
- `$update-worktree` squashes and rebases one assigned branch at the control boundary, assesses only the interaction between incoming upstream work and that branch's customizations, and adds adaptations and documentation as follow-ups on top.
- `$update-worktrees` first fetches upstream and fast-forwards a clean attached `base/main` to the selected `upstream/main` boundary. Only after verifying that exact control state does it dispatch the individual branch updates; it does not mutate the other worktrees itself.
- `$rebuild-main` rebuilds only local `main` from the control boundary and `base/fork`, then applies each remaining worktree branch with its integration glue and `FORK.md` updates before proceeding to the next. Feature and fix branches are read-only throughout this workflow; `base/fork` receives the mirrored documentation commits.
- `$babysit-worktrees` delegates each branch's pull-request comments through `$babysit`, then invokes `$rebuild-main` when fixes were produced. `$update-prs` delegates pull-request publication through `$pr` without doing branch work in the orchestrator.
- `$update-unattended` sequences the full maintenance run: update all worktrees, integrate them, push tracked branches, synchronize the Windows and Mac checkouts, and build the configured Windows, macOS, and Android artifacts. Its per-platform command recipes remain authoritative in that skill.

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

The installed Windows and Mac databases use the published fork migration IDs 1 through 68 in `effect_sql_migrations`. Preserve those migrations, including the historical lineage columns and archive glue, when assembling main even after retiring the subagent-threading UI and runtime. Their schema remains part of existing databases; retaining it does not re-enable that customization. Magi native-owner uniqueness is published at ID 68. Migration tests use this fork numbering when preparing pre-upgrade state. Standalone branch migrations are represented by this existing schema and must not reuse its published IDs. The incoming upstream baseline has no migration beyond the schema already represented here. Exact divergent upstream ledger markers are normalized before canonical replay. Verify upgrades against isolated databases, never by migrating live userdata during development.

## Installed Profile Startup Compatibility

**Worktree branch:** `base/fork`

The compatibility implementations and focused regression tests live in `base/fork`, so rebuilding `main` carries them forward before feature branches are integrated.

Stored events also outlive retired features. The event store reads historical `thread.created` events with `parentRelation.kind = "subagent"` as ordinary conversations, without rewriting their stored payloads or widening current command contracts. Both global replay and per-thread cold-storage replay use this compatibility boundary. Other relation kinds pass through the current contracts unchanged; after integrating Magi, its lineage remains intact and unknown relation kinds still fail validation. A migration-only check does not prove event replay compatibility.

The shipped web and desktop connection cache has already reached IndexedDB version 7, including archive-time thread-cache eviction. Preserve that version floor when integrating standalone branches. Requesting an older version prevents the connection runtime from opening its cache and leaves every environment unregistered, even when the server and its SQLite database are healthy. Verify upgrades with an existing client profile as well as server data.

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
- Browser `dev` and `dev:web` modes are single-origin. They omit baked `VITE_HTTP_URL` and `VITE_WS_URL` values, mark that intent explicitly so repository environment files cannot revive them, and let Vite proxy `/api`, `/ws`, `/oauth`, and `/.well-known` to the backend. Vite uses the shared `resolveDevProxyTarget` with `T3CODE_HOST`: an unset host keeps upstream's `localhost` default, wildcard binds map to the matching loopback family, and concrete addresses remain concrete.
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

On iOS, the native-client helper owns the simulator build/install and scoped temporary DerivedData. The Device panel owns streaming and screenshots. Pair through the mobile skill's deep-link helper; this avoids keyboard-layout changes to a typed host URL. Close owned AgentDevice sessions and Device panels before releasing leases, and remove temporary source worktrees afterward.

Android native builds constrain fbjni to the installed React Native catalog exposed by Expo, so a library's wildcard cannot select a binary incompatible with React Native's packaged C++ runtime. The policy contains no dependency version and follows catalog upgrades automatically. The Expo plugin applies it to normal and distribution builds; main's Windows wrapper copies the same policy into each target's generated Android project without modifying that feature branch. Native-client compatibility fingerprints include the wrapper's policy so an older APK cannot be reused after the policy changes.

Metro excludes the worktree's `.t3` directory itself and its descendants with either path separator. The watcher must not enter runtime state, where atomic cache writes can remove a file between discovery and watch registration. Windows native preparation runs before the test backend and Metro start so their watchers cannot hold dependency directories open during installation.

Primary files:

- `.agents/skills/test-t3-mobile/SKILL.md`
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
- Run iPhone Simulator checks on the MacBook Pro. When the initiating checkout is on another machine, connect through `ssh macbook-pro` and transfer its code, including uncommitted changes, as a task-owned source snapshot in an isolated Mac worktree. Build that snapshot rather than an unrelated pre-existing Mac checkout; no commit or push is required. When the suite is already running on the Mac against the intended local checkout or worktree, use it directly—do not SSH to the same machine or create a redundant copy.
- Run Xcode, CocoaPods, Metro, the backend, and simulator-facing services on the Mac, using Mac paths and an explicit simulator UDID. Keep simulator-facing endpoints on `127.0.0.1`; the Mac cannot reach its own Tailscale Serve or MagicDNS endpoint through self-hairpin routing. The selected Mac Device-panel host must be connected and its device tools available.
- Run Android Emulator checks on the Windows Desktop. When the initiating checkout is on another machine, connect through `ssh windows-desktop` and transfer its code, including uncommitted changes, as a task-owned source snapshot in an isolated Windows worktree. Build that snapshot rather than an unrelated pre-existing Windows checkout; no commit or push is required. When the suite is already running on Windows against the intended local checkout or worktree, use it directly—do not SSH to the same machine or create a redundant copy.
- Headless Android verification is available over SSH through Windows Hypervisor Platform and ADB; the Android 16/API 36 x86_64 AVD has completed a full boot through the MacBook Pro-to-Windows SSH path. Run Gradle, Metro, the backend, and emulator-facing services on Windows with Windows paths. Use `10.0.2.2` for emulator-to-host backend traffic and ADB port reversal for Metro. Drive the selected emulator through the Device panel's returned AgentDevice command, and capture evidence with `device_screenshot`.
- Treat results as host-scoped evidence. A successful macOS permission assertion can complement but does not erase the expected Windows mode-reporting mismatch, and a mobile pass applies only to the exact local checkout or transferred snapshot that was tested.
- Runtime leases are machine-local. Acquire and release them on the host running desktop or mobile interaction, following `$worktrees`; commands issued over SSH use the destination host's main and worktree paths. Non-interactive web checks need no lease, while integrated web UI automation uses the browser host's desktop lease.

This section is the shared routing policy for full verification runs. Keep platform availability and expected outcomes here instead of duplicating them in individual test skills.

## Device Host Discovery Reliability

**Worktree branch:** `fix/device-host-discovery`

SSH bootstrap and device commands send their shell scripts through stdin to `sh -s`, so a Windows PowerShell login shell cannot reinterpret POSIX quoting, variables, or the Node version check. Command input is supplied separately inside that script with `printf %s`, preserving quotes, line breaks, and the absence of a trailing newline. SSH aliases must resolve on every selected environment, including a host's own environment, before local-host detection can skip the self connection.

SSH device hosts use one npm invocation path for connection probes and pinned tool installation. Windows runs `npm-cli.js` through the selected Node executable, checking beside Node before PATH directories and preserving paths and arguments containing spaces. Non-interactive POSIX setup appends fallback tool directories so an existing Node/npm pair keeps priority. Bootstrap restores fallback-directory precedence if the selected Node is missing or older than 22, then applies the configured SDK and JVM paths so their tools keep priority. Ordinary device commands do not repeat that version probe. Unsupported-runtime errors include the detected version and executable path. Missing npm, launch failures, signals, and nonzero process exits retain distinct diagnostics, with a bounded stdout fallback when stderr is empty.

Android capability requires SDK Platform-Tools, Android Emulator, and the latest SDK Command-line Tools on local and SSH hosts. An adb-only host reports Android unavailable without disabling iOS. A host with the required tools can retain discovered devices when enumeration of stopped virtual devices fails. When `emulator -list-avds` fails, the shared service retains devices returned by the hub and reports the command, exit code, and a diagnostic tail of at most 2000 characters alongside any hub discovery errors. Successful enumeration still adds unbooted AVDs without duplicating running or repeated entries; a successful refresh clears prior warnings. Local and SSH hosts use the same partial-discovery behavior. Web and desktop show ready-host limitations in device discovery and device-host settings. While a ready host reports limitations, the Device panel shows incomplete discovery instead of an empty inventory; setup and Integrations report uncertain Android availability without creation advice. A successful refresh restores normal empty-inventory guidance. An open device keeps its host diagnostics in the Tools drawer. Mobile and agent consumers retain the existing shared device state and wire contract.

Windows hub processes invoke the SDK avdmanager and sdkmanager Java entry points directly, preserving argument boundaries and avoiding the Unix launcher paths used by the pinned hub. This applies to local and SSH hosts; an SSH hub started without the current adapter is replaced on its next startup.

Primary files:

- `apps/server/src/device/sshDeviceScript.ts`
- `apps/server/src/device/SshDeviceHost.ts`
- `apps/server/src/device/LocalDeviceHost.ts`
- `apps/server/src/device/deviceHubWindows.ts`
- `apps/server/src/device/DeviceService.ts`
- `apps/web/src/components/device/DevicePanel.tsx`
- `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/deviceHubWindows.test.ts apps/server/src/device/LocalDeviceHost.test.ts apps/server/src/device/sshDeviceScript.test.ts apps/server/src/device/SshDeviceHost.test.ts apps/server/src/device/DeviceService.test.ts apps/server/src/device/DeviceMultiHost.test.ts
```

Native Windows subprocess coverage checks paths containing spaces, npm PATH fallback, probe and install dispatch, missing npm, and actual npm failure diagnostics. Service fixtures cover missing emulator tooling, tool failures, SSH failures during optional enumeration, preserved iOS and physical Android results, existing hub diagnostics, recovery, and AVD deduplication. POSIX-only shell and lifecycle fixtures require a POSIX host; their bodies do not execute on Windows. The supported/old-Node PATH-selection and SDK/JVM precedence cases were additionally verified with isolated Git Bash shell fixtures on Windows.

Regression coverage executes bootstrap and device-command payloads through the native login shell, including PowerShell on Windows, and checks quoted arguments, exact stdin, and failure propagation. Read-only probes were also verified over real Mac-to-Windows and Windows-to-Mac SSH connections; no helper installation, desktop deployment, or live device session was started.

Capability fixtures cover incomplete and complete SDKs while preserving iOS availability. Windows launcher tests preserve callback and promisified subprocess results and arguments. The real Mac probe reports iOS available and Android unavailable. A read-only Windows check reproduces the original avdmanager ENOENT and successfully lists AVDs through the adapter; full emulator boot has not been verified.

## Preview Automation Reliability

**Worktree branch:** `fix/preview-automation-reliability`

Product-native preview automation is bounded and recoverable across the web host, MCP server, and Electron CDP controller. The branch-specific layer covers operation deadlines, control-session recovery, profile-preserving automation tab creation, one-shot automation snapshot presentation, and degraded semantic snapshots.

### Upstream ownership boundary

Upstream commit `f4c394323` (`Add background preview capture and picture-in-picture support`) owns:

- keeping inactive preview guests mounted and CSS-visible outside the human-visible panel;
- the `webContents.capturePage()` frame loop used by picture-in-picture;
- inline preview mini-player presentation, fitted-source layout, corner radii, and crash recovery; and
- background-only preview creation through `open: false`.

Upstream commit `32af2f002` (`fix(preview): stabilize PiP viewport identity`) owns epoch-scoped runtime guest identity and keeps PiP, recording, renderer surfaces, and Electron tabs aligned on that identity.

Upstream commit `fe281c540` (`fix(desktop): throttle hidden preview rendering`) owns disabling `BrowserWindow` background throttling while the shared recording/PiP frame-capture lifecycle has active consumers, then restoring throttling after its final consumer stops. Upstream commit `3a02c9cf1` (`feat(desktop): mute a browser tab`) owns tab mute and audibility state across `packages/contracts/src/ipc.ts`, `apps/desktop/src/preload.ts`, and `apps/desktop/src/preview/Manager.ts`.

Upstream commit `ef7014d851` (`fix(preview): restore recording and macOS rendering after Electron 43`) owns the renderer `getDisplayMedia()` and `MediaRecorder` recording path, the main-process display-media grant that binds each request to its exact guest, serialized grant handoff for concurrent starts, and keeping inactive macOS guests paintable. The branch composes its recording deadlines, cleanup bounds, retryable finalization, and artifact idempotency with that path; it does not retain Electron's removed `getMediaSourceId()` capture route. Recording source warm-up uses the same serialized native-capture queue as snapshots, annotations, and picture-in-picture frames, so a warm-up that outlives its bounded caller cannot overlap later native captures and those callers fail fast until the exact queue tail settles. Upstream commit `134d51096e` (`feat(desktop): browser profiles for the preview browser`) owns preview profile persistence, profile-specific Electron sessions, and selecting a profile when a tab is created. The branch carries profile identity through its automation lifecycle without adding another profile model.

Upstream commit `9e37f0c291` (`fix(preview): transfer recordings to the agent environment`) owns sending the encoded recording through the environment's attachment-upload path. `apps/web/src/browser/browserRecording.ts` extends the branch's retryable finalization through that transfer, while `apps/web/src/browser/browserRecordingUpload.ts` uses the host deadline that already reserves response grace. The branch keeps the existing attachment transport and desktop artifact model.

Upstream commit `061543e9e5` (`fix(mcp): keep preview snapshots usable by the agent and let it save them`) owns bounded snapshot text, the `includeImage` and `save` options, and object-wrapped `preview_evaluate` results. `apps/server/src/mcp/McpHttpServer.ts` preserves those options when screenshots are nullable: unavailable capture returns semantic metadata with `screenshot: null`, no image, and no saved path even with `save: true`. `apps/server/src/mcp/toolkits/preview/handlers.ts` keeps output selection and saving on the MCP side and carries the caller's evaluation timeout to the broker.

Upstream commit `39449e53e3` (`feat(desktop): import browser cookies into a profile`) owns browser discovery and importing cookies into the Electron session selected by a preview profile. `apps/web/src/components/preview/PreviewAutomationHosts.tsx` uses `previewAutomationNewTabDefaults` from `previewAutomationOpenReadiness.ts` to send the configured `profileId` with every automation-created tab. The selected profile therefore reaches the existing renderer and desktop session-partition path, so a newly created automation replacement tab sees cookies imported into that profile. The branch does not add a second import or session-partition model.

Upstream commit `949feb61` (`feat(web): configurable browser defaults`) owns the persisted viewport, zoom, appearance, and automatic floating-preview defaults, plus applying those defaults when a browser tab is created. Upstream commit `cd096b9ad` (`feat(server): users can withhold browser access from agents`) owns whether preview tools and instructions are exposed to a provider session. The branch composes with those settings; it does not maintain another browser-default or access-control layer.

Upstream commit `39abb9d1d6` (`fix(connect): refresh authorization without disconnecting`) owns prepare-before-release connection replacement in `packages/client-runtime/src/connection/supervisor.ts` before a DPoP credential expires. `apps/server/src/mcp/PreviewAutomationBroker.ts` keeps explicit preview-host assignment keyed by stable `hostId`, independently of the replaced renderer connection id, and retains the provider session's selected tab when that host reconnects. The branch does not force a disconnect to refresh routing state.

Upstream commits `7235701de0` (`fix(server): release preview hosts after unanswered requests`) and `5378f87f99` (`fix(preview): recover host registration after request timeouts`) own eviction of unanswered preview hosts and normal completion of their RPC streams so responsive renderers can re-register. The branch preserves an explicit stable-host assignment and its selected tab across that eviction. Calls remain unavailable while that host is absent, even when another host is healthy; re-registration restores the same tab without replaying the timed-out action or accepting a late response from the retired connection. The branch also separates the caller's deadline from eviction: `PreviewAutomationBroker.awaitResponse` fails the caller with `PreviewAutomationTimeoutError` at the request deadline but keeps the connection registered for `PREVIEW_AUTOMATION_EVICTION_GRACE_MS` (3 seconds), which comfortably covers the renderer's 250 ms response grace plus transit and a busy renderer. Any answer inside that window, including the renderer's typed timeout, keeps the host; the answer itself is discarded, never replayed, and never becomes the session's current tab. Only silence through the grace completes the stream and evicts the host.

Upstream commit `eb77683e55` (`fix(server): prevent duplicate desktop clients after restart`) owns atomically replacing stale `desktop-bootstrap` auth sessions. That replacement changes the authenticated renderer connection, not the physical preview-host identity. `apps/server/src/mcp/PreviewAutomationBroker.ts` already rebinds an explicit assignment when the same stable `hostId` reconnects and discards the superseded broker queue, so the branch does not add another auth-session lifecycle or special replacement path.

Upstream commit `12e8997e58` (`fix(web): keep agent browser preview visible`) owns automatically showing the floating preview after agent browser operations, except when an explicit background open suppresses presentation for that runtime tab, and carries browser-surface `zIndex` into the retained guest renderer so browser content stays above overlapping sheets. The branch composes that policy with its request deadlines, epoch-scoped runtime identity, stable narrow render-state subscriptions, and one-shot background snapshot presentation. It revalidates the runtime guest and remaining budget before the upstream auto-show mutation, and preserves explicit `open: false` or `show: false` as authoritative.

Upstream commit `19c97ea56d` (`fix(web): unlock composer when preview capture fails`) owns exact annotation-pick session settlement, atomic replacement of overlapping picks, and a five-second bound around annotation screenshot capture. The branch keeps its serialized native `capturePage()` queue around that bound so concurrent native captures cannot overlap. If a caller times out while Electron's capture remains pending, later native captures for that guest fail fast until the exact pending capture settles; semantic automation and annotation submission remain available without repeatedly spending their deadlines behind the same native call. Upstream commit `db8d60f486` (`fix(web): render transparent previews on white`) owns the white retained-webview background. Upstream commit `098bf53297` (`fix(web): preserve explicit preview navigation URLs`) owns preserving explicit localhost URLs and remapping only discovered environment-port targets; remote-environment automation therefore uses `environment-port` when it wants environment-relative routing.

Upstream commit `6319a97148` (`fix(desktop): preview CDP sessions no longer hard-crash the app`) owns pinning Electron's `Debugger` wrapper for the full CDP session and detaching through that pinned wrapper after the guest is destroyed. `apps/desktop/src/preview/Manager.ts` composes that pinned wrapper with the branch's deadline-triggered reset, exact-session teardown, and stale-session retry rules; the branch does not maintain a separate debugger-lifetime safeguard. Upstream commit `42bdea1c9c` (`fix(web): stabilize right panel transitions`) owns suppressing right-panel width transitions during resize and maximize changes. The branch's visibility and viewport readiness logic observes the resulting committed geometry without adding another transition policy.

Upstream commit `de1b798c6e` (`fix(preview): bound automation waits and screenshot captures`) owns transient native screenshot retries and an initial bound on host readiness. The branch retains its end-to-end remaining-budget propagation and semantic-only snapshot fallback. Its request-consumer and overlay-readiness helpers own deadline enforcement without a separate host-budget policy. Manual screenshot retries use the branch's serialized native-capture queue and stop immediately when that exact guest is retired, replaced, or blocked by an unsettled timed-out capture.

Upstream commit `8bbe2bf660` (`feat(web): float device streams over chat`) owns the floating player source union for browser tabs and device streams. The branch uses the browser-specific selector and source constructor in `HostedBrowserWebview.tsx`, `PreviewAutomationHosts.tsx`, and `previewAutomationPresentation.ts`. Its visibility checks, explicit background suppression, and selection recovery therefore continue to target browser tabs without treating an unrelated device stream as that browser's presentation.

Upstream commit `e816064945` (`fix(desktop): keep preview keystrokes out of the composer`) owns keyboard target resolution and native Windows guest input routing. The branch passes its control-epoch check through the bounded control-session callback to that keyboard path, alongside the operation deadline and exact-session reset. Keyboard focus timeout errors carry the branch-required operation metadata, and a timed-out operation still releases control so later input or evaluation can recover.

Upstream commit `6c69534a58` (`fix(preview): render website favicons for browser tool activity`) owns website tool icons, their response schemas, and capturing the operation's tab before a concurrent request changes the current target. The branch preserves that presentation metadata while carrying caller timeouts for input and evaluation operations. Optional favicon status lookup consumes only the original operation's remaining deadline, capped at 500 milliseconds, and is skipped when no time remains. An unavailable or timed-out metadata lookup preserves the completed operation result. The broker and handler share the same default operation timeout so omitted caller timeouts have the same bound.

Upstream commit `55c24273a0` (`fix(desktop): align preview recording cursors and show input feedback`) owns recording input decorations and the renderer compositor. The branch includes compositor initialization in the recording startup deadline and aborts pending initialization at expiry, releasing its input listener, frame callback, and canvas capture tracks before playback settles. Late initialization results cannot revive that compositor or disturb a newer recording. Desktop recording-controller notifications remain synchronous with state changes while renderer state listeners remain outside bounded finalization.

Upstream commit `894d33419d` (`fix(preview): use the visible browser for new agent sessions`) owns preferring the visible target tab's host when a provider session has no assignment. The branch retains explicit stable-host selection and reconnect recovery ahead of that implicit routing policy. Upstream commit `4f27a84631` (`fix(mcp): preview snapshots fit in the agent's tool output again`) owns compact saved-image responses and bounded snapshot text; the branch preserves semantic-only output when no screenshot exists.

Upstream's `frameCaptureSessionsRef` in `apps/desktop/src/preview/Manager.ts` continues to own sustained recording/PiP capture. Bounded automation operations temporarily disable host-window background throttling and share that registry's synchronization, so concurrent actions and recording/PiP shutdown cannot suspend each other. Native input and screenshots wait for the host to commit a frame after waking; screenshot preparation stays inside the screenshot budget so semantic snapshots and evaluation remain available when rendering cannot resume. The last operation restores throttling unless a sustained capture still needs it. This does not show or focus a window, focus a guest, or start another capture loop. The renderer's one-shot snapshot staging remains necessary to expose an inactive guest's pixels without changing human selection.

Expected behavior:

- MCP native caller metadata separates host and current-tab selection within an inherited credential. It is a bounded namespace, never a T3 thread selector: every tab stays under the credential-owned main conversation, with creator and host attribution. New contexts open their own tabs; human selection and sibling defaults cannot retarget them. Explicit `tabId` remains the deliberate sharing mechanism. Providers that omit native caller metadata retain one shared default context per credential. This path has no Magi or projected-subagent dependency.
- The WebSocket client delivers independent RPC requests concurrently while retaining per-request ordering and ACK backpressure. A paused subscription cannot block preview requests, responses, stream completion, or reconnect registration behind its receive queue. Connection failure interrupts pending delivery; timed-out browser actions are never replayed.
- Every Electron automation operation has a bounded control-session lifetime. The desktop manager reserves response grace inside the requested timeout without making the execution budget shrink when the caller increases a short timeout, always finalizes controller and action-timeline state, and detaches a timed-out debugger session while still holding an acquired control permit when a CDP command may be pending. Finalization commits the controller reset before responding but delivers that state notification separately under manager scope, so a stalled listener cannot withhold the bounded response. Timeout errors retain the failed operation or capture stage, so caller-visible diagnostics and action-timeline entries identify the work that stalled. Session removal and debugger teardown are atomic with respect to new session acquisition and bound to the exact acquired session, so late interruption or snapshot cleanup cannot detach a healthy replacement. Operations already queued on the retired semaphore detect that stale session and retry against its replacement. A request that times out while queued behind another action does not detach that action's shared debugger session.
- Click, type, press, scroll, evaluate, and wait operations carry their caller-supplied timeout through the MCP broker, clamp it to the remaining renderer host budget after readiness, and enter the desktop control-session boundary with that remaining value. Color-scheme changes and recording startup likewise receive the remaining deadline after overlay readiness; bounded and unbounded appearance mutations serialize per tab so live CDP state and persisted tab state cannot diverge, a timed-out color-scheme command does not persist a late preference, and timed-out recording startup observes cleanup only inside its reserved response grace while allowing an already-started cleanup to finish under manager scope. Timed appearance persistence re-reads current tab state after CDP settles and retries against the current guest if replacement rejects the stale guest's command. Recording stop bounds desktop capture shutdown, MediaRecorder settlement, blob conversion, and artifact persistence to the remaining deadline, and the waits it hands to desktop IPC are additionally clamped to `DESKTOP_PREVIEW_OPERATION_TIMEOUT_MAX_MS` because the MCP stop budget (`PREVIEW_RECORDING_STOP_TIMEOUT_MS`, 120 seconds) exceeds what those IPC payloads accept; desktop recording-stop cleanup also runs under manager scope so an uninterruptible capture finalizer cannot withhold the timeout response. Renderer and desktop-originated deadline failures retain captured chunks and the recording slot so finalization can be retried instead of silently losing the artifact. An in-flight artifact-save promise is shared with that retry, and every retry reuses a validated desktop artifact idempotency key, preventing duplicate files whether the renderer deadline wins before desktop IPC settles or the desktop reports a timeout after writing. Operations without a caller timeout use the remaining bounded request budget rather than restarting the desktop default after renderer readiness work.
- `stopBrowserRecordingForUpload` in `apps/web/src/browser/browserRecording.ts` retains the saved blob, artifact, and recording slot until a transfer result reaches a caller within its deadline. A failed upload can be retried without saving the file again. A retry joins an unsettled upload; if that transfer rejects because its original request deadline expired, a caller with remaining budget starts or joins one fresh transfer using its own deadline. If an upload succeeds after its caller times out, the next stop request receives that same attachment result. Native media tracks and browser-surface activity are released before upload, so retaining retry state does not keep capture running. A local Stop, including tab disposal through `desktopTabLifetime.ts`, can release retained transfer state and return the saved desktop artifact. If the server accepts an upload whose response is lost, a retry can leave an unclaimed pending copy when best-effort removal fails or races the server commit. Pending copies become eligible for cleanup after 24 hours; startup and later upload issuance trigger sweeps, so that age is not a guaranteed deletion deadline. `PreviewAutomationHosts.tsx` supplies the remaining stop budget and the shared operation deadline; `browserRecordingUpload.ts` uses that deadline without reserving response grace again.
- Snapshot collection captures every screenshot with `webContents.capturePage` on the desktop's serialized native-capture queue: `stayHidden: true` for a background guest, normal visible-page capture for the foreground. CDP `Page.captureScreenshot` is not used. For an unselected tab, the renderer stages the still-mounted guest at effectively transparent opacity for two compositor frames, but only for the snapshot itself, and the desktop manager never focuses the guest or calls `Page.bringToFront`; either activation call can make Electron promote the native guest over the host window and keep the T3 interface covered after staging ends. The screenshot wait is clamped to the remaining control-session deadline with settlement grace reserved, so a tight caller deadline still returns semantic data instead of being preempted by the outer session timeout. Every returned PNG, including resized output, is validated and bounded. When no PNG exists the snapshot returns `screenshot: null` together with `screenshotUnavailable: { stage, message, hostRendering? }` from `packages/contracts/src/previewAutomation.ts`: `capture` when Electron rejected the native capture (carrying Electron's own message, for example `UnknownVizError`), `encode` when the native image was empty or resizing produced an invalid PNG, `interrupted` when the bounded wait expired while the native capture was still pending, `pending-capture` when the serialized queue refused the capture because an earlier interrupted capture had not settled, and `budget` when the operation deadline left no time to try. `captureAutomationPage` fails with `PreviewAutomationScreenshotError`, whose message carries the bounded native cause so its span exit in `desktop.trace.ndjson` says what Electron reported; `PreviewOperationError` messages stay free of cause text because their causes can carry page-derived CDP detail. If Electron's native capture outlives its timed-out caller, later captures fail fast with `pending-capture` while the same queue tail is pending and recover automatically once it settles. Re-registering a live guest restores capture with a new queue generation while preserving the pending native tail and its interruption gate; retired-generation captures remain invalid. The semantic page state, interactive elements, accessibility tree, diagnostics, and action timeline still return instead of failing the complete snapshot.
- The desktop manager keeps the display awake while one-shot automation is live. `apps/desktop/src/preview/Manager.ts` holds at most one Electron `powerSaveBlocker` of type `prevent-display-sleep`: it starts on the first automation request (status, any control-session action, recording start or stop), which is how every automation flow begins, and every later request refreshes an activity timestamp. A tab counts as an automation tab only after an automation request targets it, so a tab a human opened and drove never holds the block; the desktop does not receive the server's `automationOrigin`, and this definition needs no extra plumbing. The block is released after `AUTOMATION_DISPLAY_WAKE_INACTIVITY_MS` (five minutes) without automation traffic, when the last automation tab closes, or on manager shutdown, whichever comes first; start and release are idempotent and logged at debug level with their reason. `preview_status` reports `displaySleepBlocked` next to `hostRendering`. This is separate from upstream's recording/PiP frame-capture lifecycle and its background-throttling policy, which it does not touch.
- `apps/web/src/components/preview/previewHostRendering.ts` reports a hidden host window as paused immediately; otherwise it probes whether the host window is painting by racing one `requestAnimationFrame` against a 500 ms bound; there is no continuous timer, and the losing side is cancelled. `preview_status` reports the result as `hostRendering: "active" | "paused"` only when the request budget leaves at least twice the probe, so the 500 ms favicon status lookup behind every action never pays for it, and `preview_snapshot` attaches it to `screenshotUnavailable` after the presentation lease is released. The MCP snapshot response states the stage, the host's message, and the liveness result in its text, so an agent can tell that the host renderer is not painting (display off, hidden window) rather than that capture is broken.
- Desktop preview guests following the system color scheme create their CDP debugger session lazily, with initialization included in the automation operation deadline. This prevents an offscreen Chromium guest from leaving `Runtime.enable` pending while holding the synchronized session lock, which previously made every later evaluation or snapshot against that tab time out even after it became presentable. `apps/web/src/browser/desktopTabLifetime.ts` passes the upstream browser appearance default through `DesktopPreviewCreateTabInputSchema` in `packages/contracts/src/ipc.ts`; `apps/desktop/src/preview/Manager.ts` normalizes that value. Its `reconcileRegisteredGuestState` reasserts current zoom and native mute state after attachment without opening a CDP session; a guest disappearing during the best-effort mute reassert does not fail registration. Only a non-system color-scheme override starts the separately bounded `restoreControlSession` recovery path after webview registration, while tabs following the system scheme stay detached until the next automation operation. Detached DevTools also restores a non-system override through that bounded path.
- Building on upstream's retained hidden guest, automation background snapshot presentation is reference-counted independently from the normal surface lease and composes with upstream's fitted-source content and corner-radius presentation. `PreviewAutomationHosts.tsx` passes the epoch-scoped runtime tab id into `previewAutomationPresentation.ts`; every surface lookup, staging marker, readiness check, diagnostic read, lease, and desktop capture targets that exact runtime guest, while selection and errors retain the stable server tab id. The presentation helper API has no state-derived or server-id compatibility fallback. Only a one-shot automation snapshot acquires this lease; upstream recording and picture-in-picture continue to use their shared frame-capture lifecycle, while navigation, color-scheme changes, evaluation, waits, and input operations do not acquire an automation presentation lease. Staging always restores the offscreen position and does not change the human-selected surface. The caller's wait, including compositor-frame staging and desktop IPC, is bounded by the operation's remaining response budget and reports a typed timeout if it stalls; once desktop capture starts, the lease itself remains held until that capture settles. If the server epoch replaces the runtime guest while staging is pending, the snapshot fails immediately with `PreviewAutomationTargetUnavailableError` instead of waiting on the stale staging marker. If the user foregrounds the target in either surface while staging is pending, that visible presentation satisfies readiness. A never-presented tab does not depend on another browser surface having supplied a panel rectangle: automation staging falls back to a deterministic rectangle fitted inside the renderer viewport.
- A background snapshot that times out before desktop capture begins releases its presentation lease even when Chromium has paused compositor-frame callbacks. Once desktop capture starts, a timed-out snapshot retains its presentation lease until that capture settles, so response timeouts cannot tear down compositor staging beneath an in-flight capture. The desktop snapshot receives the operation's remaining timeout and bounds its control session accordingly.
- The shared preview contract treats snapshot screenshots as nullable. MCP snapshot responses preserve structured semantic content and explicitly report `screenshot: null` when capture is unavailable. `includeImage: false` suppresses image content without changing page metadata; `save: true` writes a file and returns `screenshotPath` only when a PNG exists. Tool descriptions promise a PNG only when capture is available. In `packages/contracts/src/ipc.ts`, the branch's desktop snapshot schema and upstream's create-tab defaults coexist: snapshot calls default an omitted `background` flag to `false`, while tab creation carries viewport, zoom, and color-scheme defaults through the preload and desktop manager.
- The renderer automation consumer reserves response grace before the broker deadline and converts a stalled host operation into a typed `PreviewAutomationTimeoutError` instead of leaving the broker to surface a generic execution failure. Short caller-supplied timeouts retain their full execution budget, and the transition into grace reservation remains monotonic as requested timeouts increase. Requests that ask to open the inline preview use the request's remaining bounded visibility budget rather than a fixed two-second ceiling. Best-effort presentation settling uses a non-throwing remaining-budget read and clamps its 500-millisecond ceiling to that budget. Overlay status calls are themselves bounded by the remaining deadline and revalidate runtime guest identity after awaiting the desktop bridge, while overlay, navigation, and visibility polling clamp each sleep to the remaining deadline. Stable-presentation dwell also contracts to fit short deadlines instead of requiring an impossible fixed 100 milliseconds. Reused empty or failed tabs acknowledge without waiting for a browser surface those states intentionally hide. Visibility timeouts separately report the inline preview's selected tab, the right panel's active surface and open state, the active presentation kind, whether the requested browser surface was registered, and whether it had a presentation rectangle.
- `PreviewAutomationHosts.tsx` resolves `browserDefaults.ts` once at the start of each automation-open request, before taking the session snapshot that pins a reused runtime guest. That single settings snapshot supplies the new-tab viewport, selected profile, and automatic floating-preview preference, so creation and presentation cannot observe different settings during one request, while cold settings hydration cannot mix a pre-await session snapshot with a post-await server epoch. `previewAutomationNewTabDefaults` carries both `viewport` and `profileId` into `previewEnvironment.open`; every fresh automation tab therefore uses the profile-specific Electron partition that receives imported cookies. Explicit `open` or its deprecated `show` alias remains authoritative; when both are omitted, `autoShowFloatingPreview` decides presentation. The resulting `shouldPresentPreview` value is passed unchanged to `previewAutomationOpenReadiness.ts`, so a reused rendered tab left in the background does not wait for visibility while an explicitly shown tab does. After settings and session synchronization, the host rechecks its remaining deadline immediately before tab creation and every later irreversible open-side mutation, so an already expired request cannot create, resize, reveal, or navigate a preview. A newly created tab applies its server snapshot and assigned tab id, uses the configured viewport or the branch's deterministic 1280×800 fallback when the snapshot remains `fill`, initiates any requested selection, and acknowledges server-side creation without depending on cold React panel rendering, Electron overlay registration, or page readiness. Its initial URL continues loading exactly once in that same tab; later wait, snapshot, or interaction operations own attachment and page readiness. Reopening an existing shown tab selects both the preview-state tab and its matching inline mini-player surface, then waits for stable presentation. The visibility wait reasserts that selection across same-server route hydration or session reconciliation only when neither the right panel nor the mini-player already selects the tab, so a panel that is still becoming visible keeps its browser-surface lease. A server-epoch change aborts the pending open with `PreviewAutomationTargetUnavailableError`; the old request never adopts the replacement runtime guest.
- Before a non-open automation operation drives its ready target, upstream's automatic-presentation policy may reveal the runtime tab when the setting is enabled. An explicit background open records suppression for that runtime tab, while a later explicit shown open clears it. Suppression is keyed by scoped thread and epoch-specific runtime tab, pruned against authoritative sessions after reconciliation, and removed after a successful automation close. The branch rechecks both epoch-scoped identity and the remaining deadline before applying automatic presentation, so a late operation cannot reveal a replacement guest or mutate presentation after its response budget expires.
- `preview_close` connects the MCP automation lifecycle to the existing authoritative preview-session close and Electron tab disposal paths. It closes an explicit tab or the provider session's assigned tab, removes visible and background presentation state, destroys the local runtime, returns `tabId: null` so the broker releases its assignment, and remains idempotent when cleanup is retried after either side already closed. `$test-t3-app` retains every collaborative preview tab id it creates and closes those owned tabs during final teardown before stopping the test environment. This bounds retained Electron guests and reduces exposure to the crash-prone hidden screenshot bridge; it does not couple close behavior to that bridge implementation or claim to fix the underlying Electron crash.
- Retained browser guests subscribe only to render state for their own epoch-scoped runtime tab, plus their thread's active panel and mini-player selection. Presentation or background-capture updates for another tab do not rerender every mounted `HostedBrowserWebview`; selection changes override a stale surface-visible flag so background staging remains nearly transparent and exposes its readiness marker, staging derives its viewport-fitted rectangle from the target tab's own stable rectangle, and a tab foregrounded while its capture lease remains held keeps the real panel or mini-player rectangle instead of adopting that staging rectangle. Only the active guest is exposed through the host accessibility tree; a nearly transparent background-capture guest stays `aria-hidden` without affecting CDP accessibility-tree collection against the guest target.
- The stable retained-surface selector also carries upstream's presentation `zIndex` into each `HostedBrowserWebview`. Visible guests follow the owning panel or sheet stacking order, while the branch's background-capture surface keeps its fixed isolated stacking value and remains non-interactive and accessibility-hidden.
- Rendered viewport readiness revalidates the epoch-scoped runtime guest after each awaited guest measurement and clamps every polling sleep to the remaining resize deadline, preserving typed target-replacement and viewport-timeout failures for short budgets. The serialized viewport mutation also rechecks that deadline after acquiring its mutation queue, before sending the server resize.
- Each Electron profile persists one stable preview automation `hostId` and registers it with the renderer machine label, platform, per-environment connection id, and supported operations. Physical host label and platform detection run in Electron's main process and cross the existing synchronous IPC boundary; the sandboxed preload stays free of Node built-in imports so source-built and packaged desktop bridges initialize consistently. `preview_list_hosts` returns only hosts connected to the caller's environment, and `preview_select_host` binds an agent's unassigned preview context without activating or changing either desktop window. A live assignment cannot be silently moved to another host; an unavailable explicit host fails closed instead of falling back. Implicit first-use routing prefers the visible target tab owner, then another target tab owner, then focus ordering among hosts supporting the operation when no host was explicitly selected. Explicit assignments survive transport replacement by stable host identity and retain the agent's tab selection, while a disconnected selected host stays unavailable until that renderer reconnects or another agent selects a host with its own unassigned context.

Current limitations:

- Electron guests start with `transparent=false`, supplying an opaque system-scheme canvas before lazy CDP initialization. Recording timeout cleanup targets its captured native generation under the lifecycle lock, display-wake blocker acquisition is atomic, and validated responses to sibling requests keep the exact responsive host connection registered without accepting a late tab result.

- The Windows Electron 44.4.2 dev-shell reproduction distinguishes a paused host compositor from page or backend failure: hiding the owned window caused native capture to return `UnknownVizError` and CDP clicks to acknowledge success without dispatching page input. Scoped host unthrottling plus a committed host frame corrects that state without activating the window. Physical display sleep and GPU/device suspension have not been revalidated; if no frame arrives, input fails within its operation deadline and snapshots retain their semantic fallback. A previously interrupted native capture still blocks later native captures until its exact promise settles. Probe host liveness without attaching a debugger to the host window, since that can change its painting behavior.
- The isolated Windows Electron pass covers background snapshots and browser control. Full Electron recording transfer was not rerun for the caller-context and transport changes.

Primary files:

- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/ipc/channels.ts`
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts`
- `apps/desktop/src/ipc/methods/window.ts`
- `apps/desktop/src/ipc/methods/preview.ts`
- `apps/desktop/src/preload.ts`
- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/PreviewAutomationBroker.ts`
- `apps/server/src/mcp/toolkits/preview/tools.ts`
- `apps/server/src/mcp/toolkits/preview/handlers.ts`
- `apps/web/src/browser/HostedBrowserWebview.tsx`
- `apps/web/src/browser/browserRecording.ts`
- `apps/web/src/browser/browserRecordingUpload.ts`
- `apps/web/src/browser/recordingCompositor.ts`
- `apps/web/src/browser/browserDefaults.ts`
- `apps/web/src/browser/browserSurfaceStore.ts`
- `apps/web/src/browser/desktopTabLifetime.ts`
- `apps/web/src/browser/hostedBrowserWebviewStyle.ts`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/closePreviewAutomationTab.ts`
- `apps/web/src/components/preview/previewAutomationClientId.ts`
- `apps/web/src/components/preview/previewAutomationPresentation.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.ts`
- `apps/web/src/components/preview/previewAutomationOverlayReadiness.ts`
- `apps/web/src/components/preview/previewAutomationErrors.ts`
- `apps/web/src/components/preview/previewAutomationRequestConsumer.ts`
- `apps/web/src/components/preview/previewHostRendering.ts`
- `packages/contracts/src/previewAutomation.ts`
- `packages/contracts/src/ipc.ts`
- `.agents/skills/test-t3-app/SKILL.md`

Preview verification includes capture recovery, caller isolation, concurrent RPC delivery, recording finalization, and upload retries. The branch record distinguishes current-base checks from historical integrated runtime evidence; use its current test selection rather than a copied command here.

The integrated preview middleware decodes the request once and supplies both Magi caller metadata and the independent preview caller namespace. Right-panel browser creator labels use the Version Control branch's canonical browser runtime resolver, preserving its audio and mute behavior.

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

Expected behavior:

- `dev:desktop` derives `T3CODE_DESKTOP_USER_DATA_DIR=<resolved base dir>/userdata/electron` whenever the runner has an explicit base directory. Desktop configuration resolves that override to an absolute path, and app identity uses it before legacy migration or the normal Electron user-data default. This keeps an isolated worktree dev desktop from reusing an installed or earlier development profile whose incompatible IndexedDB schema can prevent the renderer from starting. Packaged/default startup remains unchanged when no override is supplied, and packaged macOS startup preserves the bundle or user-customized dock icon while unpackaged development still assigns the runtime PNG icon.

Primary files:

- `apps/desktop/src/app/DesktopAppIdentity.ts`
- `apps/desktop/src/app/DesktopConfig.ts`
- `apps/desktop/src/app/DesktopEnvironment.ts`
- `scripts/dev-runner.ts`

Focused regression coverage, including the desktop auth fixture that constructs the extended desktop environment:

```sh
vp test run scripts/dev-runner.test.ts apps/desktop/src/app/DesktopAppIdentity.test.ts apps/desktop/src/app/DesktopEnvironment.test.ts apps/desktop/src/app/DesktopClerk.test.ts
```

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
- Representative mobile verification races the Windows Android and macOS iOS hosts. Desktop verification similarly races the two host-local renderers. Request-scoped cancellation safely releases a losing near-simultaneous acquisition. Queue age never triggers cancellation, replacement, reprioritization, or coordinated handoff.
- The host-local capacities permit two Android and two iOS verifications simultaneously across the fleet. Desktop permits one Windows and one macOS interaction block simultaneously.
- `node "<main-worktree>/scripts/mobile-native-client.ts" ensure android <adb-serial> --worktree "<assigned-worktree>"` is the Windows operator entrypoint. It prepares hoisted dependencies before fingerprinting, reuses an already prepared layout, and delegates builds to `scripts/worktree-android-build.ts`. The wrapper orders the normal install and no-install Expo clean prebuild before `scripts/worktree-android-dependencies.ts`, then patches the generated app Gradle file to use Android Gradle's `buildStagingDirectory` at `<worktree-drive>:\.t3code-android-cxx\<worktree-hash>`. That short path prevents app-level CMake object paths from crossing Windows' 260-character boundary; a canonical-worktree ownership marker keeps every staging cache isolated. The wrapper uses the target checkout's Expo and React Native autolinking results to discover native source directories and validates their paths. It resolves Expo from `apps/mobile` before calling it directly, so Vite+ cannot invalidate the prepared layout before Gradle. On the exact Ninja dirty-manifest failure it waits for the failed build to exit, removes only generated `.cxx`, CMake intermediates, and the contents of that worktree's marked staging directory, revalidates, and retries once. The retry keeps the canonical worktree path rather than substituting a drive whose removal can corrupt an active Gradle build. `scripts/worktree-android-dependencies.ts` removes stale package-level dependency links only inside the selected Windows worktree and performs the frozen worktree-local hoisted install. The ordinary pnpm content store remains tool-managed and no virtual store or native staging directory is shared between worktrees. Windows Android verification keeps its disposable backend state and seeded project outside Metro's watched worktree because atomic cache replacement can otherwise terminate Metro's fallback file watcher on a transient path.
- `scripts/worktree-android-avd.ts` lazily provisions one persistent API 36 AVD per canonical Windows worktree. It invokes Windows batch SDK tools through an explicit command shell, refuses to install a missing system image without authorization, records ownership, disables Quick Boot snapshot load/save, and supports verified removal before the owning Git worktree is deleted.
- macOS creates a deterministic temporary linked worktree for Windows-originated source, including uncommitted changes. Concurrent transfers use request-specific refs and bundle files, fetch with `--no-write-fetch-head`, and verify the exact expected `HEAD` and dirty-state manifest before requesting runtime capacity. The native-client helper removes its scoped temporary DerivedData after build/install.
- Each iOS verification selects a distinct simulator through the Device panel and retains its exact AgentDevice target arguments. The native-client helper owns native compatibility and build/install.
- Desktop and mobile host races materialize exact source state on both candidates before acquisition. The first eligible host to acquire wins; the losing request exits before runtime work starts. A Windows-originated Mac desktop candidate selects the connected Mac renderer by stable preview host id without changing focus, exposes Vite on the Mac Tailnet address while keeping its backend on Mac loopback, and consumes the pairing token only after the routed page loads.

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

## Repeated Steering And Reliable Stop

**Worktree branch:** `fix/repeated-steering-and-stop`

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- An active-thread send allocates its user-message id before entering local dispatch, and the dispatch API requires that exact id. For steering the current running turn, the server projection carrying that id is authoritative acknowledgement even when the frozen dispatch snapshot has stale or absent session status. A later message from another client does not invalidate it, and an unrelated projected user message cannot acknowledge it. Sends that advance a turn retain the turn/session-status transition fallback, while the connecting phase ignores those transitions unless the exact message has already projected. Multi-model fanout and implementing a plan in a separate new thread use a distinct busy-state variant that preserves worktree preparation and submission intent. This state is cleared explicitly rather than by source-thread projections or turn/session transitions.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption first performs upstream's bounded, best-effort interruption of every live child provider turn. It then reads the root thread's history mode: legacy threads use `thread/read` with `includeTurns: true`; paginated threads use `thread/turns/list` in ascending provider order with `itemsView: notLoaded`. One two-second deadline covers the history-mode read and all pages. Selection uses the most recently started `inProgress` turn. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup, including an unexpected defect, is logged and may fall back to the session turn read after that lookup finishes; a successful lookup with no active turn returns without reviving a stale cached id. Root interrupt RPCs have a fifteen-second deadline that reaches the existing lifecycle-aware failure recovery. The runtime suppresses a repeated submitted root turn id until a different turn starts, and clears the guard on request failure so Stop can retry.

Conflict guidance:

- `apps/web/src/components/ChatView.localDispatch.ts` owns the branch's dispatch snapshot, exact-message acknowledgement, and React state hook. Keep message dispatch and new-thread busy state as distinct variants. Preserve upstream's `submissionIntent`, reconnect guard, worktree-preparation state, latest-user-message timing, and turn/session fallback around the exact-id correlation. The hook's `allocateMessageDispatch` allocates the expected `MessageId`, begins dispatch, and returns that id to the caller. Multi-model fanout and the separate plan-implementation flow use `beginNewThreadBusyState`. Fanout passes `preparingWorktree: true` and the resolved submission intent, then explicitly resets the state when its background requests own their threads or dispatch fails. Allocate a source-thread message id only on the non-fanout path; each fanout target allocates its own id.
- Do not restore upstream's inline dispatch hook or latest-user-message heuristic in `apps/web/src/components/ChatView.logic.ts` or `apps/web/src/components/ChatView.tsx`. In `ChatView.tsx`, keep the draft-hero dock transition and early in-flight guard, call `allocateMessageDispatch` for each active-thread send, pass the resolved submission intent from the composer send, and send the returned id to the server. The separate context-window compaction callback also uses that allocator while preserving the composer's draft and attachments. Plan follow-up remains foreground by default.
- `apps/web/src/components/ChatView.localDispatch.test.ts` covers the message/new-thread state variants, fanout preparation and background-intent preservation, and immunity to source-thread acknowledgement. `apps/web/src/components/ChatView.logic.test.ts` imports the dispatch helpers from `ChatView.localDispatch.ts` and covers exact projection, reconnect, fallback, and consecutive-steer behavior.
- Upstream's `apps/web/src/components/QueuedMessageSender.tsx` sends queued messages even when their chat view is closed. Its dispatch correlation uses `ChatView.localDispatch.ts`, and `apps/web/src/queuedMessageStore.ts` stores that snapshot type. In `apps/web/src/components/chat/sendQueuedMessage.ts`, allocate the outbound message id before `markDispatching`, place it in the snapshot, and send that same id to the server. `QueuedMessageSender.tsx` checks all projected messages while running or connecting and correlates turn-start failures with the snapshot's expected id. An idle queue waits for turn progress, a session-status transition, or an exact-message settlement before another send, because message projection can precede provider pickup. A ready-session timestamp refresh alone never releases it. The shared latestDispatchSettlementId lookup recognizes turn-start failures and context-compaction activities only when their requestId matches the outbound message, so a queued /compact can finish without a new turn even if the client never observes connecting. The chat compaction indicator uses the same lookup. Queue item ids identify local entries, not projected user messages. Preserve upstream's tool-boundary scheduling, failed-send recovery, and Stop cancellation of preparing uploads. `apps/web/src/components/QueuedMessageSender.test.tsx` covers consecutive queued steers, idle-phase provider-pickup holds across timestamp refreshes, matching and unrelated turn-start failures and compaction completions, blocking unrelated-client projections, and acknowledgement when a newer unrelated message follows the exact projected message; `apps/web/src/queuedMessageStore.test.ts` covers dispatch rollback and Stop boundaries.
- Keep active-turn selection, ordering, the overall lookup deadline, and fallback in `apps/server/src/provider/Layers/CodexInterruptResolution.ts`, covered by its colocated test. Inject the `readCodexThreadWithTurns` effect from `apps/server/src/provider/Layers/CodexSessionRuntime.ts`: it shares upstream's legacy/paginated reader with conversation history but preserves provider status and timestamps until each caller projects them. Keep history normalization after this shared read; normalized history lacks the metadata needed for interruption. Preserve page decoding and cursor-cycle rejection, and apply the interrupt timeout to the complete read rather than each page. The runtime must retain bounded live-child interruption before root resolution; `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` covers that fan-out.
- Upstream owns the platform-specific mock launchers and temporary-directory setup in `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`. Preserve its Windows `.cmd` and Unix `.sh` launchers for the shared `.mjs` peer and its platform-native temporary working directory so stop and child-fan-out regression coverage remains cross-platform.

Server regression coverage in `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts` and `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` retains live-root-turn selection across legacy reads and paginated boundaries, one deadline across metadata and all pages, malformed-page/cursor-cycle/failure/defect fallback, successful empty reads that suppress stale root interrupts, bounded interruption of live child turns before the root, primary history reads through the provider mock, repeated and late root interrupts, failed-request retry, and a typed timeout for an unanswered root RPC.

Use `hasServerAcknowledgedLocalDispatch` from `apps/web/src/components/ChatView.localDispatch.ts` for client dispatch correlation. Defer an explicit server receipt keyed by message id unless projected ids stop being authoritative.

## Archive Settings UX

**Worktree branch:** `feat/archive-settings-ux`

The settings Archive panel uses a dense layout so large archives remain scannable. The native mobile Archived Threads screen mirrors the same information hierarchy and behavior with mobile-native project sections, swipe actions, long-press menus, and header controls.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- In global Settings scope, the Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible, while active rows returned in those snapshots remain excluded from archive content and empty-state counts. Partial environment failures remain visible above successfully loaded project groups with their error and a keyboard- and screen-reader-accessible retry action. A total failure does not also render a misleading empty archive state, and retry reloads every configured environment. Web environment, project, and checkout Settings scopes narrow fetched environments and filter both archived project shells and threads before grouping, empty-state counts, search, and bulk actions.
- Web project headers show environment labels whenever multiple environments are configured and keep a sole remote environment labeled, while a sole primary environment remains implicit. Their `ProjectFavicon` receives the complete archived snapshot project record with environment identity through its `project` prop, so the saved title, icon override, favicon path, and workspace root stay together and configured emoji or Lucide icons and automatic fallback icons match current upstream project lists. Native project sections render the snapshot favicon or configured project icon and pair visible environment labels with the environment's machine-kind glyph. Native header controls can filter the archive to all environments or one configured environment. `apps/web/src/components/settings/ArchiveSettings.test.tsx` covers the web metadata handoff to `ProjectFavicon`.
- Native Settings uses the upstream `Connections`, `Interface`, `Projects & threads`, `Server settings`, and `App` section order in both local-only and T3 Connect-configured modes. The shared `SettingsIndexSections` exposes `Archived Threads` under `Projects & threads` in both modes. `Connections` shows `Environments` in both modes and adds `T3 Account` and `Notifications` when T3 Connect is configured. Upstream `apps/mobile/src/Stack.tsx` registers the customized Archive screen directly in the header-owning settings content stack and keeps the legacy `SettingsWaitlist` alias pointed at `SettingsAuth` in the outer auth stack.
- Web Settings search includes `Archived threads`; selecting that result opens the customized Archive panel and focuses its persistent archive search field, regardless of whether the archive is loading, empty, filtered, or populated.
- Native `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx` uses upstream `ScreenHeader`, `SettingsScreenContent`, a non-collapsable root, and `LegendList`. `ScreenHeader` and `SettingsScreenContent` supply the settings frame. The Archive screen mounts the non-collapsable root, list, pull-to-refresh control, and Android header refresh action. The customization retains inline archive search, environment filtering, all four Archived/Created sort choices in the shared header menu, and sortable project columns without remounting the list during search.
- Native archive scrolling shares upstream's `useNativeGesture` through swipe rows' `simultaneousWith` option. Preserve that coordination and `dragOffsetFromRight` when composing the cold-storage row state with the archive controls.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and rank partial matches by distinct matched-token count before the earliest token position. Phrase and all-token scores remain bounded within their relevance tiers so a long-title position penalty cannot demote a stronger match below a weaker tier. Search auto-opens matching project groups while active. Native incremental search updates the existing list without remounting it for every keystroke, preserving scroll position and transient row state.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Native project-section ordering follows the selected archive sort field and direction. Web falls back to creation time for invalid archive dates. Mobile omits invalid dates and sorts them after valid dates in both directions, preserving the cold-storage integration contract.
- Native row and bulk actions share collision-safe per-thread reservations and action-executor identity keys, reserve bulk targets before confirmation, expose busy state only after confirmation, disable overlapping swipe/menu controls while reserved, and distinguish rows skipped because the same thread action is already in progress from commands that actually fail. In `apps/mobile/src/features/home/useThreadListActions.ts`, reservation keys remain JSON tuples while lifecycle dismissal uses `scopedThreadKey` to match the identity registered by both live rows and `ArchivedThreadsScreen.tsx`. This keeps exit animations ahead of mutations without weakening action deduplication.
- Web row and project actions in `apps/web/src/components/settings/ArchiveSettings.tsx` dispatch the `threadEnvironment.unarchive` and `threadEnvironment.delete` commands directly, so the Archive panel owns archived-snapshot refresh timing without extending the shared `useThreadActions` interface. Row and project restores invalidate the affected thread's Archive Undo before dispatch using its scoped thread identity, leaving other action kinds and environments untouched. Cancelled project restores retain Undo. Successful row actions refresh the affected environment immediately. Project actions reserve collision-safe per-thread locks before confirmation, expose busy state only for threads owned by actions that have started after confirmation, disable overlapping controls while mutations run, give explicit feedback for rejected duplicates, and refresh the affected environment once after the bulk attempt instead of between concurrent mutations. Successful raw deletes use the same `discardComposerDraft` operation as live-thread deletion, releasing image and file/video uploads before clearing every draft reference without coupling Archive actions to the rest of the live-thread delete lifecycle.
- Web project and conversation titles use the shared `text-xs` size, while metadata uses `text-2xs`. Conversation rows show only the relative archived and created ages inline with the title by default. On web row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern. Native rows keep both age columns visible and expose the same actions through swipe gestures and the standard long-press context menu. The shared `ThreadSwipeable` owns its themed card-surface fallback while drawer and screen rows retain explicit surface overrides.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first. Web delete actions respect the shared `confirmThreadDelete` client setting, while native keeps its standard guarded delete flow.
- The server rejects restoring an archived thread that has since been deleted, so a stale or racing restore reports failure instead of success. Valid restores and same-command receipt replay remain unchanged.
- Archived-row context-menu action IDs and presentation metadata come from shared Archive settings logic. Unarchive uses the archive-restore icon, Delete uses the trash icon and destructive styling, and `separatorBefore` distinguishes permanent deletion from restoration in both the web fallback and Electron native menu.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete` on web and remain explicitly guarded on native; unarchive bulk actions remain guarded on both surfaces, and partial failures surface as not-fully-completed feedback instead of implying every archived thread failed.
- Web single and project delete confirmations use the shared themed dialog's destructive variant, while project unarchive confirmations keep the default variant.
- Shared archive search ranking, timestamps, sort state, and action locks live in `packages/client-runtime/src/state/archivedThreadList.ts`. Platform-specific grouping and project bulk-action concurrency remain in `apps/web/src/components/settings/ArchiveSettings.logic.ts` on web and `apps/mobile/src/features/archive/archivedThreadList.ts` on native so the dense Archive behavior stays covered without growing the React components. Web project groups retain the complete archived-snapshot project shell plus environment identity so the customized header can read shell metadata directly without a reduced field projection. Project groups expose and reuse collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, preserve the completed success/failure/skipped outcome counts, show incomplete-operation feedback, and surface the underlying exception messages instead of only a generic aggregate error. The Archive surfaces refresh the affected environment after bulk unarchive/delete attempts even when the action runner throws.
- The user guide documents Archive as a reversible thread-lifecycle action, covers the web, desktop, and mobile controls and safeguards, and explains that search scopes project bulk actions to visible matches. The guide and internal glossary distinguish settled threads, which remain live in the thread list's `Settled` section and return to the active list when un-settled or new work begins, from archived threads, which leave the thread list for Archive until restored or deleted. The glossary also distinguishes Archive from permanent deletion, and the documentation index links the guide.

Primary files:

- `apps/server/src/orchestration/decider.ts`
- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/ArchiveSettings.test.tsx`
- `apps/web/src/components/settings/ArchiveSettings.logic.ts`
- `apps/web/src/components/settings/ArchiveSettings.logic.test.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/lib/composerDraftUploads.test.ts`
- `apps/web/src/lib/composerDraftUploads.store.test.ts`
- `apps/web/src/components/settings/settingsLayout.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/home/thread-swipe-actions.tsx`
- `docs/user/archive.md`
- `docs/internals/glossary.md`
- `docs/README.md`

## Conversation Data Savings

**Worktree branch:** `feat/conversation-data-savings`

Archived conversations use cold storage instead of retaining full hot projections and diagnostics in `state.sqlite`.

Pre-cold-storage binaries cannot read histories already moved into `archive.sqlite`. Unarchive needed conversations with a cold-capable version before downgrading; a binary change alone does not restore them. Lifecycle recovery, retries, and startup compaction wait for server activation so a failed update trial cannot delete files outside the launcher's database rollback snapshot.

- `state.sqlite` keeps archived thread shells, pull-request relation rows needed to discover linked conversations, and command receipts required for retry idempotency. Conversation events, messages, activities, turns, checkpoints, plans, session/runtime rows, and content attachments are written as bounded gzip-compressed chunks in the separate `archive.sqlite` database, then removed from hot storage. Command receipts remain hot until permanent deletion so retrying an accepted archive command returns its original sequence. `projection_thread_pull_requests` remains hot with the shell, including its persisted PR and stack snapshots; archive does not rewrite those rows, and permanent deletion removes them. Pin state remains lightweight shell metadata and survives archive and unarchive.
- `apps/server/scripts/t3-sqlite-state.ts` is the supported isolated-database inspection path. It targets hot `state.sqlite` by default and accepts `--database archive` for cold manifest and chunk queries, with both paths derived from the shared server configuration. Archive and restore behavior should use application commands rather than direct archive-bundle writes.
- Content attachments are part of the archive bundle and return on unarchive. Attachment collection follows exact ids persisted in thread messages, while retry cleanup may reuse exact attachment chunk filenames already recorded in the cold bundle; normalized thread-name collisions cannot claim another thread's files. Provider diagnostic logs and terminal history logs are deliberately destructive on archive: they are deleted, never copied into the bundle, and never restored. Provider-log cleanup matches only the exact thread log and its numeric rotations so similarly prefixed thread ids are not affected.
- Cold restore preserves binary SQL values, rejects unsafe attachment entry names with a retryable failure, and atomically replaces attachment files before marking SQL rows restored. A malformed attachment leaves the cold bundle authoritative until repaired and retried. Restore pages chunk reads to bound memory, rejects unknown tables/chunk kinds, and intersects archived row columns with the current schema so older bundles remain recoverable after compatible migrations.
- Permanent thread deletion checks eligibility before writer quiescence under the storage tree lock. Obsolete jobs preserve live resources, remove only mismatched stale cold bundles before clearing their queue marker, and do nothing when no deletion marker remains. Permanent thread deletion removes the shell, event stream, command receipts, every thread-owned projection/runtime/checkpoint row, attachments, terminal history, provider logs and rotations, and any cold-archive manifest/chunks. Exact attachment ownership metadata remains available until external attachment and provider-log cleanup succeeds, after which the SQL and cold-chunk rows are removed; cross-thread plan references are cleared rather than leaving dangling ids, and the durable cleanup-queue entry is retained until filesystem cleanup and free-page reclamation succeed so interrupted deletes retry safely. Startup recovery also rediscovers soft-deleted shells that have not reached the cleanup queue, covering commits made while the lifecycle reactor was offline.
- Project removal in `apps/web/src/components/settings/ProjectSettingsPanel.tsx` applies the archived-history warning and command options from `apps/web/src/components/settings/ProjectSettingsPanel.logic.ts` independently to each selected project member. Members with known live threads use forced deletion; when a member has no live shell threads, it requests archived-thread deletion without force because archived shells are excluded from normal navigation state. The server removes archived cold bundles but still rejects any unseen live thread. Project removal emits the same per-thread deletion events for archived shells, so already-cold threads pass through the durable lifecycle worker and lose their hot shell, archive manifest, and compressed chunks before cleanup completes. `apps/web/src/components/settings/ProjectSettingsPanel.logic.test.ts` covers standalone and grouped warning text and the per-member thread partitioning that selects each member's command options; `apps/server/src/orchestration/decider.delete.test.ts` covers the archived-only live-thread precondition; and `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts` covers the forced-project decider, lifecycle reactor, and cold-storage boundary together.
- Archive/delete filesystem work runs through a durable background lifecycle queue. Thread creation is refused retryably while a soft-deleted shell or durable cleanup-queue entry remains, before any replacement event commits; the command id remains retryable after cleanup. WebSocket creation and first-prompt bootstrap wait for in-flight same-ID lifecycle work before dispatching creation, preserving draft retries without blocking the engine worker. A completed wait does not bypass the durable creation check when failed cleanup still has a marker. Unrelated bulk archives do not hold that creation wait; callers that require all lifecycle work to finish can still drain the whole queue. Archive and restore lifecycle work is serialized per project tree, with reference-counted idle-lock eviction after the final user or waiter. Archive eligibility and provider/terminal/log-writer shutdown run under that same tree lock, so a queued archive job that becomes stale after unarchive cannot stop the newly active session or delete its terminal history. Archive creation commits the complete compressed bundle, including its restore metadata, before the main-only destructive transaction deletes hot rows and marks the manifest `cleanup_pending`. This ordering avoids relying on atomic commits across attached databases when the hot database uses WAL. Destructive attachment/log cleanup must finish before the manifest becomes `cold`. Destructive archive transitions require terminal/log-writer shutdown before chunk creation and recheck the archived shell inside the hot-row deletion transaction; `archiveThread` normalizes typed quiesce failures to `ThreadColdStorageError` at the archive operation boundary. Provider shutdown also remains required while the projected session is `starting` or `running`; a missing provider binding is terminal for a settled or absent projected session, allowing legacy subagent shells that never owned a provider binding to move cold safely. Successful provider quiescence explicitly clears process-local background-liveness state, including the no-binding settled-shell path where no later `session.exited` event is guaranteed. The cold-storage boundary chunks child projections only after its caller-provided quiescence effect completes; pending-input coverage verifies that restored session and activity rows reflect stopped and resolved values while the lightweight hot shell retains a zero pending-input count. Failed lifecycle work requests one coalesced delayed rescan of the durable pending state instead of being dropped or introducing a permanent polling loop, enqueue interruptions release their deduplication reservation, and restart recovery preserves the same retry boundary. Filesystem failures other than a genuinely missing directory also keep retry state. Incomplete cleanup, including a `cleanup_pending` manifest whose archived shell has already been removed, and archived shells missing a manifest resume after restart without rebuilding an already durable bundle.
- For unarchive commands targeting an existing, undeleted archived shell, `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` restores `cold` or `cleanup_pending` bundles before domain dispatch and treats an existing `restored` manifest as an in-flight or post-commit reservation without replaying its stale chunks over live rows or attachments. Active, absent, or deleted targets reach the decider without claiming restore ownership. Domain rejections retain their rejected receipt and remain rejected on command-id retry; deleted archives stay cold for permanent cleanup without recreating attachment files. A transient restore failure re-archives any tree members restored before the failure and returns an error without writing a rejected command receipt, so the same command id can retry after storage recovers. A rejected or failed command re-archives the restored rows and files, while a successful command finalizes the cold bundle only when that request actually performed a restore; this prevents unrelated or already-hot unarchive commands from deleting archive data. The transaction and the in-memory restore-ownership handoff form one uninterruptible boundary, so cancellation cannot surface after SQL commits but before ownership transfers and roll back accepted data. Once SQL restoration commits, later publication or metrics failures cannot re-archive the restored data. Retrying an accepted unarchive receipt retries idempotent bundle finalization for that same thread. Unarchive events also queue lifecycle cleanup, and startup discovery includes restored manifests on active shells. That cleanup removes only the eligible thread's stale bundle before any provider or terminal shutdown, preserves process-owned restore reservations, and retries failures through the existing coalesced rescan. Finalization and archive-abort cleanup commit cold-row deletions before removing the main manifest, so a partial cleanup retains its discovery marker. A finalization failure does not change an already-committed unarchive result.
- Unarchive reserves still-hot archived rows with a `restored` manifest before releasing the archive-tree lock. This prevents queued lifecycle work from moving those rows cold between the restore check and the unarchive command commit; command failure archives the reserved rows, while success removes the reservation. Process-local restore ownership distinguishes those live reservations from `restored` manifests abandoned by a crashed process, which startup lifecycle discovery moves cold again while the shell remains archived. If storage cannot restore or reserve the archived conversation, the command is rejected before an active-shell event can commit.
- A `restored` manifest protects only the archive epoch that an unarchive command reserved. If post-commit bundle finalization fails and the user later archives the thread again, the newer shell timestamp lets lifecycle work replace the stale manifest and move the conversation cold.
- Standalone migration `055_ThreadStorageLifecycle` is represented on main by the published cold-storage migrations described under Published Database Compatibility. Main retains those IDs and does not run a second schema-creation migration.
- Pinning remains lightweight shell metadata: archiving a pinned thread keeps `pinned_at` in `projection_threads`, and unarchive restores the thread with its prior pinned state. The cold-storage boundary test covers this pin/archive contract.
- After the legacy queues drain, a retryable one-time `VACUUM` physically compacts `state.sqlite` and enables incremental auto-vacuum. The compaction remains pending while any archive or delete lifecycle work is still discoverable, including jobs waiting for retry. Later lifecycle operations reclaim bounded free-page batches from both `state.sqlite` and `archive.sqlite`, avoiding a full compaction on every archive.
- Normal provider, server, trace, and terminal logging behavior is unchanged. Space is reclaimed at the conversation lifecycle boundary instead of by weakening diagnostics for active work.
- Unsent composer drafts remain local when their thread is archived. Their pending server-side attachment uploads are transient rather than conversation data: `apps/web/src/hooks/useThreadActions.ts` releases image and file uploads after a successful local archive acknowledgement, while `apps/web/src/composerDraftArchiveObserver.tsx` releases them when an authoritative live shell stops listing the thread, covering archives performed by another client. Reopening an unarchived draft starts fresh uploads from the retained local attachment data.
- Production orchestration supplies the live `ThreadColdStorage` service. Isolated orchestration harnesses that do not exercise archive persistence supply `ThreadColdStorage.noOpLayer`; `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` uses that boundary while continuing to verify orphaned provider-session recovery.

Restore reservations retain their claimed root independently of SQL lookup. Finalization and rollback release only the captured claim on every exit, including failure before tree-lock acquisition, so a transient lookup failure cannot suppress lifecycle recovery for the rest of the process.

Primary files:

- `apps/server/src/orchestration/ThreadColdStorage.ts`
- `apps/server/src/orchestration/ThreadColdStorage.test.ts`
- `apps/server/src/orchestration/testUtils/orchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`
- `apps/server/src/persistence/Layers/Sqlite.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/scripts/migrate-dev-db.ts`
- `apps/server/scripts/migrate-dev-db.test.ts`
- `apps/server/scripts/t3-sqlite-state.ts`
- `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts`
- `apps/web/src/authoritativeThreadLifecycle.ts`
- `apps/web/src/authoritativeThreadLifecycle.test.ts`
- `apps/web/src/browser/usePreviewThreadLifecycleCleanup.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/routes/settings.archived.tsx`
- `apps/web/src/components/settings/ProjectSettingsPanel.tsx`
- `apps/web/src/components/settings/ProjectSettingsPanel.logic.ts`
- `apps/web/src/components/settings/ProjectSettingsPanel.logic.test.ts`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/CommandPalette.thread-project-items.tsx`
- `apps/web/src/components/CommandPalette.merged-seam.test.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/LegacySidebar.tsx`
- `apps/web/src/components/ThreadCommandSubtitle.tsx`
- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/hooks/useThreadActions.test.ts`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/lib/composerDraftUploads.test.ts`
- `apps/web/src/composerDraftArchiveObserver.tsx`
- `apps/web/src/composerDraftArchiveObserver.test.ts`
- `apps/web/src/connection/storage.ts`
- `apps/web/src/connection/storage.test.ts`
- `apps/web/src/state/shell.ts`
- `apps/web/src/contextMenuFallback.test.ts`
- `packages/client-runtime/src/rpc/client.ts`
- `packages/client-runtime/src/state/threadCommands.ts`
- `packages/client-runtime/src/state/threadCommands.test.ts`
- `packages/client-runtime/src/state/threadCommands.archive.test.ts`
- `packages/client-runtime/src/state/threadCache.ts`
- `packages/client-runtime/src/state/shell.ts`
- `packages/client-runtime/src/state/shell-sync.test.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `packages/client-runtime/src/rpc/testUtils/rpcSession.ts`
- `apps/mobile/src/persistence/mobile-database.ts`
- `apps/mobile/src/persistence/mobile-database.test.ts`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/archive/archivedThreadList.test.ts`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`

### Sidebar and shell consistency

Web and mobile archive visibility uses the upstream optimistic lifecycle wrapper in `packages/client-runtime/src/state/threadLifecycle.ts`. The branch's archive and unarchive commands in `packages/client-runtime/src/state/threadCommands.ts` project `archivedAt` onto the shared thread shell without changing the authoritative source snapshot. Accepted projections remain until the source snapshot reaches the acknowledgement sequence; rejected or interrupted requests remove only their own projection. Overlapping requests remain independent, and an older archive acknowledgement cannot hide a thread restored by a newer shell. Unarchive updates an existing shell only; a shell removed by archive reappears when authoritative synchronization restores it. `packages/client-runtime/src/state/threadCommands.test.ts` covers acknowledgement ordering, environment isolation, overlapping archives, interruption, and rollback of a queued unarchive.

`apps/web/src/components/Sidebar.logic.ts` filters `archivedAt` before project activity sorting, and `apps/web/src/components/Sidebar.tsx` filters it before pinned, active, snoozed, and settled partitioning. The legacy sidebar, landing project selectors, and ordinary command-palette thread/project actions use the same projected field, with no separate web optimistic archive store or thread-key set. Mobile's `apps/mobile/src/features/home/homeThreadList.ts` applies its existing archived-shell filter to the shared projection. Provider metadata remains scoped per environment, unsettled timestamps still re-anchor active ordering, pinned drag-and-drop operates on surviving rows, and project status, keyboard navigation, prewarming, and layout animation use the visible set. Explicit pull-request-linked thread navigation can still discover archived conversations through their retained PR relations.

The command palette builds its thread and project activity through shared production item builders that apply the filtered thread set while preserving each new-thread project item's environment location and workspace path. `apps/web/src/components/ThreadCommandSubtitle.tsx` owns the location subtitle and location search-term helper used by `apps/web/src/components/CommandPalette.tsx`; local projects remain searchable by `Local`, remote projects remain searchable by their environment label, unknown remote locations remain searchable by the rendered `Remote` fallback, and all retain their workspace-root search term and rendered path. `apps/web/src/components/CommandPalette.merged-seam.test.tsx` exercises those same item builders to cover the combined contract by excluding a thread with projected `archivedAt` while asserting the surviving project's location description and search metadata.

The integrated web Archive route uses `ArchiveSettings.tsx` from the Archive customization, including its scoped snapshots, partial-load errors, project icons, row reservations, and permanent-delete cleanup. The standalone cold-storage branch's simpler `ArchivedThreadsPanel` is superseded here. Mobile retains the Archive customization's shared row reservations and refresh ownership while cold storage supplies invalid-date handling. Neither integration introduces another schema migration or lowers the installed web cache version.

Command-palette project creation keeps upstream's single No project action and separate GitHub creation controls. Archive filtering still applies before project activity and thread ranking, including the default sidebar's Working partition.

Web and mobile Archive views track each in-flight unarchive by environment-scoped thread key. The web panel disables its button and context menu for that row while the command runs. `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx` supplies the same state to `ArchivedThreadsScreen.tsx`, which disables swipe actions, blocks deletion, and shows a row spinner until the unarchive attempt finishes. Identical provider thread ids in different environments remain independent.

Archive context-menu metadata comes from `ArchiveSettings.logic.ts`; the shared fallback and Electron native menu preserve destructive styling and the separator before deletion.

Authoritative shell synchronization is shared runtime behavior in `packages/client-runtime/src/state/shell.ts`, `packages/client-runtime/src/rpc/client.ts`, and `apps/server/src/ws.ts`; there is no separate archive-specific shell subscription. HTTP snapshots provide an early shell, while completion-capable WebSocket sessions revalidate it with a socket-owned snapshot after live buffering begins; the same refresh runs when the app returns to the foreground. Across ready-to-ready relay authorization refreshes, shell synchronization retains its previous authoritative baseline while the replacement session synchronizes and applies archive removals only from that replacement's authoritative snapshot. Cold archive storage relies on this contract because compacted per-thread history cannot prove that cached projects and threads still exist.

`packages/client-runtime/src/operations/commands.test.ts`, `packages/client-runtime/src/state/threadCommands.archive.test.ts`, and `packages/client-runtime/src/state/threads-pagination.test.ts` construct protocol-only sessions through `packages/client-runtime/src/rpc/testUtils/rpcSession.ts`. That helper owns their inert defaults and config-subscription forwarding. `packages/client-runtime/src/state/shell-sync.test.ts` and `packages/client-runtime/src/state/threads-sync.test.ts` own inline session fixtures because their synchronization coverage needs per-test subscription streams and distinct replacement-session identities. Thread lifecycle reactor tests use `apps/server/src/orchestration/testUtils/orchestrationEngine.ts`, which derives the scoped event subscription from the test's event stream.

Persisted web and mobile thread details are also fast-paint caches, not an archive source of truth. A `thread.archived` detail event, an authoritative archived detail snapshot, successful local archive acknowledgement, or shell removal evicts the persisted detail through `packages/client-runtime/src/state/threadCache.ts`. The archive command in `packages/client-runtime/src/state/threadCommands.ts` performs acknowledgement-side eviction after the interruptible server command and keeps the handoff masked from cancellation, closing the route-teardown race while upload-feedback continues through the same runtime's RPC scheduler. Per-thread cache generations, eviction tombstones, and write locks prevent queued or idle-finalizer writes from recreating the snapshot. Shell additions and `thread.unarchived` events revive the cache while invalidating only writes captured during the tombstoned generation. Web IndexedDB migration version 7 and mobile SQLite migration version 2 each clear legacy thread-detail caches once; active details repopulate on demand.

The five-minute `ThreadResumeCache` in `packages/client-runtime/src/state/threads.ts` retains the same archive generation and eviction listener after its detail subscription closes. Eviction clears the warm body and blocks stale updates or finalizers from republishing it; authoritative restore re-enables caching while body-free deletion tombstones remain retained even when shell eviction precedes the detail deletion event. Persisted reads also check the eviction state and generation, so a failed removal or a read crossing archive/restore cannot reintroduce an obsolete body or cursor. Detail subscriptions check resume-cache ownership under the cache mutation semaphore, so an obsolete subscription cannot clear its successor's cache or tombstone even after waiting for persistence. Current owners retry failed archive removals despite cache invalidation. Atom expiry releases the listener and generation state. `packages/client-runtime/src/state/threads-atoms.test.ts` covers archive during live and disposed detail subscriptions, failed removal and read races, deletion-tombstone retention, restore, warm cursor resumption, and expiry cleanup.

Failed shell-driven detail-cache removals remain pending while the authoritative shell omits the thread and retry on later shell items. An authoritative active detail snapshot also revives a cache tombstone before it queues persistence, covering reconnects where the corresponding unarchive event was compacted.

`apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts` schedules lifecycle cleanup when it observes a thread archive or deletion event, including deletions expanded from a project command; it makes a best-effort attempt to close every server preview session at event observation time so delayed archive work cannot close a preview reopened after unarchive. `apps/web/src/browser/ElectronBrowserHost.tsx` calls `apps/web/src/browser/usePreviewThreadLifecycleCleanup.ts`. That hook and `apps/web/src/composerDraftArchiveObserver.tsx` share the pure reconciliation logic in `apps/web/src/authoritativeThreadLifecycle.ts`, which retains the last authoritative per-environment thread baseline while a shell synchronizes, then detects removals once that environment is live or discards the baseline when the environment leaves the catalog. Preview cleanup clears both `apps/web/src/previewStateStore.ts` and `apps/web/src/previewMiniPlayerStore.ts` state even when server preview-close delivery arrives first. Removing the preview state unmounts the cross-thread background webview, whose `apps/web/src/browser/desktopTabLifetime.ts` lease stops recording/capture before it closes the desktop tab. Unarchive therefore starts with clean preview state instead of reviving a stale mini-player or capture session. `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`, `apps/web/src/authoritativeThreadLifecycle.test.ts`, `apps/web/src/composerDraftArchiveObserver.test.ts`, and `apps/web/src/previewMiniPlayerStore.test.ts` cover the server and renderer cleanup boundaries.

`apps/server/src/server.test.ts` verifies that HTTP-seeded shell subscriptions preserve archive removals published while WebSocket catch-up reads persisted events, then emit the synchronization completion marker. Initial-snapshot event replay in `apps/server/src/ws.ts` and deferred active-thread cache writes in `packages/client-runtime/src/state/threads.ts` remain complementary to authoritative shell refresh. `packages/client-runtime/src/state/shell-sync.test.ts` covers a ready-to-ready authorization session handoff through the authoritative archive snapshot and its detail-cache tombstone, while `apps/web/src/composerDraftArchiveObserver.test.ts` covers retaining the draft baseline during replacement synchronization and releasing its uploads only after the replacement shell becomes authoritative. The remaining cache lifecycle behavior is covered through `packages/client-runtime/src/state/threadCommands.archive.test.ts`, `packages/client-runtime/src/state/threads-sync.test.ts`, `apps/web/src/connection/storage.test.ts`, and the mobile storage/database tests.

Mobile Archive rows omit invalid lifecycle timestamps, including impossible calendar dates, instead of presenting corrupt or legacy values as newly archived. `apps/mobile/src/features/archive/archivedThreadList.ts` uses the shared zoned timestamp validator and sorts missing or invalid archive dates after valid dates in both sort directions. General mobile time rendering is unchanged.

## Thread Detail Subscription Reliability

**Worktree branch:** `fix/thread-not-found-subscription-loop`

Thread-detail synchronization distinguishes an authoritative missing resource from a transient snapshot failure across both HTTP snapshot loading and WebSocket snapshot fallback so stale thread state cannot enter an unbounded subscription retry loop.

### Fork Customizations

- An HTTP `thread_not_found` response clears the persisted detail cache and marks the client thread state deleted.
- When a bounded WebSocket resume falls back to a fresh snapshot, clients advertise `ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY` (`orchestration.thread-not-found-error.v1`) in the subscription capability list and receive a dedicated `OrchestrationThreadNotFoundError`. The error applies the same cache removal and deleted-state transition for a warm cached thread.
- The subscription input retains the optional legacy `threadNotFoundError` boolean for backward compatibility. Current clients advertise it alongside the versioned capability until every supported server understands the capability list. Servers emit the dedicated error for either opt-in. Servers predating both opt-ins ignore them and emit `OrchestrationGetSnapshotError`, which remains decodable and transient for current clients. Capability names are open strings so current servers can decode future names and act only on versions they understand.
- `packages/client-runtime/src/errors/orchestration.ts` is the canonical terminal missing-thread classifier for both transports. It preserves an HTTP `EnvironmentResourceNotFoundError` whose reason is `thread_not_found` at any typed failure position in a combined cause and recognizes the WebSocket error through the same classification. Standalone defects are not classified as terminal missing-thread errors, while unrelated expected failures remain transient.
- Cache removal is serialized with snapshot persistence, and persistence rechecks deleted state under the same lock, so a queued or in-flight save cannot resurrect an authoritatively deleted thread. Integrated main uses the generation-aware `threadCache.ts` semaphore shared with Archive eviction. `ThreadResumeCache` retains that cache state across atom disposal and remount, so a previous owner's in-flight finalizer save completes before its successor removes the cache. The terminal deletion transition is uninterruptible, so disposing the successor cannot cancel cache removal while it waits for that save.
- The missing-thread subscription terminates before opening or retrying its WebSocket stream. A subscription resumed after session replacement advertises the same capability and, when the server authoritatively reports the thread missing, deletes the warm cache and does not subscribe again on later session or foreground wakeups.
- Once thread state is deleted, subscription input creation fails closed both before and after synchronization setup, preventing foreground wakeups or replacement sessions from reopening the stream.
- `classifyThreadDetail` produces the canonical `ThreadDetailClassification` consumed by `resolveThreadDetailRef`, `useThread`, and direct route detail/status lookups. Local drafts wait for the shell whether draft-store detection or an explicit `waitForShell` request identifies the pre-creation thread. Draft workspace-mode changes before shell creation preserve lookup by the reserved thread ref, so this guard remains active while switching between current-checkout and new-worktree modes. The expected pre-creation HTTP 404 therefore cannot mark the draft deleted, and the new shell starts fresh synchronization after the first send.
- Other HTTP snapshot failures remain transient and fall back to the socket snapshot path. Other WebSocket snapshot failures remain transient and retain the existing retry behavior.

### Merge-Sensitive Seams

- `packages/contracts/src/orchestration.ts` owns the exact versioned capability token, the open capability list, and the deprecated boolean. Current clients dual-advertise while boolean-era servers remain supported; keep both fields aligned with the pre-feature and boolean-era decoding coverage in `packages/contracts/src/rpc.test.ts`.
- `packages/contracts/src/rpc.ts` includes `OrchestrationThreadNotFoundError` in the subscription error union. `apps/server/src/ws.ts` must emit that variant only when the exact versioned capability or legacy boolean is present and only when the bounded resume fallback cannot load a snapshot. Live delivery starts before the fallback snapshot load; an absent snapshot must terminate the stream before any buffered live event or synchronization marker is emitted. `apps/server/src/server.test.ts` covers this ordering.
- `packages/client-runtime/src/state/threads.ts` dual-advertises the versioned capability and legacy boolean on initial and resumed subscriptions. Its terminal missing-thread path must remain serialized with snapshot persistence across retained `ThreadResumeCache` owner handoffs and must win over reconnect, session-replacement, and foreground wakeups. `packages/client-runtime/src/state/threads-sync.test.ts` covers restart continuation from a warm cache; `packages/client-runtime/src/state/threads-atoms.test.ts` covers an old finalizer save overlapping its successor's terminal deletion.
- `apps/web/src/state/entities.ts` owns the only readiness classification for thread-detail subscriptions. `apps/web/src/components/ThreadRouteView.tsx` derives one classification and passes it to both detail and status consumers; it does not maintain a parallel readiness shape. `useThread` feeds its draft-store detection and explicit `waitForShell` input through the same classifier.
- `apps/web/src/composerDraftStore.test.ts` protects reserved draft lookup across workspace-mode changes. `apps/web/src/state/entities.test.ts` protects both hook consumers and all classification states.

### Primary Files

- `packages/client-runtime/src/errors/orchestration.ts`
- `packages/client-runtime/src/errors/orchestration.test.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.test.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `packages/client-runtime/src/state/threads-atoms.test.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/rpc.test.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/newThreadSubscriptionGate.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/components/ThreadRouteView.tsx`

## Magi Consensus Orchestration

**Worktree branch:** `feat/magi-consensus-orchestration`

Magi is an implemented fork feature for provider-neutral, weighted consensus owned by one ordinary agent within a T3 conversation. A user-facing conversation can arm its next turn, and an eligible ordinary conversation agent can start Magi after an explicit user request. Each main or verified native agent can own at most one nonterminal run, and Magi participant conversations remain ineligible. `MAGI.md` is the detailed product contract, architecture record, verification plan, drawbacks, and acceptance source.

Primary reference:

- `MAGI.md`, git-ignored on the branch and tracked as a `base/fork` copy

Supporting operational and security references:

- `docs/magi/example_prompts/MAGI_ARBITRATOR_CODE_REVIEW.md` defines the complete review-and-fix arbitration example, including roster preflight, evidence requirements, proposal handling, and the final consensus condition.
- `docs/magi/example_prompts/MAGI_ARBITRATOR_PLAN_REFINEMENT.md` defines the document-refinement arbitration example and keeps that workflow separate from implementation authorization.
- `docs/magi/example_prompts/MAGI_PERSONALITY_CODE_REVIEWER.md` is the participant review rubric used by the code-review example.
- `docs/magi/THREAT_MODEL.md` records Magi's prompt-injection, credential, tool-access, denial-of-service, cancellation, and durable-audit-data trust boundaries.

### Current integration seams

- Native Magi ownership uses the containing conversation, provider instance, and native thread identity. Codex validates ancestry through its provider API and supplies the caller's own turn and complete tool results; no projected T3 subagent conversation is required. Agent controls and evidence remain owner-scoped while the web/mobile panels aggregate the containing conversation's runs. The existing Codex turn-history helper still preserves status and start times for repeated-steering interruption handling. Cold-storage restore groups participants and any already-persisted legacy lineage with their owning lifecycle root, reserves mixed hot/cold descendants together, and retains restore-claim release on failure.

- `MagiInvocation.ts` authenticates inherited Codex caller metadata against the credential's provider instance and Codex's native ancestry. Native subagents are not T3 conversations. Runs keep the containing conversation in `rootThreadId` and their independent provider/native identity in `nativeOwner`. Start locks, active-run uniqueness, retry identity, arbitration, lifecycle controls, and evidence use that owner. The conversation panel aggregates native runs without granting its main agent control of them. No retired subagent-thread projection is required. Other providers can use ordinary conversation Magi, but native ownership requires a verified caller/context adapter and fails explicitly when unsupported.
- `CodexSessionRuntime.verifyNativeThread` checks the full parent chain through provider `thread/read` metadata without loading history for caller authentication. `readNativeThread` verifies ancestry and reads native history, including paginated turns, only when instruction or evidence context is needed. `CodexAdapter` supplies the native caller's latest instruction and complete terminal tool items from its current turn, including statusless web searches once their completed action or results are present. T3 assigns evidence ids scoped by conversation, provider instance, native thread, turn, and item; selected results are durably snapshotted by Magi. It never reads a parent's or sibling's tools as child evidence. Failed or interrupted native workers can retain a paused run for their own later continuation. Conversation deletion cancels every nonterminal main- and native-owned run before deleting their records; failed cancellation retains durable cleanup state.
- Caller and history queries bypass sidebar snapshots and project Git discovery. Evidence preparation reads project persistence directly and disables pull-request enrichment in thread detail, so unrelated sidebar cancellation cannot abort an MCP call.
- Ordinary conversation evidence reads for listing, start, and deliberation first settle the provider runtime ingestion worker, bounded by ten seconds, so a tool result the agent just produced is visible once the server has received it; the listing reports `upToDate: false` when that bound elapsed. `server.ts` provides `ProviderRuntimeIngestionLive` to `MagiService.layer` for this, and the service skips the wait when the ingestion service is absent. Native evidence comes directly from the verified provider snapshot and does not depend on parent ingestion.
- Provider recovery derives a participant's `magi-read-only` profile from persisted lineage in `getThreadRuntimeContext`. Preserve Magi relations in that narrow query; participant rows are deliberately absent from sidebar shells. OpenCode must confirm the `t3-code` MCP connection before creating or resuming its session, including when registration returns HTTP success with a failed connection status.
- Main retains the published Magi schema at migration IDs 48 through 50, archive glue at 51, and convergence at 60 in `effect_sql_migrations`. Migration 68 replaces conversation-wide active-run uniqueness with per-native-owner uniqueness while preserving existing runs. The standalone branch's `055_MagiProjections` is represented by that schema and is not applied again.
- Projection tests that delete and recreate the same thread use the live cold-storage layer and complete deletion before recreation. The no-op layer cannot clear durable cleanup markers created by the integrated lifecycle policy.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`,
  `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, and
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` project Magi lineage and
  `activeMagiRun` beside upstream's multiple `pullRequests`, `branchPullRequest`, and `unsettledAt`. A conflict resolution must preserve
  all of these behaviors in SQL columns, row schemas, and orchestration payloads. Projection bootstrap
  requests the complete paged event backlog instead of the event store's 1,000-event default.
  `ProjectionPipeline.test.ts` keeps a Magi participant-lineage event 1,001 entries beyond its
  projector checkpoint, so do not restore the default limit or weaken that regression.
- `apps/server/src/provider/Services/ProviderService.ts` and
  `apps/server/src/provider/Layers/ProviderService.ts` expose both Magi's eager `subscribeEvents`
  barrier and core `uploadFeedback`. Provider test fixtures must implement both methods.
- `apps/server/src/ws.ts` arms a first-message Magi run before dispatching the final turn through
  `dispatchFromClient`. Bypassing that wrapper drops client-origin metadata and related core command
  handling.
- `apps/server/src/provider/Layers/CodexAdapter.ts` and
  `apps/server/src/provider/Layers/CodexSessionRuntime.ts` expose Magi context usage and explicit
  compaction through the shared `ProviderService.compactThread` completion barrier beside core
  feedback upload. There is no separate Magi adapter or runtime compaction API. Provider-native collaboration events remain ordinary
  provider runtime events and do not replace Magi consensus or authorize nested Magi participant
  agents.
- Magi invokes shared compaction only for `explicit-native` participants (currently Codex).
  The native compaction receipt must belong to the same participant thread; an ordinary turn
  completion does not satisfy this barrier. Usage is reread only after compaction, before its next turn
  starts. The existing participant session, model, access mode, and delegation restrictions remain
  in force. Core slash-command compaction support does not opt a harness into Magi native compaction.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` reports Claude's core automatic compaction to Magi.
- `apps/server/src/provider/Layers/AntigravityAdapter.ts` declares the shared ACP Magi profile and
  normalizes session start and turn input through `ProviderMagiProfile.ts`, like Cursor and Grok.
  `ProviderMagiConformance.ts` lists every built-in driver; an adapter without a declared `magi`
  capability makes each of its instances report "Provider has not passed Magi conformance." in the
  Magi settings roster.
- `apps/server/src/magi/MagiService.ts` carries provider compatibility into the Magi option catalogue and start/deliberation preflight. A `compatibilityAdvisory.status` of `broken` makes the instance unavailable and preserves the advisory's repair guidance; other advisory statuses do not independently block it. Rejection leaves the configured roster unchanged and occurs before participant work or persistence.
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` keeps local git status and checkpoint
  handling for Magi participant completions but skips pull-request discovery and global list
  invalidation. Participants share the root checkout and cannot own its pull request; the root turn
  performs the single refresh for the completed Magi workflow.
- `apps/web/src/components/settings/EnvironmentSettingsPanel.tsx` and `EnvironmentSettingsPanel.logic.ts` own settings access checks shared by Providers and Magi. Both routes use upstream's `SettingsScopeContext` to select their environment; the shared panel must not independently select another environment for scoped settings. Both screens route reads, writes, loading states, and read-only permissions through that environment. The shared panel forwards the caller's environment allowlist, and shared list rows retain the settings-row search anchor. `ProviderSettingsPanel.logic.ts` keeps the provider-specific export names as a compatibility adapter and contains no independent settings logic. Unscoped Cursor-keychain searches select a connected macOS environment through the shared panel; explicitly scoped settings retain their selected environment.
- `apps/web/src/components/settings/SettingsListDetail.tsx` owns the list/editor frame and selectable
  rows shared by provider instances and Magi participants. Provider and participant screens may
  supply their own editor content, but changes to their common layout and row behavior belong in
  this module.
- `apps/web/src/components/magi/useMagiRunHistory.ts` owns the conversation's Magi run-history
  subscriptions. It keeps the latest-summary query mounted for timeline continuity and overlays the
  full 100-run history while the Magi surface is open, falling back to that latest summary while the
  expanded query loads. On collapse it retains the last expanded result while refreshing the latest
  summary once, then returns to that stable query after it catches up. It supplies the selected result
  to `MagiPanel.tsx` through `ChatView.tsx`, while `MessagesTimeline.tsx` receives only the owner's
  latest summary. Both queries are live-polled while the panel is open, so newer descendant runs
  cannot crowd the owner out of timeline updates. The timeline consumes `MagiRunSummary` metadata and must not create its own
  history/detail query or fabricate an unresolved thread id.
- The existing web right-panel toggle adds active Magi runs to its active-subagent count. `activeMagiRun.runCount` counts every nonterminal main- or native-owned run in the containing conversation once, independently of participants or paginated history. Paused and cancelling runs remain counted; terminal transitions remove them. Existing panel visibility suppression and subagent semantics remain unchanged. Web sidebars, search results and mobile conversation lists have no separate Magi indicator or Magi status announcement.
- `apps/mobile/src/components/MagiConsensusIcon.tsx` remains the Magi sheet glyph and uses the mobile theme layer's custom-SVG seam. Sidebar-only Magi hooks and lineage aggregation are removed; shared run, arm and settings atoms remain.

- Mobile new-task drafts use upstream's durable draft identity, project metadata, and inline attachment context. Magi's `magiArm` stays on that draft. Mobile opens Magi only through `Open magi` in the header menu, after `Open terminal` and `Open git controls` for existing conversations. New-task drafts expose the same menu action. There are no floating or composer Magi launchers.

### Dev-server testing

When verifying Magi in a dev server, use these participant settings:

- Codex: GPT-5.6 Luna, low reasoning, fast mode off
- Claude: Sonnet 5, low reasoning, 200k context window
- Cursor: Grok 4.6, low reasoning, fast mode off

## Default Sidebar Archive Controls

**Worktree branch:** `feat/sidebar-v2-archive-controls`

Upstream's Working shelf classifies presentation independently of archive eligibility. Settled membership alone cannot authorize archive: both bulk selection and the live post-confirmation check retain the session and background-work guards. The shared archive action also releases transient composer uploads after acknowledgement while retaining the local draft.

The default sidebar preserves archive as a separate lifecycle from settle. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus, while root conversation context menus in the default sidebar and chat header expose archive for both settled and unsettled rows. Archive remains visible but disabled while a provider session is starting or a turn or native background work is active, including monitoring-only work, and nested subagent rows continue to omit root lifecycle actions. The legacy sidebar shares the same active-work archive guard. On main, that guard runs before cold-storage archive dispatch and pending draft uploads are released only after a successful archive acknowledgement.

The collapsible `Settled` shelf header includes an `Archive all` action alongside its expansion control. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination and pinned threads that upstream classifies as settled, and remains available when the list begins with settled conversations. Individual default-sidebar and chat-header actions, selected actions, and all-settled actions honor the shared archive-confirmation setting, use the existing optimistic visibility and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove archived rows from any active selection, and report failures without implying that completed archive work was rolled back. These actions share one process-wide reservation pool keyed by the environment-scoped thread identity and coordinate their targets from confirmation through mutation. Later overlapping coordinated flows wait for the current owner, omit threads it archived successfully or intentionally skipped after a live eligibility re-check, and retry threads it canceled or failed to archive instead of racing or silently dropping the later request. Waiting bulk flows reserve their uncontested sibling threads before awaiting current owners, so later requests cannot make their confirmation scope stale. Completed archives and intentional eligibility skips are published to waiters as they occur, even if a later mutation or navigation throws. Bulk flows also re-check live turn and background-work state after coordination and confirmation, while `Archive all` additionally re-checks settled-partition membership before each mutation. Entries that became active or were un-settled while a flow waited are skipped without aborting the remaining confirmed batch, and the user is warned about the skipped entries.

`SidebarArchiveControls.tsx` owns the fork-specific settled-row controls and the `Archive all` button composed into upstream's sortable `SidebarSectionHeader`, while `SidebarArchiveControls.logic.ts` owns sidebar-only eligibility and presentation rules. `threadArchive.logic.ts` owns the shared active-work policy, outcomes, and process-wide reservation coordination used across the default sidebar, chat header, and legacy sidebar. `useThreadArchiveActions.ts` owns shared confirmation, coordination orchestration, outcome reporting, individual archive actions, and selection cleanup for the default sidebar and chat header. `useSidebarArchiveActions.ts` adds selected-thread live rechecks and all-settled membership policy to that shared lifecycle. The legacy sidebar also re-checks every selected thread immediately before mutation, skips newly blocked entries without aborting later eligible archives, retains skipped entries in the selection, and reports the shared eligibility warning. `Sidebar.logic.ts` keeps a narrow compatibility facade for archive helpers consumed by upstream-owned integration surfaces, so `Sidebar.tsx`, `LegacySidebar.tsx`, and `useThreadActions.ts` retain their existing import seam while the fork implementations remain isolated. `Sidebar.tsx` retains the archive integration points in the upstream-owned row and list surfaces; it exports the otherwise module-local upstream `SidebarThreadRow` and `SidebarSectionHeader` for focused composition coverage. The upstream `buildThreadActionMenuItems` builder owns root-menu composition, including the archive entry and its label and position. The fork supplies the broader active-work disabled state from both `Sidebar.tsx` and `useThreadActionMenu.ts` and routes individual archives through `useThreadArchiveActions.ts` for shared confirmation, coordination, and selection cleanup. Upstream auto-settle settings remain available in the same menus. Successful archives retain upstream's per-thread Undo notices, including when invoked by a bulk flow. Undo restores the archived thread and returns to it when archiving moved the reader to a draft; the fork's outcome reporting still distinguishes an archive failure from a later navigation failure. Shared lifecycle-button classes keep settle, un-settle, and archive affordances aligned with the upstream row surface tokens while upstream snooze and wake controls retain their own shelf semantics. The fork-owned settled-row component preserves upstream's styled un-settle tooltip and uses the same tooltip primitive for the archive button's enabled and active-work-disabled status copy instead of a native `title` attribute. The slim settled status slot mirrors upstream's `focus-visible` crossfade so its timestamp yields to both lifecycle buttons instead of remaining underneath them, while Woke stays visible and the controls move into flow beside it. Disabled archive controls remain focusable, expose `aria-disabled`, retain pointer targeting for the styled explanation tooltip, stop row or shelf propagation, and never dispatch the archive action. Their cursor and hover tone communicate the unavailable state; an in-flight `Archive all` remains mounted even after optimistic visibility removes every archivable row. The surrounding row structure, including row-level tooltip wrapping outside the archive control, row sizing, settled pin markers, pinned-thread sorting and dragging, filtering, un-settled-thread re-entry ordering, and decorative environment/provider status semantics, remains upstream-owned. `Sidebar.test.tsx` renders the real slim row to keep the upstream settled pin marker outside the fork's adjacent un-settle and archive status slot. It also exercises the archive button inside the real sortable shelf header across expansion, optimistic removal, and completion, preserving the header and in-flight button identities. Upstream title-search mode uses separate navigation-only result rows and temporarily replaces the normal lifecycle list; clearing search restores the settled shelf header and row archive controls.

Primary files:

- `apps/web/src/components/LegacySidebar.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/Sidebar.test.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/SidebarArchiveControls.tsx`
- `apps/web/src/components/SidebarArchiveControls.logic.ts`
- `apps/web/src/components/SidebarArchiveControls.logic.test.ts`
- `apps/web/src/components/SidebarArchiveControls.test.tsx`
- `apps/web/src/components/threadActionMenu.logic.ts`
- `apps/web/src/components/threadActionMenu.logic.test.ts`
- `apps/web/src/components/threadArchive.logic.ts`
- `apps/web/src/hooks/useSidebarArchiveActions.ts`
- `apps/web/src/hooks/useThreadActionMenu.ts`
- `apps/web/src/hooks/useThreadArchiveActions.ts`
- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/hooks/useThreadActions.test.ts`

## Version Control Panel Work

**Worktree branch:** `feat/version-control-panel-work`

The first-class Version Control panel includes a singleton right-panel surface, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, and Version Control panel RPC/contracts. On web, a logical project shared across environments renders one complete panel instance for each connected environment, with the active environment first and remote instances using the existing server-icon and environment-label treatment. `buildSourceControlEnvironmentOption` in `apps/web/src/components/ChatView.sourceControl.ts` is the shared constructor for the environment option consumed by both toolbar routing and the federated Source Control panel. Snapshots, status subscriptions, fetches, diffs, editor launches, and Git mutations stay routed through each instance's environment and cwd. Project-script saves use the destination environment’s settings capabilities and preserve its existing project overrides. A normal ahead-branch push snapshots the other connected environments before pushing; a peer whose current branch has a clean working tree, no local commits ahead of its upstream, and tracks the same normalized remote branch is fetched after the push, rechecked, and fast-forwarded. Peers that changed locally, changed upstreams, disconnected, or failed are left alone, and peer failures cannot misreport the completed source push as failed. Disconnected environments are omitted, failures remain isolated to their per-panel retry state, and only the active instance may update active-thread source-control metadata or open its standalone File surface. `SourceControlEnvironmentPanel.tsx` names this active-only capability `activeThreadRef`; the active panel uses it for File-surface openings and `PublishRepositoryDialog` link routing, while foreign panels receive `null`. The shared `apps/web/src/rightPanelStore.ts`, `RightPanelTabs.tsx`, and `ChatView.sourceControl.ts` integration keeps singleton Source Control and multi-tab pull-request surfaces as peers: `normalizeSourceControlRightPanelPresence` applies repository availability to both live and retained right-panel presence, removes only Source Control, preserves pull-request and File tabs, and falls back to the first remaining visible surface when an unavailable Source Control tab was active. `apps/web/src/components/rightPanelSurfaceActions.ts` is the canonical add-surface descriptor for availability, activation, shortcut, empty-state and menu order, instance policy, disabled presentation, and badges; `RightPanelTabs.tsx` derives both launcher action lists from one memoized snapshot of those inputs and uses the same actions for keyboard activation. Version Control uses shortcut `V`, appears first in the empty-panel launcher, and remains last in the compact add-surface menu. Browser session/runtime-tab resolution, audio state, and mute-menu behavior remain isolated in `apps/web/src/components/rightPanelBrowserTabState.ts`, so background preview mini-player lifecycle changes and right-panel browser-surface reconciliation must leave the Source Control surface open, visible, active, and present exactly once.

The shared `DiffPanel` file tree is in-panel navigation: selecting a tree entry reveals that file inside the diff. The explicit filename primary action is routed through `apps/web/src/diffFileActions.ts` and reuses the thread's default right-panel File surface. Persisted attachment tabs retain their attachment identity and payload when the file-tab migration runs for existing installs. Source Control file previews for a foreign sibling worktree retain their explicit cwd, so the same relative path in two worktrees remains available in separate File tabs.

Web source-control rows use the rich-tooltip presentation and timing shared with the default web sidebar in `apps/web/src/components/Sidebar.tsx`, including its `TooltipCardPopup` treatment. The opt-in legacy sidebar remains isolated in `apps/web/src/components/LegacySidebar.tsx` and does not define this convention. Working tree, file, branch, commit, stash, and remote cards expose their full paths or refs and relevant status, timestamp, identity, URL, and line-change details without covering the row. Clickable tree and file rows use the pointer cursor alongside their keyboard button semantics. Federated environment headers expose their complete cwd through the shared styled tooltip primitive rather than the browser-native `title` attribute. File cards use trigger-scoped virtual anchors while retaining a common panel-aligned left edge. Nested action buttons keep their terse label tooltips and preserve the parent rich card only for the nested trigger in that same row, so unrelated tooltips elsewhere are unaffected.

VCS status ignores internal `.git/` watcher events before refreshing local status. Background activity keeps lightweight current-upstream status refreshes separate from the Version Control panel's broader fetch-all-remotes work. `apps/server/src/utils/CanonicalPath.ts` owns native-first canonicalization for existing paths. `GitVcsDriverCore.ts` uses it for Git common-directory cache identity, and `GitManager.ts` uses the same path identity for status caches and worktree comparisons. The portable filesystem path and then the original input remain fallbacks, so Windows long and 8.3 aliases for a repository and its linked worktrees share cache and worktree identity without making missing paths fatal. The normal Git interval retains the shared `performance`, `balanced`, and `battery-saver` values of 15 seconds, 30 seconds, and disabled, while the panel-specific all-remotes interval uses one minute, five minutes, and disabled respectively. Automatic panel fetches run only while a panel retains Git-ref demand and the owning environment's shared lock, low-power, battery, visibility, and activity policy allows the work. A host lock alone does not pause them while a foreground client retains that cwd's demand, so remote use of a locked machine keeps remote refs fresh; `apps/server/src/sourceControl/SourceControlPanelFetchPolicy.ts` owns that panel-only exception and leaves the shared policy unchanged. Opening the web panel and focusing the mobile route refresh their local snapshots immediately. On subsequent web focus, an enabled panel interval first makes the interval-aware, policy-gated fetch request and then refreshes the local snapshot once; a zero interval skips the network request and refreshes locally immediately. Panel fetch-all requests use `--no-auto-gc` so periodic refreshes cannot repeatedly restart failed repacks. Automatic and explicit panel fetches share the existing non-interactive Git credential environment, so background refreshes cannot open credential dialogs. Explicit Fetch uses the same safeguard and always remains available, bypassing the interval cache. The previous omitted custom default migrates through the new balanced default, with its conservative cadence preserved by the panel-specific value; an explicitly persisted five-minute upstream-status override remains an override instead of being reclassified by value. Settings search indexes the individual Source Control controls: stable writing controls anchor to their rows, while discovery-dependent Git intervals and provider-avatar controls route to the panel's stable Source Control section.

`apps/server/src/sourceControl/SourceControlPanelService.ts` requests repository status with `includePullRequest: false`. `GitManager.ts` still returns local and remote synchronization state for the repository summary, but skips the provider-backed PR lookup because panel snapshots always project `pr` to `null`. The shared VCS status stream retains its normal PR behavior. Actionable rows discover each local branch's PR through the same cached `GitManager.branchPullRequest` lookup as the conversation sidebar, including head-repository validation and in-flight request reuse. Discovery does not scan or cap repository-wide PR lists. Automatic GitHub discovery lets `gh` select the target repository, including a fork's upstream or an explicit `gh repo set-default`, instead of binding searches to the push fork at `origin`. The returned PR repository identifies the configured remote whose base branch is compared; only open PRs with a local branch behind that target produce rows. Each such row carries the PR and reuses the sidebar badge beside the ahead/behind counters, including its status tooltip, in-app navigation, and modifier-click behavior. While a web or desktop item action runs and its snapshot refreshes, its hover controls are replaced by an always-visible action label using the conversation sidebar's Working indicator. Labels identify the operation, such as Committing, Stashing, Undoing, or Rebasing, and remain scoped to the affected item. Provider-backed change-request and commit-avatar lookups for Actionable rows remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows. These background reads share the provider-and-host cooldown used by pull-request services. Panel reads and GitHub adapter requests use the same normalized host key, including an explicit non-default enterprise port, so a pause applies to the matching endpoint without suppressing another port on that host. The first classified rate-limit response records the provider reset time or fallback backoff, and later panel reads skip the provider until that pause expires while retaining Git-derived content and avatar fallbacks. Provider adapters retain their provider-specific raw-state normalization, while resolved Git pull requests and panel `VcsStatusChangeRequest` schemas in `packages/contracts/src/git.ts` share the canonical `ChangeRequestState` from `packages/contracts/src/sourceControl.ts`. Terminal `closed`/`merged` checks are centralized in `packages/shared/src/sourceControl.ts` and consumed by sidebar and thread-settlement paths without changing the opt-out for automatic settlement on merge.

Forgejo/Gitea change requests participate in Actionable branch discovery across configured remotes. Its provider returns no commit avatar, so panel rows retain their avatar fallback.

The mobile Version Control and file-diff routes use the shared `ScreenHeader`. Version Control closes back to the active thread; the diff returns to Version Control with native compact-layout back navigation and an explicit back action in split layouts. Android uses the shared in-content header. Neither route shows a sidebar action.

Repository-convention message generation uses one repository-context policy reader for generic Git actions and panel commit/stash actions. Panel commit and stash generation applies the registered checkout project’s writer and writing-style overrides, falling back to the main checkout’s project for unregistered sibling worktrees. Both paths resolve the effective writer from the current provider snapshot and fall back to the configured text-generation model when the dedicated writer is disabled or not usable. They read recent commit subjects and `AGENTS.md`; Claude writers also read `CLAUDE.md`.

Version Control and source-control provider failures should preserve structured causes when normalized for panel RPC errors. GitLab, GitHub, Forgejo/Gitea, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing structured process failures into generic strings. Web mutations reconcile VCS status and an authoritative panel snapshot after both success and failure before preserving a mutation error, so conflict-producing or partially applied operations remain visible. Web Source Control mutation confirmations use the shared themed `LocalApi` dialog with the destructive variant and never fall back to a native `window.confirm`; commit branch-name entry likewise uses a themed `Dialog` and `Input` instead of native `window.prompt`. Azure DevOps commit-avatar lookups route through the organization encoded by the repository remote and use the stable Commits Get API version.

Panel mutations that can change refs invalidate both shared ref-cache layers in finalizers: `apps/server/src/sourceControl/SourceControlPanelActions.ts` and `SourceControlPanelService.ts` call the non-failing `GitVcsDriver.invalidateRefs` boundary for the shared server `listRefs` snapshot, while matching commands in `packages/client-runtime/src/state/vcs.ts` invalidate shared client ref state through `onSettled`. This applies after successful, failed, interrupted, or partially applied commit, branch, fetch, and remote mutations. Working-tree staging/unstaging/discard, stash operations, diffs, comparisons, and other read/display-only operations remain excluded. Cache invalidation supplements the existing authoritative panel/status reconciliation and never replaces or masks the original mutation result.

Thread source-control metadata update failures should surface on the thread without overwriting unrelated thread errors, and successful source-control updates should clear only the source-control metadata error for that thread. `apps/web/src/components/ChatView.sourceControl.ts` resolves the visible banner with local thread errors ahead of source-control metadata errors and persisted provider-session errors behind them. The banner also retains upstream's ChatGPT usage-limit classification. Dismissing a banner clears only its owning local or source-control error; persisted session errors are masked for the current UI session, so a lower-priority error remains available after the dismissed banner is gone. Metadata updates are serialized per thread with monotonic hook-lifetime sequencing. The subscription effect owns authoritative branch observations; enqueue inputs initialize a missing guard but never rewind an existing one. Each request snapshots the predecessor set when it starts; successful writes use and union that snapshot into the full set of unacknowledged predecessor branches, even if an in-flight acknowledgement temporarily cleared the live transition, ignore lagging observations of any predecessor until the newest target is observed, and then accept legitimate later returns to those branches. A non-stale observed write target takes precedence when that target is itself a snapshotted predecessor, so a rapid return clears the transition without requiring a duplicate acknowledgement; an observation already classified as a lagging predecessor cannot acknowledge that target early. Observations are skipped while the server-thread record is temporarily absent. Each request also snapshots the observation sequence so success, failure, interruption, and queued writes leave the next request guarded by the newest authoritative branch. Loading thread shells supply their recorded active branch as the initial guard. This prevents overlapping checkouts, a post-drain update racing subscription propagation, or a still-loading full thread from leaving server metadata behind the repository state. Grouped-project navigation retargets an open singleton Source Control surface to the active draft/thread environment and effective repository cwd, while metadata errors remain scoped to the originating environment/thread key and are pruned when that context is no longer retained.

`apps/web/src/components/BranchToolbarBranchSelector.tsx` keeps its virtualized ref list inside the web type-check guard by typing key and item-type callbacks as `string` and the row renderer as `LegendListRenderItemProps<string>`; branch selection does not cross an implicit `any` boundary.

Selected commits reconcile the real index in an interruption-safe success finalizer before temporary-index cleanup. Generation and commit execution remain cancellable; cleanup cancellation must not leave a completed commit staged again. If reconciliation fails after the commit is durable, report that the commit exists, stop before push, and provide a shell-quoted, bounded index recovery command rather than inviting another commit. A stash pop whose apply succeeded but removal failed reports that distinction and warns against reapplying.

Required edge cases: the current default branch remains a valid default compare ref and retains that stable base in its own branch details, status-derived default branch names such as `develop` are preferred over hardcoded `main`/`master` guesses, compare-history pagination queries the selected comparison range, branch pull/fetch parsing handles slashful remotes and remote-looking local branch names without treating slashless local upstreams as remote refs, fetch-before-sync refreshes the authoritative snapshot before choosing the same action's push/pull/diverged result and does not fetch an unchanged branch twice, the panel and composer share live Git status with a per-environment checkout fallback remembered for the current session, known non-Git projects disable the Source Control action and hide any retained surface while status reloads, and unseen checkouts assume Git until VCS status resolves, diverged normal merge sync is available only for the current branch, checked-out branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, sibling worktree watcher refreshes keep root Actionable rows live while skipping stale/prunable worktree paths, working-tree refreshes that race an authoritative full snapshot cannot retain pre-mutation branch/remote/stash data, failed full snapshots release the in-flight full-refresh barrier so later working-tree refreshes can remain incremental, queued web refreshes still drain when the active refresh fails or is interrupted, duplicate web and mobile actions with the same key are synchronously suppressed while the first mutation remains in flight, web and mobile stash actions carry the selected immutable SHA beside the positional ref, reject shifted or missing selections, and serialize app-owned mutations by canonical Git common directory across linked worktrees, branch sync and undo operations for checked-out branches target the owning worktree cwd, upstream remote identity keeps local-to-local tracking separate from remote pairing and sync, local and remote deletion preserve the selected identity when names collide and reject a missing target without crossing into the other kind, checkout and deletion remain rejected by both the client and server for branches checked out in a worktree whose directory exists, a local branch still registered to a worktree whose directory is gone (`prunable` in `git worktree list --porcelain`) is pruned with `git worktree prune` before `git branch -d`/`-D` runs, local delete failures for unmerged branches or branches still used by a worktree surface as stable details that copy only the branch name and worktree path Git reports while unmatched stderr stays behind the generic Git failure, cwd-scoped working-tree enrichment avoids cross-worktree file-detail reuse, a fallback File surface uses its own cwd and reveal metadata, stale background-stop failures cannot clear a newer thread's pending stop, selected-file commits omit pathspecs after staging, commit-hook output only enriches a failed Git result and never interrupts a still-running commit, merge refs are passed after `--`, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, empty working-tree diffs use the full-file fallback only for paths Git currently lists as untracked in panel-cwd-relative form, Review patches disable user-configured diff rendering, merged staged-plus-unstaged row stats are summed, collapsed mobile remotes hide their branch rows, mobile conflict-only rows open the working-tree diff side, sibling mobile working trees are not marked expansion-initialized until they become current, failed mobile branch/stash details replace loading placeholders with errors, invalid mobile branch and stash dates are omitted instead of appearing as recent activity, and late-month relative dates do not fall through to `0 years ago`.

Working-tree snapshots keep every changed path visible but defer expensive untracked-file stats and temporary-index rename detection to a batched enrichment RPC. Web and mobile queue every eligible file in the snapshot, including collapsed and offscreen working trees, so totals are independent of row rendering. Successful enrichment remains cached for the current snapshot. Keep this work separate from the initial snapshot and retain bounded batches. Git diff paths are converted from repository-relative to panel-cwd-relative before joining status rows, so panels opened below the repository root retain their line counts.

Integrated main includes Magi in the shared right-panel action model with its own availability, live-run badge, and G shortcut. Version Control remains first in the empty launcher and last in the compact menu; its visibility normalization leaves Magi and other surfaces intact.

The integrated right-panel action descriptor also retains Magi as a singleton, its active-run badge, and its `G` shortcut beside Version Control. The conversation header counts both active subagents and active Magi runs.

`SOURCE_CONTROL.md` contains the detailed implementation requirements.

Primary reference:

- `SOURCE_CONTROL.md`, git-ignored on the branch and tracked as a `base/fork` copy

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

## Upstream Update Guidance

When updating from upstream, keep these local behaviors unless upstream has an equivalent implementation:

1. Version Control remains a singleton beside Agents, pull-request, File, and preview/browser state. Preserve its native route, federated panels, coordinated clean-peer fast-forward after push, cwd-correct File routing, context-keyed state, subscription-acknowledged metadata queue, request-scoped errors, retryable mobile fetches, process-shared caches, and transport-safe error wrapping unless `upstream/main` is equivalent; use `SOURCE_CONTROL.md` as the source of truth.
2. Version Control idle-power safeguards retain native-first canonical path identity, exact 15-second, 30-second, or disabled Git status intervals, one-minute, five-minute, or disabled all-remotes intervals, shared lock and power/visibility/activity gating, ignored `.git` churn, batched ignored-path classification, batched snapshot-wide enrichment, and explicit Fetch.
3. Version Control checked-out branch labels preserve worktree paths through porcelain-first parsing and old-Git fallbacks; sync and undo target the owning checkout, while checkout and deletion stay disabled for branches owned by an existing worktree; deletion prunes stale registrations whose worktree directory is gone.
4. Thread source-control metadata update failures remain visible without clearing unrelated thread errors.
5. Mobile EAS owner, project id, and OTA updates URL remain pointed at the same local Expo project used for installable preview builds unless deliberately changed.
6. Mobile iOS development signing remains pointed at Apple team `6JGX8M7Z3L` unless deliberately changed.
7. Source Control default branch detection honors the status-reported default branch before falling back to `main` or `master`.
8. Pending-task edit/submit helpers keep edited queued tasks from being resurrected after deletion/delivery, keep edit-session ownership from racing across reopen/exit, persist unsendable cleared edits instead of sending stale text after restart, and avoid reusing stale queued workspace metadata when a pending task is retargeted.
9. Source-control metadata writes include the active thread branch as `expectedBranch` so stale Git-action results cannot overwrite newer branch/worktree metadata.
10. Desktop and mobile verification retain host-local capacities and request-scoped cross-host racing. Web servers remain unconstrained, while integrated web UI automation uses one desktop slot on its browser host.
11. Persisted generation-aware Git ref caching and mutation invalidation, interruption-safe preview listener acknowledgements, listener-specific projections, exact known-server polling cadence, incremental Version Control snapshots, and common-directory fetch deduplication retain their branch ownership unless upstream is equivalent.
12. Project removal keeps archived conversation cleanup explicit: archived-only deletion requires the dedicated opt-in and must still reject any unseen live thread.
13. Core projection migrations preserve published ids 33 through 66 and append auto-settle opt-out at 67, ensure lineage before the id-34 root backfill, and normalize only exact divergent markers before canonical replay. All migrations use `effect_sql_migrations`; migration 60 removes the abandoned experimental Magi ledger after restoring any missing canonical Magi rows.
14. Worktree-local dev state, single-origin browser proxying, Tailscale sharing, and browser-safe port selection remain integrated with the fork's IPv4 desktop/server paths, explicit desktop HMR URL handling, and desktop/mobile runtime coordination.
15. Mobile verification uses the Device panel and exact AgentDevice target arguments, deep-link pairing, and host-local leases. Windows native-client builds retain the worktree wrapper's short-path and dependency-order safeguards.
16. Preview cleanup follows authoritative archive/delete/unarchive and generation-aware shell lifecycle signals, while background mini-player presentation remains independent from the singleton Source Control surface.
17. Preview automation keeps serialized pairing, environment-scoped stable host discovery and non-disruptive explicit selection, sticky current-tab render scoping, runtime replacement, monotonic deadlines, exact-session timeout cleanup, and skipped-capture session safeguards together across renderer and desktop hosts.
18. Archive remains distinct from settle and root-only across the default Sidebar, chat header, and Legacy Sidebar. One process-wide coordinator enforces startup, active-turn, and background-work guards; `Archive all` covers the complete settled scope, including paged and pinned-settled rows, and holds reservations from confirmation through mutation. Waiters receive completed successes and eligibility skips while failed, cancelled, and unattempted work stays retryable.
19. Mobile Git checkout failures remain visible and retryable, while interrupt-only outcomes stay silent.
20. The documented finite working-indicator and deferred streaming Shiki safeguards are currently inactive; retain this summary for future evaluation.
21. Repeated steering uses exact projected message-id acknowledgement with a guarded turn/session fallback and keeps message-dispatch state separate from new-thread busy state. Stop performs bounded best-effort child interruption before authoritative live-root-turn resolution and preserves timeout, failure, defect, and successful-empty fallback semantics.
22. Thread-detail missing state preserves versioned and legacy capability negotiation, one HTTP/WS terminal classifier, serialized cache deletion and persistence, missing-snapshot termination before buffered live delivery, and one canonical draft/readiness classification that survives workspace-mode changes.
23. Provider-neutral Magi remains reconciled against `MAGI.md`, including its canonical core-ledger migrations, provider subscription/upload/dispatch/compaction contracts, complete projection replay and lineage, root-owned checkpoint refresh, run-history query ownership, shared settings structure, and shared mobile icon.

## Retirement Criteria

These local patches can be removed when upstream provides the equivalent, superseding, or overriding behavior.

When retiring the local changes, remove the corresponding tests; expect upstream behavior to be tested by upstream incoming tests as well; we do not test or concern ourselves with validating upstream.

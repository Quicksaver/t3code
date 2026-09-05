# Custom Branch Changes

> Keep this file readable for humans: do not hard-wrap prose lines; let editors wrap long lines visually. Keep headings, lists, tables, and code blocks structurally formatted.
> Keep these notes a reflection of the current implementation status. History records, such as merge, ports, and update notes, are not meant for this file.
> Each top-level section declares its active worktree branch. `none` means no active worktree owns that section, and subsections inherit the parent section's branch.

## Upstream Baseline

The fork integration boundary is the attached `base/main` control branch, with its Windows worktree at `E:\Projects\t3code.worktrees\base-main`. It advances only by fast-forward to the selected `upstream/main` commit. Each worktree update squashes the assigned branch, including `base/fork`, on its old upstream base, then rebases it onto that control commit while preserving upstream tracking. The completed branch carries one combined customization commit, including follow-up fixes and documentation, directly above the control commit, or equals it if no customizations remain. Customization commits stay on their assigned branches.

For diagnosing existing verification failures, obtain native control results through the main checkout's `scripts/worktree-baseline.ts` `ensure` command; agents must not install or run checks in the control worktree directly. The helper returns the cached manifest for the exact control commit and host/toolchain fingerprint or elects one caller to produce it while concurrent callers wait. A failure seen in a fork worktree is pre-existing only when the same failure appears in the same-host manifest. If it does not, fix it in the fork worktree that introduced or exposed it.

## Fork Documentation And Worktree Orchestration

**Worktree branch:** `none`

`AGENTS.md` points implementation and evaluation work at this file. A task that only orchestrates worktree subagents follows its invoked skill instructions without loading unrelated documentation. Each feature or fix worktree keeps its branch-only contract in `BRANCH_DETAILS.md`; local `main` consolidates that material here and must not track the branch-specific `BRANCH_DETAILS.md` files themselves.

Recreate only local `main` for each assembly. All other branches and worktrees are read-only inputs. `fork/main` is a separate worktree branch rebased like the others during worktree updates. Rewind `main` to its latest upstream base, fast-forward to `base/main`, then apply all `base/fork` commits or fast-forward `main` to `base/fork` when equivalent. Cherry-pick each remaining worktree branch's single commit onto `main` in turn. Complete its integration glue, focused validation, and affected `FORK.md` updates on `main` before applying the next branch. Reassess these notes against current branch implementations and documentation. Keep documentation with the glue it describes, in the cherry-pick commit for conflict resolutions or in the same follow-up integration commit for subsequent work.

The repository-local orchestration skills divide responsibilities as follows:

- `$worktrees` is the worker contract for exact-worktree execution, same-host control comparison, runtime leases, cross-host source transfer, Android and iOS isolation, and owned teardown.
- `$spawn-worktree` dispatches one worker to one absolute worktree path with only its branch task and required skills. It requires the worker to read that worktree's `BRANCH_DETAILS.md`, supervises runtime ownership without leaking orchestration context into the child prompt, and performs exact-worktree lease cleanup only after the worker is terminal.
- `$spawn-worktrees` inventories active non-`main` worktrees and dispatches through `$spawn-worktree`, explicitly excluding the `base/main` control worktree from worker tasks.
- `$update-worktree` squashes and rebases one assigned branch at the control boundary, assesses only the interaction between incoming upstream work and that branch's customizations, and folds adaptations and documentation into its single local commit.
- `$update-worktrees` first fetches upstream and fast-forwards a clean attached `base/main` to the selected `upstream/main` boundary. Only after verifying that exact control state does it dispatch the individual branch updates; it does not mutate the other worktrees itself.
- `$pick-from-worktrees` rebuilds only local `main` from the control boundary and `base/fork`, then applies each remaining worktree branch with its integration glue and `FORK.md` updates before proceeding to the next. Other branches are read-only throughout this workflow.
- `$comments-from-worktrees` delegates each branch's pull-request comments through `$piz-comments`, then invokes `$pick-from-worktrees` when fixes were produced. `$update-prs` delegates pull-request publication through `$piz-pr` without doing branch work in the orchestrator.
- `$update-unattended` sequences the full maintenance run: update all worktrees, integrate them, push tracked branches, synchronize the Windows and Mac checkouts, and build the configured Windows, macOS, and Android artifacts. Its per-platform command recipes remain authoritative in that skill.

Every repository-local skill above includes matching `agents/openai.yaml` metadata for its user-facing name, description, and invocation policy. Keep that metadata paired with the corresponding `SKILL.md` when a skill is renamed, added, or removed.

Primary files:

- `AGENTS.md`
- `.agents/skills/worktrees/SKILL.md`
- `.agents/skills/spawn-worktree/SKILL.md`
- `.agents/skills/spawn-worktrees/SKILL.md`
- `.agents/skills/update-worktree/SKILL.md`
- `.agents/skills/update-worktrees/SKILL.md`
- `.agents/skills/pick-from-worktrees/SKILL.md`
- `.agents/skills/comments-from-worktrees/SKILL.md`
- `.agents/skills/update-prs/SKILL.md`
- `.agents/skills/update-unattended/SKILL.md`

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
- Browser `dev` and `dev:web` modes are single-origin. They omit baked `VITE_HTTP_URL` and `VITE_WS_URL` values, mark that intent explicitly so repository environment files cannot revive them, and let Vite proxy `/api`, `/ws`, `/oauth`, and `/.well-known` to the backend.
- `vp run dev --share` publishes the selected web port through `tailscale serve`, builds pairing and development URLs from the tailnet origin, clears stale mappings before sharing, and removes the owned mapping when the runner exits. Its local proxy target uses `localhost` so the operating system can select the Vite listener's IPv4 or IPv6 loopback address; focused fixtures assert the exact serve target instead of baking in one host's path or address semantics. Sharing is unsupported for desktop mode and has no effect for server-only mode.
- `$test-t3-app` recognizes the older-worktree failure where Tailscale proxies `127.0.0.1` while Vite listens on `::1`: a healthy loopback origin plus a shared 502 triggers exact-mapping replacement with a `localhost` target and bare-origin verification, not repeated application restarts or premature token consumption.
- Development authentication accepts configured remote origins, scopes browser session cookie names by port, and gives startup pairing credentials a 24-hour lifetime so concurrent or remotely shared worktrees do not overwrite each other's browser sessions.
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

## Mobile Testing Harness Reliability And Isolation

**Worktree branch:** `none`

The fork keeps a small host-local capacity layer around upstream-style mobile verification. Dependencies and native build products otherwise use their ordinary checkout-local or tool-default paths.

Expected behavior:

- Before submitting a one-time mobile pairing token, `$test-t3-mobile` verifies the rendered host field exactly and uses simulator pasteboard input when semantic typing changes punctuation.
- `$ios-simulator-browser` starts the pinned serve-sim version with scoped cleanup for one explicit simulator UDID and requires a real live frame, not merely a loaded preview wrapper. If the default encoder logs `error encoding frame: encodingFailed` or the wrapper reports that no frames are being produced, the harness stops only its owned stream, repeats cleanup for that exact UDID, and restarts serve-sim with `--codec mjpeg`. Verification continues only after the selected simulator is reported live with a non-zero-size frame.
- Each host exposes mobile capacity two. Windows can run two Android worktree verifications while the Mac runs two iOS worktree verifications. The lease covers native preparation, device use, Metro/backend startup, interaction, and owned teardown.
- The fork replaces upstream `$test-t3-mobile`'s backtick-based remote PowerShell guidance with task-owned `.ps1` execution for multi-step control-flow scripts, preventing non-interactive stdin truncation.
- Android verification dismisses an obscuring Expo developer menu or Tools overlay and refreshes semantic bounds before tapping. Expo's development-client update-check error is non-blocking only after the intended Metro bundle and tested flow succeed.
- iOS verification supplies `en_US.UTF-8` to CocoaPods and clean prebuild processes, starts isolated Metro processes with `EXPO_OFFLINE=1`, and treats reported React Native or Worklets JavaScript/native version differences as definitive client incompatibility instead of retrying Metro.
- Disposable iOS Simulator startup uses an active ten-minute readiness deadline. Verification proceeds as soon as the semantic tree is usable, restarts the same UDID once after a completed boot remains status-bar-only for 60 seconds, and clears the Expo developer menu or Tools overlay before creating a one-time pairing credential.
- Windows native Android builds use `scripts/worktree-android-build.ts` as one ordered operation. It performs the ordinary install and Expo clean prebuild first, prepares a worktree-local hoisted dependency layout, verifies CMake inputs through both root and `apps/mobile` resolution, then invokes `expo run:android` directly without another Vite+ install. This keeps native paths short without a shared virtual store. The wrapper recovers once from the exact `build.ninja still dirty after 100 tries` failure by deleting only worktree-local generated CMake state after Gradle exits, revalidating dependency paths, and retrying the direct build; a second failure is final. Windows provisions one persistent, worktree-owned API 36 AVD per worktree through `scripts/worktree-android-avd.ts`. AVDs use ordinary Android SDK storage, disable Quick Boot snapshot load/save, and launch with `-no-snapshot`.
- iOS uses one disposable simulator per active verification. Each concurrent job has a separate XcodeBuildMCP process/session and explicit UDID.
- iOS DerivedData is not redirected. XcodeBuildMCP and Xcode use their ordinary workspace-path-specific DerivedData. Deterministic temporary Mac worktree paths let the cache remain reusable after the source checkout is removed.
- Generated Android and iOS projects, Pods, Gradle outputs, and Metro caches remain checkout-local or use upstream tool defaults.

Primary files:

- `.agents/skills/test-t3-mobile/SKILL.md`
- `.agents/skills/ios-debugger-agent/SKILL.md`
- `.agents/skills/ios-simulator-browser/SKILL.md`
- `.agents/skills/worktrees/SKILL.md`
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
- Run Xcode, CocoaPods, Metro, the backend, and simulator-facing services on the Mac, using Mac paths and an explicit simulator UDID. Keep simulator-facing endpoints on `127.0.0.1`; the Mac cannot reach its own Tailscale Serve or MagicDNS endpoint through self-hairpin routing. Xcode and simulator UI automation require the Mac's GUI session to be logged in with Accessibility permission available.
- Run Android Emulator checks on the Windows Desktop. When the initiating checkout is on another machine, connect through `ssh windows-desktop` and transfer its code, including uncommitted changes, as a task-owned source snapshot in an isolated Windows worktree. Build that snapshot rather than an unrelated pre-existing Windows checkout; no commit or push is required. When the suite is already running on Windows against the intended local checkout or worktree, use it directly—do not SSH to the same machine or create a redundant copy.
- Headless Android verification is available over SSH through Windows Hypervisor Platform and ADB; the Android 16/API 36 x86_64 AVD has completed a full boot through the MacBook Pro-to-Windows SSH path. Run Gradle, Metro, the backend, and emulator-facing services on Windows with Windows paths. Use `10.0.2.2` for emulator-to-host backend traffic and ADB port reversal for Metro. Drive and capture the emulator through ADB, and do not depend on an SSH-launched emulator window appearing in the interactive Windows desktop session.
- Treat results as host-scoped evidence. A successful macOS permission assertion can complement but does not erase the expected Windows mode-reporting mismatch, and a mobile pass applies only to the exact local checkout or transferred snapshot that was tested.
- Runtime leases are machine-local. Acquire and release them on the host running desktop or mobile interaction, following `$worktrees`; commands issued over SSH use the destination host's main and worktree paths. Non-interactive web checks need no lease, while integrated web UI automation uses the browser host's desktop lease.

This section is the shared routing policy for full verification runs. Keep platform availability and expected outcomes here instead of duplicating them in individual test skills.

## Preview Automation Reliability

**Worktree branch:** `fix/preview-automation-reliability`

The fork keeps product-native preview automation bounded and recoverable across the web host, MCP server, and Electron CDP controller. Upstream owns retained preview guests, recording capture, picture-in-picture, and the inline mini-player; the fork continues to own the bounded one-shot automation path, control-session recovery, and degraded semantic snapshots.

Expected behavior:

- Every Electron automation operation has a bounded control-session lifetime. The desktop manager reserves response grace inside the requested timeout, always finalizes controller and action-timeline state, and serializes poisoned-session replacement through synchronized session state. Finalization commits the controller reset before responding but delivers the state notification separately under manager scope, so a stalled listener cannot withhold the bounded response. Timeout errors retain the failed operation or capture stage for caller-visible diagnostics. A request that times out while queued behind another action does not detach that action's shared debugger session; after acquiring the permit it detects and retries a stale queued session. Timeout cleanup is bound to the exact acquired control-session identity, so a late finalizer cannot detach a healthy replacement session.
- Click, type, and wait operations clamp their desktop input timeout to the renderer host's remaining monotonic operation budget. A caller-supplied input timeout can shorten that boundary but cannot outlive the host request; when the input omits a timeout, the remaining request budget is forwarded instead of restarting the desktop default.
- Snapshot collection captures the exact guest with `webContents.capturePage`, using `stayHidden: true` for a staged background guest and `stayHidden: false` for the foreground. It no longer creates a per-snapshot `BrowserWindow` debugger bridge or uses CDP `Page.captureScreenshot`. Every native capture user is serialized through a `WeakMap` queue keyed by the exact `WebContents` object, and that queue remains occupied until Electron's underlying promise settles even when the requesting Effect has already timed out. Detaching or replacing a guest retires only that exact queue; a late result is rejected after an identity check and cannot be encoded for a replacement that reused the numeric web-contents id. Every returned PNG, including resized output, is validated and bounded. Final screenshot failure or timeout is logged without resetting an otherwise healthy debugger control session, and the semantic page state, interactive elements, accessibility tree, diagnostics, and action timeline still return with `screenshot: null` instead of failing the complete snapshot.
- `HostedBrowserWebview` subscribes only to stable inputs for its current tab and primitive background/visibility flags, then derives the potentially newly allocated staging rectangle outside the Zustand selector. Unrelated browser-surface updates therefore do not rerender every retained guest. Returning either the complete `byTabId` map or a fresh nested rectangle from the `useShallow` selector makes React treat unrelated or every `useSyncExternalStore` snapshot as changed, producing unnecessary guest work or a maximum-update-depth failure that unmounts the host interface and disconnects the preview automation client.
- Desktop preview guests no longer create their CDP debugger session eagerly when a webview registers. Session initialization is lazy and included in the automation operation deadline. This prevents an offscreen Chromium guest from leaving `Runtime.enable` pending while holding the synchronized session lock, which previously made every later evaluation or snapshot against that tab time out even after it became presentable. Appearance flows through `desktopTabLifetime` and IPC; zoom and native mute are reasserted without opening CDP, and a guest disappearing during mute reassert does not fail registration. Closing detached DevTools starts bounded restore only for an explicit non-system color scheme; system-scheme tabs stay detached until the next automation operation.
- Inactive preview webviews remain mounted, retain their declared viewport, and stay CSS-visible while positioned outside the human-visible panel. This preserves their runtime and semantic or input automation without selecting them. Background snapshot capture uses a reference-counted presentation lease and always restores the offscreen position afterward; navigation, color-scheme changes, evaluation, waits, and input operations remain offscreen and do not acquire that native-surface lease. Snapshot staging does not change the right-panel tab selected by the user. The entire lease, including compositor staging and desktop IPC, is bounded by the operation's remaining response budget and reports a typed timeout if it stalls. The two compositor waits prefer `requestAnimationFrame`, but each falls back after one 16-millisecond frame interval because placing the native guest can pause the host renderer's animation-frame callbacks. If the user foregrounds the target while staging is pending, that visible presentation satisfies readiness. A never-presented tab does not depend on another browser surface having supplied a panel rectangle: capture staging falls back to a deterministic rectangle fitted inside the renderer viewport.
- Foreground presentation is selection-aware across both the right-panel browser surface and preview mini-player. A stale renderer `visible` flag cannot keep an unselected guest classified as active and suppress a requested background capture after either selection changes; selected, visible guests still use the normal foreground path.
- A background snapshot that times out before desktop capture begins releases its presentation lease even when Chromium has paused compositor-frame callbacks. Once desktop IPC starts, the renderer retains that lease until the bounded desktop call settles. If Electron's native capture outlives the caller timeout, the renderer may then restore the guest offscreen, but the exact guest's native capture queue remains owned until the underlying promise settles and no later capture can overlap it. Semantic operations use the separate debugger control session and remain available while that capture queue is occupied. The desktop snapshot receives the operation's remaining timeout and bounds its control session accordingly. The one-shot path is designed to keep never-selected tabs logically hidden while returning a PNG when Chromium capture is available and leaving the host interface and automation connection intact.
- The shared preview contract treats snapshot screenshots as nullable. MCP snapshot responses omit image content when capture is unavailable while preserving structured semantic content and explicitly reporting `screenshot: null`; tool descriptions promise a PNG only when capture is available. The desktop snapshot IPC schema and preload adapter default an omitted `background` flag to `false`, preserving foreground-capture behavior for legacy callers.
- The renderer automation consumer reserves response grace before the broker deadline and converts a stalled host operation into a typed `PreviewAutomationTimeoutError` instead of leaving the broker to surface a generic execution failure. Short caller-supplied timeouts retain their full execution budget instead of being consumed by fixed grace deductions. Requests that ask to show the browser use the request's remaining bounded visibility budget rather than a fixed two-second ceiling, and their stable-presentation dwell contracts to fit short deadlines instead of requiring an impossible fixed 100 milliseconds. Reused empty or failed tabs acknowledge without waiting for a browser surface those states intentionally hide. Visibility timeouts distinguish right-panel and mini-player presentation, report the active surface id, and include whether the requested browser surface was registered and had a presentation rectangle.
- Each preview presentation is identified by a runtime tab id rather than only a logical tab id. Visibility waits abort when that runtime is replaced, presentation changes revalidate after every asynchronous boundary, and replacement hosts cannot satisfy or inherit the old runtime's readiness. One monotonic deadline budget covers selection, visibility, stability, overlay registration, navigation readiness, and response grace so retry and fallback work cannot restart an expired timeout. Renderer-side presentation settling and overlay or navigation polling clamp every sleep to the remaining budget. Overlay status IPC is bounded by that same deadline and revalidates the runtime after the awaited reply, while the optional presentation settle derives a non-negative best-effort budget and completes quietly when no time remains.
- Preview mutations check that shared deadline again immediately before creating, resizing, revealing, navigating, pressing, scrolling, changing appearance, or starting and stopping a recording. Viewport readiness polls bounded measurements and revalidates runtime identity after every awaited read, so queued work cannot mutate a replaced guest or begin after its response budget expires. Inactive and background-staged guests remain `aria-hidden` throughout those transitions.
- Bounded and unbounded mutations serialize per tab. Resize checks the deadline again after acquiring that queue and before the server mutation. A timed-out appearance change cannot persist late; persistence rereads the current tab and retries against a replacement runtime. Visible retained guests inherit panel or sheet `zIndex`, while background capture uses fixed isolated, noninteractive, `aria-hidden` stacking.
- Renderer cleanup, desktop presentation waits, and MCP evaluation all consume the same remaining request budget. Timed-out cleanup cannot keep the broker response pending, presentation races cannot succeed from a stale rectangle or replaced runtime, and `preview_evaluate` forwards its caller timeout through the broker instead of silently falling back to a longer default.
- Recording startup, first-frame acquisition, capture shutdown, recorder settlement, blob conversion, and artifact persistence all stay inside the remaining operation budget. Recording cleanup is manager-scoped. A timed-out stop preserves accumulated chunks and retryable renderer state, shares any in-flight artifact save across retries, and uses a validated idempotency key for deterministic desktop artifact paths so retrying cannot create duplicate files. Failed-start cleanup remains bounded while always releasing its renderer slot, and appearance retries reapply against a replacement guest instead of mutating stale tab state.
- A screenshot request skipped because its capture budget is already exhausted returns the available semantic snapshot without marking an otherwise healthy preview session failed. Capture failures still degrade to `screenshot: null`, while genuine session failures retain their existing recovery path.
- A newly created preview tab applies its server snapshot and assigned tab id, initiates any requested selection, and acknowledges server-side creation immediately without making the first call depend on cold React panel rendering, Electron overlay registration, or page readiness. Its initial URL continues loading exactly once in that same tab; status can report progress, while later wait, snapshot, or interaction operations own any attachment or page-readiness wait. Reopening an existing shown tab selects both the preview-state tab and its matching right-panel surface, then waits for stable panel presentation; while the request remains pending it reasserts that explicit selection across route hydration or session reconciliation instead of accepting one transient visible frame. Reused tabs retain overlay, navigation, and requested-visibility readiness checks because their existing automation target should already be available.
- Preview open automation resolves the persisted browser defaults once before it reads or mutates preview session state. One pinned snapshot supplies viewport, default presentation, and configured `profileId`; explicit `open` or legacy `show` input wins, while omitted input follows `autoShowFloatingPreview`. New tabs forward the profile into their Electron partition so imported cookies are available. `fill` uses a deterministic 1280 by 800 fallback when no presentation rectangle exists. Settings hydration cannot change the request midway, and a server-epoch replacement aborts rather than adopting a new runtime.
- An explicit background open suppresses later automatic presentation for that scoped epoch and runtime. An explicit shown open clears suppression, reconciliation prunes it, successful close removes it, and reveal rechecks identity and deadline immediately before presentation.
- `preview_close` authoritatively closes the session tab and disposes its Electron guest, clears visible and background state, returns `tabId: null` so the broker releases host assignment, and is retry-idempotent. `$test-t3-app` records collaborative preview tabs it owns and closes them during teardown.
- Browser development now uses the shared single-origin proxy and origin-derived HMR path described above. Wildcard IPv4 and IPv6 listeners map browser proxy targets to the matching loopback family while concrete LAN or IPv6 targets remain concrete; shared `DEV_LOOPBACK_HOST` and `DEV_BROWSER_LOOPBACK_HOST` constants keep this policy aligned. Local environment-port navigation normalizes to `localhost` for Chromium dual-stack reachability. Desktop development still generates IPv4 HTTP, WebSocket, and web URLs, pins Vite through `HOST=127.0.0.1`, and derives explicit HMR host/protocol/port values from `VITE_DEV_SERVER_URL` when supplied. Server-only backend URLs and the default Vite listener also remain on IPv4 loopback.
- The primary pairing route watches for later URL-fragment changes while it remains mounted. Navigating an already-loaded `/pair` document to `/pair#token=...` claims each new token once, removes the secret fragment, and queues the normal pairing exchange without requiring a reload or a second desktop window. Pairing submissions execute serially, submission state stays active until every queued exchange settles, and a rejected exchange releases the queue for the next fragment, so rapid fragment navigations cannot overlap token exchanges.
- Desktop development derives `T3CODE_DESKTOP_USER_DATA_DIR` from the resolved isolated T3 home. Preview verification therefore cannot silently attach to the installed app's Electron profile or collide with another worktree's desktop guest state.
- Each Electron profile persists one stable preview automation `hostId` and registers it with the renderer machine label, platform, per-environment connection id, and supported operations. Physical host label and platform detection run in Electron's main process and cross the existing synchronous IPC boundary; the sandboxed preload stays free of Node built-in imports so source-built and packaged desktop bridges initialize consistently. `preview_list_hosts` returns only hosts connected to the caller's environment, and `preview_select_host` binds an unassigned provider session without activating or changing either desktop window. A live assignment cannot be silently moved to another host; an unavailable explicit host fails closed instead of falling back. Implicit first-use routing still follows the existing capability and focus ordering when no host was explicitly selected. Explicit assignments survive transport replacement by stable host identity and retain the provider session's tab selection, while a disconnected selected host stays unavailable until that renderer reconnects or the caller uses a new unassigned provider session.

Current limitations:

- Electron `webContents.capturePage` can still fail or remain pending. The intended degraded result remains a usable semantic snapshot with `screenshot: null`, not raster evidence. A never-settling native capture deliberately holds only that exact guest's capture queue closed; later screenshot attempts degrade instead of overlapping it, while semantic automation remains available and replacing the guest retires the stale queue.
- There is no isolated-worktree Electron end-to-end proof for hidden, never-selected `preview_snapshot`. Controlled web disables Browser, and preview tools may attach to an installed desktop host unless the test owns an isolated Electron profile.

Primary files:

- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/app/DesktopAppIdentity.ts`
- `apps/desktop/src/app/DesktopConfig.ts`
- `apps/desktop/src/app/DesktopEnvironment.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/ipc/channels.ts`
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts`
- `apps/desktop/src/ipc/methods/window.ts`
- `apps/desktop/src/ipc/methods/preview.ts`
- `apps/server/src/mcp/PreviewAutomationBroker.ts`
- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/toolkits/preview/tools.ts`
- `apps/web/src/browser/browserRecording.ts`
- `apps/web/src/browser/browserDefaults.ts`
- `apps/web/src/browser/browserTargetResolver.ts`
- `apps/web/src/browser/desktopTabLifetime.ts`
- `apps/web/src/browser/HostedBrowserWebview.tsx`
- `apps/web/src/browser/browserSurfaceStore.ts`
- `apps/web/src/browser/hostedBrowserWebviewStyle.ts`
- `apps/web/src/components/auth/PairingRouteSurface.tsx`
- `apps/web/src/components/auth/PairingRouteSurface.logic.ts`
- `apps/web/src/components/preview/closePreviewAutomationTab.ts`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/previewAutomationClientId.ts`
- `apps/web/src/components/preview/previewAutomationOverlayReadiness.ts`
- `apps/web/src/components/preview/previewAutomationPresentation.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.ts`
- `apps/web/src/components/preview/previewAutomationErrors.ts`
- `apps/web/src/components/preview/previewAutomationRequestConsumer.ts`
- `apps/web/src/components/preview/previewNavigationReadiness.ts`
- `apps/web/src/components/preview/previewViewportReadiness.ts`
- `packages/contracts/src/previewAutomation.ts`
- `packages/contracts/src/ipc.ts`
- `packages/shared/src/devProxy.ts`
- `apps/web/vite.config.ts`
- `.agents/skills/test-t3-app/SKILL.md`
- `scripts/dev-runner.ts`

Focused regression coverage lives in `scripts/dev-runner.test.ts`, desktop identity, environment, window, and manager tests, the MCP broker/server/tool tests, browser recording, target resolution, surface, viewport action/layout, and runtime-tab tests, pairing and close-tab tests, preview client/open/overlay/presentation/presentation-suppression/request/navigation/readiness/rollback tests, and the preview and IPC contract tests.

```sh
vp test run scripts/dev-runner.test.ts apps/desktop/src/ipc/methods/window.test.ts apps/desktop/src/preview/Manager.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/PreviewAutomationBroker.test.ts apps/server/src/mcp/toolkits/preview/tools.test.ts apps/web/src/browser/browserRecording.test.ts apps/web/src/browser/browserSurfaceStore.test.ts apps/web/src/browser/hostedBrowserWebviewStyle.test.ts apps/web/src/components/auth/PairingRouteSurface.logic.test.ts apps/web/src/components/preview/previewAutomationClientId.test.ts apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts apps/web/src/components/preview/previewAutomationOverlayReadiness.test.ts apps/web/src/components/preview/previewAutomationPresentation.test.ts apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts apps/web/src/components/preview/previewNavigationReadiness.test.ts apps/web/src/components/preview/previewViewportReadiness.test.ts packages/contracts/src/ipc.test.ts packages/contracts/src/preview.test.ts
```

## Temporary Clerk Passkey Native Package Override

**Worktree branch:** `none`

Upstream currently pins `@clerk/electron-passkeys@0.0.4-canary.v20260819050620`. The four platform-specific native packages published for that canary contain only `package.json` and `LICENSE`; each package declares a `.node` entry that is absent from its tarball. Isolated installs reproduce the defect.

Main retains the upstream Clerk Electron and passkey wrapper versions so it keeps the automatic-passkey-prompt fix, but `pnpm-workspace.yaml` overrides the four native leaf packages to `0.0.3`. The canary wrapper's `index.js` is byte-identical to the `0.0.3` wrapper, and the `0.0.3` native packages contain the declared macOS and Windows binaries. Keep all four overrides and their lockfile resolutions together.

Remove these overrides after the pinned Clerk version resolves all four native packages to tarballs that contain their declared `.node` files. Verify at least the macOS arm64 DMG and affected Windows desktop artifact before retiring the workaround.

## Worktree Runtime And Native Baseline Coordination

**Worktree branch:** `none`

The fork keeps host-local coordination for interactive desktop and mobile verification. Source checks run directly in each assigned worktree without a lease, while one deterministic script per host owns native verification of that host's upstream control branch.

Expected behavior:

- `scripts/worktree-runtime-slot.ts` exposes `mobile` capacity two and `desktop` capacity one on each host. Version 1-3 state migrates to the version 4 shape and obsolete web holders or requests are discarded. Command-line acquisition and release require a request id; interrupted acquisition cancels that request and releases a matching near-simultaneous holder.
- `scripts/worktree-baseline.ts` computes host-native upstream-control install, typecheck, and bounded-test results once for an exact commit and host/toolchain fingerprint. It invokes pnpm through the Windows command processor on Windows and directly on macOS or Linux. Concurrent cache misses on one host coalesce behind one producer. The script alone operates that host's control worktree and writes logs and the manifest atomically under ignored `.t3/research/worktree-baselines`; interrupted and out-of-memory runs are not cached.
- Candidate workers run source checks normally in their assigned worktrees without a lease. Before changing code or tests for a failure, they compare its exact output with the same-host control manifest and logs. Shared host-specific and locale failures remain unchanged.
- Web servers have no runtime queue. Each worktree uses its own ignored `.t3` state and reads the actual server and web ports from `[dev-runner]`. Integrated UI automation, including standalone browser fallbacks, uses the selected host's desktop lease.
- Workers enter every ready desktop and mobile queue concurrently, run the first eligible acquisition, cancel their other requests, and re-enter the remaining queues after releasing the winner. Each worker holds one runtime lease at a time except while a mobile stream briefly uses a desktop renderer.
- Representative mobile verification races the Windows Android and macOS iOS hosts. Desktop verification similarly races the two host-local renderers. Request-scoped cancellation safely releases a losing near-simultaneous acquisition. Queue age never triggers cancellation, replacement, reprioritization, or coordinated handoff.
- The host-local capacities permit two Android and two iOS verifications simultaneously across the fleet. Desktop permits one Windows and one macOS interaction block simultaneously.
- `scripts/worktree-android-build.ts` is the single Windows native-build entrypoint. It orders the normal install and no-install Expo clean prebuild before `scripts/worktree-android-dependencies.ts`, then patches the generated app Gradle file to use Android Gradle's `buildStagingDirectory` at `<worktree-drive>:\.t3code-android-cxx\<worktree-hash>`. That short path prevents app-level CMake object paths from crossing Windows' 260-character boundary; a canonical-worktree ownership marker keeps every staging cache isolated. The wrapper validates every known CMake-fed package from both root and actual mobile package resolution and resolves Expo from `apps/mobile` before calling it directly, so Vite+ cannot invalidate the prepared layout before Gradle. On the exact Ninja dirty-manifest failure it waits for the failed build to exit, removes only generated `.cxx`, CMake intermediates, and the contents of that worktree's marked staging directory, revalidates, and retries once. The retry keeps the canonical worktree path rather than substituting a drive whose removal can corrupt an active Gradle build. `scripts/worktree-android-dependencies.ts` removes stale package-level dependency links only inside the selected Windows worktree and performs the frozen worktree-local hoisted install. The ordinary pnpm content store remains tool-managed and no virtual store or native staging directory is shared between worktrees. Windows Android verification keeps its disposable backend state and seeded project outside Metro's watched worktree because atomic cache replacement can otherwise terminate Metro's fallback file watcher on a transient path.
- `scripts/worktree-android-avd.ts` lazily provisions one persistent API 36 AVD per canonical Windows worktree. It invokes Windows batch SDK tools through an explicit command shell, refuses to install a missing system image without authorization, records ownership, disables Quick Boot snapshot load/save, and supports verified removal before the owning Git worktree is deleted.
- macOS creates a deterministic temporary linked worktree for Windows-originated source, including uncommitted changes. Concurrent transfers use request-specific refs and bundle files, fetch with `--no-write-fetch-head`, and verify the exact expected `HEAD` and dirty-state manifest before requesting runtime capacity. Xcode's normal workspace-path-specific DerivedData remains on the Mac after that source checkout is removed.
- Each iOS verification uses a disposable simulator and its own XcodeBuildMCP server process/session. Session defaults remain non-persistent and DerivedData follows XcodeBuildMCP's workspace-specific default.
- Desktop and mobile host races materialize exact source state on both candidates before acquisition. The first eligible host to acquire wins; the losing request exits before runtime work starts. A Windows-originated Mac desktop candidate selects the connected Mac renderer by stable preview host id without changing focus, exposes Vite on the Mac Tailnet address while keeping its backend on Mac loopback, and consumes the pairing token only after the routed page loads.

Primary files:

- `.agents/skills/spawn-worktree/SKILL.md`
- `.agents/skills/worktrees/SKILL.md`
- `.agents/skills/test-t3-app/SKILL.md`
- `.agents/skills/test-t3-mobile/SKILL.md`
- `.agents/skills/ios-debugger-agent/SKILL.md`
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
vp test run scripts/worktree-runtime-slot.test.ts scripts/worktree-baseline.test.ts scripts/worktree-android-build.test.ts scripts/worktree-android-dependencies.test.ts scripts/worktree-android-avd.test.ts
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

The macOS handoff selects the newest arm64 DMG under `release`, launches a separately titled Terminal tab, asks the installed app to quit, and mounts the selected image read-only in a task-owned temporary directory. It replaces only `/Applications/T3 Code (Alpha).app`, verifies the installed signature, applies an ad-hoc signature only when the local build is unsigned or already ad-hoc, detaches the image, relaunches the app, and closes the owned Terminal window. Stale mount cleanup is limited to the script's `t3-code-dmg.*` temporary directories.

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

The fork carries an upstream-oriented fix for running conversations so users can send any number of steering prompts and can stop the active agent at any time, including after one or more steers. Preserve this patch until upstream provides equivalent acknowledgement and interruption behavior.

Expected behavior:

- An active-thread send allocates its user-message id before entering local dispatch, and the dispatch API requires that exact id. The acknowledgement search checks all projected user messages, not only the newest one, so a later message from another client cannot hide the expected steer. The exact projected message id is authoritative even when the captured session state is stale, ready, or absent. Sends that advance a turn retain the turn/session-transition fallback, but `connecting` state ignores those transitions unless the exact message has projected. Unrelated projected user messages must not acknowledge the dispatch, and steering the existing running turn must not wait for a new turn or session transition before re-enabling the composer. Implementing a plan in a separate new thread uses its own busy-state variant and is cleared explicitly instead of observing projections from the source thread.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption reads the live provider thread with `includeTurns: true`, selects the most recently started `inProgress` turn, and bounds that lookup with a timeout. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. The cached session turn is read lazily only after the live lookup fails, dies, or times out; unexpected lookup defects are logged before fallback, while a successful lookup with no active turn returns without reviving a stale cached id.
- Root stop preserves upstream's bounded best-effort child interruption fan-out before resolving the root's authoritative live turn. A child fan-out failure must not prevent the root interruption path from settling.

Conflict guidance:

- `ChatView.localDispatch.ts` owns the dispatch snapshot, exact-message-id acknowledgement, and dispatch hook. Keep message dispatch and new-thread busy variants distinct; preserve submission intent, reconnect guarding, worktree preparation, latest-user-message timing, and the guarded turn/session fallback. `allocateMessageDispatch` allocates and begins a dispatch before returning its `MessageId`; plan implementation uses `beginNewThreadBusyState` and defaults its follow-up to foreground work.
- Do not restore the inline dispatch hook or latest-message heuristic to `ChatView.logic.ts` or `ChatView.tsx`. Preserve the draft-hero dock transition, early in-flight guard, resolved submission intent, and returned message id. Use `hasServerAcknowledgedLocalDispatch` for correlation; add an explicit server receipt only if projected ids stop being authoritative.
- `CodexInterruptResolution.ts` owns live-root lookup ordering, timeout, and fallback, separately from runtime model and effort behavior. `CodexSessionRuntime.ts` retains both child fan-out and the root-resolution call.
- The collaboration integration fixture selects its `.cmd` launcher on Windows and `.sh` launcher elsewhere, uses a Node-native temporary cwd, and keeps both wrappers thin around the shared `.mjs` fixture.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.localDispatch.ts`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/server/src/provider/Layers/CodexInterruptResolution.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`
- `apps/server/src/provider/testFixtures/codexCollabMockPeer.cmd`

Regression coverage lives in `apps/web/src/components/ChatView.localDispatch.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`, and `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement across projected history, reconnect and turn/session fallback, background-intent preservation, timestamp-based live-turn selection, lazy timeout/failure and unexpected-defect fallback, successful empty reads that suppress stale interrupts, and bounded root interruption after best-effort child fan-out.

## Conversation User Context Rendering

**Worktree branch:** `feat/conversation-user-context-rendering`

The fork's user-message rendering composes terminal, element, preview-annotation, and review-comment parsers into one ordered content sequence while keeping tool and subagent activity rendering outside the timeline component.

Expected behavior:

- Standalone trailing `<element_context>` messages render as element chips instead of showing raw XML-like tags. Messages containing mixed or repeated terminal, element, preview, and review blocks retain their send order, including review comments before, between, or after generated contexts.
- Generated context tags do not leak into the visible user-message body. Literal user-authored tag-like text remains visible, malformed trailing generated blocks are suppressed rather than partially exposed, and Copy retains the original serialized message text.
- Inline file-change and review-comment diffs in the timeline intentionally use the lightweight `FileDiff` surfaces; `AnnotatableCodeView` remains the full diff-panel review-comment surface unless the timeline grows equivalent review-comment authoring behavior.

Implementation notes:

- Keep the upstream parsers under `apps/web/src/lib` and compose them in `userMessageContext.ts` rather than replacing them. Top-level review-comment segmentation occurs before generated-context parsing; review tags inside generated terminal, element, or preview bodies remain content rather than becoming review cards.
- `UserMessageContentParts.tsx` owns collapsible text, inline terminal labels, element chips, preview cards, and review cards. `MessagesTimeline.tsx` retains attachments, row actions, renderer inputs, row selection, list orchestration, and work-group scroll state, but only extracts the state and inputs for each user row.
- `WorkActivityRows.tsx` owns live, grouped, and expanded tool and subagent rows. `MessagesTimeline.tsx` supplies `WorkActivityRowsProvider`, while `ExpandedWorkGroupEntries` supplies `WorkGroupViewProvider`; do not import timeline-private contexts into `WorkActivityRows.tsx`.
- Extracted content renders through React text nodes and existing components, never through `dangerouslySetInnerHTML`. Keep parser ordering and raw-tag regressions in `userMessageContext.test.ts` and rendering integration in `MessagesTimeline.test.tsx`. When upstream changes tool or subagent rows, port those changes into `WorkActivityRows.tsx` while retaining live/failed styles, group expansion, expanded images and details, icons, and subagent status/token summaries.

Primary files:

- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/components/chat/userMessageContext.ts`
- `apps/web/src/components/chat/userMessageContext.test.ts`
- `apps/web/src/components/chat/UserMessageContentParts.tsx`
- `apps/web/src/components/chat/WorkActivityRows.tsx`
- `apps/web/src/lib/terminalContext.ts`
- `apps/web/src/lib/elementContext.ts`
- `apps/web/src/lib/previewAnnotation.ts`

Focused regression coverage:

```sh
vp test run apps/web/src/components/chat/userMessageContext.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx
```

## Conversation Tool Activity Rendering

**Worktree branch:** `feat/file-command-activity-boxes`

The custom behavior is focused on making tool activity easier to read in long-running Codex threads without changing agent execution semantics.

## File Change And Command Activity Boxes

Shared client-runtime `presentation.ts` remains authoritative for compact tool labels, T3 MCP labels and icons, grouping categories and count summaries, superseded-marker filtering, and viewed-image discovery. `workLogActivity.ts` composes its rich command and file fields with provider-neutral browser, computer, icon, and source metadata.

File-change and command activities are rendered as clickable, expandable rows in the conversation work log.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- File-change-style tool rows that also carry command metadata or patch payloads still prefer the changed-file path preview while collapsed, so rows such as `apply_patch` stay oriented around the file being edited instead of the command label.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- Tool rows that merely mention changed files, such as file-read detail rows, stay in the generic detail panel unless they include a patch or are explicitly marked as a file-change request, so read-only tool output is not mislabeled as an editable file-change row.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- Differing raw command text is rendered inline as a normal detail block in the expanded row, not hidden behind a second nested disclosure.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.
- Structured non-zero command exit codes produce the failure affordance, and an exact zero duration is rendered as `0ms`.
- Cumulative file-change patch snapshots replace their shorter prefix instead of duplicating already-rendered hunks, and an oversized patch is skipped without preventing valid sibling diffs from rendering.
- Inline activity diffs use their parser cache keys for React identity instead of only the resolved path, so successive snapshots of the same file cannot reuse stale component or parser state.
- Command output extraction ignores blank-only completed stdout/stderr fallbacks so aggregated command output is still shown, but preserves whitespace-only incremental `tool.updated` chunks, including raw output `content`, so streamed output is not collapsed away.
- Incremental command output chunks concatenate without injected separators, while shorter completed snapshots, newline-terminated shorter updated snapshots, and shorter single-line repeated-prefix snapshots do not overwrite a previously merged longer output snapshot.
- MCP tool-data serialization preserves repeated references to the same argument object when they are not cyclic, while still redacting real ancestor-chain cycles as `[Circular]`, so expanded generic details stay informative without risking recursive rendering.
- Settled adjacent tools collapse into the count-aware group summary. Only one row accepted by the rich command/file predicate bypasses that summary; generic-detail-only rows remain summarized, expanded groups emit each constituent as a work row, and metadata-only lifecycle markers or collab-agent rows never become rich disclosures. Live work remains one status row whose members expand individually.
- Each expanded work row owns one disclosure. Inline `FileDiff` renders already expanded without nested per-file or collapse controls, viewed-image previews stay in that row, and non-rich tools retain their generic detail fallback.
- Collapsed generic and MCP activity rows use the cheap shared expandability predicate and defer full detail derivation until expansion. The live timeline therefore reaches the hardened redaction, cycle handling, and long-string truncation path without eagerly serializing large or cyclic tool payloads during collapsed-row rendering.
- Row-level keyboard expansion only handles Enter and Space when the event target is the row itself, so nested action controls do not also toggle the parent activity row.
- Activity identity is scoped by turn plus a top-level-first, legacy-nested tool-call id. Cumulative merging uses the incoming `sourceActivityKind`; session replacement retains applied command lifecycle records and resumes after the latest applied sequence. A superseded `tool.updated` row may be pruned only when its completion contains every projected cumulative output, exit, duration, patch, and path contribution.
- Server transport projection preserves the client-consumed command metadata, file-change details, and collab details while removing unrelated provider payload bulk. Command text, file paths, patches, nested provider patch containers, and dynamic command metadata are bounded independently so an oversized sibling cannot hide valid details. Collab projection keeps ordered streamed output chunks, prompt-bearing inputs, tool/item identity, `kind`, parent-collab metadata, and child references required by the work-log and subagent lifecycle views.
- Projection normalizes activity kinds to strings, retains patches only for file-change-shaped activity, and exposes truncation at `data.rawOutput.truncated`. Identical self-contained patch snapshots share a cumulative slot, while path-dependent add/delete patches remain distinct.
- Command stdout, stderr, aggregated output, and equivalent dynamic result strings stay server-side in persistence for negotiated web thread snapshots and live activity events. Compact command activities carry only an `output available` marker; expanding a collapsed lifecycle row loads each missing contributing thread-and-activity-scoped detail over HTTP with bounded concurrency, preserves successful chunks when another detail fails, shows a retryable loading/error state, and reuses fetched details while the row remains mounted. Detail output merges only into the row's output fields so completion identity and lifecycle state remain stable. Lazy output is capability-gated and explicitly requested by web; mobile and older clients retain embedded command output until their expand-time detail UI has parity.
- Persist only validated workspace image paths. Summarize cumulative non-terminal `item.updated` command payloads before persistence to prevent quadratic growth, but retain terminal completions in full until client-bound projection. Transfer-budget coverage keeps roughly 30 percent headroom while rejecting transfer of fully retained MCP payloads.
- On-demand activity detail projection recognizes command-shaped dynamic tools without an explicit kind, nested `item.result.result` fallbacks, and command output stored directly on the payload envelope. It applies one observable 200,000-character command-output budget to the requested activity. Snapshot projection retains at most four inline patches found through four nesting levels, each independently capped at 200,000 characters; unrelated and object-valued provider payloads remain pruned.
- Generic activity detail is suppressed when it merely repeats the displayed command or raw command. For lifecycle rows without provider ids, the final collapse identity prefers detail, then command, then raw command, so distinct no-id commands remain distinct without unstable position-based keys.
- Known shell wrappers are stripped only when their boundary quotes match. Otherwise the serialized wrapper text remains intact.
- Expanded changed-file pills and inline diff headers use the shared styled tooltip instead of native `title` attributes, preserving readable full paths for pointer and keyboard users.
- The standalone file-command-activity branch applies its disposable thread-detail cache eviction as web connection database v5 directly after `base/main` v4. On the integrated fork, Archive already owns v5, so the activity eviction moves to v6; direct upgrades across both boundaries clear the cache once, while v5 clients run the v6 eviction. This prevents pre-lazy-output caches from hydrating legacy embedded command output without downgrading profiles that have already opened v6.

Provider-specific command/file payload parsing, bounded patch extraction, changed-file discovery, and cumulative output/patch merging live in the directly tested `apps/web/src/lib/workLogActivity.ts` module. `apps/web/src/session-logic.ts` retains timeline ordering, lifecycle collapse, subagent-row composition, and the public work-log API.

The desktop identity regression fixture derives its legacy macOS user-data probe through the injected host path service. This keeps the unchanged identity behavior testable on both Windows and POSIX hosts instead of embedding a POSIX-only expected path.

When reconciling `MessagesTimeline.tsx`, preserve both the expandable activity-row behavior and the `hideEmptyPlaceholder` handling used by the draft hero. Neither concern supersedes the other during upstream updates.

Primary files:

- `apps/server/src/orchestration/ActivityPayloadProjection.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/integration/TransferBudgetReport.integration.ts`
- `apps/server/src/orchestration/http.ts`
- `apps/server/test/ActivityPayloadProjection.test.ts`
- `packages/client-runtime/src/state/threadActivityHttp.ts`
- `packages/client-runtime/src/work-log/presentation.ts`
- `packages/shared/src/toolActivity.ts`
- `apps/web/src/connection/storage.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/lib/workLogActivity.ts`
- `apps/web/src/lib/diffRendering.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/lib/workLogEntryDetails.ts`

### Tests Covering The Custom Behavior

Relevant tests live in:

- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- `apps/web/src/session-logic.test.ts`
- `apps/web/src/session-logic.command-output.test.ts`
- `apps/web/src/lib/workLogActivity.test.ts`
- `apps/web/src/lib/diffRendering.test.ts`
- `apps/server/src/orchestration/ActivityPayloadProjection.test.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`

Useful focused commands:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/session-logic.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/MessagesTimeline.test.tsx)
```

## Archive Settings UX

**Worktree branch:** `feat/archive-settings-ux`

The settings Archive panel is intentionally denser than the upstream-style settings rows so large archives remain scannable. The native mobile Archived Threads screen mirrors the same information hierarchy and behavior with mobile-native project sections, swipe actions, long-press menus, and header controls.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default. Active rows accidentally returned by a stale archived snapshot are excluded.
- The Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible.
- Archive snapshot failures remain visible even when another environment loaded successfully. Partial and total failures use the shared error Alert with a keyboard- and screen-reader-accessible retry action; a total failure does not also render a misleading empty archive state, and retry reloads every configured environment.
- Project headers identify every environment when more than one environment is configured and identify a sole remote environment so users can distinguish identical project names and execution locations. A sole primary environment remains implicit, generic primary labels normalize to `This device`, and unknown environment metadata does not produce a misleading label. Web passes the archived snapshot's project name, icon override, favicon path, workspace root, and environment identity to `ProjectFavicon`. Native renders that snapshot favicon beside the environment's machine-kind glyph, and its header can filter to all environments or one configured environment.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, rank partial matches by distinct matched-token count before the earliest token position, and auto-open matching project groups while search is active. Phrase and all-token scores stay bounded within their relevance tiers so long-title position penalties cannot demote a stronger match below a weaker tier. Web and mobile use the same ranking tiers.
- Settings search includes `Archived threads`; selecting it opens this customized panel, focuses the persistent archive search field while the panel is loading, empty, filtered, or populated, and visibly pulses that field without remounting it.
- Native incremental search updates the existing archive list without remounting it for every keystroke, preserving scroll position and transient row state.
- Expanded project headers include aligned sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default. The controls retain explicit pointer affordances and expose sort state through the header semantics.
- Native project-section ordering follows the selected archive sort field and direction. Ascending sections use each project's oldest timestamp and descending sections use its newest, computed in one bounded pass without spreading large timestamp arrays. Missing or invalid timestamps are omitted from native display and sort after valid timestamps in either direction instead of being presented as a different lifecycle date.
- Conversation rows show only the relative archived and created ages inline with the title by default. On web row hover or keyboard-visible row-action focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern without treating ordinary pointer focus as keyboard focus. Native rows keep both age columns visible and expose the same actions through swipe gestures and the standard long-press context menu. The shared `ThreadSwipeable` owns its themed card-surface fallback, while drawer and screen rows keep explicit surface overrides.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first. Web delete actions respect the shared `confirmThreadDelete` client setting when a local dialog host is available and otherwise follow the standard hosted thread-action fallback instead of blocking the action. Native keeps its standard guarded delete flow, and archived-row context menus open only on long press so a normal tap remains available for row interaction.
- Archived-row context-menu action IDs and presentation metadata come from the shared Archive settings logic. Unarchive uses the archive-restore icon, Delete uses the trash icon and destructive styling, and `separatorBefore` distinguishes permanent deletion from restoration in both the web fallback and Electron native menu.
- Web archive-row and project-bulk delete confirmations use the shared themed confirmation dialog through `LocalApi`; they do not fall back to browser-native `window.confirm`. The destructive variants retain explicit labels and copy for single-thread, filtered-project, and full-project deletion, while project unarchive confirmation deliberately uses the dialog's default variant.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete` on web and remain explicitly guarded on native; unarchive bulk actions remain guarded on both surfaces, and partial failures, including interrupted-only outcomes, surface as not-fully-completed feedback instead of implying every archived thread failed. Native bulk actions distinguish genuine failures from rows skipped because the same action is already in progress and report those counts separately. Unexpected native bulk-action exceptions unpack aggregate failures, de-duplicate their messages, and show up to three concrete details with a bounded remainder or generic fallback.
- Archive grouping, search ranking, sort state, and project bulk-action concurrency live in `apps/web/src/components/settings/ArchiveSettings.logic.ts` on web and `apps/mobile/src/features/archive/archivedThreadList.ts` on native. Archived groups retain the complete project shell, including favicon and environment metadata, and expose collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. When a bulk runner throws, it stops scheduling new work, waits for active workers, preserves completed success/failure/skipped counts, surfaces the underlying exception messages, and refreshes the affected environment even after failure.
- Web row and project actions reserve collision-safe per-thread locks before confirmation so overlapping clicks cannot dispatch duplicate mutations. The rendered busy state begins only after confirmation succeeds and includes only the threads owned by actions that actually started, rejected duplicates receive explicit feedback, individual unarchive actions retain their spinner, and project bulk work suppresses per-row archived-snapshot refreshes in favor of one refresh after the attempt. A thrown single-row unarchive or delete rejection is settled and reported through the standard archived-action error feedback instead of escaping as an unhandled promise rejection.
- `ArchiveSettings.tsx` dispatches `threadEnvironment.unarchive` and `threadEnvironment.delete` directly so it owns snapshot refresh timing without extending `useThreadActions`. Successful row actions refresh the affected environment immediately. Successful raw deletes call `discardComposerDraft`, which releases image and file/video uploads before clearing every draft reference.
- Native row and bulk actions use owning collision-safe reservations acquired before confirmation, and their executor identities serialize the environment/thread tuple instead of joining it with an ambiguous separator. While a target is reserved, overlapping swipe, context-menu, row, and bulk controls remain disabled; visible busy indicators begin only after confirmation succeeds. Rejected duplicates cannot release another action's reservation, canceled confirmations release their own targets, and bulk reservations cover the complete target set before the confirmation dialog opens.
- Native settings share the exact `General`, `Appearance`, `Legacy`, `Archive`, and `App` tail in that order for local and Connect-configured modes. The settings contract owns the Archive route and the legacy `waitlist` alias; after the Connect waitlist was retired, that alias opens Sign in while preserving old links.
- Native route ownership is explicit through `SETTINGS_CUSTOM_ROUTE_SCREENS_BY_STACK`: Archive belongs to the `content` collection for the header-owning settings stack, while the waitlist alias belongs to the `auth` collection for the outer authentication stack. `Stack.tsx` registers upstream settings routes, including `SettingsProviderSetup`, before spreading the custom content collection. Archive environment labels use the shared styled tooltip rather than a native title affordance.
- The Archive guide distinguishes settled threads, which remain live and return to Active after un-settle or new work, from archived threads, which remain absent until restore or permanent deletion. The glossary also distinguishes Archive from permanent deletion, and the documentation index links the guide.

Primary files:

- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/ArchiveSettings.test.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/components/settings/ArchiveSettings.logic.ts`
- `apps/web/src/components/settings/ArchiveSettings.logic.test.ts`
- `apps/web/src/components/settings/settingsLayout.tsx`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/lib/composerDraftUploads.test.ts`
- `apps/web/src/lib/composerDraftUploads.store.test.ts`
- `apps/mobile/src/Stack.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/home/thread-swipe-actions.tsx`
- `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`
- `apps/mobile/src/features/settings/settingsContract.ts`
- `apps/mobile/src/features/settings/settingsContract.test.ts`
- `apps/mobile/src/features/settings/settingsRouteScreens.ts`
- `docs/user/archive.md`
- `docs/internals/glossary.md`
- `docs/README.md`

## Conversation Data Savings

**Worktree branch:** `feat/conversation-data-savings`

Archived conversations use cold storage instead of retaining full hot projections and diagnostics in `state.sqlite`.

- Archiving removes the conversation from the active UI optimistically while durable cold-storage work continues in the server background. Failed archive dispatch or post-click navigation reveals the row again, while a successful archive still refreshes the archived snapshot if navigation failed. Web and mobile unarchive actions show a per-conversation loading spinner and disable competing unarchive/delete/swipe actions until the request settles.
- `state.sqlite` keeps only the lightweight archived thread shell needed by the Archive page plus accepted command receipts required for retry idempotency. Those receipts remain hot until permanent deletion so replaying an accepted archive command returns its original sequence. Conversation events, messages, activities, turns, checkpoints, plans, session/runtime rows, and content attachments are written as bounded gzip-compressed chunks in the separate `archive.sqlite` database, then removed from hot storage. Pin state remains lightweight shell metadata and survives archive and unarchive.
- Magi participant sessions and every owner- or run-keyed Magi projection follow the same cold-storage boundary, including runs owned by native subagents. All manifests in that mixed lineage use the ordinary conversation's lifecycle root, so archive, unarchive, and a later rearchive operate on one tree. Existing version-1 cold bundles are upgraded in place by appending only their Magi chunks, preserving the already-compressed transcript and attachment chunks.
- Content attachments are part of the archive bundle and return on unarchive. Attachment collection follows exact ids persisted in thread messages, while retry cleanup may reuse exact attachment chunk filenames already recorded in the cold bundle; normalized thread-name collisions cannot claim another thread's files. Provider diagnostic logs and terminal history logs are deliberately destructive on archive: they are deleted, never copied into the bundle, and never restored. Provider-log cleanup derives the thread-log prefix from the configured provider event-log filename and matches only the exact thread log and its numeric rotations so similarly prefixed thread ids are not affected.
- Cold restore preserves binary SQL values, validates attachment entry names, and atomically replaces attachment files before marking SQL rows restored. It keeps compressed chunks authoritative on failure, pages chunk reads to bound memory, rejects unknown tables/chunk kinds, and intersects archived row columns with the current schema so older bundles remain recoverable after compatible migrations.
- Permanent thread deletion removes the shell, event stream, command receipts, every thread-owned projection/runtime/checkpoint row, attachments, terminal history, provider logs and rotations, and any cold-archive manifest/chunks. Exact attachment ownership metadata remains available until external attachment and provider-log cleanup succeeds, after which the SQL and cold-chunk rows are removed; cross-thread plan references are cleared rather than leaving dangling ids, and the durable cleanup-queue entry is retained until filesystem cleanup and free-page reclamation succeed so interrupted deletes retry safely.
- Project removal explicitly opts archived shells into deletion even when no live rows are visible in the sidebar. Grouped project removal derives each member's command options from that member's own live-thread set, so mixed groups force-delete only members with known live threads and use archived-only cleanup for the others. Grouped-project title updates occur only after a real edit and only when at least one member title differs. The server still rejects an unseen live thread, and both sidebar variants warn that archived conversation history is included for single projects and grouped projects. Removal emits the same subagent-aware per-root deletion events for archived shells, so already-cold thread trees pass through the durable lifecycle worker and lose their hot shells, archive manifests, and compressed chunks before cleanup completes.
- Archive/delete filesystem work runs through a durable background lifecycle queue so command acknowledgement and the UI are not blocked by compression or large cleanup operations. Archive and restore lifecycle work is serialized per project tree, with reference-counted idle-lock eviction after the final user or waiter. Archive creation uses a retry-safe two-phase boundary: compressed chunks and hot-row deletion commit before the manifest enters `cleanup_pending`, and destructive attachment/log cleanup must finish before it becomes `cold`. Destructive archive transitions recheck the archived shell inside the transaction, then quiesce the provider, terminal, and provider-log writers while still holding the same tree lock used by restore. A stale archive job therefore cannot stop a thread that became active while it was waiting or close a preview reopened after unarchive. Successful provider quiescence clears process-local background liveness before terminal and log cleanup, while a skipped stale job leaves that liveness intact. The cold bundle captures the post-quiescence session and user-input state, including stopped pending-input turns and their resolved activities. The public `archiveThread` boundary normalizes typed quiesce failures to `ThreadColdStorageError`, while mismatched or unexpected failures remain attached as a bounded cause instead of escaping the lifecycle error contract. Provider shutdown also remains required while the projected session is `starting` or `running`; a missing provider binding is terminal for a settled or absent projected session, allowing legacy subagent shells that never owned a provider binding to archive or delete safely. Archive codec, unknown-table, and unknown-chunk-kind failures retain structured tagged errors. Failed lifecycle work requests one coalesced delayed rescan of the durable pending state instead of being dropped or introducing a permanent polling loop, enqueue interruptions release their deduplication reservation, and restart recovery preserves the same retry boundary. Incomplete cleanup, including a `cleanup_pending` manifest whose archived shell has already been removed, and archived shells missing a manifest resume without rebuilding an already durable bundle.
- Destructive deletion fails closed before SQL or cold-storage removal when provider stop, terminal close, or provider-log writer shutdown fails. The durable cleanup entry remains retryable, so operational cleanup failures cannot silently delete the remaining conversation state. Every filesystem failure except a genuinely missing directory retains durable retry state.
- A stale restored reservation cannot overwrite a newer archive epoch, missing lifecycle queue rows are reconstructed from manifests and shells during recovery, and an unavailable environment catalog does not cause live thread references to be treated as absent. Process-local restore ownership distinguishes an actively restored root from an orphaned `restored` manifest; startup recovery re-archives orphaned restore reservations discovered after a restart while leaving a restore still owned by the current process alone.
- `OrchestrationEngine` stamps optional dispatch-client origin metadata onto every planned event before persistence. Unarchive restores `cold`, `restored`, or `cleanup_pending` bundles before dispatching the domain command. Still-hot archived rows receive a `restored` manifest reservation before the archive-tree lock is released, preventing queued lifecycle work from moving them cold between the restore check and the command commit. Each reservation is scoped to its original archive timestamp, so a later archive epoch can replace a stale `restored` manifest and move its hot rows cold even if earlier restore finalization failed. A transient restore failure returns an error without writing a rejected command receipt, allowing the same command id to retry after storage recovers. Partial restore failures roll back restored rows and files, and the restore transaction commit is masked against interruption so committed data cannot be mistaken for a failed restore. A rejected or failed command re-archives restored or reserved rows and files, while a successful command finalizes the cold bundle only when that request actually performed a restore; replaying an already accepted unarchive command retries that finalization so a prior cleanup failure cannot strand restored archive data. This prevents unrelated or already-hot unarchive commands from deleting archive data. If storage cannot restore or reserve the archived conversation, the command is rejected before an active-shell event can commit. Once SQL restoration commits, later publication or metrics failures cannot re-archive the restored data.
- The standalone conversation-data-savings branch adds one `048_ThreadStorageLifecycle` migration directly after `base/main`; it creates the complete archive manifest, maintenance, and cleanup-queue schema and queues existing archived and deleted threads. `fork/main` preserves its already-run development history instead: migration `035_ThreadColdArchive` registers archived conversations, `036_DeletedThreadCleanupQueue` registers deleted conversations, and `037_SubagentColdArchiveGlue` applies lineage-aware grouping. Migrations 38 through 47 preserve or rehome the overlapping upstream settlement, snooze, title, pinning, keyset, project-mode, favicon, and lifecycle compatibility work. Magi remains recorded in the same `effect_sql_migrations` ledger at 48 through 50, followed by Magi archive glue and rehomed upstream work at 51 through 59. Migration 60 performs the final idempotent convergence, restores canonical Magi ledger rows after experimental histories, and removes the abandoned `effect_sql_magi_migrations` table if it exists. Startup recognizes the exact divergent upstream history and misplaced historical Magi rows before canonical replay. The dev-database migration command validates the single manifest. Parent relation remains published at 33, and root-id backfill at 34 first ensures those lineage columns so a database recorded only through upstream settlement migration 33 also converges safely.
- After the legacy queues drain, a retryable one-time `VACUUM` physically compacts `state.sqlite` and enables incremental auto-vacuum. Compaction remains pending while archive or delete lifecycle work is still discoverable, including jobs waiting for retry. Later lifecycle operations reclaim bounded free-page batches from both `state.sqlite` and `archive.sqlite`, avoiding a full compaction on every archive.
- Normal provider, server, trace, and terminal logging behavior is unchanged. Space is reclaimed at the conversation lifecycle boundary instead of by weakening diagnostics for active work.
- Mobile Archive rows omit missing or invalid lifecycle timestamps and sort those rows after valid timestamps in either direction rather than substituting the conversation creation time. This integrated behavior intentionally supersedes the standalone Archive branch's older creation-time fallback. HTTP-seeded shell subscriptions also buffer archive removals published while WebSocket replay catches up, so an authoritative shell snapshot cannot race with a live removal.
- Persisted web and mobile shell state is a fast-paint cache only. HTTP provides an early shell snapshot, while completion-capable WebSocket sessions revalidate it with a socket-owned snapshot after live buffering begins. A ready-to-ready authorization refresh hands the old ready session directly to its replacement without publishing a disconnected state, retains the authoritative baseline during replacement synchronization, and applies removals only from the replacement's authoritative snapshot. Foreground wakeups on those sessions request the same socket-owned snapshot instead of trusting an in-memory cursor, while reusing the live RPC session avoids another HTTP load. Initial replay and deferred active-thread cache writes complement that reconciliation instead of making persisted shells authoritative. A `thread.archived` detail event or authoritative archived detail snapshot evicts its persisted snapshot through `evictCachedThread` and prevents deferred writes from restoring it; successful local archive acknowledgement invokes the same eviction after route teardown, while `makeEnvironmentShellState` also evicts detail snapshots before publishing shell removals from events or authoritative snapshot reconciliation. Per-thread cache generations, eviction tombstones, and write locks are shared across those paths while `makeEnvironmentThreadState` is retained, so queued and idle-finalizer writes cannot recreate an evicted snapshot; shell additions and `thread.unarchived` detail events call `reviveCachedThread` to make the cache writable again, invalidating writes captured while the tombstone was active without invalidating unrelated active writes. Web IndexedDB migration version 5 and mobile SQLite migration version 2 each clear legacy thread-detail caches once so conversations archived before this behavior do not retain stale hot copies; active details repopulate on demand.
- Retained detail subscriptions continue retrying through archive eviction while they remain retained, allowing an existing consumer to observe a later unarchive instead of becoming permanently stranded behind the cache tombstone. Unrelated transient subscription failures retain their normal bounded retry behavior.
- Preview guest cleanup follows authoritative thread lifecycle events instead of depending only on current shell membership. Archive cleanup closes guests only after eligibility is revalidated inside the serialized archive-tree lock, delete cleanup remains durable, and `thread.unarchived` closes any stale preview left by a fast archive-to-unarchive race. Web cleanup reconciles live-environment shell changes, preserves disconnected environments until their catalog is authoritative, and uses generation-aware shell synchronization so a stale snapshot cannot close a revived thread's previews or leak removed-thread guests.
- Failed persisted-detail eviction remains pending while the authoritative shell continues to omit the thread and retries during later reconciliation instead of being forgotten. An authoritative active snapshot revives the cache tombstone before persistence, so a thread restored outside the local client can repopulate its detail cache without allowing stale pre-eviction writes through.
- Optimistic and persisted archive filtering occurs before project activity sorting and before pinned, active, snoozed, and settled partitioning. It preserves environment-scoped provider metadata, unsettled timestamp re-anchoring, pinned drag ordering, project rows and statuses, keyboard navigation, and prewarming. Command-palette production builders receive the filtered thread set while retaining each project item's environment identity and workspace path, so an archived conversation cannot remain visible or become the latest project target through a secondary list model while durable work finishes.
- Command-palette project search indexes the displayed location fallback as well as configured location labels, so projects rendered as `Remote` remain discoverable by that text even without explicit environment metadata.
- Unsent composer drafts remain local when their thread is archived. Successful local archive acknowledgement and authoritative remote shell removal release transient pending image and file/video uploads; reopening the draft starts new uploads instead of reusing released handles.
- Production orchestration supplies live `ThreadColdStorage`. Isolated orchestration harnesses that do not exercise archive persistence use `ThreadColdStorage.noOpLayer`; the orphaned-provider-session startup integration test relies on this boundary.
- `t3-sqlite-state` defaults to the hot state database, derives state and archive paths from the shared server configuration, and supports `--database archive` as the read-only inspection path for application-managed cold archive manifests and chunks. Archive and restore mutations must use application commands rather than direct bundle writes.

Primary files:

- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/composerDraftArchiveObserver.tsx`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/browser/usePreviewThreadLifecycleCleanup.ts`
- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/server/src/orchestration/ThreadColdStorage.ts`
- `apps/server/src/orchestration/testUtils/orchestrationEngine.ts`
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`
- `apps/server/src/persistence/Migrations/035_ThreadColdArchive.ts`
- `apps/server/src/persistence/Migrations/036_DeletedThreadCleanupQueue.ts`
- `apps/server/src/persistence/Migrations/037_SubagentColdArchiveGlue.ts`
- `apps/server/src/persistence/Migrations/040_ProjectionThreadTitleRegeneration.ts`
- `apps/server/src/persistence/Migrations/041_ThreadColdArchiveCompatibility.ts`
- `apps/server/src/persistence/Migrations/047_ThreadStorageLifecycleCompatibility.ts`
- `apps/server/src/persistence/Migrations/051_MagiThreadColdArchiveGlue.ts`
- `apps/server/scripts/t3-sqlite-state.ts`
- `packages/client-runtime/src/state/shell.ts`
- `packages/client-runtime/src/state/threadCache.ts`
- `packages/client-runtime/src/state/threadCommands.ts`
- `packages/client-runtime/src/state/threads.ts`
- `apps/web/src/connection/storage.ts`

## Thread Detail Subscription Reliability

**Worktree branch:** `fix/thread-not-found-subscription-loop`

Thread-detail synchronization distinguishes an authoritative missing resource from a transient snapshot failure across HTTP loading and bounded WebSocket snapshot fallback so stale thread state cannot enter an unbounded subscription retry loop.

Expected behavior:

- Clients dual-advertise `ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY`, whose exact value is `orchestration.thread-not-found-error.v1`, and the deprecated `threadNotFoundError` boolean. Capability names remain an open string list. The server emits `OrchestrationThreadNotFoundError` only for either opt-in; older servers may emit the still-decodable transient `OrchestrationGetSnapshotError`.
- `packages/client-runtime/src/errors/orchestration.ts` is the canonical terminal classifier for both transports. It recognizes an HTTP `EnvironmentResourceNotFoundError` whose reason is `thread_not_found` at any typed expected-failure position in a combined cause and the WebSocket typed error. Standalone defects and unrelated expected failures remain transient.
- An authoritative missing result clears the persisted detail cache and marks client state deleted. Cache removal and snapshot persistence use the same serialization lock, and persistence rechecks deleted state under that lock so queued or in-flight saves cannot resurrect the thread.
- The missing-thread subscription terminates before opening or retrying its WebSocket stream. Live delivery begins before fallback snapshot loading, but a missing fallback snapshot terminates the subscription before any buffered live event or synchronization marker is emitted. Resumed subscriptions re-advertise the capability, and terminal missing state wins over session replacement, reconnect, and foreground wakeups.
- A known local draft does not start its server-detail subscription until the shell observes `thread.created`, so the expected pre-creation HTTP 404 cannot mark the draft deleted and the new shell starts fresh synchronization after the first send. Draft-store detection or explicit `waitForShell` enables this guard, and lookup stays keyed by the reserved thread reference across current-checkout or new-worktree mode changes.
- Every direct web thread-detail consumer, including the server-thread route, uses the ready-state gate for both detail and status state so local drafts cannot bypass the pre-creation subscription guard. The explicit route renders loading while that gate is closed, the thread view only after detail and status are ready, and a missing state only after an authoritative ready result.
- `classifyThreadDetail` produces the canonical `ThreadDetailClassification`; `resolveThreadDetailRef`, `useThread`, and direct route detail and status lookups consume it. It returns a subscribable reference only when the shell is ready, while explicit wait-for-shell callers and known local drafts remain gated without duplicating route-specific readiness rules.
- Once thread state is deleted, subscription input creation fails closed both before and after synchronization setup, preventing foreground wakeups or replacement sessions from reopening the stream.
- Other HTTP snapshot failures remain transient and fall back to the socket snapshot path. Other WebSocket snapshot failures remain transient and retain the existing bounded retry behavior.
- Initial detail snapshots retain the server-advertised bounded turn window and request older pages explicitly. Page merges, cache generations, archive tombstones, and foreground resume share one serialized state path so pagination cannot revive an evicted snapshot or let an older load overwrite a newer window.
- Completion-marker sessions request an authoritative socket snapshot before treating an in-memory cursor as resumable. Once that socket snapshot establishes the session, later same-session foreground resumes use the current cursor without entering a reconnect loop.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/rpc.test.ts`
- `packages/client-runtime/src/errors/orchestration.ts`
- `packages/client-runtime/src/errors/orchestration.test.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.ts`
- `packages/client-runtime/src/state/threadSnapshotHttp.test.ts`
- `packages/client-runtime/src/state/threads.ts`
- `packages/client-runtime/src/state/threads-sync.test.ts`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/newThreadSubscriptionGate.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`

## Codex CLI installation-aware updates

**Worktree branch:** `fix/codex-installation-aware-updates`

The fork chooses the Codex update command from the resolved CLI installation instead of assuming every unrecognized `codex` command came from npm.

Expected behavior:

- A resolved or canonical Codex executable inside an npm global installation uses `npm install -g --allow-scripts=@openai/codex @openai/codex@latest`. npm detection includes canonical module paths, `%APPDATA%\npm` shims in both default and redirected profiles, and direct `.cmd` or `.ps1` shims under `C:\Program Files\nodejs` and `C:\Program Files (x86)\nodejs`.
- Existing Vite+, Bun, pnpm, and Homebrew installation detections keep their package-manager-specific update commands.
- Default commands, unresolved bare commands, and bare commands whose resolved path matches no package-manager classifier—including the Unix and Windows install-script locations—use `codex update`. Explicit unclassified paths use `<configured-path> update`.
- Displayed update commands quote the executable and every argument with PowerShell syntax on Windows and POSIX-shell syntax elsewhere; one-click execution retains the original structured executable and argument values.
- Provider status snapshots persist the selected command in `<t3-home>/caches/codex.json`.
- Package-managed provider definitions may omit `fallbackUpdate`. Omission keeps the standard resolver behavior: a missing binary path and any unmatched bare command use npm, while explicit unclassified paths have no one-click update. Codex opts into self-update; Claude and OpenCode retain the standard omitted-fallback behavior.

Primary files:

- `apps/server/src/provider/providerMaintenance.ts`
- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/server/src/provider/Drivers/CodexDriver.test.ts`
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- `apps/server/src/provider/Drivers/OpenCodeDriver.ts`
- `packages/shared/src/shell.ts`

Focused regression coverage lives in `apps/server/src/provider/providerMaintenance.test.ts` and `apps/server/src/provider/Drivers/CodexDriver.test.ts`. It protects resolver precedence, omitted fallback behavior, npm shim classification, platform display rendering, and Codex-specific selection.

## Subagent Threading Work

**Worktree branch:** `feat/subagent-threading-work`

The Codex subagent-threading work is integrated on `fork/main`; the active worktree remains its maintenance owner. Treat Codex subagent lineage, child-thread projection, the default Sidebar's running-descendant/live-task counter and Agents-panel navigation, Legacy Sidebar and mobile lineage rows, child-thread output isolation, child stop behavior, provider-control failure isolation, parent metadata ingestion, and related tests as part of the fork's customization set during upstream updates.

Upstream's native observability and the fork's persisted child routing are complementary. Preserve `CodexAdapter`'s `collabAgent/*` to `task.*` mapping when reconciling upstream changes, then layer the fork's child-message routing and output isolation around it. `CodexSessionRuntime` must keep both outputs from registered child activity: the synthetic `collabAgent/*` event for the Agents roster and the original lifecycle event routed to the deterministic local child thread with `subagentChildren`/`parentCollab` metadata. Dropping either output breaks one of the two consumer surfaces. Focused adapter and runtime coverage must exercise both outputs so the Agents roster and persisted child navigation cannot regress independently.

Thread archive/delete lifecycle behavior is enforced server-side in the orchestration decider and documented in `SUBAGENTS.md`. The sidebar treats those operations as root-thread lifecycle actions, hiding the row actions for subagent children and failing closed when a selected thread key no longer resolves before multi-select delete.

The upstream default Sidebar integration keeps only a non-disclosing subagent indicator on root conversation rows. It contains the greater of the recursive count of persisted running descendants and the server-projected live provider-agent count, with no arrow; clicking it navigates to that root conversation when necessary and opens its Agents right-panel surface. The row tooltip repeats that running count in its own subagent status line. The live-task fallback covers provider-native agents before or without a separately navigable child shell. Bounded settled-task tombstones prevent late progress from reviving a settled count, while an explicit `running` or `waiting` update reopens an idle resumable agent without reopening a hard-terminal task. Default Sidebar rows never render descendants, including the exact terminal child currently open, so the Agents panel is the one roster and navigation surface. Root lifecycle actions continue to own the hidden descendant tree.

Standalone subagent conversation visibility is default-off behind the `Subagent conversations` toggle in Settings → General. While off, the Agents panel remains the upstream-compatible lifecycle roster but its rows are not conversation links; Default Sidebar search, the command palette, and Legacy Sidebar omit child navigation; and direct child routes return to the direct parent without subscribing to child detail. Enabling the toggle restores those web navigation surfaces. Lightweight child shells, lineage, recursive running counts, and root-owned archive/delete behavior remain active regardless of the preference, because those are required for agent observability and lifecycle correctness and may be shared with another client.

When standalone visibility is enabled, Default Sidebar search traverses complete depth-first lineages from active, snoozed, and settled roots in lifecycle order after logical-project scoping, so matching nested or terminal descendants remain navigable even though the normal list renders root rows only.

Web lineage traversal, recursive counts, search, and root classification live in `SidebarSubagents.logic.ts`, while `SidebarSubagentThreadRow` layers the fork's Agents indicator onto the upstream-shaped row model. Logical-project selection passes the memoized complete member-key set into `selectSidebarProjectLineageThreads(...)` before any lineage operation, and focused lineage coverage lives in `SidebarSubagents.logic.test.ts`.

Keep pending tasks outside `buildVisibleThreadLineage(...)`; recent, fallback, and active-row lineage flows through `selectRecentThreadLineage(...)`. Grouped navigation scopes `threadsForGrouping`, not raw shells, so a detail-synthesized selected child survives. `getLatestThreadSortTimestamp(...)` supplies the shared member aggregation and malformed-timestamp behavior for web and mobile; web falls back to the project timestamp for an empty list. Pin ordering and reorder capability gating operate on filtered roots before descendants are flattened, and `SidebarSubagentThreadRow` remains a narrow running-count decoration rather than absorbing draft or project-settings row structure.

Mobile Thread List v2 applies contextual visibility before active, settled, and snoozed partitioning, retains only the exact selected terminal shell without promoting it or restoring hidden terminal ancestors, keeps terminal descendants searchable as navigation-only rows, carries stored depth into rendering, and rebases filtered search rows. Settled and snoozed lineages remain atomic across pagination and shelves; collapsing Settled hides complete groups while the exact selected settled child remains navigable. Snoozing a root retains eligible running descendants, depth, counts, and expansion while only the root receives wake metadata. Independently snoozing a nested child shelves and rebases only its subtree. Snoozed counts, shelf membership, and wake metadata remain search-scoped. Each conversation with running descendants shows a recursive running total, nested generations start collapsed, and expanding one row reveals only eligible running children as compact status rows at stored lineage depth. Root lifecycle actions stay hidden from all subagent rows, and pin keys order complete root-lineage groups.

Logical project scopes include every grouped member project reference before lineage is classified or rendered. Parent and child shells associated with stale and canonical ids for the same physical project remain in one nested path on web and mobile, while unrelated logical groups remain excluded and new-thread targeting resolves back to the canonical project. Mobile home and thread-navigation rows resolve the logical group title across every member reference instead of displaying a stale member title.

Child runtime events that arrive with parent-collab metadata may synthesize the missing child shell before their output/actions are ingested. `makeSyntheticSubagentThreadShell(...)` is the only constructor for these shells: it inherits parent project, model, runtime, interaction, branch, and worktree context; resets child-owned lifecycle, session, activity, and presentation state; and satisfies `Required<OrchestrationThreadShell>`. Title generation runs only while a child retains its seed or generic `Subagent` title, persists the result on that shell, and scopes agent-id lookup to the active environment and root lineage after opt-in. Child stop requests must target the selected child turn when known, and if no active child turn can be identified the server records a child interrupt failure and marks the child stopped instead of falling back to the root session's active turn. Provider-control diagnostics are best effort during projected-state cleanup: failed diagnostic appends are counted and logged without preventing child relation/session cleanup or root session-stop terminalization after a failed provider request.

Provider-native activity that does not represent Codex collaboration lineage, including Antigravity task batches, remains on its existing presentation path and does not become a persisted child conversation.

Child conversation parent navigation is composed through `WorkspaceBreadcrumb`'s optional `trailingAction` slot. Keep that control outside the ordered breadcrumb list so the current thread retains `aria-current="page"`, while preserving the existing callback, accessible label, tooltip, and conditional visibility.

`resolveRightPanelControlsOwner(...)` is the placement seam for title-bar controls: the root owns them while an inline panel is present, an open sheet owns them in sheet layout, and the chat header is the fallback. `apps/web/src/components/chat/SubagentControlBar.tsx` owns the standalone web child's status and stop action without duplicating that UI in the composer. The mobile control of the same name owns its reserved height, and `ThreadDetailScreen.tsx` selects it instead of the normal composer for child shells.

The upstream Agents right-panel surface is retained with its stabilized fixed-height rows, while the fork indexes persisted child shells by provider-thread identity only after standalone conversation visibility is enabled. Direct-agent branches with running work sort above idle and finished branches; descendants render immediately below their parent with the same capped indentation rhythm previously used by the default Sidebar. With standalone visibility enabled, resolved agent rows use the child's persisted title and navigate directly to the environment-scoped child conversation; otherwise the provider rows remain visible but non-interactive. Root-only settle, snooze, archive, and delete actions are hidden for children and rejected again if a stale native menu returns one, while pinning, rename, title regeneration, mark-unread, copy, and branch actions remain available. Pinned lineages sort by their representative pin key before flattening so descendants never detach or promote themselves above their root.

The opt-in Legacy Sidebar applies the same root-only archive/delete boundary. Single-row and bulk handlers re-read the latest shells after native menus and confirmation dialogs, reject changed or unresolved selections, clear stale confirmations, and retain process-local working/monitoring guards before archive dispatch.

The activity transport projection is part of this ownership boundary. It must retain ordered collab output, prompt-bearing inputs, lifecycle identity, parent metadata, distinct resumed-child references, and the live provider-agent count while pruning unused provider payload fields. Those child references support persistence and routing only: the parent timeline must filter the fork-specific reference rows and render upstream's single `Ran x subagent(s)` activity box, including token usage and the Agents-panel action, as its sole subagent visualization. `SUBAGENTS.md` remains the detailed contract.

Projection bootstrap replays the complete event backlog rather than stopping at the default read-page limit. `mapThreadSharedFields(...)` in `ProjectionSnapshotQuery.ts` is the single read and fold-back seam for full snapshots, command read models, shells, and detail; keep `parentRelation` non-optional. `mapThreadParentRelationFields(...)` in `ProjectionPipeline.ts` is the single write mapping used by both `thread.created` and `thread.meta-updated`. Both preserve root, native-subagent, and Magi lineage fields; keep explicit SQL reads and upsert conflict guards aligned with them. The canonical migration ledger for these fields is documented under Conversation Data Savings and must not be replaced with the branch's obsolete pre-integration numbering.

The standalone subagent branch adds one `048_ProjectionThreadParentRelation` migration directly after `base/main`. It contains the complete lineage columns, root backfill, and indexes. Only `fork/main` retains the earlier 33 through 34 lineage history and its later convergence migration because those intermediate builds ran against the fork's development databases.

Projected provider-agent activity is reconciled against persisted child-thread lifecycle state even when standalone subagent conversations are hidden. A persisted terminal child therefore settles a stale projected running row without requiring the child shell to appear in navigation.

`SUBAGENTS.md` remains the complete implementation contract. This section records the integration seams needed during fork assembly; keep the subagent threading work unless `upstream/main` has gained an equivalent UI-aware subagent architecture, then reconcile against the detailed note.

Primary reference:

- `SUBAGENTS.md`

## Magi Consensus Orchestration

**Worktree branch:** `feat/magi-consensus-orchestration`

Magi is an implemented fork feature for provider-neutral, weighted consensus owned by one exact T3 conversation. A user-facing root can arm its next turn, and eligible ordinary agents—including persisted provider-native subagent conversations—can start Magi after an explicit user request. Active-run exclusion is per exact conversation, so a parent and its native child or sibling conversations may run Magi concurrently; Magi participant conversations remain ineligible. Control-tool routing reads only the credential owner's persisted provider binding, never enumerates all live and durable sessions, and fails within a bounded deadline if routing state cannot be loaded. Every configured participant remains in the roster. Provider or model unavailability returns control to the arbitrator before dispatch instead of silently excluding that participant. `magi_get_options` returns only availability and validation data; it never exposes or supplies the panel's remembered run configuration. Complete projection replay must retain Magi lineage even when the event backlog exceeds the default read-page limit. `MAGI.md` is the detailed product contract, architecture record, completed checklist, verification plan, drawbacks, and acceptance source.

Projection integration:

- `ProjectionThreads`, `ProjectionPipeline`, and `ProjectionSnapshotQuery` preserve Magi lineage and `activeMagiRun` alongside `linkedPullRequest` and `unsettledAt` through SQL columns, row schemas, read models, shells, and payloads. Bootstrap uses complete paged replay, with regression coverage beyond 1,000 events.
- The standalone Magi branch adds one `048_MagiProjections` migration directly after `base/main`, containing its final schema, uniqueness rule, and proposal terminology. `fork/main` preserves the Magi migrations already recorded at core IDs 48 through 50 and uses core migration 60 for WIP-history convergence. Every migration uses `effect_sql_migrations`; do not restore a feature-specific ledger.

Provider and completion integration:

- `ProviderService` and its fixtures retain both eager Magi `subscribeEvents` and core `uploadFeedback`. The WebSocket dispatcher arms first-message Magi before `dispatchFromClient`.
- Codex runtime and adapter paths preserve Magi context usage, explicit compaction, and feedback. Provider-native collaboration does not become Magi, and Magi participant conversations cannot start nested runs. Claude automatic compaction reports into Magi; do not restore the removed simulated trigger.
- `CheckpointReactor` retains participant Git and checkpoint handling but skips participant PR discovery and global invalidation. The owning root performs the single refresh.
- `AntigravityAdapter` declares the shared ACP Magi profile and normalizes session start and turn input through `ProviderMagiProfile.ts`, like Cursor and Grok. `ProviderMagiConformance.ts` lists every built-in driver; an adapter without a declared `magi` capability makes each of its instances report "Provider has not passed Magi conformance." in the Magi roster.

Client ownership:

- Shared environment selection and access live in `EnvironmentSettingsPanel*`; `ProviderSettingsPanel.logic.ts` remains a compatibility adapter. `SettingsListDetail.tsx` owns the shared list and editor structure.
- `useMagiRunHistory` owns the latest summary, expanded 100-run subscription, and transition behavior. Only the expanded query live-polls. `ChatView` passes the selected summary to the panel and timeline; the timeline must not query independently or fabricate a thread id.
- Web and mobile share `MagiConsensusIcon`. It uses `withUniwind(Svg)`, `currentColor`, `accent-icon`, and explicit overrides, and remains outside the theme escape-hatch allowlist.

Primary reference:

- `MAGI.md`

Supporting operational and security references:

- `MAGI_ARBITRATOR_CODE_REVIEW.md` defines the complete review-and-fix arbitration example, including roster preflight, evidence requirements, proposal handling, and the final consensus condition.
- `MAGI_ARBITRATOR_PLAN_REFINEMENT.md` defines the document-refinement arbitration example and keeps that workflow separate from implementation authorization.
- `MAGI_PERSONALITY_CODE_REVIEWER.md` is the complete participant review rubric used by the code-review example; a pointer to an explicit-only provider skill is not a substitute for supplying its contents.
- `apps/server/src/magi/THREAT_MODEL.md` records Magi's prompt-injection, credential, tool-access, denial-of-service, cancellation, and durable-audit-data trust boundaries.

### Dev-server testing

When verifying Magi in a dev server, use these participant settings:

- Codex: GPT-5.6 Luna, low reasoning, fast mode off
- Claude: Sonnet 5, low reasoning, 200k context window
- Cursor: Grok 4.6, low reasoning, fast mode off
- Antigravity: Gemini 3.8 Flash Low

## Default Sidebar Archive Controls

**Worktree branch:** `feat/sidebar-v2-archive-controls`

The default Sidebar preserves archive as a separate lifecycle from settle. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus, while root conversation context menus in the default Sidebar and chat header expose archive for settled and unsettled rows. The Legacy Sidebar uses the same shared policy. Archive remains visible but disabled during provider-session startup, an active turn, or native background `working` or `monitoring`; a starting session is active even before it has an active turn id. Nested subagent rows continue to omit root lifecycle actions.

Archive eligibility also treats process-local `working` or `monitoring` liveness as active work even after the projected turn settles. Row, selection, and archive-all paths recheck that guard before mutation, and stale native menu results cannot bypass the root-only boundary.

Disabled archive buttons remain the pointer target so clicks cannot fall through to row navigation. Every default-sidebar, chat-header, and Legacy Sidebar entry point uses one process-wide reservation pool keyed by the collision-safe target identity, preventing duplicate confirmations or mutations until the current action settles.

Blocked archive controls keep pointer targeting while presenting a not-allowed cursor and muted hover tone. Legacy multi-selection rechecks each entry immediately before mutation, continues with eligible siblings, removes only successfully archived entries from selection, keeps intentional eligibility skips selected, and reports those skips without treating them as failures.

Header, row-menu, selection, and archive-all entry points share one process-wide archive coordinator, so overlapping callers observe the same reservations and completed outcomes. Disabled archive controls remain focusable and pointer-interactive for their styled explanation tooltip, expose `aria-disabled`, stop row or shelf propagation, and never dispatch the archive action while ineligible.

The `Settled` section header includes an `Archive all` action alongside upstream's collapsible settled and snoozed shelves. Its disabled button remains the pointer target so clicks cannot fall through to the settled shelf, and the affordance stays mounted while an active batch has optimistically removed the last archivable row. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination and pinned rows that upstream classifies as settled, and remains available when the list begins with settled conversations. Individual, selected, and all-settled archive actions honor the shared archive-confirmation setting, use the existing optimistic visibility and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove archived rows from any active selection, and report failures without implying that completed archive work was rolled back. Coordination lasts from confirmation through mutation. Overlapping flows reserve uncontested siblings before waiting for an earlier owner so a later caller cannot stale the confirmed scope; they publish each successful archive and intentional eligibility skip to waiters as soon as it is known even if a later entry throws, omit entries another owner completed by either outcome, retry entries that were cancelled, failed, or never attempted, and recheck live running eligibility immediately before each mutation. `Archive all` additionally rechecks settled-partition membership; entries that become active or are un-settled while a flow waits are skipped without aborting eligible siblings, with warning feedback that says they are no longer eligible rather than assuming they became active.

Ownership and merge boundaries:

- `SidebarArchiveControls.tsx` owns settled-row controls and the shelf divider; `SidebarArchiveControls.logic.ts` owns sidebar-only eligibility and presentation. `threadArchive.logic.ts` owns shared active-work policy, outcomes, and process-wide coordination. `useThreadArchiveActions.ts` owns confirmation, coordination, reporting, individual actions, and selection cleanup; `useSidebarArchiveActions.ts` adds selected and all-settled rechecks.
- `Sidebar.logic.ts` is a narrow compatibility facade around upstream-owned `Sidebar.tsx`, `LegacySidebar.tsx`, and `useThreadActions.ts`. `threadActionMenu.logic.ts` remains the root-menu composition seam, with `Sidebar.tsx` and `useThreadActionMenu.ts` supplying disabled state and dispatching through the shared hook.
- Upstream retains row wrappers and sizing, pin and drag behavior, filtering and unsettled ordering, and status semantics. The fork keeps the slim settled timestamp crossfade for both lifecycle buttons while `Woke` remains visible, navigation-only rows during title search, lifecycle controls after search clears, and an interactive settled-divider list item. Styled tooltips, including un-settle, replace native `title` attributes, and row-level tooltip wrapping stays outside the archive control.

Project removal warns that archived conversation history is included. The policy is owned by `ProjectSettingsPanel.logic.ts`; without visible live threads it requests archived-thread cleanup without force, while known live threads continue through the explicit confirmed force-delete path.

Primary files:

- `apps/web/src/components/LegacySidebar.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/Sidebar.test.tsx`
- `apps/web/src/components/SidebarArchiveControls.tsx`
- `apps/web/src/components/SidebarArchiveControls.test.tsx`
- `apps/web/src/components/SidebarArchiveControls.logic.ts`
- `apps/web/src/components/SidebarArchiveControls.logic.test.ts`
- `apps/web/src/components/threadArchive.logic.ts`
- `apps/web/src/components/threadActionMenu.logic.ts`
- `apps/web/src/components/threadActionMenu.logic.test.ts`
- `apps/web/src/hooks/useThreadActionMenu.ts`
- `apps/web/src/hooks/useThreadArchiveActions.ts`
- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/hooks/useThreadActions.test.ts`
- `apps/web/src/hooks/useSidebarArchiveActions.ts`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`

## Version Control Panel Work

**Worktree branch:** `feat/version-control-panel-work`

The first-class Version Control panel is integrated on `fork/main`; the active worktree remains its maintenance owner. Treat the Version Control singleton right-panel surface, its native mobile screen, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, review-patch construction, and Version Control panel RPC/contracts as part of the fork's customization set during upstream updates. The native screen reuses the server-authoritative panel RPCs and shared branch/change presentation rules, and is opened from the mobile Git action menu through the explicit `Version Control` action.

Web branch deletion, discard, remote removal, and stash-drop confirmations use the shared themed confirmation dialog, preserving the existing destructive copy and action labels without invoking browser-native confirmation UI. Creating a branch from a commit likewise uses the themed dialog and retains typed input through mutation failures.

Source Control remains available while repository status is loading, but a confirmed non-Git project disables its add-surface action and hides retained Source Control surfaces. This availability guard composes with the fork's Source Control feature flag and preserves visible File-surface fallback behavior.

Upstream's removal of the Plan right-panel surface and addition of the Agents surface are adopted. Version Control remains a singleton alongside Agents, survives migration when an active legacy Plan surface is dropped, and stays unique in both empty-state and add-surface menus. The shared add-surface action model carries badges and pointer affordances: Agents displays its live count, while Version Control intentionally has no badge count.

`rightPanelSurfaceActions.ts` is the canonical descriptor for availability, activation, shortcuts, empty-state and menu order, instance policy, disabled presentation, and badges. Version Control uses `V`, appears first in the empty launcher, and remains last in the compact add menu. `normalizeSourceControlRightPanelPresence` removes only Source Control when unavailable, preserves pull-request and File surfaces, and selects the first remaining visible surface when necessary. Browser runtime-tab resolution, audio, mute-menu, preview mini-player, and Agents reconciliation must leave an existing Source Control surface visible, active, and present exactly once.

On web, a logical project shared across environments exposes one Version Control panel section for each connected environment. `buildSourceControlEnvironmentOption` constructs the environment option shared by toolbar routing and the federated panel. The active environment appears first and stays expanded, while secondary environments start collapsed and mount their complete panel instance only when expanded. Remote sections reuse the default Sidebar server-icon and environment-label treatment, and every snapshot, status subscription, fetch, diff, editor launch, Git mutation, and saved project action remains routed through the instance's own environment and cwd. Multi-environment sections expose the same project-action picker used by the conversation header. Starting an action opens a terminal surface that records the selected environment, project, cwd, and worktree, so later terminal operations stay on that environment while the conversation remains on its original one. Disconnected environments are omitted without placeholders; request failures from environments that remain connected and expanded stay isolated in their normal per-panel error and retry state. Only the active panel receives `activeThreadRef` and may update active-thread source-control metadata, open the active thread's File surface, or route `PublishRepositoryDialog` links; foreign panels receive `null`. When an unavailable Source Control surface falls back to a visible File surface, file cwd and reveal metadata come from that visible surface rather than a hidden active descriptor.

A normal ahead-branch push snapshots connected peers before pushing. A peer that remains clean and synced on the same normalized remote branch is fetched, rechecked, and fast-forwarded afterward; changed, disconnected, differently tracked, or failed peers remain untouched, and peer failures cannot make the completed source push appear failed.

The shared `DiffPanel` tree is in-panel navigation: selecting a tree item reveals that file inside the diff. Only the explicit filename primary action opens the thread's default File surface. A sibling-worktree preview retains its own cwd, allowing identical relative paths from different worktrees to coexist in separate File tabs.

Preserve the branch-local idle-power safeguards for VCS status: ignore internal `.git/` watcher events before refreshing local status; debounce and deduplicate the remaining watcher paths before classifying the complete batch with one `git check-ignore -z --stdin` subprocess; and keep the default automatic remote Git fetch interval conservative unless upstream provides equivalent lower-churn VCS status behavior. `CanonicalPath.ts` supplies native-first identity for existing paths, with portable and original-input fallbacks; Git common-directory caches, status caches, and worktree comparisons therefore treat Windows long and 8.3 aliases as one repository without making missing paths fatal.

The resolved default background policy remains a custom profile based on the balanced preset with automatic Git fetch at five minutes. Normal Git intervals for performance, balanced, and battery-saver are 15 seconds, 30 seconds, and disabled; panel all-remotes intervals are one minute, five minutes, and disabled. Automatic panel fetches require retained Git-ref demand and obey the owning environment's shared lock, low-power, battery, visibility, and activity policy. Opening web Version Control or focusing the mobile route refreshes locally immediately. Later web focus first requests the interval-aware policy-gated fetch and then performs one local refresh; a disabled interval skips network and refreshes locally. Explicit Fetch remains available. Older persisted settings retain their supported legacy interval fields when decoded, and an explicitly persisted five-minute upstream-status override remains explicit instead of being reclassified as the former branch default. Profile or policy overrides remain coherent when background settings are updated.

Working-tree snapshots keep every changed path visible but defer expensive untracked-file stats and temporary-index rename detection to a batched visible-row enrichment RPC. Web caches successful enrichment for the current snapshot, does not discard it when a row scrolls away, and records deleted rows with no rename result so they do not repeatedly request the same work. Preserve this lazy enrichment boundary unless upstream provides equivalent complete-row behavior without returning per-file Git work to the initial snapshot path.

Settings search indexes individual Source Control controls without making optional discovery state authoritative. Stable writing controls anchor directly to their rows, while Git fetch and provider-avatar results target the persistent Source Control section when the related provider row is absent or collapsed.

Provider-backed change-request lookups remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows.

`SourceControlPanelService` requests repository status with `includePullRequest: false` and projects `pr` as `null`; the shared VCS stream retains normal pull-request behavior. Resolved Git pull requests and panel change requests share the canonical `ChangeRequestState`. Terminal closed/merged checks stay centralized in shared source-control code for Sidebar and thread settlement without changing the opt-out for automatic settlement on merge.

Generic Git actions and panel commit/stash generation share one repository-context policy reader. Both resolve the effective writer from the current provider snapshot, fall back to the configured text-generation model when necessary, and read recent commit subjects plus `AGENTS.md`; Claude writers also read `CLAUDE.md`.

The server resolves one process-scoped `SourceControlPanelService` layer from the runtime instead of constructing a service per WebSocket connection. Snapshot and automatic-fetch caches are therefore shared across connected clients while request-specific authorization and routing remain at the socket boundary.

Version Control and source-control provider failures should preserve structured, bounded, transport-safe causes when normalized for panel RPC errors. Wrapper messages come only from stable operation fields and explicit caller detail, never from an unknown `cause.message`, so credential-bearing subprocess text cannot become the RPC error message. GitLab, GitHub, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing typed process failures into generic strings.

Provider API rate-limit state is shared process-wide between pull-request reads and the panel's best-effort pull-request or avatar enrichment. Cooldown keys normalize provider hostnames without ports, and transport-safe normalization preserves finite `status`, `retryAt`, and `failureKind` metadata so real provider 429 responses activate the shared bounded cooldown instead of being retried independently by each surface.

Thread source-control metadata update failures should surface on the thread without overwriting unrelated thread errors, and successful source-control updates should clear only the source-control metadata error for that thread. The visible banner prioritizes local thread errors, then source-control metadata errors, then persisted provider-session errors. Dismissal clears only the owning local or source-control error; persisted session errors are masked for the current UI session so a lower-priority error can remain. A per-thread metadata queue keeps sequencing monotonic for the hook lifetime so a reopened thread key cannot let an old in-flight failure overwrite a newer successful checkout. Each queued request snapshots every still-unacknowledged predecessor guard and the current observation sequence when it starts; subscription observations remain authoritative, acknowledge only fresh request targets, reject lagging predecessors while allowing a later legitimate return, and are skipped while the server-thread record is absent. Success, failure, interruption, and queued handoff leave the next request guarded by the newest observation. Rapid chained transitions therefore retain their guards across completion, failure, and in-flight acknowledgement without replaying stale enqueue state. Server-thread updates carry the active or loading-shell branch as `expectedBranch`, allowing the server to reject a stale metadata write instead of overwriting a newer branch/worktree transition.

Dismissal is source-aware: the visible thread error clears only when the user dismisses the same error source that is still presented. A later failure from another source, including an identical message, remains visible, while replacement by the same source preserves the expected single-message dismissal behavior.

Grouped-project draft navigation retargets the singleton Source Control surface from the active scoped draft/thread reference and effective Git cwd on every render. Switching grouped projects keeps the surface open without reusing the previous repository context, leaking its metadata error, or dispatching redundant retarget updates when the resolved context is unchanged.

Every environment panel is keyed by the same environment, thread, cwd, and worktree identity as its process-local cache entry. Changing any part of that repository context remounts request, refresh, detail, selection, and error state before the destination cache can be written, preventing late work from one checkout from leaking into another.

Panel snapshot generations remain globally monotonic even when a cwd cache entry is evicted, and File-surface identities encode the cwd/path tuple without delimiter collisions. Clickable Version Control rows retain explicit pointer affordances across branch, repository, and working-tree surfaces.

The native route records working-tree expansion initialization only when that change set is current, so a sibling checkout that later becomes current still receives its one-time default `Changes` expansion.

Background preview mini-player lifecycle changes do not own or retarget the singleton Source Control surface. An open Source Control panel stays visible and bound to the same environment, thread, and cwd while a preview enters, changes, or leaves mini-player presentation. Background-stop requests are sequenced across thread switches so a late failure from one thread cannot clear a newer thread's pending Stop state.

Preserve the panel's review-hardened edge cases: the current default branch keeps its own stable default comparison base, status-derived default branch names such as `develop` are preferred over hardcoded `main`/`master` guesses, compare-history pagination queries the selected comparison range, branch pull/fetch parsing handles slashful remotes and remote-looking local branch names without treating slashless local upstreams as remote refs, diverged normal merge sync is available only for the current branch, checked-out branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, sibling worktree watcher refreshes keep root Actionable rows live while skipping stale/prunable worktree paths, branch sync and undo operations for checked-out branches target the owning worktree cwd, checkout and deletion remain disabled for branches checked out in any worktree, and the server independently rejects deletion of any local branch carrying a worktree path. Review patches disable user-configured diff rendering. Web stash apply, pop, and drop actions share one repository mutation key so positional refs cannot race renumbering. Asynchronous diff-worker completion repaints an already-open inline viewer, cwd-scoped working-tree enrichment avoids cross-worktree file-detail reuse, rename diff requests preserve the original source path while copied rows request only the destination path, mobile publish asks for a destination when multiple remotes exist, interrupted mobile detail and diff reads retry once before settling into cancellation or a recoverable error, selected-file commits use a temporary index built from `HEAD` so deselected staged changes remain staged but are excluded from the commit, client surfaces leave selected-path staging to the server, generation and commit failures preserve the real index, a post-commit real-index synchronization failure is logged without reporting the created commit as failed, commit-hook output only enriches a failed Git result and never interrupts a still-running commit, selected stage/diff/synchronization/unstage operations plus selected stash, discard, and temporary intent-to-add commands use literal-path semantics, configured remote names, including names containing slashes, determine the local tracking branch name before collision-safe remote checkout creates a uniquely suffixed branch instead of detaching `HEAD`, native mutation completion accepts the authoritative full snapshot before requesting a status refresh, merge and rebase refs are passed after `--`, Electron destructive menu groups retain an explicit separator, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, merged staged-plus-unstaged row stats are summed, invalid native branch and stash dates are omitted instead of appearing as recent activity, and late-month relative dates do not fall through to `0 years ago`.

Web source-control rows use the default Sidebar's rich-tooltip timing and `TooltipCardPopup` treatment; the Legacy Sidebar does not own this convention. Working-tree, file, branch, commit, stash, and remote rows expose their full paths or refs and relevant status, time, identity, URL, and line-change details. Federated headers use the styled cwd tooltip. File cards use trigger-scoped virtual anchors with a shared panel-aligned edge, and nested action tooltips leave unrelated parent cards unchanged.

Watcher refreshes that arrive while an authoritative full snapshot is in flight are promoted to full snapshots, preventing stale cached branch, remote, stash, or comparison data from being merged back after the mutation. Full-snapshot completion advances the per-cwd barrier on success, failure, or interruption, and queued panel refreshes drain after the current request even when that request fails, so watcher or mutation updates are not stranded behind or permanently promoted by a failed snapshot. On mobile, collapsed remote sections render no branch rows until expanded, conflict-only files open the working-tree diff side, staged-only files continue to open the staged side, and branch, fork-comparison, and stash detail failures replace indefinite loading placeholders with scoped retryable errors.

Native snapshot refresh acceptance is keyed by both request generation and cwd, so late retained callbacks cannot update a newly selected checkout. Branch and stash detail requests use the same current-request discipline. A failed initial snapshot settles into visible failure state with an in-place Retry action, while interrupted reads are treated as cancellation. Initial mobile remote fetching deduplicates successful and in-flight requests but clears its latch after failure, allowing the next eligible pass to retry instead of permanently suppressing automatic fetches. A pull-to-refresh indicator remains visible when a background refresh supersedes that request and clears only when the newest accepted refresh settles. Mobile Version Control actions, sections, selectable files, diffs, commits, working trees, branches, stashes, remotes, remote branches, and dismissible errors retain explicit accessibility labels, roles, checked/disabled states, and expansion semantics.

Mobile branch checkout failures propagate to the route-level action state, keep the action sheet available for correction or retry, and preserve the underlying Git error. The route owns that checkout failure exclusively, so the shared Git-action layer does not also emit a duplicate toast or connection banner. Interrupt-only outcomes remain silent cancellation and do not surface a false failure.

Web mutations acquire their action key synchronously before React renders disabled state, suppress duplicate invocations until the first action settles, keep request-scoped action errors separate from refresh failures, reconcile VCS status and an authoritative full snapshot after both success and failure, then preserve the original mutation error so conflicts and partially applied results become visible without losing the failure message. Azure DevOps commit-author avatar lookup derives the organization from the repository remote, passes it explicitly to the CLI, and uses the stable Commits Get `7.1` API instead of ambient CLI defaults.

Fetch-before-sync actions perform one fetch, accept the authoritative post-fetch full snapshot, and only then recompute push, pull, and divergence state; an unchanged branch is not fetched twice. Native mutations acquire their action key synchronously before React busy state rerenders and release it after snapshot reconciliation even when reconciliation fails, preventing duplicate actions from overlapping gesture or menu entry points.

Ref-affecting panel mutations invalidate both shared ref-cache layers after an actual Git mutation attempt. Server action finalizers clear the `GitVcsDriver` snapshot without masking the original command result, and matching client atoms invalidate persisted ref state on settlement so web and mobile consumers request the post-mutation snapshot. Validation-only failures, cache-hit automatic fetches, working-tree/stash actions, and display-only reads avoid redundant invalidation.

`SOURCE_CONTROL.md` remains the complete implementation contract. This section records the integration seams needed during fork assembly; keep the Version Control panel work unless `upstream/main` has gained an equivalent agent-aware version-control panel, then reconcile against the detailed note.

Keep the virtualized branch picker callbacks explicitly typed through `LegendList<string>` and `LegendListRenderItemProps<string>` so branch row rendering does not reopen an implicit-`any` boundary.

Primary reference:

- `SOURCE_CONTROL.md`

### Version Control performance improvements

- Git ref lists use a persisted, generation-aware first-page cache rather than periodic polling. A connected generation performs one live refresh, failures retry with bounded exponential backoff, generation changes cancel stale work, filtered and cursor pages remain live-only, and inactive atoms expire after 30 seconds. The branch selector paginates on demand. The Diff comparison menu explicitly refreshes when opened, resets its retained query when closed, and records one queued rerun while a request is active.
- Ref-affecting mutations invalidate the shared server snapshot and persisted client ref state after real mutation attempts, including failed, interrupted, or partially applied attempts. Validation-only failures and cache-hit automatic fetches avoid redundant invalidation, and invalidation never masks the original result.
- Version Control snapshots are incremental after the authoritative initial load. Watcher updates refresh current and sibling working-tree slices while reusing cached branches, remotes, stashes, and comparisons. Mount, focus or visibility, explicit actions, and manual refreshes request a full snapshot. The server compares repository identity, branch, upstream, ahead and behind counts, provider, and change-request status before accepting an incremental result and falls back to full whenever those fields change. Per-cwd revisions prevent an older request from replacing a newer snapshot.
- Automatic `fetch --all` work is coordinated by Git common directory. Concurrent panels share one in-flight request, successful automatic requests remain fresh for five minutes, and failures cool down briefly. Manual Fetch invalidates freshness and performs a real all-remotes fetch.

Primary files and focused coverage remain in `packages/client-runtime/src/state/vcs.ts`, `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/components/DiffPanel.tsx`, `apps/server/src/sourceControl/SourceControlPanelService.ts`, their focused tests, and the web and mobile Version Control panels.

## Preview Port Discovery Performance

**Worktree branch:** `fix/reduce-background-git-ref-port-polling`

Preview discovery stays fresh without a permanent broad process sweep.

- `PortDiscoverySubscription.ts` owns retain-before-subscribe ordering. The first retainer, or a retainer introducing configured URLs absent from the latest scan, triggers one immediate scan; subscription then replays the retained listener-specific projection without starting a second scan.
- Broad and configured probes publish only browser-ready HTTP or HTTPS targets. Each listener receives the projection for its configured URLs. Candidate readiness is reused for 15 seconds only when URL and listener identity are unchanged; PID or expiry changes force validation. The first 10-second known-server tick may reuse this cache, while the second must revalidate.
- Scans and publication are reentrant-safe: an active request records one queued rerun, publication ordering prevents an older scan from overwriting a newer result, and interruption re-fails the shared in-flight result instead of reporting the prior snapshot. Background polling logs ordinary failures without swallowing caller interruption.
- Snapshot publication, registration replay, and removal share serialized notification state, while per-listener queues deliver callbacks outside the global lock. Callback delivery and publisher acknowledgement form an interruption-masked handoff; failed initial replay rolls back registration, and cleanup interrupts blocked callback work without waiting behind it.
- Releasing the final retainer invalidates the published snapshot and listener projections under the scan lock but retains the bounded readiness cache. Retention, release, and transitions between no known server and a browser-ready server wake the scheduler. Polling is every 10 seconds only while discovery is retained and at least one browser-ready server is known; otherwise it is every 20 seconds.
- Managed terminal PID-set changes trigger an immediate scan. After a non-empty change, the first identical follow-up performs one settle scan so a late-bound port is found; idle reports do not consume it. The broad `lsof` safety scan preserves discovery for servers outside managed terminals without restoring the old three-second polling loop.

Primary files:

- `apps/server/src/preview/PortScanner.ts`
- `apps/server/src/preview/PortScanner.test.ts`
- `apps/server/src/preview/PortDiscoverySubscription.ts`
- `apps/server/src/preview/PortDiscoverySubscription.test.ts`
- `apps/server/src/ws.ts`

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

1. Command and file-change activities stay readable as compact expandable rows. Preserve count-aware settled grouping, one disclosure per expanded row, generic fallback, live-member expansion, and the exclusion of metadata-only and collab-agent markers from rich disclosures.
2. Codex subagent threading work, including its sole synthetic-shell constructor, distinct read/write parent-relation mappers, complete projection replay, and authoritative child and root provider-control cleanup, remains preserved unless `upstream/main` has an equivalent UI-aware architecture; use `SUBAGENTS.md` as the source of truth.
3. Version Control remains a singleton beside Agents, pull-request, File, and preview/browser state. Preserve its native route, federated panels, coordinated clean-peer fast-forward after push, cwd-correct File routing, context-keyed state, subscription-acknowledged metadata queue, request-scoped errors, retryable mobile fetches, process-shared caches, and transport-safe error wrapping unless `upstream/main` is equivalent; use `SOURCE_CONTROL.md` as the source of truth.
4. Version Control idle-power safeguards retain native-first canonical path identity, exact 15-second, 30-second, or disabled Git status intervals, one-minute, five-minute, or disabled all-remotes intervals, shared lock and power/visibility/activity gating, ignored `.git` churn, batched ignored-path classification, lazy visible-row enrichment, and explicit Fetch.
5. Expanded command activity rows show differing raw command text inline with the other command details.
6. Command lifecycle identity stays scoped by turn and top-level-first tool id. Session replacement resumes after the latest applied sequence, snapshot pruning requires a complete cumulative completion, and output merging preserves meaningful streams across blank fallbacks, whitespace chunks, split chunks, and shorter snapshots.
7. Version Control checked-out branch labels preserve worktree paths through porcelain-first parsing and old-Git fallbacks; sync and undo target the owning checkout, while checkout and deletion stay disabled for branches owned by any worktree.
8. Thread source-control metadata update failures remain visible without clearing unrelated thread errors.
9. Mobile EAS owner, project id, and OTA updates URL remain pointed at the same local Expo project used for installable preview builds unless deliberately changed.
10. Mobile iOS development signing remains pointed at Apple team `6JGX8M7Z3L` unless deliberately changed.
11. Activity row path previews remain preserved for file-change-style tools, and row-target-only Enter/Space handling applies to every expandable activity row.
12. Source Control default branch detection honors the status-reported default branch before falling back to `main` or `master`.
13. Mobile pending-task rows stay outside lineage traversal. Thread rows preserve active-path depth and the exact selected terminal child without restoring hidden terminal ancestors.
14. Pending-task edit/submit helpers keep edited queued tasks from being resurrected after deletion/delivery, keep edit-session ownership from racing across reopen/exit, persist unsendable cleared edits instead of sending stale text after restart, and avoid reusing stale queued workspace metadata when a pending task is retargeted.
15. Source-control metadata writes include the active thread branch as `expectedBranch` so stale Git-action results cannot overwrite newer branch/worktree metadata.
16. Desktop and mobile verification retain host-local capacities and request-scoped cross-host racing. Web servers remain unconstrained, while integrated web UI automation uses one desktop slot on its browser host.
17. Persisted generation-aware Git ref caching and mutation invalidation, interruption-safe preview listener acknowledgements, listener-specific projections, exact known-server polling cadence, incremental Version Control snapshots, and common-directory fetch deduplication retain their branch ownership unless upstream is equivalent.
18. Project removal keeps archived conversation cleanup explicit: archived-only deletion requires the dedicated opt-in and must still reject any unseen live thread.
19. Core projection migrations preserve published ids 33 through 60, ensure lineage before the id-34 root backfill, and normalize only exact divergent markers before canonical replay. All migrations use `effect_sql_migrations`; migration 60 removes the abandoned experimental Magi ledger after restoring any missing canonical Magi rows.
20. Worktree-local dev state, single-origin browser proxying, Tailscale sharing, and browser-safe port selection remain integrated with the fork's IPv4 desktop/server paths, explicit desktop HMR URL handling, and desktop/mobile runtime coordination.
21. Main-owned mobile testing skills continue to verify pairing URL fields under non-US keyboard layouts and retry owned serve-sim streams with scoped MJPEG fallback when default frame encoding fails.
22. Activity persistence compacts cumulative non-terminal command updates, keeps terminal completion authoritative, and preserves transfer-budget headroom. Transport keeps bounded client-consumed metadata, patches, and collab fields while pruning unrelated bulk; command output stays server-side until expansion and the single-activity detail endpoint applies its bounded projection.
23. Preview cleanup follows authoritative archive/delete/unarchive and generation-aware shell lifecycle signals, while background mini-player presentation remains independent from the singleton Source Control surface.
24. Preview automation keeps serialized pairing, environment-scoped stable host discovery and non-disruptive explicit selection, sticky current-tab render scoping, runtime replacement, monotonic deadlines, exact-session timeout cleanup, and skipped-capture session safeguards together across renderer and desktop hosts.
25. Mobile Thread List v2 preserves contextual lineage, navigation-only terminal descendants, atomic settled and snoozed shelves, root-subtree snooze behavior, whole-lineage pin ordering, and root-only lifecycle actions.
26. Archive remains distinct from settle and root-only across the default Sidebar, chat header, and Legacy Sidebar. One process-wide coordinator enforces startup, active-turn, and background-work guards; `Archive all` covers the complete settled scope, including paged and pinned-settled rows, and holds reservations from confirmation through mutation. Waiters receive completed successes and eligibility skips while failed, cancelled, and unattempted work stays retryable.
27. Mobile Git checkout failures remain visible and retryable, while interrupt-only outcomes stay silent.
28. The documented finite working-indicator and deferred streaming Shiki safeguards are currently inactive; retain this summary for future evaluation.
29. Codex CLI updates use npm only for detected npm installations and preserve recognized package-manager commands. Default and unmatched bare commands use `codex update`; an explicit unclassified path uses that configured executable with `update`. Display quoting never replaces structured execution values.
30. Repeated steering uses exact projected message-id acknowledgement with a guarded turn/session fallback and keeps message-dispatch state separate from new-thread busy state. Stop performs bounded best-effort child interruption before authoritative live-root-turn resolution and preserves timeout, failure, defect, and successful-empty fallback semantics.
31. Thread-detail missing state preserves versioned and legacy capability negotiation, one HTTP/WS terminal classifier, serialized cache deletion and persistence, missing-snapshot termination before buffered live delivery, and one canonical draft/readiness classification that survives workspace-mode changes.
32. Provider-neutral Magi remains reconciled against `MAGI.md`, including its canonical core-ledger migrations, provider subscription/upload/dispatch/compaction contracts, complete projection replay and lineage, root-owned checkpoint refresh, run-history query ownership, shared settings structure, and shared mobile icon.
33. User-message context rendering retains ordered terminal, element, preview, and review parts, literal user tag text, original serialized Copy output, top-level review segmentation, and the `UserMessageContentParts` and `WorkActivityRows` ownership split.

## Retirement Criteria

These local patches can be removed when upstream provides the equivalent, superseding, or overriding behavior.

When retiring the local changes, remove the corresponding tests; expect upstream behavior to be tested by upstream incoming tests as well; we do not test or concern ourselves with validating upstream.

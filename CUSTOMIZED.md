# Custom Branch Changes

> Keep this file readable for humans: do not hard-wrap prose lines; let editors wrap long lines visually. Keep headings, lists, tables, and code blocks structurally formatted.
> Keep these notes a reflection of the current implementation status. History records, such as merge, ports, and update notes, are not meant for this file.

## Upstream Baseline

Generated after the worktree port refresh against local `origin/main` ref `8454550fa` and `upstream/main` ref `52b04b947`. After the upstream merge and worktree port refresh, the fork is 332 commits ahead and 0 commits behind `upstream/main`; the current fork diff against `upstream/main` touches 293 files with 46006 insertions and 1876 deletions.

## Latest Merge Impact

The fork is now merged through upstream `52b04b947`. This brings in the right-panel inset restoration when maximized, Electron dev and packaged renderer startup fixes, the preview automation migration from single-owner components to live owner streams, preview automation viewport/readiness/device-toolbar edge-case handling, and Grok ACP resume hardening that waits for replay-idle readiness during `session/load`. The merge conflict-prone files were `apps/server/src/mcp/McpHttpServer.test.ts`, `apps/server/src/provider/acp/AcpSessionRuntime.ts`, `apps/server/src/ws.ts`, `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/ChatView.tsx`, and `pnpm-lock.yaml`; preserve the fork's workspace-aware provider-skill RPC layer and source-control metadata helpers while keeping upstream's preview automation broker wiring and ACP replay-idle load gate.

The latest worktree review-port pass also brought in the archived-action local-API fallback, archive grouping/search helper extraction and bulk-action hardening, colon-safe archive project grouping keys, activity detail patch merging/deleted-file/MCP-row handling, basename-safe changed-file/diff matching, stable same-timestamp unkeyed tool-update ordering, terminal-backed project action readiness/probing hardening, source-control panel review fixes, VCS stream local-watcher retention before initial snapshots, interrupted branch-detail load suppression, Codex workspace-skill invalid-cwd normalization, VS Code persistence cleanup coverage, and stricter subagent interrupt turn targeting. These ports intentionally adapt the isolated worktree fixes onto current `main` instead of replaying whole split-branch trees, because several worktrees lack root-owned VS Code, provider-skill, source-control, and chat customizations.

The upstream Legend List chat scrolling upgrade is now merged into the fork's web and mobile chat surfaces. The conflict-prone files were `apps/web/src/components/ChatView.tsx` and `apps/web/src/components/chat/MessagesTimeline.tsx`; preserve upstream's anchored end-space, composer inset adjustment, `getItemType`, upgraded `@legendapp/list` APIs, and mobile `KeyboardAwareLegendList` / `useKeyboardChatComposerInset` / `useKeyboardScrollToEnd` flow while keeping the fork's workspace-aware provider skill rendering, subagent child-thread navigation, command/file activity rows, and full-width conversation/composer defaults.

The shared helper `packages/shared/src/chatList.ts` is now the canonical place for chat list anchor spacing. Web `MessagesTimeline` and mobile `ThreadFeed` should use `resolveChatListAnchoredEndSpace(...)` instead of reimplementing per-surface bottom-follow heuristics. The prior web-only first-row `scrollToEnd` effect in `MessagesTimeline` is retired by this merge, and mobile removed `apps/mobile/src/lib/threadFeedLayout.ts` in favor of Legend List's built-in keyboard and anchored end-space behavior. The remaining fold-settling suppression around turn-fold toggles is intentional: `scheduleFoldToggleSettlingReset(...)` in `apps/web/src/components/chat/MessagesTimeline.tsx` temporarily disables `maintainScrollAtEnd` while inserted/removed fold rows settle so the clicked fold row does not jump.

Upstream also moved the web composer into an absolute overlay with measured inset compensation, adjusts the scroll-to-bottom pill above the composer, returns mobile `onSendMessage` message ids so the sent row can become the anchor, removes queued-message feed rows from the mobile feed presentation path, bumps `@legendapp/list` to `3.2.0`, bumps `react-native-keyboard-controller` to `1.21.7`, pins `react-native-nitro-modules` to `0.35.9`, and adds the shared `@t3tools/shared/chatList` export. The fork keeps the upstream overlay model but removes the residual `max-w-208` cap from the web composer overlay wrapper so the visual blur/chrome matches the branch's full-width composer policy.

Customization-sensitive follow-up areas:

- The fork's workspace-scoped provider skill loading must keep feeding `MessagesTimeline` from `activeProviderWorkspaceSkills.skills`; do not regress to provider snapshot skills when applying upstream chat scroll changes, or repo-local `$skill` chips in sent user prompts can go stale or disappear across workspace switches.
- The fork's command/file activity expansion, turn folding, subagent child-thread rows, and full-width conversation containers now run inside upstream's anchored `LegendList` model. Do not reintroduce per-surface bottom-follow heuristics; keep the targeted fold-settling suppression unless upstream provides equivalent no-jump behavior for fold toggles.
- The fork's mobile EAS ownership remains fork-specific in `apps/mobile/app.config.ts`; upstream's mobile package/runtime upgrades are compatible with that metadata, but changing mobile native behavior now means `vp run lint:mobile` is part of the required validation.
- The previous upstream sidebar toggle and titlebar inset merge remains relevant to `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`, `apps/web/src/components/NoActiveThreadState.tsx`, `apps/web/src/routes/_chat.index.tsx`, and `apps/web/src/routes/settings.tsx`. Preserve upstream's global/floating sidebar control and collapsed-titlebar inset behavior, while keeping the fork's Electron forced-desktop sidebar layout, VS Code-visible sidebar trigger, version tooltip, and parent-conversation header action.
- The remaining fork sidebar/header compatibility rules stay centralized in `apps/web/src/components/AppSidebarLayout.logic.ts`, `apps/web/src/components/Sidebar.logic.ts`, and `apps/web/src/components/chat/ChatHeader.tsx`; upstream's `SidebarTrigger` still owns the shared trigger state and chrome behavior directly.

## Debug Browser Launch

For web/server debug work in this branch, start the backend with browser auto-open disabled, then if needed navigate the intended active browser window manually or through Playwright MCP:

```sh
T3CODE_NO_BROWSER=1 pnpm exec node scripts/dev-runner.ts --dev-url http://127.0.0.1:5173 dev:server
```

Then in a separate terminal:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5173 VITE_WS_URL=ws://127.0.0.1:13773 pnpm exec vp run --filter @t3tools/web dev -- --host 127.0.0.1 --port 5173
```

If a pairing URL is required, open the printed `/pair#token=...` URL in the already-open browser window being used for the debug session.

There should be a `throwaway` project already existing, located at `~/Sites/throwaway`. This project is a playground to test git workflow freely where you can perform any git operations including destructive ones. It is ok to leave in it temporary artifacts, commits, branches, staged and unstaged changes, etc, for posterior runs or reference.

## Installable Build Commands

Use these commands from the repository root when producing local installable artifacts for this customized branch.

### VS Code Extension

Build a local VSIX:

```sh
pnpm --filter t3code-vscode package
```

Install the newest generated package into VS Code:

```sh
code --install-extension "$(ls -t apps/vscode-extension/*.vsix | head -1)"
```

### Desktop App

Build a macOS arm64 DMG using the same desktop artifact path used for this branch:

```sh
pnpm run dist:desktop:dmg:arm64
```

Build a local macOS arm64 DMG, then hand the install step to Terminal.app so it can finish after the running T3 Code app quits:

```sh
scripts/install-desktop-dmg-from-t3.zsh
```

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

This branch carries local conversation-rendering and orchestration changes that are not assumed to exist upstream. Keep this file current when changing local behavior so future merges can preserve the intended UX, and so these patches can be removed when upstream covers the same behavior.

## Conversation User Context Rendering

The fork's user-message rendering composes upstream standalone element-pick chips with local terminal-context and preview-annotation presentation.

Expected behavior:

- Standalone trailing `<element_context>` messages render as element chips instead of showing raw XML-like tags.
- Messages sent with terminal contexts, element contexts, and trailing preview annotations render terminal chips, element chips, and preview annotation cards separately in send-time visual order after the prompt body.
- Raw `<terminal_context>`, `<element_context>`, and `<preview_annotation>` blocks should not leak into the visible user-message body when those blocks were generated by the composer.
- Inline file-change and review-comment diffs in the timeline intentionally use the lightweight `FileDiff` surfaces; `AnnotatableCodeView` remains the full diff-panel review-comment surface unless the timeline grows equivalent review-comment authoring behavior.

Implementation notes:

- `MessagesTimeline` strips trailing generated context blocks with `extractTrailingPreviewAnnotation`, `extractTrailingElementContexts`, and `extractTrailingTerminalContexts` in a loop so terminal, element, and preview blocks can be recovered when their trailing order varies.
- Extracted context content is rendered through React text nodes and existing chip/card components, never through `dangerouslySetInnerHTML`; tests should keep covering escaping for hostile context text.
- Keep tests for canonical send order, reversed terminal/element order, repeated terminal blocks, malformed or unclosed generated blocks, and raw-tag absence in the user bubble.

Primary files:

- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/terminalContext.ts`
- `apps/web/src/lib/elementContext.ts`
- `apps/web/src/lib/previewAnnotation.ts`

## Conversation Tool Activity Rendering

The custom behavior is focused on making tool activity easier to read in long-running Codex threads without changing agent execution semantics.

### File Change And Command Activity Boxes

File-change and command activities are rendered as clickable, expandable rows in the conversation work log.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- Differing raw command text is rendered inline as a normal detail block in the expanded row, not hidden behind a second nested disclosure.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.
- Command output extraction ignores blank-only completed stdout/stderr fallbacks so aggregated command output is still shown, but preserves whitespace-only incremental `tool.updated` chunks, including raw output `content`, so streamed output is not collapsed away.
- Incremental command output chunks concatenate without injected separators, while shorter completed snapshots, newline-terminated shorter updated snapshots, and shorter single-line repeated-prefix snapshots do not overwrite a previously merged longer output snapshot.

Primary files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`

## Tests Covering The Custom Behavior

Relevant tests live in:

- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/session-logic.test.ts`
- `apps/web/src/components/chat/ChatComposerOverlayBackground.test.tsx`

Useful focused commands:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/session-logic.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/MessagesTimeline.test.tsx)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/ThreadConversationWidth.test.tsx)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/ChatComposerOverlayBackground.test.tsx)
```

Before considering the branch healthy, also run:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

## Conversation Width Defaults

This branch intentionally removes the default max width from the main chat conversation and composer surfaces across browser, desktop, and VS Code extension hosts.

Expected behavior:

- By default, conversation rows, the composer, the composer overlay chrome/blur, composer banners, and the branch toolbar expand across the available chat window space.
- The VS Code `t3code.ui.threadConversationMaxWidth` setting remains available as an explicit opt-in max-width override.
- Leaving the VS Code setting empty means no maximum width, not the upstream narrow conversation width.

Primary files:

- `apps/web/src/components/chat/ThreadConversationWidth.tsx`
- `apps/web/src/components/chat/ComposerBannerStack.tsx`
- `apps/web/src/components/BranchToolbar.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/index.css`
- `apps/vscode-extension/package.json`

Relevant tests live in:

- `apps/web/src/components/chat/ThreadConversationWidth.test.tsx`
- `apps/web/src/components/chat/ChatComposerOverlayBackground.test.tsx`

## Archive Settings UX

The settings Archive panel is intentionally denser than the upstream-style settings rows so large archives remain scannable.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and auto-open matching project groups while search is active.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Conversation rows show only the relative archived and created ages inline with the title by default. On row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first, and delete actions respect the shared `confirmThreadDelete` client setting.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete`, unarchive bulk actions remain guarded, and partial failures surface as not-fully-completed toasts instead of implying every archived thread failed.
- Archive grouping, search ranking, sort state, and project bulk-action concurrency live in `apps/web/src/components/settings/SettingsPanels.logic.ts` so the dense Archive panel behavior stays covered without growing the React component. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, and report interrupted counts separately from visible failures.

Primary files:

- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/components/settings/SettingsPanels.logic.ts`

## Terminal-backed Project Actions

This branch should treat terminal-backed project actions as reusable terminal workflows, not as fire-and-forget terminal creation.

Expected behavior:

- Running a project action should reuse a stable terminal for that action when possible instead of opening a new terminal instance on every click.
- If action-specific reuse is not available, terminal-backed actions should still prefer a shared action terminal group so repeated runs do not leave many stale terminal instances behind.
- A project action must not write its command until the target terminal session is ready to receive input. This avoids shells with slow startup, such as login `bash`, rendering the command before the prompt and leaving the command unexecuted.
- If the selected reusable terminal is busy running a subprocess, the action may choose another action terminal rather than injecting input into a live process.
- The readiness wait uses the current terminal session summary when available, and otherwise attaches to the terminal stream and waits briefly for prompt-like output before writing. If the prompt is never observed, the wait times out and the action still writes rather than hanging indefinitely.
- The Effect-based readiness wait exposes a strict typed-error path for attach failures and prompt timeouts, while the project action command path deliberately keeps the existing best-effort fallback that writes after failure/timeout instead of blocking the action.
- Action terminal ids encode script ids and reserve numeric `:<suffix>` ids for fallback terminals, so script ids such as `build-2` or legacy colon ids such as `build:dev` cannot be mistaken for fallback terminals of another action.
- Fallback action terminal tabs include their instance suffix in parentheses, such as `Action: build (2)`, while script ids that naturally end in digits, such as `build-2`, keep readable labels such as `Action: build 2`.
- POSIX subprocess detection is conservative when full process-tree inspection fails: a shell child is treated as busy rather than idle so commands are not injected into a terminal that may still have a hidden descendant process.
- Terminal UI controls should be unavailable whenever host terminal support is disabled or no active project exists, so hosts such as VS Code do not expose terminal actions that cannot run.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/web/src/projectScriptTerminals.ts`
- `apps/web/src/state/projectActionTerminal.ts`
- `apps/server/src/terminal/Manager.ts`

Relevant tests live in:

- `apps/web/src/projectScriptTerminals.test.ts`
- `apps/server/src/terminal/Manager.test.ts`
- `packages/shared/src/terminalLabels.test.ts`

Useful focused command:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/projectScriptTerminals.test.ts)
```

## Codex Workspace Skill Loading

Fix Codex repo-local skill discovery in the composer by resolving skills for the active project/worktree cwd, instead of relying on the global provider status snapshot.

Expected behavior:

- Repo-local Codex skills for the active workspace appear in the `$` skill picker.
- The server exposes a workspace-aware `server.listProviderSkills` path and validates enabled Codex skill-listing requests against the requested cwd.
- The server routes skill listing through a bounded request lister that coalesces concurrent requests for the same provider/cwd, limits cross-workspace concurrency, and applies a short TTL so reconnects or repeated composer renders do not repeatedly spawn Codex app-server probes.
- The Codex provider requests `skills/list` with the current workspace cwd, times out hung app-server probes, and terminates the probe process when a timeout occurs.
- Provider skill-list failures preserve structured reason, operation, provider instance, normalized cwd, and bounded cause diagnostics for missing providers, invalid cwd, settings failures, Codex home preparation, probe timeouts, and probe failures while keeping stable user-facing messages. Raw thrown values are not sent directly to clients; the server keeps a small plain diagnostic shape so file paths, process output, and unexpected objects do not expand the wire payload.
- Non-Codex or disabled providers keep returning provider snapshot skills instead of failing workspace skill search.
- The client runtime keys provider-skill query state by environment, provider instance, and cwd, with a bounded stale window so reconnects refresh workspace-local skills without reusing another workspace's snapshot.
- The composer loads workspace skills lazily: it starts workspace skill discovery when the `$` skill menu is active or the prompt already contains a complete `$skill` token, rather than probing on every empty composer mount. It preserves already loaded repo-local skills while refreshing the same workspace, falls back to provider snapshot skills when a settled workspace lookup returns no skills or errors, and clears stale repo-local skills during workspace switches or settled no-data states.
- The conversation timeline renders sent user prompts against the same workspace-aware skill list as the composer, so repo-local `$skill-name` references display with the same skill chip treatment as user-level skills.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/provider/ProviderSkillsLister.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/providerWorkspaceSkillsState.ts`
- `packages/contracts/src/server.ts`
- `packages/client-runtime/src/state/server.ts`

Relevant tests live in:

- `apps/server/src/server.test.ts`
- `apps/server/src/provider/ProviderSkillsLister.test.ts`
- `apps/server/src/provider/Layers/CodexProvider.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/GrokProvider.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/lib/providerWorkspaceSkillsState.test.ts`
- `packages/client-runtime/src/state/runtime.test.ts`

Useful focused commands:

```sh
(cd apps/server && pnpm exec vp test run --passWithNoTests src/provider/ProviderSkillsLister.test.ts src/provider/Layers/CodexProvider.test.ts src/provider/Layers/CursorProvider.test.ts src/provider/Layers/GrokProvider.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/lib/providerWorkspaceSkillsState.test.ts)
```

## Thread Detail Subscription Reliability

This branch carries a server-side fix for a race in thread-detail websocket subscriptions. The bug can make the initial user prompt disappear from newly started conversations in packaged/static hosts such as the desktop app and VS Code extension, because those hosts are more likely to dispatch the first `thread.message-sent` event while the server is still loading the initial thread snapshot for `subscribeThread`.

Expected behavior:

- A new conversation's first user message remains visible after the optimistic row is replaced by server state.
- `ORCHESTRATION_WS_METHODS.subscribeThread` attaches to the live orchestration event stream before loading the initial thread detail snapshot.
- Thread-detail events emitted during the snapshot read are buffered and replayed after the snapshot when their sequence is newer than the snapshot sequence.
- The fix is host-agnostic server reliability work. Preserve it for desktop, VS Code extension, and web clients unless upstream has equivalent snapshot-plus-live-tail subscription behavior.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/server.test.ts`

## VS Code Extension Work

This branch also carries the VS Code extension work that is not assumed to exist on `main`. Treat the VS Code extension, its desktop-backed integration model, workspace-scoped webview behavior, host-injected primary-environment bootstrap, host MCP bridge, release packaging, and related tests as part of this branch's customization set during upstream merges.

The VS Code host display-preference bridge, including the `enableSourceControlPanel` preference and web `hostDisplayPreferences` handling, is local-main integration glue for composing the VS Code webview with other local customizations. It should not be treated as part of any isolated worktree branch, including the Version Control panel branch. Keep this glue on local `main` when reconciling isolated branches, and only preserve it in the VS Code extension context when maintaining the host/webview preference contract.

VS Code workspace-folder identity should stay aligned with the shared desktop/host-MCP workspace helpers in `packages/shared/src/workspaceFolders.ts`; do not reintroduce independent active-folder matching in the extension.

The VS Code webview is a host-managed workspace surface, not a normal hosted web app. The web app should register the primary environment directly from `window.t3HostBridge.getLocalEnvironmentBootstrap()` when that bootstrap includes the environment id, label, HTTP URL, WebSocket URL, and bearer token. Do not reintroduce a dependency on `/.well-known/t3/environment` before the VS Code sidebar can load workspace threads.

Host MCP discovery remains best-effort during provider startup, but skipped advertisements should retain diagnostics for duplicate server names, missing sockets, socket-check failures, failed probes, rejected probes, and advertisement-read failures so the desktop/VS Code bridge can be debugged without turning stale advertisements into provider-start failures. Diagnostic emission is best-effort and non-blocking; focused tests can collect it through the `onDiagnostic` callback, and production troubleshooting currently relies on server-side instrumentation rather than a dedicated end-user UI.

The implementation details are intentionally kept in `apps/vscode-extension/IMPLEMENTATION.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the extension work unless `main` has gained an equivalent VS Code extension architecture, then reconcile against the detailed implementation note.

Primary reference:

- `apps/vscode-extension/IMPLEMENTATION.md`

## Subagent Threading Work

This branch also carries the Codex subagent-threading work that is not assumed to exist on `main`. Treat Codex subagent lineage, child-thread projection, contextual active sidebar rows, active terminal subagent ancestor visibility, parent subagent reference blocks, resumed-child parent activity rows, child-thread output isolation, child stop behavior, parent metadata ingestion, and related tests as part of this branch's customization set during upstream merges.

Thread archive/delete lifecycle behavior is enforced server-side in the orchestration decider: archiving or deleting a parent thread cascades through active subagent descendants before the parent event, and force-deleting a project delegates through lifecycle roots so descendant subagents are not double-deleted.

Child runtime events that arrive with parent-collab metadata may synthesize the missing child shell before their output/actions are ingested. Child stop requests must target the selected child turn when known, and if no active child turn can be identified the server records a child interrupt failure and marks the child stopped instead of falling back to the root session's active turn.

The implementation details are intentionally kept in `SUBAGENTS.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the subagent threading work unless `main` has gained an equivalent UI-aware subagent architecture, then reconcile against the detailed subagent note.

Primary reference:

- `SUBAGENTS.md`

## Version Control Panel Work

This branch includes a first-class Version Control panel that is not assumed to exist on `main`. Treat the Version Control singleton right-panel surface, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, compare-base semantics, and Version Control panel RPC/contracts as part of this branch's customization set during upstream merges.

Preserve the branch-local idle-power safeguards for VCS status: ignore internal `.git/` watcher events before refreshing local status, and keep the default automatic remote Git fetch interval conservative unless upstream provides equivalent lower-churn VCS status behavior.

Provider-backed change-request lookups remain best-effort in the panel service. Provider/auth/CLI failures must not fail the whole panel snapshot or hide git-derived actionable branch rows.

Version Control and source-control provider failures should preserve structured causes when normalized for panel RPC errors. GitLab, GitHub, Azure DevOps, and Bitbucket provider paths should keep provider-specific not-found/auth/missing-CLI details without collapsing structured process failures into generic strings.

Thread source-control metadata update failures should surface on the thread without overwriting unrelated thread errors, and successful source-control updates should clear only the source-control metadata error for that thread.

Preserve the panel's review-hardened edge cases: the current default branch remains a valid default compare ref, compare-history pagination queries the selected comparison range, branch pull/fetch parsing handles slashful remotes and remote-looking local branch names without treating slashless local upstreams as remote refs, diverged normal merge sync is available only for the current branch, checked-out branch worktree paths fall back from porcelain worktree output to branch-format placeholders without failing on older Git versions, tracked discard restore failures surface instead of being swallowed, fallback rename parsing preserves original paths, merged staged-plus-unstaged row stats are summed, and late-month relative dates do not fall through to `0 years ago`.

The implementation details are intentionally kept in `SOURCE_CONTROL.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the Version Control panel work unless `main` has gained an equivalent agent-aware version-control panel, then reconcile against the detailed source-control note.

Primary reference:

- `SOURCE_CONTROL.md`

## Mobile EAS Project Ownership

This branch points the mobile Expo/EAS project at the local `quicksaver` owner instead of upstream's `pingdotgg` owner so installable internal mobile builds can be produced without requiring access to the upstream Expo organization.

Expected behavior:

- `apps/mobile/app.config.ts` uses `owner: "quicksaver"` for EAS project ownership.
- `apps/mobile/app.config.ts` uses EAS project id `c65ac46d-6488-49af-b61e-ab9bef78f96e`.

Important merge rule:

If upstream changes the mobile EAS project metadata, preserve the local `quicksaver` owner and project id unless this branch intentionally switches back to the upstream Expo organization or to a new local EAS project. Re-check this before resolving conflicts in `apps/mobile/app.config.ts`, because accepting upstream's `pingdotgg` owner can make local `eas build --profile preview` fail with Expo authorization errors.

Primary file:

- `apps/mobile/app.config.ts`

## Merge Guidance

When merging from upstream, keep these local behaviors unless upstream has an equivalent implementation:

1. Command and file-change activities stay readable as compact expandable rows in the conversation work log.
2. Codex subagent threading work remains preserved as a local customization unless `main` has an equivalent UI-aware subagent architecture; use `SUBAGENTS.md` as the detailed source of truth.
3. Chat conversation and composer surfaces default to no maximum width across all host types.
4. VS Code extension work remains preserved as a local customization unless `main` has an equivalent implementation; use `apps/vscode-extension/IMPLEMENTATION.md` as the detailed source of truth.
5. Workspace-scoped Codex skill loading remains preserved so repo-local Codex skills for the active workspace continue to appear in the `$` skill picker and sent user-message skill chips without repeated unbounded provider probes or stale skill leakage across workspaces.
6. Version Control panel work remains preserved as a local customization unless `main` has an equivalent agent-aware version-control panel; use `SOURCE_CONTROL.md` as the detailed source of truth.
7. Version Control idle-power safeguards continue to ignore internal `.git/` watcher churn and use a conservative automatic remote Git fetch interval unless upstream ships equivalent low-churn behavior.
8. Thread-detail subscriptions preserve first-message events emitted during initial snapshot loading unless upstream ships equivalent snapshot-plus-live-tail buffering.
9. Terminal-backed project actions reuse action terminals where possible and wait for terminal readiness before writing commands.
10. Expanded command activity rows show differing raw command text inline with the other command details.
11. Command output merging preserves meaningful streamed output across blank fallbacks, whitespace chunks, split chunks, and shorter snapshots.
12. Terminal-backed project action terminal ids remain collision-resistant and busy detection stays conservative when subprocess inspection is incomplete.
13. Terminal UI controls stay gated on both host terminal support and an active project.
14. Version Control checked-out branch labels preserve worktree paths through porcelain-first parsing and old-Git fallbacks.
15. Thread source-control metadata update failures remain visible without clearing unrelated thread errors.
16. Mobile EAS project ownership remains pointed at the local Expo project used for installable preview builds unless deliberately changed.

## Retirement Criteria

These local patches can be removed when upstream provides all of the following:

- A canonical parent-child relationship for subagent/collab tool events.
- A UI model that treats subagents as routeable child threads with parent reference blocks.
- Sidebar, routing, archive/delete, and stop behavior that match `SUBAGENTS.md`.
- Tests or contracts that guarantee child output and actions stay scoped to the child conversation view.

When retiring the local changes, remove the corresponding tests or update them to assert the upstream behavior directly.

## Worktrees Tracking

> Here are referenced the latest commit SHAs for the `main` branch of both the `origin` and `upstream` remotes. These SHAs are used to determine if any worktrees need to be updated with changes from `upstream/main` and `origin/main`.

**Last origin/main commit SHA:** 8454550fa
**Last upstream/main commit SHA:** 52b04b947
**Last post-merge main...upstream/main count:** 328 ahead / 0 behind
**Last resolved main...upstream/main diff size:** 293 files changed, 45052 insertions, 1789 deletions

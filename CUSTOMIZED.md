# Custom Branch Changes

## Last Upstream Merge

Generated from local `main` at `2492d3d25` and `upstream/main` at `e95b57dc2` (`v0.0.28-nightly.20260618.594`). Before the merge, this branch was 207 commits ahead and 1 commit behind upstream; after the merge, this branch is 208 commits ahead and 0 commits behind `upstream/main`. The incoming upstream diff from the merge base was 606 files changed, 37206 insertions, and 53661 deletions; the remaining fork delta against `upstream/main` is 230 files changed, 32054 insertions, and 748 deletions.

No local customization is retired by this merge. Upstream rewrote the client connection architecture around `@t3tools/client-runtime` connection registries, atom-backed environment state, desktop/mobile connection catalogs, and shared environment RPC state; removed the old web `store`, `environments/runtime`, `rpc/serverState`, `wsRpcClient`, and many `.browser` shims; and added mobile connection storage/onboarding, relay token handling, thread outbox state, and `docs/architecture/connection-runtime.md`. These upstream changes are authoritative; the local custom Version Control panel, VS Code extension, subagent threading, wide conversation defaults, workspace skill loading, and terminal action reuse work were ported onto the new runtime model.

Concrete conflict notes from this merge:

- `pnpm-lock.yaml` was regenerated from the merged manifests and `pnpm install` was run so upstream's new mobile `expo-network` dependency and the VS Code extension's explicit `@t3tools/shared` workspace dependency are linked.
- The local workspace-scoped provider skill picker now uses `serverEnvironment.listProviderSkills` from `packages/client-runtime/src/state/server.ts` instead of the deleted web runtime connection object.
- The local Version Control panel now calls the existing `vcs.panel.*` RPCs through `vcsEnvironment` atom commands instead of the removed `EnvironmentApi` object, while keeping its right-panel surface and live VCS status integration.
- VS Code webview scoping was preserved on the new project shell model by matching project `workspaceRoot` values, keeping the button-based sidebar wordmark, and retaining hosted/settings back-target behavior.
- Terminal host gating, stable project-action terminal IDs, subagent parent navigation, and disabled-terminal cleanup were carried forward into the upstream `ChatView` atom state.
- Validation for this merge used `pnpm exec vp check`, `pnpm exec vp run typecheck`, and `pnpm exec vp run lint:mobile`. `vp check` still reports warning-only schema-hoisting notices in upstream-added mobile connection files; `lint:mobile` also warns that optional local `swiftlint`, `ktlint`, and `detekt` binaries are not installed.

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
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.

Primary files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`

## Tests Covering The Custom Behavior

Relevant tests live in:

- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/session-logic.test.ts`

Useful focused commands:

```sh
pnpm --filter @t3tools/web test -- src/session-logic.test.ts
pnpm --filter @t3tools/web test -- src/components/chat/MessagesTimeline.test.tsx
pnpm --filter @t3tools/web test -- src/components/chat/ThreadConversationWidth.test.tsx
```

Before considering the branch healthy, also run:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

## Conversation Width Defaults

This branch intentionally removes the default max width from the main chat conversation and composer surfaces across browser, desktop, and VS Code extension hosts.

Expected behavior:

- By default, conversation rows, the composer, composer banners, and the branch toolbar expand across the available chat window space.
- The VS Code `t3code.ui.threadConversationMaxWidth` setting remains available as an explicit opt-in max-width override.
- Leaving the VS Code setting empty means no maximum width, not the upstream narrow conversation width.

Primary files:

- `apps/web/src/components/chat/ThreadConversationWidth.tsx`
- `apps/web/src/components/chat/ComposerBannerStack.tsx`
- `apps/web/src/components/BranchToolbar.tsx`
- `apps/vscode-extension/package.json`

Relevant tests live in:

- `apps/web/src/components/chat/ThreadConversationWidth.test.tsx`

## Terminal-backed Project Actions

This branch should treat terminal-backed project actions as reusable terminal workflows, not as fire-and-forget terminal creation.

Expected behavior:

- Running a project action should reuse a stable terminal for that action when possible instead of opening a new terminal instance on every click.
- If action-specific reuse is not available, terminal-backed actions should still prefer a shared action terminal group so repeated runs do not leave many stale terminal instances behind.
- A project action must not write its command until the target terminal session is ready to receive input. This avoids shells with slow startup, such as login `bash`, rendering the command before the prompt and leaving the command unexecuted.
- If the selected reusable terminal is busy running a subprocess, the action may choose another action terminal rather than injecting input into a live process.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/server/src/terminal/Layers/Manager.ts`

## Codex Workspace Skill Loading

Fix Codex repo-local skill discovery in the composer by resolving skills for the active project/worktree cwd, instead of relying on the global provider status snapshot.

Expected behavior:

- Repo-local Codex skills for the active workspace appear in the `$` skill picker.
- The server exposes a workspace-aware `server.listProviderSkills` path and validates enabled Codex skill-listing requests against the requested cwd.
- The Codex provider requests `skills/list` with the current workspace cwd and supports forced refreshes when the workspace skill cache needs to be invalidated.
- Non-Codex or disabled providers keep returning provider snapshot skills instead of failing workspace skill search.
- The web composer keeps provider skills keyed by active workspace, clears stale snapshot skills when the workspace changes, and surfaces skill-listing failures instead of silently reusing stale results.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `packages/contracts/src/server.ts`
- `packages/client-runtime/src/state/server.ts`

Relevant tests live in:

- `apps/server/src/server.test.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.test.ts`

## VS Code Extension Work

This branch also carries the VS Code extension work that is not assumed to exist on `main`. Treat the VS Code extension, its desktop-backed integration model, workspace-scoped webview behavior, host MCP bridge, release packaging, and related tests as part of this branch's customization set during upstream merges.

The implementation details are intentionally kept in `apps/vscode-extension/IMPLEMENTATION.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the extension work unless `main` has gained an equivalent VS Code extension architecture, then reconcile against the detailed implementation note.

Primary reference:

- `apps/vscode-extension/IMPLEMENTATION.md`

## Subagent Threading Work

This branch also carries the Codex subagent-threading work that is not assumed to exist on `main`. Treat Codex subagent lineage, child-thread projection, nested active sidebar rows, parent subagent reference blocks, child-thread output isolation, child stop behavior, and related tests as part of this branch's customization set during upstream merges.

The implementation details are intentionally kept in `SUBAGENTS.md` instead of being duplicated here. Unlike the other sections in this file, `CUSTOMIZED.md` should only preserve the merge-maintenance rule for this area: keep the subagent threading work unless `main` has gained an equivalent UI-aware subagent architecture, then reconcile against the detailed subagent note.

Primary reference:

- `SUBAGENTS.md`

## Version Control Panel Work

This branch includes a first-class Version Control panel that is not assumed to exist on `main`. Treat the Version Control singleton right-panel surface, VS Code host display setting, live VCS status watcher, Actionable and Remotes panel model, selected-file commit/stash flow, branch/commit/stash/remote actions, and Version Control panel RPC/contracts as part of this branch's customization set during upstream merges.

Preserve the branch-local idle-power safeguards for VCS status: ignore internal `.git/` watcher events before refreshing local status, and keep the default automatic remote Git fetch interval conservative unless upstream provides equivalent lower-churn VCS status behavior.

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
5. Workspace-scoped Codex skill loading remains preserved so repo-local Codex skills for the active workspace continue to appear in the `$` skill picker.
6. Version Control panel work remains preserved as a local customization unless `main` has an equivalent agent-aware version-control panel; use `SOURCE_CONTROL.md` as the detailed source of truth.
7. Version Control idle-power safeguards continue to ignore internal `.git/` watcher churn and use a conservative automatic remote Git fetch interval unless upstream ships equivalent low-churn behavior.
8. Terminal-backed project actions reuse action terminals where possible and wait for terminal readiness before writing commands.
9. Mobile EAS project ownership remains pointed at the local Expo project used for installable preview builds unless deliberately changed.

## Retirement Criteria

These local patches can be removed when upstream provides all of the following:

- A canonical parent-child relationship for subagent/collab tool events.
- A UI model that treats subagents as routeable child threads with parent reference blocks.
- Sidebar, routing, archive/delete, and stop behavior that match `SUBAGENTS.md`.
- Tests or contracts that guarantee child output and actions stay scoped to the child conversation view.

When retiring the local changes, remove the corresponding tests or update them to assert the upstream behavior directly.

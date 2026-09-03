# Codex Workspace Skill Loading

Fix Codex repo-local skill discovery in the composer by resolving skills for the active project/worktree cwd, instead of relying on the global provider status snapshot.

## Upstream supersession assessment

Upstream now covers most of this branch's behavior:

- `80a14b6588` adds core workspace-scoped skill discovery for Codex and OpenCode, including server contracts, caching, the web composer, and timeline rendering.
- `bc918e74ac` adds the same `snapshotForCwd` mechanism for Claude.
- `15fea6c5f4`, still to be merged into this branch, extends discovery to Cursor and Grok, wires it into mobile, and adds a ten-second retry cooldown.

The dedicated RPC and parallel `providerWorkspaceSkills` cache are superseded. Upstream's active `$` query handling and thread-provider timeline decoration also work as needed.

Parts that may still be worth preserving in a later, smaller change:

- Codex plugin discovery
- Authentication-aware failure handling, even with a simpler structured error contract
- The unsettled-worktree guard
- Cwd normalization folded into upstream's snapshot keying to prevent inconsistent cache entries
- Disconnected-workspace isolation
- Windows shadow-home symlink retry handling

Lazy skill discovery is no longer needed. Timeline provider selection is also unnecessary because changing providers for the next turn is not currently possible.

Expected behavior:

- Repo-local Codex skills for the active workspace appear in the `$` skill picker.
- The server exposes a workspace-aware `server.listProviderSkills` path through a focused provider-skills RPC handler and validates enabled Codex skill-listing requests against the requested cwd.
- The server routes skill listing through a bounded request lister that keys equivalent requests by normalized workspace root, coalesces concurrent requests for the same provider/cwd, limits cross-workspace concurrency, and applies a short TTL only to successful lookups so reconnects or repeated composer renders do not repeatedly spawn Codex app-server probes while transient failures remain immediately retryable. Concurrent probes tolerate another request winning the race to create an identical shared-state symlink in the same Codex shadow home.
- The Codex provider requests `skills/list` with the current workspace cwd, times out hung app-server probes, and terminates the probe process when a timeout occurs.
- Installed and enabled remote Codex plugin skills are merged into the workspace result with namespaced references such as `$coderabbit:code-review`, so advertised plugin skills appear in the composer picker. Plugin discovery is best-effort: if `plugin/installed` or an individual `plugin/read` fails, normal workspace skills remain available.
- Provider skill-list failures preserve structured reason, operation, provider instance, normalized cwd, and bounded cause diagnostics for missing providers, invalid cwd, settings failures, Codex home preparation, unauthenticated Codex accounts, probe timeouts, and probe failures while keeping stable user-facing messages. Raw thrown values are not sent directly to clients; the server keeps a small plain diagnostic shape so file paths, process output, and unexpected objects do not expand the wire payload.
- Non-Codex or disabled providers keep returning provider snapshot skills instead of failing workspace skill search.
- The client runtime keys provider-skill query state by environment, provider instance, and cwd, with a bounded stale window so reconnects refresh workspace-local skills without reusing another workspace's snapshot. Client-side fallback skill changes do not refresh the workspace query or respawn Codex skill probes.
- Web workspace-skill lookup follows the route environment's connection state. While disconnected, it does not start an RPC, retains only verified skills for the same environment/provider/cwd across lazy menu close/reopen cycles, otherwise falls back to provider snapshot skills with a non-pending reconnect error, and resumes the workspace refresh when the environment reconnects.
- The composer loads workspace skills lazily: it starts workspace skill discovery when the `$` skill menu is active or the prompt already contains a complete `$skill` token at whitespace, punctuation, or end-of-input, rather than probing on every empty composer mount. Mobile extends the upstream shared `useComposerCommandMenu` hook with one workspace-skill state value and one activation callback. `resolveComposerWorkspaceSkillMenu` selects workspace or provider-snapshot skills and keeps workspace loading or error feedback out of unrelated path completion. `ThreadComposer` and `NewTaskDraftScreen` no longer maintain separate `$` trigger and search implementations. The clients preserve already loaded repo-local skills while refreshing the same workspace, fall back to provider snapshot skills when a settled workspace lookup returns no skills or errors, keep structured lookup errors visible alongside those fallback skills, and clear stale repo-local skills during workspace switches or settled no-data states.
- Shared composer token collection uses the canonical skill parser. Its default whitespace boundary keeps active trailing mobile `$` queries editable, while web prompt segmentation opts into complete punctuation and end-of-input boundaries. The web path filters the active caret query before chip conversion, so it does not need a separate skill parse and deduplication pass.
- While the desktop composer caret is at the end of an active `$` query, the query remains editable text through workspace-skill refreshes and is excluded from inline-token cursor adjacency. This keeps the filtered picker open until the user selects a skill; selected and otherwise completed references still render as skill chips.
- The conversation timeline renders sent user prompts against the same workspace-aware skill list as the composer, so repo-local `$skill-name` references display with the same skill chip treatment as user-level skills. Timeline lookup stays disabled until a sent user prompt contains a complete skill token, including one at the end of the message, so an empty draft does not probe Codex merely to decorate nonexistent messages.
- Web composer and timeline skill lookup share the same provider-instance resolver, including settings-adjusted enabled state, availability, provider locks, continuation groups, and deterministic fallback. Timeline decoration prioritizes the active session and persisted thread model ahead of an unsaved composer draft selection, so changing the next-turn model cannot retarget already-sent skill references.
- The shared client-runtime policy, including target preparation, snapshot transitions, fallback selection, and error formatting, drives both web and mobile adapters. Mobile follows the selected environment's connection state, retains only verified same-workspace skills while disconnected or across lazy lookup close/reopen cycles, shows loading and structured reconnect/error feedback, refreshes an already-open `$` menu when skills arrive, decorates complete skill references, and prevents stale successful results from surviving failed refreshes or workspace switches.
- Mobile thread detail keeps workspace lookup lazy: it activates only while the composer `$` menu is active, when the draft contains a complete skill token, or when a visible sent user prompt contains a complete skill reference.
- New-task drafts expose the same filtered `$` picker as existing thread composers and request workspace skills lazily while that menu is active or after a complete `$skill` reference at whitespace, punctuation, or end-of-input. Workspace-aware lookup waits until the default workspace mode and server configuration have settled, so a provisional local mode cannot expose checkout-only skills for a draft that resolves to a future worktree. Settled local drafts resolve the selected checkout or project root, while settled future-worktree drafts deliberately have no cwd and use provider snapshots until the target directory exists.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/auth/RpcAuthorization.ts`
- `apps/server/src/diagnostics/ErrorCause.ts`
- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/server/src/provider/Drivers/CodexHomeLayout.ts`
- `apps/server/src/provider/ProviderSkillsRpc.ts`
- `apps/server/src/provider/ProviderSkillsLister.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/server/src/workspace/WorkspacePaths.ts`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ComposerPromptEditor.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ComposerCommandMenu.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/SkillInlineText.tsx`
- `apps/web/src/components/chat/skillInlineTokens.ts`
- `apps/web/src/composer-editor-mentions.ts`
- `apps/web/src/composer-logic.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.ts`
- `apps/web/src/lib/useTimelineProviderWorkspaceSkills.ts`
- `apps/web/src/providerInstances.ts`
- `apps/web/src/state/query.ts`
- `apps/mobile/modules/t3-markdown-text/src/nativeMarkdownText.ts`
- `apps/mobile/src/state/providerWorkspaceSkillsState.ts`
- `apps/mobile/src/state/query.ts`
- `apps/mobile/src/features/threads/ComposerCommandPopover.tsx`
- `apps/mobile/src/features/threads/new-task-flow-provider.tsx`
- `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`
- `apps/mobile/src/features/threads/ThreadComposer.tsx`
- `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`
- `apps/mobile/src/features/threads/new-task-provider-skills.ts`
- `apps/mobile/src/features/threads/thread-composer-skill-items.ts`
- `apps/mobile/src/features/threads/thread-provider-skills.ts`
- `apps/mobile/src/features/threads/use-composer-command-menu.ts`
- `packages/shared/src/composerInlineTokens.ts`
- `packages/shared/src/skillInlineTokens.ts`
- `packages/client-runtime/src/providerSkills.ts`
- `packages/client-runtime/src/state/providerWorkspaceSkills.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/server.ts`
- `packages/client-runtime/src/state/server.ts`

Relevant tests and fixtures live in:

- `apps/server/scripts/codex-skills-mock-app-server.ts`
- `apps/server/src/server.test.ts`
- `apps/server/src/auth/RpcAuthorization.test.ts`
- `apps/server/src/diagnostics/ErrorCause.test.ts`
- `apps/server/src/provider/Drivers/CodexHomeLayout.test.ts`
- `apps/server/src/provider/ProviderSkillsRpc.test.ts`
- `apps/server/src/provider/ProviderSkillsLister.test.ts`
- `apps/server/src/provider/Layers/CodexProvider.test.ts`
- `apps/server/src/provider/Layers/CodexProviderSkills.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/GrokProvider.test.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
- `apps/server/src/provider/testUtils/serverProviderSnapshot.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/chat/ComposerCommandMenu.test.tsx`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/composer-editor-mentions.test.ts`
- `apps/web/src/composer-logic.test.ts`
- `apps/web/src/lib/providerWorkspaceSkillsState.test.ts`
- `apps/web/src/lib/useTimelineProviderWorkspaceSkills.test.ts`
- `apps/web/src/providerInstances.test.ts`
- `apps/mobile/src/lib/nativeMarkdownText.test.ts`
- `apps/mobile/src/features/threads/new-task-provider-skills.test.ts`
- `apps/mobile/src/features/threads/thread-composer-skill-items.test.ts`
- `apps/mobile/src/features/threads/thread-provider-skills.test.ts`
- `apps/mobile/src/features/threads/use-composer-command-menu.test.ts`
- `packages/shared/src/composerInlineTokens.test.ts`
- `packages/shared/src/skillInlineTokens.test.ts`
- `packages/client-runtime/src/providerSkills.test.ts`
- `packages/client-runtime/src/state/providerWorkspaceSkills.test.ts`
- `packages/client-runtime/src/state/runtime.test.ts`

Useful focused commands:

```sh
(cd apps/server && pnpm exec vp test run --passWithNoTests src/provider/ProviderSkillsRpc.test.ts src/provider/ProviderSkillsLister.test.ts src/provider/Layers/CodexProvider.test.ts src/provider/Layers/CodexProviderSkills.test.ts src/provider/Layers/CursorProvider.test.ts src/provider/Layers/GrokProvider.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/composer-editor-mentions.test.ts src/composer-logic.test.ts src/lib/providerWorkspaceSkillsState.test.ts)
(cd apps/mobile && pnpm exec vp test run --passWithNoTests src/features/threads/new-task-provider-skills.test.ts src/features/threads/thread-composer-skill-items.test.ts src/features/threads/thread-provider-skills.test.ts src/features/threads/use-composer-command-menu.test.ts)
(cd packages/shared && pnpm exec vp test run --passWithNoTests src/composerInlineTokens.test.ts src/skillInlineTokens.test.ts)
(cd packages/client-runtime && pnpm exec vp test run --passWithNoTests src/state/providerWorkspaceSkills.test.ts)
```

## Development Ports

- Web: `5735`
- Server/WebSocket: `13775`
- This branch's fixed port reservation overrides the general `AGENTS.md` instruction to accept
  shifted worktree ports. Because `scripts/dev-runner.ts` derives a different preferred offset from
  this worktree path, start the web stack with `T3CODE_PORT_OFFSET=2 vp run dev`. Only proceed when
  the `[dev-runner]` startup line reports exactly `webPort=5735` and `serverPort=13775`; if it
  selects replacements because either port is unavailable, stop and free the reserved ports before
  retrying.

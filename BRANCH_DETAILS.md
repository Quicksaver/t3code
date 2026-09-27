# Magi Consensus Orchestration

**Worktree branch:** `feat/magi-consensus-orchestration`

Magi is an implemented fork feature for provider-neutral, weighted consensus owned by one T3 conversation. A user-facing conversation can arm its next turn, and an eligible ordinary conversation agent can start Magi after an explicit user request. One conversation can own at most one nonterminal run, and Magi participant conversations remain ineligible. `MAGI.md` is the detailed product contract, architecture record, verification plan, drawbacks, and acceptance source.

Primary reference:

- `MAGI.md`

Supporting operational and security references:

- `MAGI_ARBITRATOR_CODE_REVIEW.md` defines the complete review-and-fix arbitration example, including roster preflight, evidence requirements, proposal handling, and the final consensus condition.
- `MAGI_ARBITRATOR_PLAN_REFINEMENT.md` defines the document-refinement arbitration example and keeps that workflow separate from implementation authorization.
- `MAGI_PERSONALITY_CODE_REVIEWER.md` is the participant review rubric used by the code-review example.
- `apps/server/src/magi/THREAT_MODEL.md` records Magi's prompt-injection, credential, tool-access, denial-of-service, cancellation, and durable-audit-data trust boundaries.

## Preferred development ports

- Web: `8556`
- Server: `16596`

These are the stable preferred ports for this worktree. The `[dev-runner]` line remains authoritative
when an occupied port forces a shift.

## Current integration seams

- `MagiInvocation.ts` reads native-child `parentRelation` records through `getThreadLineage`; `MagiHistory.ts` uses the same lineage query. The separately integrated subagent-threading work supplies `kind: "subagent"`, `parentThreadId`, and `providerThreadId`. This standalone checkout does not carry that shape: history remains root-only and unknown native callers fail closed. After picking both branches, preserve native lineage in both queries. Caller routing and descendant history must not load the sidebar snapshot or resolve project Git identities. Evidence preparation reads project persistence directly and disables pull-request enrichment in thread detail. Keep these paths independent of cancellable Git discovery so sidebar/history refresh cancellation cannot abort an unrelated MCP call. Each native child owns its evidence, runs, and controls; the parent panel aggregates runs without changing their ownership.
- Provider recovery derives a participant's `magi-read-only` profile from persisted lineage in `getThreadRuntimeContext`. Preserve Magi relations in that narrow query when integrating native-child lineage; participant rows are deliberately absent from sidebar shells. OpenCode must confirm the `t3-code` MCP connection before creating or resuming its session, including when registration returns HTTP success with a failed connection status.
- `apps/server/src/persistence/Migrations.ts` adds `055_MagiProjections` directly after upstream's `054_ProjectionThreadsAutoSettleDisabledAt`. It creates the complete Magi schema, indexes, and proposal terminology in the ordinary `effect_sql_migrations` ledger. The feature branch has one canonical migration because upstream has not run intermediate Magi schemas.
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
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` keeps local git status and checkpoint
  handling for Magi participant completions but skips pull-request discovery and global list
  invalidation. Participants share the root checkout and cannot own its pull request; the root turn
  performs the single refresh for the completed Magi workflow.
- `apps/web/src/components/settings/EnvironmentSettingsPanel.tsx` and `EnvironmentSettingsPanel.logic.ts` own settings access checks shared by Providers and Magi. Both routes use upstream's `SettingsScopeContext` to select their environment; the shared panel must not independently select another environment for scoped settings. Both screens route reads, writes, loading states, and read-only permissions through that environment. `ProviderSettingsPanel.logic.ts` keeps the provider-specific export names as a compatibility adapter and contains no independent settings logic. Unscoped Cursor-keychain searches select a connected macOS environment through the shared panel; explicitly scoped settings retain their selected environment.
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
- `apps/mobile/src/components/MagiConsensusIcon.tsx` is the shared mobile Magi glyph for conversation
  rows and the run sheet. It follows the mobile theme layer's custom-SVG seam with
  `withUniwind(Svg)`, `currentColor`, and the semantic `accent-icon` default while retaining explicit
  `color` and `colorClassName` overrides. It is not a reviewed `useUniwindTheme` escape hatch and must
  remain absent from `no-mobile-uniwind-theme-escape-hatches.ts`'s interop allowlist.

- Mobile new-task drafts use upstream's durable draft identity, project metadata, and inline attachment context. Magi's `magiArm` stays on that draft. Mobile opens Magi only through `Open magi` in the header menu, after `Open terminal` and `Open git controls` for existing conversations. New-task drafts expose the same menu action. There are no floating or composer Magi launchers.

## Dev-server testing

When verifying Magi in a dev server, use these participant settings:

- Codex: GPT-5.6 Luna, low reasoning, fast mode off
- Claude: Sonnet 5, low reasoning, 200k context window
- Cursor: Grok 4.6, low reasoning, fast mode off

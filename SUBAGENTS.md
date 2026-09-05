# UI-Aware Subagent Threading

## Scope

This branch adds durable, routeable Codex subagent conversations without changing normal root-thread behavior or inferring lineage for providers that do not expose it.

The customization covers:

- Codex subagent lineage and deterministic local child-thread identity.
- Projection of children as first-class thread shells and details.
- Routeable child conversations, opt-in default web Agents-panel navigation, and contextual Legacy Sidebar/mobile rows.
- Persisted child-conversation routing from Agents-panel items after web opt-in.
- One persisted generated child title shared by the sidebar, Agents panel, and child conversation.
- Exact selected-terminal-child visibility in Legacy Sidebar/mobile without restoring hidden terminal ancestors.
- Isolation of child prompts, output, tool calls, diffs, and nested child work from the parent timeline.
- Explicit child stop through the provider-bound root session with an explicit child turn id.
- Parent-collaboration metadata ingestion and missing-child shell synthesis.
- Exclusion of mobile pending/new-task rows from thread lineage traversal.
- Preservation of subagent lineage across logical project scopes and stale/canonical project identities.
- Server-enforced root lifecycle semantics for archive/delete, including descendants.
- Root-only lifecycle affordances across web, desktop, and mobile row or chat-header menus: canonical and shared menus gate settle, snooze, and delete, while the legacy web sidebar gates archive and delete.

Providers without durable child-thread lineage retain their provider-native activity presentation. Antigravity task events and active-batch handling stay on that path and are not converted into persisted child conversations. This branch does not add generalized provider-worker concurrency, pending-task editing fixes, timeline scrolling/minimap changes, or development-server HMR changes.

## User-visible behavior

- A Codex child agent is represented by a real conversation thread whose `parentRelation.kind` is `subagent`.
- The default web Sidebar renders root rows only. A root with running descendants or live provider-native agent tasks shows a bot indicator containing the greater of the persisted recursive running-descendant total and the live task total; it has no disclosure arrow, and activating it navigates to that root when necessary and opens its Agents panel. After `Subagent conversations` is enabled in Settings → General, Default Sidebar search exposes matching nested or terminal descendants for direct navigation.
- The Agents panel is always the default web lifecycle roster. Direct-agent branches containing live work sort before idle and terminal branches, and descendants render immediately below their parent with capped lineage indentation. Resolved rows open persisted child conversations only after the default-off standalone conversation setting is enabled.
- The opt-in Legacy Sidebar and mobile Thread List v2 retain contextual lineage rows. Running children remain at stored depth, while terminal children stay hidden unless that exact child is open; hidden terminal ancestors do not reappear, and terminal rows do not contribute to running counters.
- Logical project filters operate over every member project reference before lineage is rendered. A parent and child associated with stale and canonical ids for the same physical project remain in one nested path, while unrelated project groups remain excluded. Mobile thread rows resolve their displayed project title from the logical scope across all of those references rather than reverting to a stale member title.
- A running descendant retains its stored depth even if an intermediate terminal parent is hidden.
- `MessagesTimeline` and `AgentsPanel` own subagent lifecycle and activity presentation. The timeline's spawn/activity row opens the Agents panel; this branch does not render separate subagent tool-call boxes.
- With standalone visibility enabled, clicking a resolved Agents-panel item opens its persisted child conversation. Provider agent ids are matched only within the active environment and root lineage; while disabled, provider rows remain visible but non-interactive.
- The persisted child title is generated once and displayed consistently in the sidebar, Agents panel, and child conversation.
- Parent views retain the activity presentation while child output and actions render only in the persisted child conversation.
- Child views show the launch/follow-up prompt when Codex exposes it, followed by child-owned output and actions. Grandchildren appear only inside their direct parent child view.
- Child views cannot be prompted or steered. A running child exposes an explicit stop control and direct-parent navigation.
- Stopping a root does not implicitly stop running children. Stopping a child targets that child and never falls back to the root active turn.
- The canonical Sidebar and shared chat-header menus expose settle, snooze, and delete only for lifecycle roots. Subagent children retain non-lifecycle actions such as pin, rename, unread, copy, and project settings. Server planning applies root archive/delete through active descendants, deepest first.
- In `LegacySidebar.tsx`, root-lifecycle gating applies to multi-select and single-row archive/delete: every target must resolve to a persisted root shell and lifecycle affordances are hidden otherwise. Bulk handlers re-read the unchanged selected set and current shells before dispatch, while single-row handlers re-read the latest shell before dispatch.
- User-defined pin ordering applies to whole root-lineage groups on the lineage-rendering mobile and Legacy Sidebar surfaces; the default web Sidebar orders root rows only.

## Data model and persistence

Projected threads carry this relation:

```ts
type OrchestrationThreadParentRelation =
  | {
      kind: "root";
      rootThreadId: ThreadId;
    }
  | {
      kind: "subagent";
      rootThreadId: ThreadId;
      parentThreadId: ThreadId;
      parentTurnId: TurnId | null;
      parentItemId: ProviderItemId;
      parentActivitySequence: number;
      providerThreadId: string;
      titleSeed: string | null;
      depth: number;
      startedAt: string;
      completedAt: string | null;
      status: "running" | "completed" | "errored" | "interrupted" | "stopped";
    };
```

`apps/server/src/persistence/Migrations/034_ProjectionThreadParentRelation.ts` idempotently adds the explicit projection columns and parent/root indexes. `apps/server/src/persistence/Migrations/035_BackfillEmptyProjectionThreadRootIds.ts` invokes that schema migration before ensuring the settled-thread columns and repairing empty root ids that could remain in already-created projection rows. This is the convergence path for databases whose recorded numeric migration 34 is `ProjectionThreadsSnoozed`, because the migrator skips every migration at or below the latest recorded id. `apps/server/src/persistence/Migrations/036_ProjectionThreadsSnoozed.ts` idempotently ensures the snooze columns when migration 34 is instead `ProjectionThreadParentRelation`. Projection reads, shells, detail snapshots, reducers, and shell/detail merges preserve `parentRelation`. Shell-stream refetch/coalescing and WebSocket RPC delivery also retain the complete relation.

`mapThreadParentRelationFields(...)` in `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` maps root defaults and subagent lineage columns for both `thread.created` and `thread.meta-updated`. Projection bootstrap reads every unapplied event instead of stopping at the event store's default 1,000-event window, so a child beyond that boundary still rebuilds with its root, direct parent, depth, timing, provider identity, and terminal status. `ProjectionPipeline.test.ts` holds that contract with a completed depth-two child placed after 1,000 earlier events.

`apps/server/src/persistence/Migrations.ts` records lineage and its compatibility repairs at IDs 34-39, turn-keyset and pin-order migrations at IDs 40 and 41, project default-thread-environment and favicon migrations at IDs 42 and 43, and `044_ProjectionThreadLineageConvergenceAfterProjectMigrations.ts` as a second idempotent lineage convergence. Auth-session connection, linked pull request, unsettled timestamp, automatic project-model cleanup, and project auto-pull occupy IDs 45-49 under matching `045_...` through `049_...` filenames. `050_ProjectionThreadLineageConvergenceAfterUpstreamTail.ts` repeats the idempotent convergence above the customized tail, covering supported ledgers that reached ID 38, the project-migration boundary, or migration ID 45 without the lineage columns. `051_RepairAutomaticSettlementTimestamps.ts` and `052_ProjectionProjectIcon.ts` carry the automatic-settlement repair and project-icon schema without reusing IDs 46 and 47 in that ledger.

Normal root/default projection upserts do not overwrite an existing subagent relation. Create and metadata-update commands reject missing parents and cyclic ancestry.

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` requests a generated child title only while the latest persisted shell title is still the launch seed or `Subagent`. The generated result is stored through `thread.meta.update` and reused by every client surface rather than generated separately per surface.

`makeSyntheticSubagentThreadShell(...)` in the same module is the single missing-child shell constructor. It inherits parent project, model, runtime, interaction, branch, and worktree context; resets child-owned lifecycle, session, activity, and presentation fields; and satisfies `Required<OrchestrationThreadShell>` so additions to the shell contract must be handled at this seam.

## Codex routing and ingestion

- `CodexSubagentRouting.ts` owns provider-route correlation for legacy `collabAgentToolCall` and multi-agent v2 `subAgentActivity` notifications.
- A local child id is deterministic from the local direct parent thread id plus the provider child thread id. Parent item ids are activity identities, not child identities.
- Direct-child `started` and prompt-bearing interaction events create parent activity references. Control-only wait/close events reuse existing references. Ancestor, sibling, and indirect descendant interactions do not rewrite direct lineage.
- Parent runtime items carry `subagentChildren`; child runtime events carry `parentCollab` when correlated.
- Ingestion creates or updates child shells, preserves the authoritative direct parent/root/depth, and reopens terminal relations when a prompt-bearing resumed activity begins.
- Child events can synthesize a missing shell from runtime metadata before the normal parent projection catches up.
- Raw child prompts are appended as stable, non-streaming user messages in the child thread. Whitespace-only prompts are ignored.
- Child terminal state comes from child lifecycle events. A later generic session exit cannot overwrite a more specific terminal state.
- Parent projection suppresses child-owned output/actions. Unsupported providers keep their existing behavior.
- `CodexSessionRuntime` synthesizes `collabAgent/*` notifications from provider child-thread activity. `CodexAdapter` maps those notifications into the shared `task.started`, `task.updated`, and `task.progress` lifecycle with `timelineBypass`, preserving identity, parent/path metadata, active/waiting/idle/failed/interrupted state, cumulative token usage, and activity summaries for the Agents panel. Interaction-only activity preserves identity without synthesizing `running` or reopening the persisted child relation; a real resume becomes active through authoritative lifecycle notifications. This feed is additive: the runtime also forwards each registered child's original lifecycle on its deterministic local child thread with `subagentChildren`/`parentCollab` metadata. Dropping either path leaves the Agents panel empty or leaves its rows without persisted titles and navigation.
- `apps/server/src/orchestration/ActivityPayloadProjection.ts` prunes transported `collab_agent_tool_call` data to client-consumed fields while preserving allowlisted streamed output chunk fields verbatim, prompt-bearing item/raw-input fields, tool and item ids, `kind`, parent-collab item/detail metadata, and `subagentChildren` thread/parent-item/title references. Client work-log derivation retains that metadata for child persistence, routing, and identity without receiving unrelated provider payload bulk, but filters fork-specific child-reference entries from the rendered parent timeline.

## Stop semantics

Web stop input uses the running child's latest projected turn id. The provider reactor resolves a child's provider route through `rootThreadId` and calls the provider with the explicit child turn.

If no child turn exists, the reactor records a best-effort failure, marks the child relation stopped, and clears the synthetic child session. It does not interrupt the root active turn. If the child interrupt request fails or times out, diagnostic recording remains best effort so cleanup can still terminalize the child relation/session.

`thread.session.stop` on a synthetic child never assumes a separate child provider binding. It uses the live root route when available, then clears the child projection state. Root session stop is bounded and terminalizes the projected session even when both the provider request and failure-activity append fail. Failed diagnostic appends are counted and logged without blocking child or root cleanup. Normal root interrupt behavior remains provider-runtime-owned.

## Web projection and timeline

- `MessagesTimeline` and `AgentsPanel` own subagent lifecycle/activity presentation. The branch supplies persisted conversation routing and titles without replacing their tool-call or spawn rows.
- The Codex parent timeline uses a single spawn-summary activity box for fork-persisted subagents. It reads `Kicked off x subagent(s)` while live or `Ran x subagent(s)` after settlement, includes aggregate token usage when available, and opens the Agents panel. Fork-specific `collab_agent_tool_call` rows carrying `subagentChildren` remain available to persistence and routing consumers but are filtered before timeline grouping so they cannot duplicate that summary or affect collapsed tool-row counts. Legacy collab rows without child references and provider-native subagent activity remain on their normal presentation paths.
- `apps/web/src/components/SidebarSubagents.logic.ts` retains cycle-safe root classification, recursive counts, traversal, and search without promoting descendants through hidden terminal parents; non-lineage Sidebar behavior remains in `Sidebar.logic.ts`.
- The default Sidebar keeps root conversations in the active/settled layout and does not render subagent rows. It compares the recursively counted running descendants with the server-projected `activeSubagentCount` from live provider tasks and exposes the greater total through a non-disclosing bot indicator that opens the root conversation's Agents panel. This preserves visibility while a persisted child shell is missing or catching up without double-counting once both paths converge.
- The live-task projection excludes idle and terminal tasks from the running count and retains a bounded in-memory settled-task tombstone until provider session exit. Late item/progress notifications cannot resurrect a settled badge; a fresh start clears the tombstone, and explicit `running` or `waiting` updates may resume an idle task but not a hard-terminal one.
- Sidebar filters the non-archived structural shell list through `selectSidebarProjectLineageThreads(...)` in `apps/web/src/sidebarProjectGrouping.ts` before root classification, running-descendant counting, and search. The caller supplies the memoized key set built from every stale and canonical project reference in the selected logical group. `SidebarSubagentThreadRow` in `Sidebar.tsx` supplies the running-count decoration to `SidebarThreadRow` without coupling lineage behavior to the draft or project-settings structure. Default Sidebar search, the command palette, and Legacy Sidebar omit child navigation while standalone visibility is disabled.
- `collectSearchableSidebarThreads(...)` collects complete depth-first lineages from active, snoozed, and settled roots in that order without depending on expanded-row state, using the already project-scoped structural shell list.
- Child shells remain available for lifecycle status, lineage, recursive running counts, and root-owned lifecycle behavior. Child detail routing and search become available only after standalone visibility is enabled; a disabled direct child route redirects to its immediate parent without subscribing to child detail.
- The Agents panel forms a cycle-safe hierarchy for non-workflow agents from explicit owner ids and Codex `agentPath` metadata. Direct branches with active work sort first; descendants stay directly below their parent with capped indentation.
- `deriveAgentChildConversationByProviderId(...)` in `ChatView.logic.ts` indexes persisted child shells by provider agent id only after standalone visibility is enabled and only within the active environment and root lineage. Each indexed record contains both the scoped thread route and persisted title, preventing unrelated shells from supplying either value.
- `ChatView.tsx` passes the persisted title map and route callback to `AgentsPanel` only after opt-in; otherwise the panel remains a non-interactive lifecycle roster.
- `resolveRightPanelControlsOwner(...)` in `ChatView.logic.ts` assigns the shared right-panel controls to the root while an inline panel is present, the open sheet for sheet layout, or the chat header fallback. `ChatView.tsx` applies that placement to the Agents panel without adding Agents-specific controls, and `ChatView.logic.test.ts` covers each ownership state.
- Child views replace the normal composer with the subagent status/stop control owned by `SubagentControlBar.tsx`. `ChatHeader.tsx` exposes direct-parent navigation through the optional `trailingAction` slot in `WorkspaceBreadcrumb.tsx`; the action remains outside the ordered breadcrumb list while the current thread item retains `aria-current="page"`.
- Session logic excludes child-owned entries from parent work logs, retains child-reference correlation data in derived work logs, and filters those reference rows from the rendered parent timeline so the spawn CTA remains the sole visualization.
- `threadActionMenu.logic.ts` gates settle, snooze, and delete through the explicit `permissions.rootLifecycle` contract. `Sidebar.tsx` and `useThreadActionMenu.ts` derive it from `parentRelation`, and both dispatch paths retain fail-closed guards so child or stale menu results cannot invoke root lifecycle mutations.
- `LegacySidebar.tsx` passes `canUseSelectedRootThreadLifecycleActions(...)` into `buildMultiSelectThreadContextMenuItems(...)` for bulk actions, then re-reads the selected keys and current shells before dispatch and fails closed if the selection changed. `LegacySidebar.logic.ts` applies the equivalent resolved-shell permission to inline archive and the single-row context menu; those handlers re-read the latest shell before dispatch. Unresolved keys and subagent shells therefore fail closed in both paths.

## Mobile and client runtime

- `apps/mobile/src/lib/threadLineage.ts` is the shared lineage traversal for the adaptive home list and thread navigation sidebar.
- Mobile Thread List v2 runs that traversal before its active/settled/snoozed partition, derives cycle-safe recursive running-descendant counts from the structural scope, and collapses each nested generation behind its conversation's explicit disclosure control. Expanded eligible running children render as compact status rows at their stored depth. It preserves only the exact selected terminal shell without restoring hidden terminal ancestors or promoting or paging out settled lineages, keeps terminal descendants searchable by title as navigation-only rows, rebases matching search rows when their parents are filtered out, and keeps settled and snoozed lineage groups atomic while paging or shelving. Collapsing the settled shelf hides complete lineage groups, while a selected settled subagent remains directly navigable at its stored depth. A snoozed root retains its running descendants, stored depths, recursive running count, and expansion state in the snoozed shelf instead of promoting terminal children into the active list; only that root receives wake metadata. A nested subagent already snoozed in persisted state from another or older client shelves its subtree without hiding unsnoozed ancestors or siblings and rebases that shelf subtree to depth zero; current row menus do not expose child lifecycle mutations. Snoozed counts count independently snoozed threads, while counts, shelf membership, and wake metadata remain scoped to the active search.
- Pinned mobile lineage groups are ordered through `sortPinnedThreadsByOrderKey(...)` using their pinned representative, then flattened in their original lineage order so children never become independent pinned roots.
- Pending/new-task rows are composed outside this traversal. They can participate in project grouping and search, but never become lineage nodes or contribute thread depths.
- Home-list grouping maps every logical-scope project reference, including stale duplicate ids, before lineage traversal; quick new-thread targeting resolves activity back to the canonical physical project. `buildHomeProjectTitleIndex(...)` maps the logical group title across every member reference for both `HomeScreen` and `ThreadNavigationSidebar`.
- The thread navigation sidebar applies project-scope filtering to the selected-shell-aware `threadsForGrouping` collection rather than the raw shell snapshot.
- Only the selected terminal child shell remains visible; hidden terminal ancestors stay hidden, and running descendants keep their stored depth through hidden terminal parents.
- Search results rebase visible depth when filtered parents are absent.
- Child detail shows parent navigation and the stop/status control from `apps/mobile/src/features/threads/SubagentControlBar.tsx` instead of a composer. That component also owns the height reserved by `ThreadDetailScreen.tsx`.
- Composer-state and selection guards reject subagent draft mutation, setting mutation, and send attempts.
- Client-runtime reducers and shell/detail merges retain `parentRelation` across snapshot and stream updates.
- `getLatestThreadSortTimestamp(...)` in `packages/client-runtime/src/state/threadSort.ts` calculates the newest member timestamp for web sidebar project groups and mobile home project groups. Web uses it only for non-empty thread lists and otherwise falls back to the project's timestamp; mobile may use its empty-thread-group seed before folding in pending-task timestamps.

## Root lifecycle

The orchestration decider treats root archive/delete as a lifecycle operation over active subagent descendants. Descendants are planned deepest first, followed by the requested root. Project force-delete delegates through lifecycle roots so descendants are not independently planned twice.

Web actions keep local navigation, draft cleanup, and materialized descendant cleanup aligned with the server command, but correctness does not depend on every client having loaded every descendant.

## Verification targets

`ProviderCommandReactor.test.ts` covers cleanup after combined provider-control and failure-activity append failures for child interrupts and root session stops.

`apps/server/src/provider/Layers/AntigravityAdapter.test.ts` resolves the native-resume working directory through Effect's path service before asserting it, so the provider resume contract has the same test on Windows and POSIX. This is test portability only and does not change Antigravity runtime behavior.

Focused coverage lives in:

- `apps/server/src/provider/Layers/CodexSubagentRouting.test.ts`
- `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/server/src/orchestration/decider.delete.test.ts`
- `apps/server/test/ActivityPayloadProjection.test.ts`
- `apps/server/src/persistence/Migrations/016_CanonicalizeModelSelections.test.ts`
- `apps/server/src/persistence/Migrations/035_BackfillEmptyProjectionThreadRootIds.test.ts`
- `apps/server/src/persistence/Migrations/042_ProjectionProjectsDefaultThreadEnvMode.test.ts`
- `apps/server/src/persistence/Migrations/043_ProjectionProjectFaviconPath.test.ts`
- `apps/server/src/persistence/Migrations/051_RepairAutomaticSettlementTimestamps.test.ts`
- `apps/server/src/persistence/Migrations/052_ProjectionProjectIcon.test.ts`
- `apps/server/src/provider/Layers/AntigravityAdapter.test.ts`
- `apps/server/src/server.test.ts`
- `apps/web/src/components/LegacySidebar.logic.test.ts`
- `apps/web/src/components/Sidebar.test.tsx`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/SidebarSubagents.logic.test.ts`
- `apps/web/src/components/WorkspaceBreadcrumb.test.tsx`
- `apps/web/src/components/AgentsPanel.test.tsx`
- `apps/web/src/components/chat/ChatHeader.test.ts`
- `apps/web/src/components/ChatView.browserHistoryInterop.test.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/threadActionMenu.logic.test.ts`
- `apps/web/src/session-logic.test.ts`
- `apps/mobile/src/lib/threadLineage.test.ts`
- `apps/mobile/src/features/home/homeThreadList.test.ts`
- `apps/mobile/src/features/threads/threadListV2.test.ts`
- `packages/client-runtime/src/state/entities.test.ts`
- `packages/client-runtime/src/state/threadReducer.test.ts`

Follow the repository's focused local-verification policy:

```sh
git diff --check
vp test run <focused-test-files>
vp run --filter=<affected-package> typecheck
```

Run targeted formatting and lint checks for affected files when available. For user-visible frontend
changes, the primary agent should run the isolated `test-t3-app` browser workflow after integration.
Do not run repo-wide checks locally unless explicitly requested; run `pnpm exec vp run lint:mobile`
only when native Swift/Kotlin code changes.

## Remaining risks

- Reconnect and multi-client behavior still warrants stress coverage around the snapshot/WebSocket catch-up boundary.
- Deep nesting should be load-tested for indentation and row ordering under large active-child sets.
- Dynamic Type, split-view resizing, and safe-area changes should be exercised on physical mobile devices.
- Parent-relation projection columns remain intentionally explicit across SQL reads and the upsert
  conflict guard in `ProjectionSnapshotQuery.ts` and `ProjectionThreads.ts`; only the pipeline
  event-payload mapping is centralized in `mapThreadParentRelationFields(...)`. A schema-focused
  read refactor may still centralize them without changing behavior.

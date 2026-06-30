# UI-Aware Subagent Orchestration Plan

## Branch Metadata

- Latest upstream merge prepared: `upstream/main` at `2448212367b4348f39eaf5c2635eea6896218cba` applied into `split/subagent-threading-work` from pre-merge branch HEAD `63a7d2fd7c1dbff26c8e7d1416e051367969e571`. The merge is intentionally left uncommitted for coordinator review; `MERGE_HEAD` points at `2448212367b4348f39eaf5c2635eea6896218cba`.
- Post-merge branch diff against `upstream/main`: 33 branch-only commits before the final merge commit, 0 upstream-only commits in the applied merge result, 43 files changed, 5845 insertions, 373 deletions. Because the merge is intentionally uncommitted, raw Git ancestry still reports `HEAD...upstream/main` as 33 ahead and 2 behind; the staged merge result applies both upstream-only commits.
- Remote tracking status during the prepared merge: `split/subagent-threading-work` is 0 commits ahead and 0 commits behind `origin/split/subagent-threading-work`; this branch continues to use `upstream/main` as the merge baseline.
- Conflict notes for the `244821236` merge: no files stopped for manual conflict resolution. Git auto-merged `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`, and `apps/web/src/components/chat/MessagesTimeline.test.tsx`; the resulting branch keeps upstream's restored Legend List scroll anchoring, scroll-to-end affordance behavior, timeline minimap, composer overlay inset handling, and package version bumps while preserving this branch's subagent control bar, parent subagent reference blocks, child output isolation, child stop routing, sidebar nesting, and hidden child route behavior.
- New fork customizations introduced by this merge: none. The branch-owned adaptation is limited to carrying the existing UI-aware Codex subagent behavior through upstream's revised chat timeline scroll/minimap implementation.
- Retired customizations made redundant by upstream: none identified. Upstream's timeline minimap and scroll-affordance fixes do not provide Codex subagent lineage, child-thread projection, sidebar nesting, stop routing, parent activity rows, child output isolation, or archive/delete descendant lifecycle semantics.
- Follow-up refactor after the `244821236` merge: subagent work-entry display-part resolution, child row model derivation, relation terminal snapshotting, and block display-state derivation now live in `apps/web/src/components/chat/MessagesTimeline.logic.ts`; `MessagesTimeline.tsx` keeps the React rendering, shell lookup, and navigation wiring.
- Assessment follow-up after the timeline-logic refactor: review fixes tightened chat timeline anchor cleanup on send rollback, precise manual-scroll cancellation, generic child-title fallback, exact Legend List end-state handling, live-follow frame scheduling, anchored-turn end measurement, minimap visibility/state derivation, subagent reinvocation heuristics, stale running-relation display, and short-prompt/output deduplication.

## Status

This plan has been updated after the implementation and review-fix pass. The feature is implemented for Codex only. Unsupported providers should continue using the previous inline subagent-output behavior until they expose durable child-thread lineage.

The current behavior is:

- A Codex subagent is represented as its own conversation thread.
- Active subagent threads appear in the sidebar nested under the direct parent that spawned them.
- Completed, errored, interrupted, or stopped subagent threads are normally hidden from the sidebar but remain reachable from the parent conversation view. When a terminal subagent conversation is the active route, that subagent and any intermediate subagent ancestors are shown in the sidebar at their normal nested positions until the user navigates away.
- A parent conversation view shows only parent-owned output and subagent summary blocks for direct children.
- When Codex resumes an existing subagent with a follow-up prompt, the parent conversation appends a new subagent summary block for that resumed activity while preserving the original block, and the same child thread appears in the sidebar as running again until the resumed turn reaches a terminal state.
- A child conversation view shows the raw initial prompt that launched that child when Codex exposes it, followed by that child's output, tool calls, diffs, MCP calls, and other actions. Grandchildren appear only as blocks inside their direct parent child view.
- Users cannot prompt or steer a subagent. The child view exposes stop control only while the child is running and a header button for returning to its direct parent conversation.
- Stopping a parent does not automatically stop running children. Stopping a child explicitly targets that child.
- Archive/delete actions are exposed only for root parent conversations and should include descendant subagent threads as part of that root lifecycle.

## Assessment

The original architecture had three important gaps: no durable parent/child thread lineage, no routeable hidden child-thread detail after completion, and parent timelines that mixed child output/actions into the parent view. Those gaps have now been addressed for Codex by carrying Codex child-session identity into orchestration metadata, projecting child threads as first-class threads, and rendering child work only in the child's own conversation.

The most important implementation choice is that a subagent is not just a special visual box. It is a real projected thread with a `parentRelation.kind === "subagent"` relation. The parent timeline keeps only a compact child reference block derived from the Codex collab lifecycle item, while child output and actions are ingested into the child thread's timeline.

## Implemented Data Model

Thread parentage is persisted on projected threads. The implemented shape is:

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
      parentItemId: string | null;
      parentActivitySequence: number;
      providerThreadId: string;
      titleSeed: string | null;
      depth: number;
      startedAt: string;
      completedAt: string | null;
      status: "running" | "completed" | "errored" | "interrupted" | "stopped";
    };
```

The persistence migration stores this relation as explicit projection-thread columns, including root thread, direct parent thread, provider child thread id, parent activity sequence, title seed, depth, started/completed timestamps, and subagent status. Indexes support parent lookup and root lifecycle lookup.

Review fixes added preservation guards so a normal root/default projection upsert cannot overwrite an existing subagent relation for the same thread.

## Server Implementation

1. Codex child identity is mapped into deterministic local child thread ids from `parentThreadId + providerThreadId`. This intentionally avoids using `parentItemId`, because Codex may emit multiple collab lifecycle/control items for the same child provider thread.

2. Codex collab lifecycle items now carry `subagentChildren` metadata on the parent activity payload. Each child reference includes the provider thread id, local child thread id, optional parent item id, and optional title seed. Prompt-bearing `spawnAgent`, `resumeAgent`, and `sendInput` items start a new parent activity reference for the same child thread, while control-only `wait` and `closeAgent` items stay tied to the existing reference so they do not create duplicate blocks. The parent UI uses this metadata to render the compact `Subagent - <title>` block.

3. Codex collab lifecycle tracking preserves both the raw child prompt and the title seed. The raw prompt comes from the collab tool item `prompt` field and is used as displayable child-thread conversation history; the title seed remains the input for generated child titles and parent summary labeling. Whitespace-only raw prompts are ignored.

4. Child-thread creation and updates happen through orchestration ingestion. The server preserves the direct parent, root thread id, depth, parent activity sequence, title seed, provider thread id, and started timestamp. When a terminal child is resumed from a new prompt-bearing parent activity, ingestion updates the existing child relation back to `running`, clears `completedAt`, records the new parent item id, and appends the follow-up prompt to the child conversation. Synthetic child shells are created so hidden child routes can be opened before the full projection catches up, and child runtime events that arrive with parent-collab metadata can synthesize the missing child shell before their output or tool activity is ingested.

5. When Codex exposes a raw child prompt, ingestion appends it to the child thread as a non-streaming user message through an internal `thread.message.user.append` command. The prompt message uses stable ids derived from `childThreadId + parentItemId`, is not bound to the parent turn, and is appended even if the child shell already exists because Codex first emitted a started item without a prompt and later emitted a completed item with the concrete prompt.

6. Child terminal status is derived from child lifecycle events, not from the parent collab item alone. Terminal updates apply only while the relation is still `running`, which prevents later `session.exited` events from overwriting a more specific `completed`, `errored`, `interrupted`, or `stopped` result.

7. Child stop/interrupt handling routes through the provider-bound root session while targeting the selected child thread/turn. Parent stop remains scoped to the requested parent thread and does not cascade to active children. If a child stop request cannot identify an active child turn, the server records an interrupt failure on the child, marks the child stopped, and does not fall back to the root session active turn.

8. Completed child detail remains tied to the root parent lifecycle. The orchestration decider cascades root parent archive/delete actions through active descendant subagent threads before applying the parent event, with deepest children first. Force-deleting a project delegates through lifecycle root threads so descendant subagents are deleted once through their parent root instead of being planned twice. The web action layer still performs stop, terminal-close, navigation, draft cleanup, and currently materialized descendant cleanup around those server lifecycle commands.

9. Unsupported providers keep the previous fallback behavior. No durable nested-thread behavior should be inferred for Claude, Cursor, OpenCode, or other providers until their event streams expose enough lineage to make child routing reliable.

## Web Implementation

1. Sidebar nesting is driven by `parentRelation`. Active subagents render under their direct parent only. Terminal subagents are omitted from the sidebar during normal parent browsing, but the currently open terminal child path remains visible and indented while that child or nested descendant is selected. Sidebar tree construction keeps the full non-archived parent chain as structural context before applying terminal-row visibility, so a running descendant does not get promoted to a root row just because an intermediate terminal ancestor is hidden. The currently routed child shell is also included in the sidebar's in-memory route context when available, which preserves active-path visibility while hidden thread details are still catching up to the normal sidebar list.

2. Conversation detail routing accepts hidden child threads through projected/synthetic shells. A child thread can be opened from its parent block even after it has disappeared from the active sidebar.

3. Parent timelines render direct child summary blocks from `subagentChildren`. The block text is `Subagent` while the generated child title is pending or still the placeholder, then `Subagent - <title>` once a generated child title is available. The child title is generated from the child title seed derived from the initial subagent prompt when available, and raw child prompts are not used as the visible title fallback. Duration and status display use shared helpers, with running children described as `Working for <duration>` and completed children described as `Completed in <duration>`.

4. Parent timelines do not render child prompt messages, child output, child shell commands, child file diffs, child MCP calls, or child action boxes. Those entries appear only inside the child thread view.

5. Child timelines render their raw launch prompt when available, then their own output/actions, and can render their own direct child summary blocks. This gives arbitrary-depth nesting without showing grandchildren in the original root parent view.

6. Child conversation views replace the normal composer with a subagent control bar. Users cannot send prompts to a subagent. While a child is running, the available user control is stop. The chat header also includes an up-navigation button that opens the direct parent conversation.

7. Review fixes removed duplicate compact subagent rows from Codex control sequences such as `wait` and `closeAgent`. Parent timelines now de-dupe child reference rows by child thread id plus parent collab item id, so control repeats collapse while each prompt-bearing resumed child activity with a new parent item id renders as a new appended block, even when multiple activities happen in the same parent turn. Subagent row live-status matching treats the parent collab item id as authoritative when present, also requires turn agreement when both sides know the turn id, and falls back to turn matching for legacy rows where one side lacks the item id.

8. Shared subagent display helpers keep duration and fallback labels consistent across parent blocks and child controls. Terminal child rows with missing completion timestamps show an explicit unknown-duration fallback instead of implying successful completion, and active children use `working` wording instead of `running` wording.

9. Thread list and detail state now share the client-runtime idle retention TTL, so short route/sidebar unmount gaps should not immediately drop hidden child-thread detail or active subagent sidebar state.

10. Multi-select lifecycle actions fail closed when a selected sidebar key no longer resolves in the current project thread map. This prevents stale or cross-project selection state from exposing root delete actions without current thread metadata.

## Decisions Captured

- Persistence retention: child detail is tied to parent lifecycle.
- Provider scope: Codex only for first implementation; unsupported providers degrade to current behavior.
- Title semantics: use the child title seed from the Codex collab item, normally derived from the subagent's initial prompt.
- Prompt history semantics: use the raw Codex collab item prompt as the child thread's initial user message when available. Do not use the title seed as a fallback prompt, because generated/summarized title seeds are not necessarily the literal child instruction.
- Error semantics: child failures do not bubble up as parent failures. Parent status and child status are independent.
- Missing completion events: follow the same lifecycle behavior as normal agent sessions. Use available terminal events where present; otherwise preserve running/unknown state until a stop, interrupt, session exit, reconnect reconciliation, or later terminal event updates it.
- Stop behavior: stopping a parent does not stop children; stopping a child is allowed from the child view.
- Steering behavior: users cannot manually prompt or steer subagents.
- Diff/checkpoint semantics: child file changes affect the shared workspace and should be parent-visible in aggregate at the workspace level, while per-action rendering remains scoped to the child conversation view.
- Archive/delete semantics: root parent actions own descendant child lifecycle. Child and nested-child rows do not expose independent archive/delete actions.

## Verification Completed

The implementation and review fixes have been covered by focused automated tests and Playwright regression checks:

- Server tests cover Codex subagent ingestion, parent-collab child shell synthesis, child terminal status, parent-relation persistence, projection upsert preservation, child stop/interrupt routing through the provider-bound root session without root-turn fallback, and archive/delete lifecycle cascades through subagent descendants.
- Server tests cover raw subagent prompt projection into child threads, including start-then-complete late prompt updates and whitespace-only prompt suppression.
- Web tests cover sidebar/thread state behavior, hidden terminal ancestor traversal, active terminal child path retention, subagent sibling ordering, duplicate parent subagent control-row removal, same-turn resumed child activity rows, child composer suppression, subagent stop control behavior, multi-select lifecycle gating for unresolved selected keys, and duration fallback labels.
- Client-runtime tests cover shared idle retention for stream-backed thread state across short subscriber gaps.
- Playwright checked Codex subagent behavior with marker prompts: before the prompt projection fix, the child view showed the output marker but not the initial prompt marker; after the fix, the child view showed the initial prompt marker followed by the output marker. Earlier Playwright coverage also checked that the parent showed exactly one compact subagent block, child output/actions did not leak into the parent, the child view was reachable from the parent block, the child view showed the child command/output, and the child view did not expose a prompt composer.

The prepared `244821236` merge was validated with:

- `pnpm --dir apps/web exec vp test run src/components/chat/MessagesTimeline.test.tsx src/components/chat/timelineScrollAnchoring.test.tsx`: 2 files passed, 34 tests passed.
- `pnpm --dir apps/web exec vp test run src/components/ChatView.logic.test.ts src/components/Sidebar.logic.test.ts`: 2 files passed, 87 tests passed.
- `pnpm --dir apps/server exec vp test run src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/decider.delete.test.ts src/provider/Layers/CodexAdapter.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts`: 4 files passed, 108 tests passed.
- `pnpm --dir apps/web exec tsc --noEmit --pretty false --project tsconfig.json`: passed.
- `pnpm exec vp check`: passed; reported existing lint warnings only.
- `pnpm exec vp run typecheck`: passed across 15 workspace tasks.

Current completion gates for this repo remain:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

Use focused package tests for the changed surface. If native mobile code changes in a future pass, also run:

```sh
pnpm exec vp run lint:mobile
```

## Remaining Risks And Hardening Items

1. Archive/delete lifecycle is now planned server-side for active descendant subagents, but archived descendant visibility and historical tombstone browsing should still be audited across reconnects and multi-client gaps.

2. Diff/checkpoint aggregation is intentionally parent-visible at the workspace level, but the exact UI for aggregate root diffs should be audited separately. Per-action diff rendering is scoped to the child timeline.

3. Reconnect and restart behavior should be stress-tested with active children, especially when the parent reconnects after receiving child output but before receiving the parent collab lifecycle item.

4. Multi-client behavior needs broader coverage across web, desktop, VS Code, and mobile shells. The data model is shared, but route guards, sidebar shell subscriptions, and hidden-thread availability should be checked in each client surface.

5. Deep nesting should be load-tested. The model supports arbitrary depth, but the UI should still be checked for indentation, active-row sorting stability, and large active-child sets.

6. Unsupported provider fallback should remain explicit. If another provider later exposes durable child-thread lineage, it should be added provider-by-provider rather than by guessing from output text.

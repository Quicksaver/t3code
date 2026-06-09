# UI-Aware Subagent Orchestration Plan

## Status

This plan has been updated after the implementation and review-fix pass. The feature is implemented for Codex only. Unsupported providers should continue using the previous inline subagent-output behavior until they expose durable child-thread lineage.

The current behavior is:

- A Codex subagent is represented as its own conversation thread.
- Active subagent threads appear in the sidebar nested under the direct parent that spawned them.
- Completed, errored, interrupted, or stopped subagent threads are hidden from the sidebar but remain reachable from the parent conversation view.
- A parent conversation view shows only parent-owned output and subagent summary blocks for direct children.
- A child conversation view shows only that child's output, tool calls, diffs, MCP calls, and other actions. Grandchildren appear only as blocks inside their direct parent child view.
- Users cannot prompt or steer a subagent. The child view exposes stop control only while the child is running.
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

2. Codex collab lifecycle items now carry `subagentChildren` metadata on the parent activity payload. Each child reference includes the provider thread id, local child thread id, optional parent item id, and optional title seed. The parent UI uses this metadata to render the compact `Subagent - <title>` block.

3. Child-thread creation and updates happen through orchestration ingestion. The server preserves the direct parent, root thread id, depth, parent activity sequence, title seed, provider thread id, and started timestamp. Synthetic child shells are created so hidden child routes can be opened before the full projection catches up.

4. Child terminal status is derived from child lifecycle events, not from the parent collab item alone. Terminal updates apply only while the relation is still `running`, which prevents later `session.exited` events from overwriting a more specific `completed`, `errored`, `interrupted`, or `stopped` result.

5. Child stop/interrupt handling routes through the provider-bound root session while targeting the selected child thread/turn. Parent stop remains scoped to the requested parent thread and does not cascade to active children.

6. Completed child detail remains tied to the root parent lifecycle. The web action layer dispatches archive/delete lifecycle actions for the root and collected descendant subagent threads, with root actions last. Delete also attempts to stop and close terminal state for involved lifecycle thread ids.

7. Unsupported providers keep the previous fallback behavior. No durable nested-thread behavior should be inferred for Claude, Cursor, OpenCode, or other providers until their event streams expose enough lineage to make child routing reliable.

## Web Implementation

1. Sidebar nesting is driven by `parentRelation`. Active subagents render under their direct parent only. Terminal subagents are omitted from the sidebar but remain available through the parent summary block.

2. Conversation detail routing accepts hidden child threads through projected/synthetic shells. A child thread can be opened from its parent block even after it has disappeared from the active sidebar.

3. Parent timelines render direct child summary blocks from `subagentChildren`. The block text is `Subagent - <title>`, where title generation uses the child title seed derived from the initial subagent prompt when available. Duration and status display use shared helpers.

4. Parent timelines do not render child output, child shell commands, child file diffs, child MCP calls, or child action boxes. Those entries appear only inside the child thread view.

5. Child timelines render their own output/actions and can render their own direct child summary blocks. This gives arbitrary-depth nesting without showing grandchildren in the original root parent view.

6. Child conversation views replace the normal composer with a subagent control bar. Users cannot send prompts to a subagent. While a child is running, the available user control is stop.

7. Review fixes removed duplicate compact subagent rows from Codex control sequences such as `wait` and `closeAgent`. Parent timelines now de-dupe child reference rows when all referenced child thread ids were already represented.

8. Shared subagent display helpers keep duration and fallback labels consistent across parent blocks and child controls. Terminal child rows with missing completion timestamps show an explicit unknown-duration fallback instead of implying successful completion.

## Decisions Captured

- Persistence retention: child detail is tied to parent lifecycle.
- Provider scope: Codex only for first implementation; unsupported providers degrade to current behavior.
- Title semantics: use the child title seed from the Codex collab item, normally derived from the subagent's initial prompt.
- Error semantics: child failures do not bubble up as parent failures. Parent status and child status are independent.
- Missing completion events: follow the same lifecycle behavior as normal agent sessions. Use available terminal events where present; otherwise preserve running/unknown state until a stop, interrupt, session exit, reconnect reconciliation, or later terminal event updates it.
- Stop behavior: stopping a parent does not stop children; stopping a child is allowed from the child view.
- Steering behavior: users cannot manually prompt or steer subagents.
- Diff/checkpoint semantics: child file changes affect the shared workspace and should be parent-visible in aggregate at the workspace level, while per-action rendering remains scoped to the child conversation view.
- Archive/delete semantics: root parent actions own descendant child lifecycle. Child and nested-child rows do not expose independent archive/delete actions.

## Verification Completed

The implementation and review fixes have been covered by focused automated tests and Playwright regression checks:

- Server tests cover Codex subagent ingestion, child terminal status, parent-relation persistence, projection upsert preservation, and child stop/interrupt routing through the provider-bound root session.
- Web tests cover sidebar/thread state behavior, duplicate parent subagent control-row removal, child composer suppression, subagent stop control behavior, and duration fallback labels.
- Playwright checked Codex subagent behavior with a low-reasoning mini model: the parent showed exactly one compact subagent block, child output/actions did not leak into the parent, the child view was reachable from the parent block, the child view showed the child command/output, and the child view did not expose a prompt composer.

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

1. Root lifecycle cascade should be hardened server-side for hidden descendants that are not materialized in the current client environment. The client currently dispatches archive/delete for collected descendants, but a database/root-thread cascade would be more robust across reconnects and multi-client gaps.

2. Diff/checkpoint aggregation is intentionally parent-visible at the workspace level, but the exact UI for aggregate root diffs should be audited separately. Per-action diff rendering is scoped to the child timeline.

3. Reconnect and restart behavior should be stress-tested with active children, especially when the parent reconnects after receiving child output but before receiving the parent collab lifecycle item.

4. Multi-client behavior needs broader coverage across web, desktop, VS Code, and mobile shells. The data model is shared, but route guards, sidebar shell subscriptions, and hidden-thread availability should be checked in each client surface.

5. Deep nesting should be load-tested. The model supports arbitrary depth, but the UI should still be checked for indentation, active-row sorting stability, and large active-child sets.

6. Unsupported provider fallback should remain explicit. If another provider later exposes durable child-thread lineage, it should be added provider-by-provider rather than by guessing from output text.

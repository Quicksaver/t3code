# Repeated Steering And Reliable Stop

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- An active-thread send allocates its user-message id before entering local dispatch, and the dispatch API requires that exact id. For steering the current running turn, the server projection carrying that id is authoritative acknowledgement even when the frozen dispatch snapshot has stale or absent session status. A later message from another client does not invalidate it, and an unrelated projected user message cannot acknowledge it. Sends that advance a turn retain the turn/session transition fallback, while the connecting phase ignores those transitions unless the exact message has already projected. Implementing a plan in a separate new thread uses its own busy-state variant and is cleared explicitly instead of observing projections from the source thread.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption first performs upstream's bounded, best-effort interruption of every live child provider turn, then reads the live root provider thread with `includeTurns: true`, selects the most recently started `inProgress` turn, and bounds that lookup with a timeout. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup, including an unexpected defect, is logged and may fall back to the session turn read after that lookup finishes; a successful lookup with no active turn returns without reviving a stale cached id.

Conflict guidance:

- `apps/web/src/components/ChatView.localDispatch.ts` owns the branch's dispatch snapshot, exact-message acknowledgement, and React state hook. Keep message dispatch and new-thread busy state as distinct variants. Preserve upstream's `submissionIntent`, reconnect guard, worktree-preparation state, latest-user-message timing, and turn/session fallback around the exact-id correlation. The hook's `allocateMessageDispatch` allocates the expected `MessageId`, begins dispatch, and returns that id to the caller. The separate plan-implementation flow must use `beginNewThreadBusyState` so source-thread projections cannot acknowledge it.
- Do not restore upstream's inline dispatch hook or latest-user-message heuristic in `apps/web/src/components/ChatView.logic.ts` or `apps/web/src/components/ChatView.tsx`. In `ChatView.tsx`, keep the draft-hero dock transition and early in-flight guard, call `allocateMessageDispatch` for each active-thread send, pass the resolved submission intent from the composer send, and send the returned id to the server. Plan follow-up remains foreground by default.
- `apps/web/src/components/ChatView.localDispatch.test.ts` covers the message/new-thread state variants and background-intent preservation. `apps/web/src/components/ChatView.logic.test.ts` imports the dispatch helpers from `ChatView.localDispatch.ts` and covers exact projection, reconnect, fallback, and consecutive-steer behavior.
- Keep live-turn lookup, ordering, timeout, and fallback in the focused `apps/server/src/provider/Layers/CodexInterruptResolution.ts` module with coverage in its colocated test, separate from the runtime model/effort instruction coverage in `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`. `apps/server/src/provider/Layers/CodexSessionRuntime.ts` must retain both upstream's bounded live-child interruption and the call into branch-owned live root-turn resolution; `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` covers the child fan-out path.
- `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts` selects `apps/server/src/provider/testFixtures/codexCollabMockPeer.cmd` on Windows and the existing `.sh` wrapper elsewhere, and uses Node's platform-native temporary directory as the mock runtime working directory. Keep both wrappers as thin launchers for the shared `.mjs` peer and avoid Unix-only working-directory assumptions so the branch's stop and child-fan-out regression suite remains cross-platform.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.localDispatch.ts`
- `apps/server/src/provider/Layers/CodexInterruptResolution.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`
- `apps/server/src/provider/testFixtures/codexCollabMockPeer.cmd`

Regression coverage lives in `apps/web/src/components/ChatView.localDispatch.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`, and `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement, reconnect and turn/session fallback behavior, background-intent preservation, timestamp-based live-root-turn selection, lookup timeout/failure/defect fallback, successful empty reads that suppress stale root interrupts, and bounded interruption of live child turns before the root.

Use `hasServerAcknowledgedLocalDispatch` from `apps/web/src/components/ChatView.localDispatch.ts` for client dispatch correlation. Defer an explicit server receipt keyed by message id unless projected ids stop being authoritative.

## Development Ports

- Web: `5738`
- Server/WebSocket: `13778`

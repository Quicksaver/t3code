# Thread Detail Subscription Reliability

The thread-detail WebSocket subscription flow prevents a race that can make the initial user prompt disappear from newly started conversations in packaged/static hosts such as the desktop app, where the first `thread.message-sent` event may arrive while the server is still loading the initial thread snapshot for `subscribeThread`.

Expected behavior:

- A new conversation's first user message remains visible after the optimistic row is replaced by server state.
- `ORCHESTRATION_WS_METHODS.subscribeThread` obtains an independent domain-event subscription before either persisted `afterSequence` replay or an initial WebSocket snapshot read.
- The acquired subscription is actively drained into a scoped thread-only queue while persisted catch-up or snapshot loading runs; merely acquiring the subscription without consuming it is not sufficient.
- HTTP snapshot clients replay persisted events after the supplied sequence, then continue from the live queue while suppressing overlapping events at or below the highest persisted replay sequence.
- WebSocket snapshot fallback clients emit the atomic snapshot, then replay only buffered/live thread events newer than the snapshot sequence.
- Snapshot-plus-live-tail subscription behavior is host-agnostic and applies to both desktop and web clients.

Primary files:

- `apps/server/src/ws.ts`
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts`
- `apps/server/src/server.test.ts`

## Development Ports

- Web: `5741`
- Server/WebSocket: `13781`

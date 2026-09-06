# Conversation user-context rendering

Upstream structured composer-context records now own user-message context parsing, inline chips, preview images, and clipboard preservation. The branch's legacy `userMessageContext.ts` parser and `UserMessageContentParts.tsx` renderer were superseded during the rebase onto `a43f9b45ae85caf37e0be8270ad3d27365ece2bd`.

The remaining customization extracts tool-activity and subagent rendering into `apps/web/src/components/chat/WorkActivityRows.tsx`. It owns live tool rows, grouped tool toggles, expanded details and images, tool icons, question-answer history, timestamps, and expandable subagent rows. `MessagesTimeline.tsx` retains row selection, list orchestration, and work-group scroll state.

Merge guidance:

- Preserve incoming user-message behavior in `MessagesTimeline.tsx`, including structured context references and clipboard payloads.
- Port upstream tool-activity and subagent changes into `WorkActivityRows.tsx`. Preserve live and failed tool styling, group expansion, expanded images and details, question-answer previews, tool icon resolution, and subagent expansion, status, and token summaries.
- Keep the dependency explicit. `MessagesTimeline.tsx` supplies work-row inputs through `WorkActivityRowsProvider`, while `ExpandedWorkGroupEntries` supplies entry expansion state through `WorkGroupViewProvider`. Do not import the timeline's private contexts into `WorkActivityRows.tsx`.

Focused verification:

```sh
vp test run apps/web/src/components/chat/MessagesTimeline.test.tsx
```

## Development ports

- Web: `5745`
- Server/WebSocket: `13785`
- Offset `12` is this worktree's reserved starting offset. Run the stack with `T3CODE_PORT_OFFSET=12 vp run dev`.
- The dev runner may shift occupied ports. Its `[dev-runner]` output is authoritative.

# Conversation user-context rendering

This branch keeps generated composer context out of the visible user-message body. `userMessageContext.ts` composes the terminal, element, preview-annotation, and review-comment parsers into ordered content parts. `UserMessageContentParts.tsx` owns their visual rendering, including collapsible text, inline terminal labels, element chips, preview annotations, and review-comment cards. `MessagesTimeline.tsx` extracts the state for each user row and passes the renderer its thread, workspace, theme, skill, and image-preview inputs.

`WorkActivityRows.tsx` keeps tool-activity and subagent row rendering separate from that user-message path. It owns live tool rows, grouped tool toggles, expanded tool details and images, tool icons, and the subagent CTA. `MessagesTimeline.tsx` retains row selection, list orchestration, and work-group scroll state.

Expected behavior:

- A message containing `<terminal_context>`, `<element_context>`, and `<preview_annotation>` blocks shows the prompt as normal text and each generated block as its matching chip or card.
- Mixed and repeated context blocks retain their send order, including when review comments appear before, after, or between them.
- Generated tags do not appear as literal text in the user bubble.
- Literal tag-like text written by the user remains visible.
- Malformed trailing generated blocks are suppressed instead of leaking partial markup.
- The copy action retains the original serialized message text.
- Extracted text renders through React text nodes. Do not introduce `dangerouslySetInnerHTML` for context content.

Merge guidance:

- Keep the upstream terminal, element, and preview parsers in `apps/web/src/lib`. `apps/web/src/components/chat/userMessageContext.ts` composes them rather than replacing them.
- Preserve the top-level review-comment segmentation in `userMessageContext.ts`. Review tags found inside generated context bodies are content, not review cards.
- Keep `UserTimelineRow` in `MessagesTimeline.tsx` responsible for attachments, row actions, and renderer inputs. Keep context-part layout and leaf rendering in `UserMessageContentParts.tsx` rather than adding it back to the timeline.
- When upstream changes user-message layout or review-comment rendering, preserve the ordered `contentParts` handoff between `UserTimelineRow` and `UserMessageContentParts`. Moving review parsing below generated-context parsing causes review tags inside terminal, element, or preview bodies to become cards.
- Keep parser context-order and raw-tag regressions in `userMessageContext.test.ts`, and renderer integration cases in `MessagesTimeline.test.tsx`, when resolving changes to `userMessageContext.ts`, `UserTimelineRow`, `UserMessageContentParts`, or its leaf renderers.
- When upstream changes tool-activity or subagent rows in `MessagesTimeline.tsx`, port those changes into `WorkActivityRows.tsx`. Preserve live and failed tool styling, group expansion, expanded images and details, tool icon resolution, and subagent status and token summaries.
- Keep the dependency between the two modules explicit. `MessagesTimeline.tsx` supplies work-row inputs through `WorkActivityRowsProvider`, while `ExpandedWorkGroupEntries` supplies entry expansion state through `WorkGroupViewProvider`. Do not import the timeline's private contexts into `WorkActivityRows.tsx`.

Primary files:

- `apps/web/src/components/chat/userMessageContext.ts`
- `apps/web/src/components/chat/userMessageContext.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/WorkActivityRows.tsx`
- `apps/web/src/components/chat/UserMessageContentParts.tsx`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/lib/terminalContext.ts`
- `apps/web/src/lib/elementContext.ts`
- `apps/web/src/lib/previewAnnotation.ts`

Focused verification:

```sh
vp test run apps/web/src/components/chat/userMessageContext.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx
```

## Development ports

- Web: `5745`
- Server/WebSocket: `13785`
- Offset `12` is this worktree's reserved starting offset. Run the stack with `T3CODE_PORT_OFFSET=12 vp run dev`.
- The dev runner may shift occupied ports. Its `[dev-runner]` output is authoritative.

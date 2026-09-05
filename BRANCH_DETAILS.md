# File change and command activity boxes

## Current state

The shared client-runtime presentation layer owns tool action categories, count-aware summaries, labels, icons, and viewed-image discovery. The web timeline owns grouping and the generic tool-detail path. This branch extends that model with an explicit rich-payload contract for command and file activity. The server preserves bounded structured fields, the web session layer merges lifecycle updates, and command or file-change rows render dedicated detail views inside the standard grouped timeline. Thread synchronization preserves applied command lifecycle records during RPC session replacement and resumes after the latest applied event sequence, leaving the web session layer to merge the completed cumulative output into one displayed activity row.

Fork compatibility:

- `apps/desktop/src/app/DesktopAppIdentity.test.ts` derives its legacy macOS user-data fixture with the host path service, so the identity behavior is asserted consistently on Windows and POSIX validation hosts.

Conflict-sensitive files:

- `packages/client-runtime/src/work-log/presentation.ts` owns shared label normalization, T3 MCP tool labels and icons, grouping categories and summaries, superseded-marker filtering, and viewed-image discovery. The branch-specific parser reuses its `normalizeCompactToolLabel` helper so lifecycle identity and timeline presentation normalize labels the same way.
- `packages/client-runtime/src/state/threads-sync.test.ts` is an upstream-owned test extended by this branch. Keep upstream's replacement-session resume test intact and preserve the sibling command-lifecycle assertions that cover record and payload retention during synchronization.
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` extends the settled and live grouping rules from the shared presentation layer. It uses `hasRichWorkEntryDetails` only to decide whether a single row bypasses the group summary. Rows inside an expanded group are always emitted as work rows. Metadata-only command lifecycle markers and collaboration-agent rows must not become branch-specific disclosures.
- `apps/web/src/components/chat/MessagesTimeline.tsx` owns disclosure rendering for individual work rows through `hasExpandableWorkEntryDetails`. Live command labels use the shared parser from `packages/client-runtime/src/work-log/commandLabel.ts`. A disclosure preserves the shared viewed-image preview. Its textual details prefer the branch-specific command output or inline file diffs. Other tools retain upstream's compact generic detail body without nested disclosure controls. The file also owns user-attachment preview and download callbacks plus the optional `hideEmptyPlaceholder` behavior used by the draft hero; activity changes must preserve those independent paths.
- `apps/web/src/lib/diffRendering.ts` owns the shared file-diff render key used by both inline activity diffs and the full diff panel.
- `apps/web/src/lib/workLogActivity.ts` owns provider-specific command/file payload parsing, viewed-image path extraction, top-level and nested tool-call IDs, `mcp-elicitation` request classification, bounded patch extraction, changed-file discovery, cumulative output/patch merging, and composition with the shared provider-neutral tool presentation metadata. It retains the branch's structured stdout, stderr, exit-code, duration, and patch extraction instead of reducing those fields to a generic text detail. Its shell-wrapper parsing preserves the original command when boundary quotes do not match.
- `apps/web/src/lib/workLogEntryDetails.ts` owns command and file detail eligibility, rich detail derivation, supplemental-detail deduplication, and the generic tool-detail fallback. Both timeline grouping and expanded-row rendering use this module, so generic MCP data remains available when a row does not qualify for a rich command or file view.
- `apps/web/src/session-logic.ts` owns timeline ordering, lifecycle collapse, and public work-log composition. Lifecycle identity includes the turn and tool-call ID, and cumulative stream merging uses `sourceActivityKind` from the incoming activity.
- `apps/server/src/orchestration/ActivityPayloadProjection.ts` retains the command output metadata and bounded file patches consumed by expandable rows, including nested command values, direct raw-output strings, and ACP text-content arrays. It also preserves validated workspace image paths for image-read previews. Snapshot projection recognizes top-level and nested tool-call IDs when pruning superseded updates. It retains an update when its projected command output, canonical exit/duration metadata, patch, or changed path is missing from the completion, while unrelated activity payload bulk remains pruned.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` applies the summary-only command projection to cumulative non-terminal `item.updated` activities before persistence, preventing quadratic storage growth. Terminal `item.completed` activities retain their full payload until the normal client-bound projection applies.
- `packages/shared/src/toolActivity.ts` owns the activity limits, payload key sets, traversal containers, and unified-diff recognition shared by server projection and web extraction.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- Settled adjacent tool rows collapse into a count-aware action summary. Expanding that summary preserves the individual command and file-change disclosures instead of flattening their rich details into the generic tool panel.
- A single command or file-change row bypasses the action summary only when its branch-specific command or file detail predicate accepts it. Rows that expand only into the generic detail panel stay behind the summary.
- Live tool work uses one status row and reveals its constituent rows when expanded; completed branch-specific command and file details remain available after the turn settles.
- Shared T3 MCP labels, icons, search categories, and lifecycle-marker filtering remain the source of truth for both summary rows and individual rows.
- Provider-neutral browser, computer, icon, and source metadata passes through the rich activity parser, so command and file rows keep upstream presentation metadata.
- File-change-style tool rows that also carry command metadata or patch payloads still prefer the changed-file path preview while collapsed, so rows such as `apply_patch` stay oriented around the file being edited instead of the command label.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- Expanded changed-file pills and inline diff headers use styled tooltips for truncated paths instead of native `title` attributes.
- Inline file diffs use the shared stable render key so parser cache keys distinguish repeated same-path snapshots consistently across diff surfaces.
- Within an expanded tool group, each detailed activity row owns one disclosure boundary. Inline `FileDiff` children render expanded without adding per-file or collapse-all controls.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- Tool rows that merely mention changed files, such as file-read detail rows, stay in the generic detail panel unless they include a patch or are explicitly marked as a file-change request, so read-only tool output is not mislabeled as an editable file-change row.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- A viewed-image tool row remains expandable and renders the shared workspace image preview inside the same row boundary as any branch-specific details.
- Differing raw command text is rendered inline as a normal detail block in the expanded row, not hidden behind a second nested disclosure.
- Known shell wrappers are removed from displayed command text only when their command boundary quotes match. Serialized wrappers with unmatched boundary quotes remain intact.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.
- Structured non-zero command exit codes produce the failure affordance, and an exact zero duration is rendered as `0ms`.
- Cumulative file-change patch snapshots replace their shorter prefix instead of duplicating already-rendered hunks, and an oversized patch is skipped without preventing valid sibling diffs from rendering.
- Activity payload projection preserves the command output strings and numeric exit/duration metadata consumed by expanded rows, including command-shaped dynamic tools without an explicit kind, nested `item.result.result` fallback output, direct string `rawOutput`, and ACP `data.content` text blocks, with one `WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars` budget per activity (currently 200,000 characters) and truncation observable through `data.rawOutput.truncated`, plus at most four inline patches discovered through four nesting levels and capped at `WORK_LOG_ACTIVITY_LIMITS.maxPatchChars` (currently 200,000 characters) each; unrelated and object-valued payload bulk remains pruned.
- Thread transfer budgets retain roughly 30% headroom above this branch's richer bounded activity projection while still detecting accidental transfer of full retained MCP results.
- Projected kinds are normalized to their string type, patches are retained only for file-change-shaped activities, identical self-contained patches consume one shared inline patch slot, and path-dependent add/delete patches remain distinct per file.
- Command output extraction ignores blank-only completed stdout/stderr fallbacks so aggregated command output is still shown, but preserves whitespace-only incremental `tool.updated` chunks, including raw output `content`, so streamed output is not collapsed away.
- Incremental command output chunks concatenate without injected separators, while shorter completed snapshots, newline-terminated shorter updated snapshots, and shorter single-line repeated-prefix snapshots do not overwrite a previously merged longer output snapshot.
- Command lifecycle rows without explicit tool-call IDs keep stable display detail as their collapse identity and fall back to parsed command text when duplicate display details are suppressed, so enriched updates still collapse while adjacent same-title rows for distinct commands stay separate.
- Tool-call IDs are read from the top-level payload first and the legacy nested data object second. They scope lifecycle collapse and work-group identity to a turn, so interleaved calls merge into the correct row.
- Thread-detail snapshots remove a superseded `tool.updated` row only when the matching completion contains its projected cumulative details. Updates that contribute command output, canonical exit/duration metadata, patches, or changed paths remain so web work-log derivation yields the same cumulative detail after reload.
- MCP tool-data serialization preserves repeated references to the same argument object when they are not cyclic, while still redacting real ancestor-chain cycles as `[Circular]`, so expanded generic details stay informative without risking recursive rendering.
- Row-level keyboard expansion only handles Enter and Space when the event target is the row itself, so nested action controls do not also toggle the parent activity row.

Primary branch-owned files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/lib/workLogActivity.ts`
- `apps/web/src/lib/diffRendering.ts`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/workLogEntryDetails.ts`
- `apps/server/src/orchestration/ActivityPayloadProjection.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/integration/TransferBudgetReport.integration.ts`
- `packages/shared/src/toolActivity.ts`

The branch consumes `packages/client-runtime/src/work-log/presentation.ts` and `packages/client-runtime/src/work-log/commandLabel.ts` as upstream-owned dependencies. They currently match `upstream/main`.

Relevant tests live in:

- `apps/web/src/lib/workLogActivity.test.ts`
- `apps/web/src/lib/diffRendering.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- `apps/web/src/session-logic.command-output.test.ts`
- `apps/web/src/session-logic.test.ts`
- `apps/server/src/orchestration/ActivityPayloadProjection.test.ts` for focused projection and provider-shape regressions
- `apps/server/test/ActivityPayloadProjection.test.ts` for cross-client projection and transfer-budget coverage
- `packages/client-runtime/src/state/threads-sync.test.ts` for cumulative command activity across RPC session replacement

Useful focused commands:

```sh
vp test run apps/web/src/lib/workLogActivity.test.ts apps/web/src/lib/diffRendering.test.ts apps/web/src/session-logic.command-output.test.ts apps/web/src/session-logic.test.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx
vp test run apps/server/src/orchestration/ActivityPayloadProjection.test.ts apps/server/test/ActivityPayloadProjection.test.ts
vp test run packages/client-runtime/src/state/threads-sync.test.ts
```

## Development ports

- Web: `5737`
- Server/WebSocket: `13777`

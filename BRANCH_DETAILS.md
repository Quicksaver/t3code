# Archive Settings UX

The settings Archive panel uses a dense layout so large archives remain scannable. The native mobile Archived Threads screen mirrors the same information hierarchy and behavior with mobile-native project sections, swipe actions, long-press menus, and header controls.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- The Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible, while active rows returned in those snapshots remain excluded from archive content and empty-state counts. Partial environment failures remain visible above successfully loaded project groups with their error and a keyboard- and screen-reader-accessible retry action. A total failure does not also render a misleading empty archive state, and retry reloads every configured environment.
- Web project headers show environment labels whenever multiple environments are configured and keep a sole remote environment labeled, while a sole primary environment remains implicit. Their `ProjectFavicon` receives the archived snapshot's project name, icon override, favicon path, workspace root, and environment identity, so configured emoji or Lucide icons and automatic fallback icons match current upstream project lists. Native project sections render the snapshot favicon and pair visible environment labels with the environment's machine-kind glyph. Native header controls can filter the archive to all environments or one configured environment. `apps/web/src/components/settings/ArchiveSettings.test.tsx` covers the web metadata handoff to `ProjectFavicon`.
- Native Settings exposes `Archived Threads` in both local-only and T3 Connect-configured modes through a shared `General`, `Appearance`, `Legacy`, `Archive`, and `App` tail, preserving that order while each mode keeps its own account and configuration controls. The native settings contract owns the `SettingsArchive` route name, link, and title plus the legacy `SettingsWaitlist` alias metadata. The `SETTINGS_CUSTOM_ROUTE_SCREENS_BY_STACK` grouping in `apps/mobile/src/features/settings/settingsRouteScreens.ts` assigns Archive to its `content` collection for the header-owning settings content stack and keeps the distinct waitlist alias pointed at `SettingsAuth` in its `auth` collection for the outer auth stack. In `apps/mobile/src/Stack.tsx`, the content stack registers upstream settings routes, including `SettingsProviderSetup`, before spreading the custom content collection, while the outer auth stack spreads the separate auth collection.
- Web Settings search includes `Archived threads`; selecting that result opens the customized Archive panel and focuses its persistent archive search field, regardless of whether the archive is loading, empty, filtered, or populated.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and rank partial matches by distinct matched-token count before the earliest token position. Phrase and all-token scores remain bounded within their relevance tiers so a long-title position penalty cannot demote a stronger match below a weaker tier. Search auto-opens matching project groups while active. Native incremental search updates the existing list without remounting it for every keystroke, preserving scroll position and transient row state.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Native project-section ordering follows the selected archive sort field and direction. Invalid archived timestamps fall back to the conversation's created timestamp for sorting and display on both surfaces.
- Native row and bulk actions share collision-safe per-thread reservations and action-executor identity keys, reserve bulk targets before confirmation, expose busy state only after confirmation, disable overlapping swipe/menu controls while reserved, and distinguish rows skipped because the same thread action is already in progress from commands that actually fail.
- Web row and project actions in `apps/web/src/components/settings/ArchiveSettings.tsx` dispatch the `threadEnvironment.unarchive` and `threadEnvironment.delete` commands directly, so the Archive panel owns archived-snapshot refresh timing without extending the shared `useThreadActions` interface. Successful row actions refresh the affected environment immediately. Project actions reserve collision-safe per-thread locks before confirmation, expose busy state only for threads owned by actions that have started after confirmation, disable overlapping controls while mutations run, give explicit feedback for rejected duplicates, and refresh the affected environment once after the bulk attempt instead of between concurrent mutations. Successful raw deletes use the same `discardComposerDraft` operation as live-thread deletion, releasing image and file/video uploads before clearing every draft reference without coupling Archive actions to the rest of the live-thread delete lifecycle.
- Conversation rows show only the relative archived and created ages inline with the title by default. On web row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern. Native rows keep both age columns visible and expose the same actions through swipe gestures and the standard long-press context menu. The shared `ThreadSwipeable` owns its themed card-surface fallback while drawer and screen rows retain explicit surface overrides.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first. Web delete actions respect the shared `confirmThreadDelete` client setting, while native keeps its standard guarded delete flow.
- Archived-row context-menu action IDs and presentation metadata come from shared Archive settings logic. Unarchive uses the archive-restore icon, Delete uses the trash icon and destructive styling, and `separatorBefore` distinguishes permanent deletion from restoration in both the web fallback and Electron native menu.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete` on web and remain explicitly guarded on native; unarchive bulk actions remain guarded on both surfaces, and partial failures surface as not-fully-completed feedback instead of implying every archived thread failed.
- Web single and project delete confirmations use the shared themed dialog's destructive variant, while project unarchive confirmations keep the default variant.
- Archive grouping, search ranking, sort state, and project bulk-action concurrency live in `apps/web/src/components/settings/ArchiveSettings.logic.ts` on web and `apps/mobile/src/features/archive/archivedThreadList.ts` on native so the dense Archive behavior stays covered without growing the React components. Web project groups retain the complete archived-snapshot project shell plus environment identity so the customized header can read shell metadata directly without a reduced field projection. Project groups expose and reuse collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, preserve the completed success/failure/skipped outcome counts, show incomplete-operation feedback, and surface the underlying exception messages instead of only a generic aggregate error. The Archive surfaces refresh the affected environment after bulk unarchive/delete attempts even when the action runner throws.
- The user guide documents Archive as a reversible thread-lifecycle action, covers the web, desktop, and mobile controls and safeguards, and explains that search scopes project bulk actions to visible matches. The guide and internal glossary distinguish settled threads, which remain live in the thread list's `Settled` section and return to the active list when un-settled or new work begins, from archived threads, which leave the thread list for Archive until restored or deleted. The glossary also distinguishes Archive from permanent deletion, and the documentation index links the guide.

Primary files:

- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/ArchiveSettings.test.tsx`
- `apps/web/src/components/settings/ArchiveSettings.logic.ts`
- `apps/web/src/components/settings/ArchiveSettings.logic.test.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/lib/composerDraftUploads.ts`
- `apps/web/src/lib/composerDraftUploads.test.ts`
- `apps/web/src/lib/composerDraftUploads.store.test.ts`
- `apps/web/src/components/settings/settingsLayout.tsx`
- `apps/mobile/src/Stack.tsx`
- `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`
- `apps/mobile/src/features/settings/settingsContract.ts`
- `apps/mobile/src/features/settings/settingsContract.test.ts`
- `apps/mobile/src/features/settings/settingsRouteScreens.ts`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/home/thread-swipe-actions.tsx`
- `docs/user/archive.md`
- `docs/internals/glossary.md`
- `docs/README.md`

## Development Ports

- Web: `5734`
- Server/WebSocket: `13774`

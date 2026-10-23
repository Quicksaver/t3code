/**
 * V1 rows a migrated thread owns that V2 stops reading once the importer has
 * hydrated its transcript. Cold storage moves them with an archived thread, so
 * pre-V2 conversations leave the active database too, and restores them with
 * the rest of its rows. The V1 thread, pull-request and session rows stay hot:
 * shell import and repair, and the settings migration, still read them.
 *
 * Every `?` in a predicate binds the thread id.
 */
export const LEGACY_V1_THREAD_TABLES: ReadonlyArray<{
  readonly table: string;
  readonly predicate: string;
}> = [
  { table: "projection_thread_messages", predicate: "thread_id = ?" },
  {
    table: "orchestration_command_receipts",
    predicate: "command_type = 'legacy' AND aggregate_kind = 'thread' AND aggregate_id = ?",
  },
];

// Migration 063 drops these unread V1 projections. Older archives still contain
// their chunks; decode them for integrity, then discard their obsolete rows.
export const OBSOLETE_V1_ARCHIVE_TABLES: ReadonlySet<string> = new Set([
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_turns",
  "projection_pending_approvals",
]);

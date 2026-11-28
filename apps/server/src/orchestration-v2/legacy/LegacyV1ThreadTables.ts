/**
 * Move rows V2 stops reading after transcript hydration; thread, PR and session rows stay hot
 * because shell import, repair and settings migration still read them.
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

/**
 * Cold storage for archived conversations.
 *
 * An archived thread keeps its shell row and its `thread.*` lifecycle events in
 * the hot database. Everything else it owns (runs, items, messages, the rest of
 * its event stream, the V1 rows of a migrated conversation, and attachment
 * files) moves into gzip chunks in `archivev2.sqlite`. Reads
 * and commands restore the thread before they touch it, and a durable
 * `thread.cold-archive` effect moves it back while it stays archived. Permanent deletion purges the same storage but
 * keeps the deleted shell and lifecycle events that worktree cleanup and
 * projection replay rely on.
 *
 * Every transition for a thread runs under its ThreadCommandExecutor lock, so
 * it is serialized with command dispatch for that thread. Reads and commands
 * hold a lease through `withHot` for as long as they use the thread's rows; a
 * cold move waits for leases to end, and leases taken during a move wait for
 * it and then restore.
 */
import {
  CommandId,
  OrchestrationV2ThreadShellJson,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  attachmentFileNameCandidates,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { LEGACY_V1_THREAD_TABLES } from "./legacy/LegacyV1ThreadTables.ts";
import { ThreadCommandExecutor } from "./ThreadCommandExecutor.ts";

const gzipAsync = NodeUtil.promisify(NodeZlib.gzip);
const gunzipAsync = NodeUtil.promisify(NodeZlib.gunzip);

const ARCHIVE_SCHEMA = "cold_archive";
const ARCHIVE_VERSION = 1;
const ROW_CHUNK_SIZE = 250;
const RESTORE_CHUNK_PAGE_SIZE = 32;
const BINARY_VALUE_KEY = "__t3_archive_binary_base64";
/** A restored archived thread stays hot this long before it moves back to cold storage. */
export const RECOLD_DELAY_MS = 2 * 60 * 1000;
/** Free pages returned per incremental-vacuum step; each step is one short write. */
export const RECLAIM_CHUNK_PAGES = 128;
/** Rows deleted per commit while a thread leaves hot storage. */
const DELETE_CHUNK_ROWS = 500;
/** Compressed bundle bytes written per commit. */
const BUNDLE_COMMIT_BYTES = 2 * 1024 * 1024;

// Lets timers and I/O run between bounded steps of lifecycle work. Effect's own
// yield can stay on the same macrotask, which would still stall the event loop.
const yieldToEventLoop = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve)),
);

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(UnknownFromJsonString);
const encodeShell = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2ThreadShellJson));

export class ThreadColdStorageError extends Schema.TaggedError<ThreadColdStorageError>()(
  "ThreadColdStorageError",
  {
    operation: Schema.Literals(["archive", "restore", "schedule", "purge", "reconcile"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const context = this.threadId === undefined ? "" : ` for '${this.threadId}'`;
    return `Cold thread storage failed during ${this.operation}${context}.`;
  }
}

export interface ThreadColdStorageShape {
  /**
   * Runs `use` against the thread's hot rows, restoring a cold thread first.
   * No cold move starts while `use` runs. A plain restore queues the move back
   * to cold storage; `unarchive` cancels it instead.
   */
  readonly withHot: <A, E, R>(
    threadId: ThreadId,
    use: Effect.Effect<A, E, R>,
    options?: { readonly unarchive?: boolean },
  ) => Effect.Effect<A, E | ThreadColdStorageError, R>;
  /** Restores the cold thread that holds an attachment whose file is not on disk. */
  readonly ensureAttachmentHot: (
    attachmentId: string,
  ) => Effect.Effect<void, ThreadColdStorageError>;
  /**
   * Queues a `thread.cold-archive` effect now: it moves a still-archived thread
   * back to cold storage, or drops the bundle of an unarchived one.
   */
  readonly scheduleArchive: (threadId: ThreadId) => Effect.Effect<void, ThreadColdStorageError>;
  /** Runs the `thread.cold-archive` effect. `prepare` runs before rows move. */
  readonly archive: <E>(
    threadId: ThreadId,
    prepare: Effect.Effect<unknown, E>,
  ) => Effect.Effect<void, ThreadColdStorageError>;
  /** Runs the `thread.storage-purge` effect for a deleted thread. */
  readonly purge: (threadId: ThreadId) => Effect.Effect<void, ThreadColdStorageError>;
  /** Startup discovery of archived and deleted threads that still need lifecycle work. */
  readonly reconcile: Effect.Effect<void, ThreadColdStorageError>;
}

/** Defaults to no cold storage so isolated harnesses keep every row hot. */
export class ThreadColdStorage extends Context.Reference<ThreadColdStorageShape>(
  "t3/orchestration-v2/ThreadColdStorage",
  {
    defaultValue: () => ({
      withHot: (_threadId, use) => use,
      ensureAttachmentHot: () => Effect.void,
      scheduleArchive: () => Effect.void,
      archive: () => Effect.void,
      purge: () => Effect.void,
      reconcile: Effect.void,
    }),
  },
) {}

type SqlRow = Record<string, unknown>;

interface ThreadTable {
  readonly table: string;
  /** Selects one thread's rows. Every `?` binds the thread id. */
  readonly predicate: string;
}

// Child projections, in insert order. Shell rows, provider sessions, subagent
// links and context transfers stay hot: they are small and other threads read them.
const PROJECTION_TABLES: ReadonlyArray<ThreadTable> = [
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_context_handoffs",
].map((table) => ({ table, predicate: "thread_id = ?" }));

// The `thread.*` lifecycle events stay hot so shell replay, projection rebuilds
// and afterSequence resumes still see the thread. The newest event of the
// stream also stays hot so later events keep a unique stream_version.
const EVENTS_TABLE: ThreadTable = {
  table: "orchestration_events",
  predicate: `aggregate_kind = 'thread' AND stream_id = ?
    AND NOT (application_event_version = 2 AND event_type LIKE 'thread.%')
    AND sequence < (
      SELECT MAX(sequence) FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ?
    )`,
};

// Removed on permanent deletion in addition to the cold tables. Provider
// sessions can be shared, so purge removes them once their last binding is gone.
const PURGE_ONLY_TABLES: ReadonlyArray<ThreadTable> = [
  { table: "orchestration_v2_projection_provider_threads", predicate: "thread_id = ?" },
  { table: "orchestration_v2_projection_provider_session_bindings", predicate: "thread_id = ?" },
  { table: "orchestration_v2_projection_subagents", predicate: "thread_id = ?" },
  { table: "orchestration_v2_thread_launch_workflows", predicate: "thread_id = ?" },
  { table: "provider_session_runtime", predicate: "thread_id = ?" },
  { table: "mcp_app_model_context", predicate: "thread_id = ?" },
];

const bindCount = (predicate: string) => predicate.split("?").length - 1;
const bindThread = (table: ThreadTable, threadId: string) =>
  Array.from({ length: bindCount(table.predicate) }, () => threadId);

class ArchiveCodecError extends Schema.TaggedError<ArchiveCodecError>()("ArchiveCodecError", {
  operation: Schema.Literals(["encode", "decode", "compress", "decompress"]),
  cause: Schema.Defect(),
}) {}

class ArchiveContentError extends Schema.TaggedError<ArchiveContentError>()("ArchiveContentError", {
  detail: Schema.String,
}) {}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isSafeAttachmentEntry(entry: string): boolean {
  return (
    entry.length > 0 &&
    entry !== "." &&
    entry !== ".." &&
    !entry.includes("/") &&
    !entry.includes("\\") &&
    !entry.includes("\0")
  );
}

const encodeRows = (rows: ReadonlyArray<SqlRow>) =>
  encodeUnknownJsonString(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          value instanceof Uint8Array
            ? { [BINARY_VALUE_KEY]: Buffer.from(value).toString("base64") }
            : value,
        ]),
      ),
    ),
  ).pipe(
    Effect.map((encoded) => new Uint8Array(Buffer.from(encoded, "utf8"))),
    Effect.mapError((cause) => new ArchiveCodecError({ operation: "encode", cause })),
  );

const decodeRows = (data: Uint8Array) =>
  decodeUnknownJsonString(Buffer.from(data).toString("utf8")).pipe(
    Effect.mapError((cause) => new ArchiveCodecError({ operation: "decode", cause })),
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => {
          if (!Array.isArray(decoded)) throw new TypeError("Archived rows must be an array");
          return decoded.map((row): SqlRow => {
            if (row === null || typeof row !== "object" || Array.isArray(row)) {
              throw new TypeError("Archived row must be an object");
            }
            return Object.fromEntries(
              Object.entries(row).map(([column, value]) => {
                const binary =
                  value !== null && typeof value === "object" && !Array.isArray(value)
                    ? (value as Record<string, unknown>)[BINARY_VALUE_KEY]
                    : undefined;
                return typeof binary === "string"
                  ? [column, new Uint8Array(Buffer.from(binary, "base64"))]
                  : [column, value];
              }),
            );
          });
        },
        catch: (cause) => new ArchiveCodecError({ operation: "decode", cause }),
      }),
    ),
  );

const compress = (data: Uint8Array) =>
  Effect.tryPromise({
    try: () => gzipAsync(data),
    catch: (cause) => new ArchiveCodecError({ operation: "compress", cause }),
  }).pipe(Effect.map((value) => new Uint8Array(value)));

const decompress = (data: Uint8Array) =>
  Effect.tryPromise({
    try: () => gunzipAsync(data),
    catch: (cause) => new ArchiveCodecError({ operation: "decompress", cause }),
  }).pipe(Effect.map((value) => new Uint8Array(value)));

interface ManifestRow {
  readonly status: "moving" | "cold" | "restored" | "kept-hot" | "purged";
  readonly archived_at: string | null;
  readonly restore_generation: number;
}

interface ThreadRow {
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly parent_thread_id: string | null;
  readonly relationship_to_parent: string | null;
  readonly forked_from_thread_id: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const threadLocks = yield* ThreadCommandExecutor;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;

  yield* fs.makeDirectory(path.dirname(config.archiveDbPath), { recursive: true });
  yield* sql.unsafe(`ATTACH DATABASE ? AS ${ARCHIVE_SCHEMA}`, [config.archiveDbPath]);
  // A rollback journal would make every chunk insert a slow, fully synced commit.
  yield* sql.unsafe(`PRAGMA ${ARCHIVE_SCHEMA}.journal_mode = WAL`);
  // Takes effect only while the file is still empty; existing files keep their mode.
  yield* sql.unsafe(`PRAGMA ${ARCHIVE_SCHEMA}.auto_vacuum = INCREMENTAL`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.archive_threads (
      thread_id TEXT PRIMARY KEY,
      archive_version INTEGER NOT NULL,
      archived_at TEXT,
      original_bytes INTEGER NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.archive_thread_chunks (
      thread_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (thread_id, chunk_index)
    )
  `);
  // Asset requests find a cold attachment by its file name.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${ARCHIVE_SCHEMA}.archive_thread_chunks_kind
    ON archive_thread_chunks(kind)
  `);

  // Only incremental auto-vacuum databases can return free pages in short steps.
  // Others keep reusing their free pages; they never get a blocking full VACUUM.
  const reclaimableSchemas = yield* Effect.filter(["main", ARCHIVE_SCHEMA], (schema) =>
    sql
      .unsafe(`PRAGMA ${schema}.auto_vacuum`)
      .pipe(Effect.map((rows) => Number((rows as ReadonlyArray<SqlRow>)[0]?.auto_vacuum) === 2)),
  );

  // Tables added by later migrations may be absent from older test schemas.
  const existingTables = new Set(
    (
      (yield* sql.unsafe(
        `SELECT name FROM main.sqlite_master WHERE type = 'table'`,
      )) as ReadonlyArray<SqlRow>
    ).map((row) => String(row.name)),
  );
  const coldTables = [...PROJECTION_TABLES, EVENTS_TABLE, ...LEGACY_V1_THREAD_TABLES].filter(
    (entry) => existingTables.has(entry.table),
  );
  const coldTableNames = new Set(coldTables.map((entry) => entry.table));
  const purgeTables = [...coldTables, ...PURGE_ONLY_TABLES].filter((entry) =>
    existingTables.has(entry.table),
  );

  // Reads check this before touching the database; only this service changes cold state.
  const coldThreadIds = new Set(
    (
      (yield* sql.unsafe(
        `SELECT thread_id FROM thread_archive_manifests WHERE status IN ('moving', 'cold')`,
      )) as ReadonlyArray<SqlRow>
    ).map((row) => String(row.thread_id)),
  );
  // Leases of reads and commands running against a thread's hot rows, and the
  // threads whose cold move is under way. Both change in synchronous steps, so
  // a lease and a move never both start on the same thread.
  const hotLeases = new Map<string, number>();
  const archiving = new Set<string>();
  const releaseLease = (threadId: string) =>
    Effect.sync(() => {
      const remaining = (hotLeases.get(threadId) ?? 1) - 1;
      if (remaining > 0) hotLeases.set(threadId, remaining);
      else hotLeases.delete(threadId);
    });
  const takeLease = (threadId: string) =>
    Effect.sync(() => {
      hotLeases.set(threadId, (hotLeases.get(threadId) ?? 0) + 1);
    });
  // Takes a lease without the thread lock when no cold state or move is involved.
  const takeHotLease = (threadId: string) =>
    Effect.sync(() => {
      if (coldThreadIds.has(threadId) || archiving.has(threadId)) return false;
      hotLeases.set(threadId, (hotLeases.get(threadId) ?? 0) + 1);
      return true;
    });
  // Starts a cold move unless a lease is held.
  const startMove = (threadId: string) =>
    Effect.sync(() => {
      if ((hotLeases.get(threadId) ?? 0) > 0) return false;
      archiving.add(threadId);
      return true;
    });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readManifest = (threadId: string) =>
    sql<ManifestRow>`
      SELECT status, archived_at, restore_generation
      FROM thread_archive_manifests WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const readThread = (threadId: string) =>
    sql<ThreadRow>`
      SELECT
        archived_at,
        deleted_at,
        json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
        json_extract(payload_json, '$.forkedFrom.threadId') AS forked_from_thread_id
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const hasActiveRun = (threadId: string) =>
    sql`
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId}
        AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  // Forks read their source's rows, through any chain of forks. A deleted fork
  // keeps that dependency until its own purge removes its rows.
  const hasForkDependents = (threadId: string) =>
    sql`
      SELECT 1 FROM orchestration_v2_projection_threads AS fork
      LEFT JOIN thread_archive_manifests AS manifest ON manifest.thread_id = fork.thread_id
      WHERE json_extract(fork.payload_json, '$.forkedFrom.threadId') = ${threadId}
        AND (fork.deleted_at IS NULL OR manifest.status IS NULL OR manifest.status <> 'purged')
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  // Forks read their source's rows, and a subagent's parent may still recover
  // its result. Those threads stay hot while archived.
  const isReferencedByLiveThread = (threadId: string, thread: ThreadRow) =>
    Effect.gen(function* () {
      if (yield* hasForkDependents(threadId)) return true;
      if (thread.relationship_to_parent !== "subagent" || thread.parent_thread_id === null) {
        return false;
      }
      const parent = yield* readThread(thread.parent_thread_id);
      return (
        Option.isSome(parent) &&
        parent.value.deleted_at === null &&
        parent.value.archived_at === null
      );
    });

  const upsertManifest = (input: {
    readonly threadId: string;
    readonly status: ManifestRow["status"];
    readonly archivedAt: string | null;
    readonly shellJson?: string | null;
    readonly originalBytes?: number;
    readonly compressedBytes?: number;
    readonly bumpGeneration?: boolean;
  }) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      yield* sql`
        INSERT INTO thread_archive_manifests (
          thread_id, status, archived_at, restore_generation, shell_json,
          original_bytes, compressed_bytes, updated_at
        )
        VALUES (
          ${input.threadId}, ${input.status}, ${input.archivedAt},
          ${input.bumpGeneration === true ? 1 : 0}, ${input.shellJson ?? null},
          ${input.originalBytes ?? 0}, ${input.compressedBytes ?? 0}, ${updatedAt}
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          status = excluded.status,
          archived_at = excluded.archived_at,
          restore_generation = thread_archive_manifests.restore_generation
            + ${input.bumpGeneration === true ? 1 : 0},
          shell_json = excluded.shell_json,
          original_bytes = excluded.original_bytes,
          compressed_bytes = excluded.compressed_bytes,
          updated_at = excluded.updated_at
      `;
    });

  // Callers only drop a bundle that is stale or no longer needed, so a header
  // left after an interrupted deletion never guards data that matters.
  const deleteBundle = (threadId: string) =>
    Effect.gen(function* () {
      while (true) {
        // The count must come from the same connection hold as its DELETE.
        const deleted = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              `DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE rowid IN (
                 SELECT rowid FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
                 WHERE thread_id = ? LIMIT ${RESTORE_CHUNK_PAGE_SIZE}
               )`,
              [threadId],
            );
            const rows = (yield* sql.unsafe(
              "SELECT changes() AS changes",
            )) as ReadonlyArray<SqlRow>;
            return Number(rows[0]?.changes ?? 0);
          }),
        );
        if (deleted === 0) break;
        yield* yieldToEventLoop;
      }
      yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
        threadId,
      ]);
    });

  const assertBundleComplete = (threadId: string) =>
    Effect.gen(function* () {
      const rows = (yield* sql.unsafe(
        `SELECT archive_version FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`,
        [threadId],
      )) as ReadonlyArray<SqlRow>;
      const version = rows[0]?.archive_version;
      if (version === undefined) {
        return yield* new ArchiveContentError({ detail: "the cold bundle is missing" });
      }
      if (Number(version) !== ARCHIVE_VERSION) {
        return yield* new ArchiveContentError({
          detail: `unsupported cold bundle version ${String(version)}`,
        });
      }
    });

  const bundleAttachmentEntries = (threadId: string) =>
    sql
      .unsafe(
        `SELECT kind FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
         WHERE thread_id = ? AND kind LIKE 'attachment:%'`,
        [threadId],
      )
      .pipe(
        Effect.map((rows) =>
          (rows as ReadonlyArray<SqlRow>).flatMap((row) => {
            const entry = String(row.kind).slice("attachment:".length);
            return isSafeAttachmentEntry(entry) ? [entry] : [];
          }),
        ),
      );

  // Removes only the exact thread log and its numeric rotations.
  const removeProviderLogs = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const segment = toSafeThreadAttachmentSegment(threadId);
      if (!segment) return;
      // An open writer would recreate the file, and Windows cannot delete it.
      yield* providerLoggers.native?.closeThread?.(threadId) ?? Effect.void;
      const configuredBaseName = path.basename(config.providerEventLogPath);
      const extension = path.extname(configuredBaseName);
      const prefix = `${
        extension.length > 0 ? configuredBaseName.slice(0, -extension.length) : configuredBaseName
      }.`;
      const baseName = `${prefix}${segment}.log`;
      const entries = yield* fs
        .readDirectory(config.providerLogsDir)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed([] as string[]) : Effect.fail(error),
          ),
        );
      yield* Effect.forEach(
        entries.filter((entry) => {
          if (entry === baseName) return true;
          if (!entry.startsWith(`${baseName}.`)) return false;
          const rotation = entry.slice(baseName.length + 1);
          return rotation.length > 0 && /^\d+$/.test(rotation);
        }),
        (entry) => fs.remove(path.join(config.providerLogsDir, entry), { force: true }),
        { concurrency: 4, discard: true },
      );
    });

  const freePageCount = (schema: string) =>
    sql
      .unsafe(`PRAGMA ${schema}.freelist_count`)
      .pipe(Effect.map((rows) => Number((rows as ReadonlyArray<SqlRow>)[0]?.freelist_count ?? 0)));

  // Returns free pages to the file system in bounded steps, yielding between them.
  const reclaimFreePages = Effect.gen(function* () {
    for (const schema of reclaimableSchemas) {
      let free = yield* freePageCount(schema);
      while (free > 0) {
        yield* sql.unsafe(`PRAGMA ${schema}.incremental_vacuum(${RECLAIM_CHUNK_PAGES})`);
        yield* yieldToEventLoop;
        const remaining = yield* freePageCount(schema);
        // Another connection can hold pages back; leave them for a later pass.
        if (remaining >= free) break;
        free = remaining;
      }
    }
  });

  // Removes a thread's rows in batches of at most DELETE_CHUNK_ROWS per commit, so
  // no single commit writes a whole conversation's pages. `finish` runs inside
  // the last commit.
  const deleteThreadRows = <E>(
    tables: ReadonlyArray<ThreadTable>,
    threadId: string,
    finish: Effect.Effect<unknown, E>,
  ) =>
    Effect.gen(function* () {
      const remaining = [...tables].toReversed();
      while (remaining.length > 0) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            let budget = DELETE_CHUNK_ROWS;
            while (remaining.length > 0 && budget > 0) {
              const entry = remaining[0]!;
              yield* sql.unsafe(
                `DELETE FROM ${entry.table} WHERE rowid IN (
                   SELECT rowid FROM ${entry.table} WHERE ${entry.predicate} LIMIT ${budget}
                 )`,
                bindThread(entry, threadId),
              );
              const rows = (yield* sql.unsafe(
                "SELECT changes() AS changes",
              )) as ReadonlyArray<SqlRow>;
              const changed = Number(rows[0]?.changes ?? 0);
              if (changed < budget) remaining.shift();
              budget -= changed;
            }
            if (remaining.length === 0) yield* finish;
          }),
        );
        yield* yieldToEventLoop;
      }
    });

  // A `moving` thread's bundle is complete and its reads already restore from it,
  // so its remaining hot rows can go in batches. It stays `moving` until its
  // files are gone too, so an interrupted cleanup is resumed. Repeats safely.
  const finishMove = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* deleteThreadRows(coldTables, threadId, Effect.void);
      yield* removeColdFiles(threadId);
      yield* sql`
        UPDATE thread_archive_manifests SET status = 'cold', updated_at = ${yield* nowIso}
        WHERE thread_id = ${threadId} AND status = 'moving'
      `;
    });

  // Free pages are returned once the lifecycle queue drains: a backlog such as
  // the startup convergence reuses them meanwhile, and one final pass returns
  // the rest. Delayed re-cold effects do not hold it back.
  const compactOnce = Effect.gen(function* () {
    // The effect that called this is itself still running.
    const queue = yield* sql<{ readonly pending: number; readonly running: number }>`
        SELECT
          COALESCE(SUM(status = 'pending' AND available_at <= ${yield* nowIso}), 0) AS pending,
          COALESCE(SUM(status = 'running'), 0) AS running
        FROM orchestration_v2_effect_outbox
        WHERE effect_type IN ('thread.cold-archive', 'thread.storage-purge')
      `;
    if ((queue[0]?.pending ?? 0) > 0 || (queue[0]?.running ?? 0) > 1) return;
    yield* reclaimFreePages;
  });

  const enqueueColdArchive = (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly delayMs: number;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:thread-cold:${input.threadId}:${input.key}`);
      yield* outbox.enqueue([
        {
          id: `effect:${commandId}:thread.cold-archive`,
          commandId,
          threadId: input.threadId,
          request: { type: "thread.cold-archive" },
          availableAt: DateTime.add(now, { milliseconds: input.delayMs }),
        },
      ]);
    });

  const moveCold = Effect.fn("ThreadColdStorage.moveCold")(function* (
    threadId: ThreadId,
    archivedAt: string | null,
  ) {
    const shell = yield* projections.getThreadShell(threadId);
    const shellJson =
      shell === null ? null : yield* encodeShell(shell as OrchestrationV2ThreadShell);

    // A previous attempt or restore may have left a stale bundle behind.
    yield* deleteBundle(threadId);
    let chunkIndex = 0;
    let originalBytes = 0;
    let compressedBytes = 0;
    // Chunks are written in commits of about BUNDLE_COMMIT_BYTES each.
    let pending: Array<readonly [number, string, number, Uint8Array]> = [];
    let pendingBytes = 0;
    const flushChunks = Effect.gen(function* () {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      yield* sql.withTransaction(
        Effect.forEach(
          batch,
          ([index, kind, rowCount, data]) =>
            sql.unsafe(
              `INSERT INTO ${ARCHIVE_SCHEMA}.archive_thread_chunks
                (thread_id, chunk_index, kind, row_count, data)
               VALUES (?, ?, ?, ?, ?)`,
              [threadId, index, kind, rowCount, data],
            ),
          { discard: true },
        ),
      );
      yield* yieldToEventLoop;
    });
    const insertChunk = (kind: string, rowCount: number, encoded: Uint8Array) =>
      Effect.gen(function* () {
        const data = yield* compress(encoded);
        pending.push([chunkIndex, kind, rowCount, data]);
        pendingBytes += data.byteLength;
        chunkIndex += 1;
        originalBytes += encoded.byteLength;
        compressedBytes += data.byteLength;
        if (pendingBytes >= BUNDLE_COMMIT_BYTES) yield* flushChunks;
      });

    for (const entry of coldTables) {
      let lastRowId = 0;
      while (true) {
        const rows = (yield* sql.unsafe(
          `SELECT rowid AS __archive_rowid, * FROM ${entry.table}
           WHERE (${entry.predicate}) AND rowid > ?
           ORDER BY rowid ASC LIMIT ${ROW_CHUNK_SIZE}`,
          [...bindThread(entry, threadId), lastRowId],
        )) as ReadonlyArray<SqlRow>;
        if (rows.length === 0) break;
        const stored = rows.map(({ __archive_rowid, ...row }) => {
          lastRowId = Number(__archive_rowid);
          return row;
        });
        yield* insertChunk(`table:${entry.table}`, stored.length, yield* encodeRows(stored));
      }
    }

    const attachmentIds = yield* projections.getThreadAttachmentIds(threadId);
    for (const attachmentId of new Set(attachmentIds)) {
      const filePath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      if (filePath === null) continue;
      const entry = path.basename(filePath);
      if (!isSafeAttachmentEntry(entry)) continue;
      yield* insertChunk(`attachment:${entry}`, 1, yield* fs.readFile(filePath));
    }
    yield* flushChunks;

    yield* sql.unsafe(
      `INSERT INTO ${ARCHIVE_SCHEMA}.archive_threads
        (thread_id, archive_version, archived_at, original_bytes, compressed_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [threadId, ARCHIVE_VERSION, archivedAt, originalBytes, compressedBytes, yield* nowIso],
    );

    // Attached WAL databases do not commit atomically together, so the bundle is
    // complete before this main-only transaction rechecks eligibility and hands
    // the thread's reads to the bundle. Only then do the hot rows go.
    const moved = yield* sql.withTransaction(
      Effect.gen(function* () {
        const thread = yield* readThread(threadId);
        if (
          Option.isNone(thread) ||
          thread.value.deleted_at !== null ||
          thread.value.archived_at === null
        ) {
          return false;
        }
        // A run or fork may have started while the bundle was written.
        if (
          (yield* hasActiveRun(threadId)) ||
          (yield* isReferencedByLiveThread(threadId, thread.value))
        ) {
          yield* upsertManifest({ threadId, status: "kept-hot", archivedAt });
          return false;
        }
        yield* upsertManifest({
          threadId,
          status: "moving",
          archivedAt,
          shellJson,
          originalBytes,
          compressedBytes,
        });
        return true;
      }),
    );
    if (!moved) {
      yield* deleteBundle(threadId);
      return;
    }
    coldThreadIds.add(threadId);
    yield* finishMove(threadId);
  });

  // Idempotent: safe to repeat when a crash interrupted the cleanup after commit.
  const removeColdFiles = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const entries = yield* bundleAttachmentEntries(threadId);
      yield* Effect.forEach(
        entries,
        (entry) => fs.remove(path.join(config.attachmentsDir, entry), { force: true }),
        { concurrency: 4, discard: true },
      );
      yield* removeProviderLogs(threadId);
    });

  const insertRows = (
    table: string,
    rows: ReadonlyArray<SqlRow>,
    columnsByTable: Map<string, ReadonlySet<string>>,
  ) =>
    Effect.gen(function* () {
      if (!coldTableNames.has(table)) {
        return yield* new ArchiveContentError({ detail: `unknown table '${table}'` });
      }
      let columns = columnsByTable.get(table);
      if (columns === undefined) {
        columns = new Set(
          (
            (yield* sql.unsafe(
              `PRAGMA main.table_info(${quoteIdentifier(table)})`,
            )) as ReadonlyArray<SqlRow>
          ).map((column) => String(column.name)),
        );
        columnsByTable.set(table, columns);
      }
      for (const row of rows) {
        // Bundles can outlive migrations: drop removed columns, default new ones.
        const present = Object.keys(row).filter((column) => columns.has(column));
        if (present.length === 0) continue;
        // Rows written after the move are newer than the bundle and win.
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${present
            .map(quoteIdentifier)
            .join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
          present.map((column) => row[column]),
        );
      }
    });

  const readChunkPage = (threadId: ThreadId, kindPattern: string, afterIndex: number) =>
    sql
      .unsafe(
        `SELECT chunk_index, kind, data FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
         WHERE thread_id = ? AND chunk_index > ? AND kind LIKE ?
         ORDER BY chunk_index ASC LIMIT ${RESTORE_CHUNK_PAGE_SIZE}`,
        [threadId, afterIndex, kindPattern],
      )
      .pipe(Effect.map((rows) => rows as ReadonlyArray<SqlRow>));

  // Writes attachment files outside any transaction; a failed write leaves the
  // bundle authoritative for a retry.
  const restoreFiles = (threadId: ThreadId) =>
    Effect.gen(function* () {
      let afterIndex = -1;
      while (true) {
        const chunks = yield* readChunkPage(threadId, "attachment:%", afterIndex);
        if (chunks.length === 0) break;
        for (const chunk of chunks) {
          afterIndex = Number(chunk.chunk_index);
          const entry = String(chunk.kind).slice("attachment:".length);
          if (!isSafeAttachmentEntry(entry)) {
            return yield* new ArchiveContentError({ detail: `unsafe attachment '${entry}'` });
          }
          const data = yield* decompress(chunk.data as Uint8Array);
          const target = path.join(config.attachmentsDir, entry);
          const temporary = `${target}.t3-restore`;
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fs
            .writeFile(temporary, data)
            .pipe(
              Effect.andThen(fs.remove(target, { force: true })),
              Effect.andThen(fs.rename(temporary, target)),
              Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
            );
        }
      }
    });

  // Inserts rows one page of chunks per commit, decoding outside the commit, so
  // a large conversation never holds the database connection for its whole size.
  const restoreRows = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const columnsByTable = new Map<string, ReadonlySet<string>>();
      let afterIndex = -1;
      while (true) {
        const chunks = yield* readChunkPage(threadId, "table:%", afterIndex);
        if (chunks.length === 0) break;
        const decoded = yield* Effect.forEach(chunks, (chunk) =>
          decompress(chunk.data as Uint8Array).pipe(
            Effect.flatMap(decodeRows),
            Effect.map((rows) => [String(chunk.kind).slice("table:".length), rows] as const),
          ),
        );
        afterIndex = Number(chunks.at(-1)!.chunk_index);
        yield* sql.withTransaction(
          Effect.forEach(decoded, ([table, rows]) => insertRows(table, rows, columnsByTable), {
            discard: true,
          }),
        );
        yield* yieldToEventLoop;
      }
    });

  const restore = Effect.fn("ThreadColdStorage.restore")(function* (
    threadId: ThreadId,
    unarchive: boolean,
  ) {
    const manifest = yield* readManifest(threadId);
    const thread = yield* readThread(threadId);
    // Deleted threads stay cold until their purge removes the bundle.
    if (Option.isNone(thread) || thread.value.deleted_at !== null) return;
    if (
      Option.isSome(manifest) &&
      (manifest.value.status === "cold" || manifest.value.status === "moving")
    ) {
      const unknownKinds = yield* sql.unsafe(
        `SELECT kind FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
         WHERE thread_id = ? AND kind NOT LIKE 'table:%' AND kind NOT LIKE 'attachment:%'
         LIMIT 1`,
        [threadId],
      );
      if (unknownKinds.length > 0) {
        return yield* new ArchiveContentError({ detail: "unknown chunk kind" });
      }
      // A missing or newer bundle fails the read and keeps the manifest.
      yield* assertBundleComplete(threadId);
      // Readers keep waiting until the last commit. Marked `moving` first, an
      // interrupted restore is converged by startup reconcile like a move.
      yield* sql`
        UPDATE thread_archive_manifests SET status = 'moving', updated_at = ${yield* nowIso}
        WHERE thread_id = ${threadId} AND status = 'cold'
      `;
      yield* restoreFiles(threadId);
      yield* restoreRows(threadId);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* upsertManifest({
            threadId,
            status: "restored",
            archivedAt: manifest.value.archived_at,
            bumpGeneration: true,
          });
          if (!unarchive) {
            const generation = manifest.value.restore_generation + 1;
            yield* enqueueColdArchive({
              threadId,
              key: `${manifest.value.archived_at ?? "unknown"}:${generation}`,
              delayMs: RECOLD_DELAY_MS,
            });
          }
        }),
      );
      coldThreadIds.delete(threadId);
      if (!unarchive) yield* outbox.notifyAvailable();
    }
    if (unarchive && Option.isSome(manifest) && manifest.value.status !== "purged") {
      // The thread is hot from here on; a queued re-cold must not hold back its
      // effects. The bundle goes in the cold-archive effect queued after the
      // unarchive command, off the command's path.
      const cancelled = yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["thread.cold-archive"],
        reason: "Thread unarchived.",
      });
      yield* outbox.signalCancellations(cancelled);
    }
  });

  const archive = Effect.fn("ThreadColdStorage.archive")(function* <E>(
    threadId: ThreadId,
    prepare: Effect.Effect<unknown, E>,
  ) {
    const manifest = yield* readManifest(threadId);
    const thread = yield* readThread(threadId);
    if (Option.isNone(thread) || thread.value.deleted_at !== null) return;
    if (thread.value.archived_at === null) {
      // Unarchived since this effect was queued: drop any bundle it left behind.
      if (Option.isSome(manifest)) {
        yield* deleteBundle(threadId);
        yield* sql`DELETE FROM thread_archive_manifests WHERE thread_id = ${threadId}`;
      }
      return;
    }
    if (Option.isSome(manifest) && manifest.value.status === "cold") {
      yield* removeColdFiles(threadId);
      return;
    }
    if (Option.isSome(manifest) && manifest.value.status === "moving") {
      yield* finishMove(threadId);
      return;
    }
    if (
      (yield* hasActiveRun(threadId)) ||
      (yield* isReferencedByLiveThread(threadId, thread.value))
    ) {
      yield* upsertManifest({ threadId, status: "kept-hot", archivedAt: thread.value.archived_at });
      return;
    }
    if (!(yield* startMove(threadId))) {
      // A read or command is using the rows; try again once it has finished.
      yield* enqueueColdArchive({
        threadId,
        key: `${thread.value.archived_at}:busy:${yield* nowIso}`,
        delayMs: RECOLD_DELAY_MS,
      });
      yield* outbox.notifyAvailable();
      return;
    }
    yield* prepare.pipe(
      Effect.andThen(moveCold(threadId, thread.value.archived_at)),
      Effect.ensuring(Effect.sync(() => archiving.delete(threadId))),
    );
  });

  const removeAttachmentFiles = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const fromMessages = (yield* projections.getThreadAttachmentIds(threadId)).flatMap(
        (attachmentId) => {
          const filePath = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId,
          });
          return filePath === null ? [] : [path.basename(filePath)];
        },
      );
      const entries = new Set([...(yield* bundleAttachmentEntries(threadId)), ...fromMessages]);
      yield* Effect.forEach(
        entries,
        (entry) => fs.remove(path.join(config.attachmentsDir, entry), { force: true }),
        { concurrency: 4, discard: true },
      );
    });

  const enqueuePurge = (threadIds: ReadonlyArray<string>, key: string, delayMs = 0) =>
    Effect.gen(function* () {
      const availableAt = DateTime.add(yield* DateTime.now, { milliseconds: delayMs });
      yield* outbox.enqueue(
        threadIds.map((threadId) => {
          const commandId = CommandId.make(`command:thread-purge:${threadId}:${key}`);
          return {
            id: `effect:${commandId}:thread.storage-purge`,
            commandId,
            threadId: ThreadId.make(threadId),
            request: { type: "thread.storage-purge" as const },
            availableAt,
          };
        }),
      );
    });

  const purge = Effect.fn("ThreadColdStorage.purge")(function* (threadId: ThreadId) {
    const thread = yield* readThread(threadId);
    if (Option.isNone(thread) || thread.value.deleted_at === null) return;
    // A read or command still holds the thread, such as a fork reading it as its
    // source; try again once it has finished. New leases wait for the purge.
    if (!(yield* startMove(threadId))) {
      yield* enqueuePurge([threadId], `busy:${yield* nowIso}`, RECOLD_DELAY_MS);
      yield* outbox.notifyAvailable();
      return;
    }
    yield* removeStorage(threadId, thread.value).pipe(
      Effect.ensuring(Effect.sync(() => archiving.delete(threadId))),
    );
  });

  const removeStorage = (threadId: ThreadId, thread: ThreadRow) =>
    Effect.gen(function* () {
      // Forks still read this thread's rows. Its purge runs again once the last
      // of them is purged, or on the next startup.
      if (yield* hasForkDependents(threadId)) return;
      // The bundle and the messages are the only inventory of the thread's files.
      yield* removeAttachmentFiles(threadId);
      yield* removeProviderLogs(threadId);
      yield* deleteBundle(threadId);
      // Batched like a move; an interrupted purge repeats until it records `purged`.
      yield* deleteThreadRows(
        purgeTables,
        threadId,
        Effect.gen(function* () {
          // A shared session goes once no binding is left and its owner is this
          // thread or already purged, whichever thread loses the last binding.
          // Found again on every attempt, so an interrupted purge cannot miss it.
          yield* sql`
            DELETE FROM orchestration_v2_projection_provider_sessions
            WHERE NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.provider_session_id
                  = orchestration_v2_projection_provider_sessions.provider_session_id
              )
              AND (
                thread_id = ${threadId}
                OR thread_id IN (
                  SELECT thread_id FROM thread_archive_manifests WHERE status = 'purged'
                )
              )
          `;
          yield* upsertManifest({ threadId, status: "purged", archivedAt: thread.archived_at });
        }),
      );
      coldThreadIds.delete(threadId);
      const sourceId = thread.forked_from_thread_id;
      if (sourceId === null) return;
      // The source this fork kept hot or unpurged can move on now.
      const source = yield* readThread(sourceId);
      const sourceManifest = yield* readManifest(sourceId);
      if (Option.isNone(source)) return;
      if (
        source.value.deleted_at !== null &&
        !(Option.isSome(sourceManifest) && sourceManifest.value.status === "purged")
      ) {
        yield* enqueuePurge([sourceId], `after-fork:${threadId}`);
        yield* outbox.notifyAvailable();
      } else if (
        source.value.deleted_at === null &&
        source.value.archived_at !== null &&
        Option.isSome(sourceManifest) &&
        sourceManifest.value.status === "kept-hot"
      ) {
        yield* enqueueColdArchive({
          threadId: ThreadId.make(sourceId),
          key: `after-fork:${threadId}`,
          delayMs: 0,
        });
        yield* outbox.notifyAvailable();
      }
    });

  const reconcile = Effect.gen(function* () {
    // One identity per startup, so work whose earlier attempt failed for good
    // runs again; threads with unsettled lifecycle work are left to it.
    const attempt = `reconcile:${yield* nowIso}`;
    // Archived threads that have not been evaluated yet, were left hot by a
    // restore, stopped part way through a move (including its file cleanup), or
    // were kept hot by a blocker that may be gone; and unarchived threads whose
    // bundle was never dropped.
    const archived = yield* sql<{ readonly thread_id: string }>`
      SELECT thread.thread_id
      FROM orchestration_v2_projection_threads AS thread
      LEFT JOIN thread_archive_manifests AS manifest ON manifest.thread_id = thread.thread_id
      WHERE thread.deleted_at IS NULL
        AND (
          (thread.archived_at IS NOT NULL
            AND (manifest.thread_id IS NULL
              OR manifest.status IN ('restored', 'moving', 'kept-hot')))
          OR (thread.archived_at IS NULL AND manifest.thread_id IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.effect_type = 'thread.cold-archive'
            AND effect.status IN ('pending', 'running')
        )
    `;
    for (const row of archived) {
      yield* enqueueColdArchive({
        threadId: ThreadId.make(row.thread_id),
        key: attempt,
        delayMs: 0,
      });
    }
    const deleted = yield* sql<{ readonly thread_id: string }>`
      SELECT thread.thread_id
      FROM orchestration_v2_projection_threads AS thread
      LEFT JOIN thread_archive_manifests AS manifest ON manifest.thread_id = thread.thread_id
      WHERE thread.deleted_at IS NOT NULL
        AND (manifest.thread_id IS NULL OR manifest.status <> 'purged')
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.effect_type = 'thread.storage-purge'
            AND effect.status IN ('pending', 'running')
        )
    `;
    if (deleted.length > 0) {
      yield* enqueuePurge(
        deleted.map((row) => row.thread_id),
        attempt,
      );
    }
    const queued = archived.length + deleted.length;
    if (queued > 0) {
      yield* outbox.notifyAvailable(queued);
    } else {
      yield* compactOnce;
    }
  });

  const mapError =
    (operation: ThreadColdStorageError["operation"], threadId?: ThreadId) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ThreadColdStorageError({
              operation,
              ...(threadId === undefined ? {} : { threadId }),
              cause,
            }),
        ),
      );

  // Hot threads take their lease without the lock. A cold thread, a move in
  // progress, or an unarchive (which cancels queued re-colds) goes through the
  // lock, so the lease starts after any move has finished and the restore ran.
  const acquireLease = (threadId: ThreadId, unarchive: boolean) =>
    Effect.gen(function* () {
      if (!unarchive && (yield* takeHotLease(threadId))) return;
      yield* threadLocks.withLock(
        threadId,
        restore(threadId, unarchive).pipe(Effect.andThen(takeLease(threadId))),
      );
    }).pipe(mapError("restore", threadId));

  const withHot: ThreadColdStorageShape["withHot"] = (threadId, use, options) =>
    Effect.acquireUseRelease(
      acquireLease(threadId, options?.unarchive === true),
      () => use,
      () => releaseLease(threadId),
    );

  const ensureAttachmentHot = (attachmentId: string) =>
    Effect.gen(function* () {
      if (resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId })) {
        return;
      }
      const kinds = attachmentFileNameCandidates(attachmentId).map((name) => `attachment:${name}`);
      if (kinds.length === 0) return;
      const rows = (yield* sql.unsafe(
        `SELECT thread_id FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
         WHERE kind IN (${kinds.map(() => "?").join(", ")}) LIMIT 1`,
        kinds,
      )) as ReadonlyArray<SqlRow>;
      const owner = rows[0]?.thread_id;
      if (owner === undefined) return;
      yield* withHot(ThreadId.make(String(owner)), Effect.void);
    }).pipe(mapError("restore"));

  return ThreadColdStorage.of({
    withHot,
    ensureAttachmentHot,
    scheduleArchive: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* readThread(threadId);
        if (Option.isNone(thread) || thread.value.deleted_at !== null) return;
        yield* enqueueColdArchive({
          threadId,
          key: `${thread.value.archived_at ?? "active"}:scheduled:${yield* nowIso}`,
          delayMs: 0,
        });
        yield* outbox.notifyAvailable();
      }).pipe(mapError("schedule", threadId)),
    // Convergence runs many of these back to back; each starts on a fresh turn
    // of the event loop.
    archive: (threadId, prepare) =>
      yieldToEventLoop.pipe(
        Effect.andThen(threadLocks.withLock(threadId, archive(threadId, prepare))),
        Effect.andThen(compactOnce),
        mapError("archive", threadId),
      ),
    purge: (threadId) =>
      yieldToEventLoop.pipe(
        Effect.andThen(threadLocks.withLock(threadId, purge(threadId))),
        Effect.andThen(compactOnce),
        mapError("purge", threadId),
      ),
    reconcile: reconcile.pipe(mapError("reconcile")),
  });
});

/** The service alone, for tests that drive reconciliation themselves. */
export const layer = Layer.effect(ThreadColdStorage, make);

/**
 * The server's cold storage. Building it also starts reconciliation, parked
 * until activation commits the update, so archived threads and unpurged
 * deletions that predate this server converge without another wiring step.
 */
export const layerWithReconcile = Layer.effectDiscard(
  Effect.gen(function* () {
    const coldStorage = yield* ThreadColdStorage;
    yield* forkParked(
      coldStorage.reconcile.pipe(
        Effect.withSpan("server.startup.thread-cold-storage.reconcile"),
        Effect.ignoreCause({ log: true }),
      ),
    );
  }),
).pipe(Layer.provideMerge(layer));

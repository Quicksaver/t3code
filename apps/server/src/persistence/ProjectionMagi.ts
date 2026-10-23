import {
  ContextArtifactManifest,
  ContextArtifactId,
  IsoDateTime,
  MagiRunDetail,
  MagiRunId,
  MagiRunState,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "./Errors.ts";

export const PersistedMagiRun = Schema.Struct({
  detail: MagiRunDetail,
  initiatingReferenceId: Schema.NullOr(Schema.String),
  initiatingInstruction: Schema.String,
  focusedObjective: Schema.NullOr(Schema.String),
  arbitratorPrompt: Schema.String,
  protocol: Schema.Unknown,
  updatedAt: IsoDateTime,
  /**
   * The owning conversation's run currently driving Magi: the run that started it, then the
   * latest run that called a Magi tool or the control continuation. Its lifecycle drives
   * main-agent pauses.
   */
  mainRunId: Schema.NullOr(RunId),
});
export type PersistedMagiRun = typeof PersistedMagiRun.Type;

export interface MagiContextArtifactRecord {
  readonly manifest: ContextArtifactManifest;
  readonly result: unknown;
}

export interface ProjectionMagiRepositoryShape {
  readonly putRun: (run: PersistedMagiRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getRun: (
    runId: MagiRunId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly findActiveRun: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  /** A delegated owner still owes its final answer while an asynchronous Magi run is active. */
  readonly hasPendingOwnerWork: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** The owner's newest run started from `initiatingReferenceId`. */
  readonly findRunByInitiatingReferenceId: (input: {
    readonly rootThreadId: ThreadId;
    readonly initiatingReferenceId: string;
  }) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly listRunsByOwner: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly listRecoverableRuns: () => Effect.Effect<
    ReadonlyArray<PersistedMagiRun>,
    ProjectionRepositoryError
  >;
  readonly deleteByOwnerThreadId: (
    ownerThreadId: ThreadId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Stores each artifact once and addresses it to every listed participant conversation. */
  readonly putContextArtifacts: (input: {
    readonly runId: MagiRunId;
    readonly artifacts: ReadonlyArray<MagiContextArtifactRecord>;
    readonly participantThreadIds: ReadonlyArray<ThreadId>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** The given threads that are a participant conversation of any recorded Magi run. */
  readonly findParticipantThreads: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;
  /** Resolves only artifacts addressed to `participantThreadId`; other ids are absent. */
  readonly readContextArtifacts: (input: {
    readonly participantThreadId: ThreadId;
    readonly artifactIds: ReadonlyArray<ContextArtifactId>;
  }) => Effect.Effect<ReadonlyArray<MagiContextArtifactRecord>, ProjectionRepositoryError>;
}

export const RECOVERABLE_MAGI_STATES: ReadonlyArray<MagiRunState> = [
  "initializing",
  "awaiting-main-tool",
  "deliberating",
  "awaiting-arbitration",
  "awaiting-actions",
  "awaiting-next-turn",
  "awaiting-main-approval",
  "awaiting-main-input",
  "awaiting-action-reconciliation",
  "paused",
  "cancelling",
];

export class ProjectionMagiRepository extends Context.Service<
  ProjectionMagiRepository,
  ProjectionMagiRepositoryShape
>()("t3/persistence/ProjectionMagi/ProjectionMagiRepository") {}

const decodeRun = Schema.decodeUnknownEffect(PersistedMagiRun);
const decodeManifest = Schema.decodeUnknownEffect(ContextArtifactManifest);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isPersistenceSqlError = Schema.is(PersistenceSqlError);

const parseJson = (operation: string, value: string) =>
  decodeJson(value).pipe(Effect.mapError(toPersistenceDecodeError(operation)));

const makeProjectionMagiRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeRunRows = (operation: string, rows: ReadonlyArray<{ readonly snapshot: string }>) =>
    Effect.forEach(rows, (row) =>
      parseJson(`${operation}.json`, row.snapshot).pipe(
        Effect.flatMap((value) =>
          decodeRun(value).pipe(Effect.mapError(toPersistenceDecodeError(`${operation}.decode`))),
        ),
      ),
    );
  const firstRun = (operation: string, rows: ReadonlyArray<{ readonly snapshot: string }>) =>
    decodeRunRows(operation, rows.slice(0, 1)).pipe(
      Effect.map(([first]) => (first === undefined ? Option.none() : Option.some(first))),
    );

  const putRun: ProjectionMagiRepositoryShape["putRun"] = (run) => {
    const { summary } = run.detail;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const roots = yield* sql<{ readonly deletedAt: string | null }>`
            SELECT deleted_at AS "deletedAt" FROM orchestration_v2_projection_threads
            WHERE thread_id = ${summary.rootThreadId}
          `;
          if (!roots[0] || roots[0].deletedAt !== null) {
            return yield* new PersistenceSqlError({
              operation: "ProjectionMagi.putRun",
              detail: "The root thread does not exist or was deleted.",
              correlation: { threadId: summary.rootThreadId },
            });
          }
          yield* sql`
            INSERT INTO magi_runs (
              run_id, root_thread_id, state, initiating_reference_id, snapshot_json,
              started_at, updated_at
            ) VALUES (
              ${summary.runId}, ${summary.rootThreadId}, ${summary.state},
              ${run.initiatingReferenceId}, ${encodeJson(run)}, ${summary.startedAt}, ${run.updatedAt}
            )
            ON CONFLICT (run_id) DO UPDATE SET
              state = excluded.state,
              snapshot_json = excluded.snapshot_json,
              updated_at = excluded.updated_at
          `;
          yield* Effect.forEach(
            run.detail.participants.flatMap((participant) =>
              participant.childThreadId === null ? [] : [participant.childThreadId],
            ),
            (threadId) => sql`
              INSERT OR IGNORE INTO magi_run_participants (thread_id, run_id)
              VALUES (${threadId}, ${summary.runId})
            `,
            { discard: true },
          );
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          isPersistenceSqlError(error)
            ? error
            : toPersistenceSqlError("ProjectionMagi.putRun")(error),
        ),
      );
  };

  const getRun: ProjectionMagiRepositoryShape["getRun"] = (runId) =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs WHERE run_id = ${runId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getRun.query")),
      Effect.flatMap((rows) => firstRun("ProjectionMagi.getRun", rows)),
    );

  const findActiveRun: ProjectionMagiRepositoryShape["findActiveRun"] = (rootThreadId) =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs
      WHERE root_thread_id = ${rootThreadId} AND state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.findActiveRun.query")),
      Effect.flatMap((rows) => firstRun("ProjectionMagi.findActiveRun", rows)),
    );

  const hasPendingOwnerWork: ProjectionMagiRepositoryShape["hasPendingOwnerWork"] = (threadId) =>
    sql`
      SELECT 1 FROM magi_runs
      WHERE root_thread_id = ${threadId} AND state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
        AND json_type(snapshot_json, '$.protocol.turnDelivery') = 'object'
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.hasPendingOwnerWork")),
      Effect.map((rows) => rows.length > 0),
    );

  const findRunByInitiatingReferenceId: ProjectionMagiRepositoryShape["findRunByInitiatingReferenceId"] =
    (input) =>
      sql<{ readonly snapshot: string }>`
        SELECT snapshot_json AS snapshot FROM magi_runs
        WHERE root_thread_id = ${input.rootThreadId}
          AND initiating_reference_id = ${input.initiatingReferenceId}
        ORDER BY started_at DESC, run_id DESC LIMIT 1
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(
          toPersistenceSqlError("ProjectionMagi.findRunByInitiatingReferenceId.query"),
        ),
        Effect.flatMap((rows) => firstRun("ProjectionMagi.findRunByInitiatingReferenceId", rows)),
      );

  const listRunsByOwner: ProjectionMagiRepositoryShape["listRunsByOwner"] = (rootThreadId) =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs
      WHERE root_thread_id = ${rootThreadId}
      ORDER BY started_at ASC, run_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRunsByOwner.query")),
      Effect.flatMap((rows) => decodeRunRows("ProjectionMagi.listRunsByOwner", rows)),
    );

  const listRecoverableRuns: ProjectionMagiRepositoryShape["listRecoverableRuns"] = () =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs
      WHERE state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
         OR json_extract(snapshot_json, '$.protocol.cleanupPending') = 1
         OR (state = 'failed' AND json_extract(snapshot_json, '$.protocol.turnDelivery.state') = 'pending')
         OR EXISTS (
           SELECT 1 FROM orchestration_v2_projection_threads owner
           WHERE owner.thread_id = magi_runs.root_thread_id
             AND json_extract(owner.payload_json, '$.pendingMagiRunId') = magi_runs.run_id
         )
      ORDER BY updated_at ASC, run_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRecoverableRuns.query")),
      Effect.flatMap((rows) => decodeRunRows("ProjectionMagi.listRecoverableRuns", rows)),
    );

  const deleteByOwnerThreadId: ProjectionMagiRepositoryShape["deleteByOwnerThreadId"] = (
    ownerThreadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM magi_context_grants WHERE run_id IN (
              SELECT run_id FROM magi_runs WHERE root_thread_id = ${ownerThreadId}
            )
          `;
          yield* sql`
            DELETE FROM magi_context_artifacts WHERE run_id IN (
              SELECT run_id FROM magi_runs WHERE root_thread_id = ${ownerThreadId}
            )
          `;
          yield* sql`
            DELETE FROM magi_run_participants WHERE run_id IN (
              SELECT run_id FROM magi_runs WHERE root_thread_id = ${ownerThreadId}
            )
          `;
          yield* sql`DELETE FROM magi_runs WHERE root_thread_id = ${ownerThreadId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProjectionMagi.deleteByOwnerThreadId")),
      );

  const putContextArtifacts: ProjectionMagiRepositoryShape["putContextArtifacts"] = (input) =>
    sql
      .withTransaction(
        Effect.forEach(
          input.artifacts,
          (artifact) =>
            Effect.gen(function* () {
              yield* sql`
                INSERT OR IGNORE INTO magi_context_artifacts (artifact_id, run_id, manifest_json, result_json)
                VALUES (
                  ${artifact.manifest.artifactId}, ${input.runId},
                  ${encodeJson(artifact.manifest)}, ${encodeJson(artifact.result ?? null)}
                )
              `;
              yield* Effect.forEach(
                input.participantThreadIds,
                (participantThreadId) => sql`
                  INSERT OR IGNORE INTO magi_context_grants (participant_thread_id, artifact_id, run_id)
                  VALUES (${participantThreadId}, ${artifact.manifest.artifactId}, ${input.runId})
                `,
                { discard: true },
              );
            }),
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionMagi.putContextArtifacts")));

  const findParticipantThreads: ProjectionMagiRepositoryShape["findParticipantThreads"] = (
    threadIds,
  ) =>
    threadIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly threadId: ThreadId }>`
          SELECT DISTINCT thread_id AS "threadId" FROM magi_run_participants
          WHERE thread_id IN ${sql.in(threadIds)}
        `.pipe(
          Effect.map((rows) => rows.map((row) => row.threadId)),
          NodeSqliteClient.readOnly,
          Effect.mapError(toPersistenceSqlError("ProjectionMagi.findParticipantThreads")),
        );

  const readContextArtifacts: ProjectionMagiRepositoryShape["readContextArtifacts"] = (input) =>
    input.artifactIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly manifest: string; readonly result: string }>`
          SELECT artifacts.manifest_json AS manifest, artifacts.result_json AS result
          FROM magi_context_grants AS grants
          INNER JOIN magi_context_artifacts AS artifacts
            ON artifacts.artifact_id = grants.artifact_id
          WHERE grants.participant_thread_id = ${input.participantThreadId}
            AND grants.artifact_id IN ${sql.in(input.artifactIds)}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(toPersistenceSqlError("ProjectionMagi.readContextArtifacts.query")),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.all({
                manifest: parseJson(
                  "ProjectionMagi.readContextArtifacts.manifest",
                  row.manifest,
                ).pipe(
                  Effect.flatMap((value) =>
                    decodeManifest(value).pipe(
                      Effect.mapError(
                        toPersistenceDecodeError("ProjectionMagi.readContextArtifacts.decode"),
                      ),
                    ),
                  ),
                ),
                result: parseJson("ProjectionMagi.readContextArtifacts.result", row.result),
              }),
            ),
          ),
        );

  return {
    putRun,
    getRun,
    findActiveRun,
    hasPendingOwnerWork,
    findRunByInitiatingReferenceId,
    listRunsByOwner,
    listRecoverableRuns,
    deleteByOwnerThreadId,
    findParticipantThreads,
    putContextArtifacts,
    readContextArtifacts,
  } satisfies ProjectionMagiRepositoryShape;
});

export const ProjectionMagiRepositoryLive = Layer.effect(
  ProjectionMagiRepository,
  makeProjectionMagiRepository,
);

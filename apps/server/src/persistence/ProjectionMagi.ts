import {
  ContextArtifactManifest,
  ContextArtifactId,
  IsoDateTime,
  MagiArmThreadResult,
  MagiListRunsInput,
  MagiListRunsResult,
  MagiRunDetail,
  MagiRunId,
  MagiRunState,
  MagiRunSummary,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
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
  /** The user message whose run started Magi; it anchors the run in the timeline. */
  mainMessageId: Schema.NullOr(MessageId),
  /** The owner followed by its lineage ancestors; each sees the run in its Magi history. */
  audienceThreadIds: Schema.Array(ThreadId),
});
export type PersistedMagiRun = typeof PersistedMagiRun.Type;

/** An arm and, once a user message carried it, that message. */
export interface PersistedMagiArm {
  readonly arm: MagiArmThreadResult;
  readonly attachedMessageId: MessageId | null;
}

export interface MagiContextArtifactRecord {
  readonly manifest: ContextArtifactManifest;
  readonly result: unknown;
}

export interface ProjectionMagiRepositoryShape {
  readonly putArm: (arm: MagiArmThreadResult) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getArm: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersistedMagiArm>, ProjectionRepositoryError>;
  readonly setArmAttachment: (input: {
    readonly threadId: ThreadId;
    readonly armId: MagiArmThreadResult["armId"];
    readonly messageId: MessageId | null;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Clears the conversation's arm, or only the given arm, keeping its revision counter so the
   * next arm continues from it.
   */
  readonly deleteArm: (input: {
    readonly threadId: ThreadId;
    readonly armId?: MagiArmThreadResult["armId"];
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** The latest arm revision of the conversation, including cleared arms; 0 when never armed. */
  readonly getArmRevision: (threadId: ThreadId) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly putRun: (run: PersistedMagiRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getRun: (
    runId: MagiRunId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
  readonly findActiveRun: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersistedMagiRun>, ProjectionRepositoryError>;
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
  /** Runs visible to a conversation: its own and those of its descendants. */
  readonly listRuns: (
    input: MagiListRunsInput,
  ) => Effect.Effect<MagiListRunsResult, ProjectionRepositoryError>;
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

const decodeArm = Schema.decodeUnknownEffect(MagiArmThreadResult);
const decodeRun = Schema.decodeUnknownEffect(PersistedMagiRun);
const decodeSummary = Schema.decodeUnknownEffect(MagiRunSummary);
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

  const putArm: ProjectionMagiRepositoryShape["putArm"] = (arm) =>
    sql`
      INSERT INTO magi_arms (thread_id, arm_id, revision, config_json, armed_at, attached_message_id)
      VALUES (${arm.threadId}, ${arm.armId}, ${arm.revision}, ${encodeJson(arm.config)}, ${arm.armedAt}, NULL)
      ON CONFLICT (thread_id) DO UPDATE SET
        arm_id = excluded.arm_id,
        revision = excluded.revision,
        config_json = excluded.config_json,
        armed_at = excluded.armed_at,
        attached_message_id = NULL
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionMagi.putArm")));

  const getArm: ProjectionMagiRepositoryShape["getArm"] = (threadId) =>
    sql<{
      readonly armId: string;
      readonly threadId: string;
      readonly revision: number;
      readonly config: string;
      readonly armedAt: string;
      readonly attachedMessageId: string | null;
    }>`
      SELECT arm_id AS "armId", thread_id AS "threadId", revision, config_json AS config,
             armed_at AS "armedAt", attached_message_id AS "attachedMessageId"
      FROM magi_arms WHERE thread_id = ${threadId} AND arm_id IS NOT NULL
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getArm.query")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(Option.none());
        const { attachedMessageId, ...armRow } = row;
        return parseJson("ProjectionMagi.getArm.json", row.config).pipe(
          Effect.flatMap((config) =>
            decodeArm({ ...armRow, config }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectionMagi.getArm.decode")),
            ),
          ),
          Effect.map((arm) =>
            Option.some({
              arm,
              attachedMessageId:
                attachedMessageId === null ? null : MessageId.make(attachedMessageId),
            }),
          ),
        );
      }),
    );

  const setArmAttachment: ProjectionMagiRepositoryShape["setArmAttachment"] = (input) =>
    sql`
      UPDATE magi_arms SET attached_message_id = ${input.messageId}
      WHERE thread_id = ${input.threadId} AND arm_id = ${input.armId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.setArmAttachment")),
    );

  const deleteArm: ProjectionMagiRepositoryShape["deleteArm"] = (input) =>
    sql`
      UPDATE magi_arms
      SET arm_id = NULL, config_json = NULL, armed_at = NULL, attached_message_id = NULL
      WHERE thread_id = ${input.threadId}
        ${input.armId === undefined ? sql`` : sql`AND arm_id = ${input.armId}`}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionMagi.deleteArm")));

  const getArmRevision: ProjectionMagiRepositoryShape["getArmRevision"] = (threadId) =>
    sql<{ readonly revision: number }>`
      SELECT revision FROM magi_arms WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.revision ?? 0),
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getArmRevision")),
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
              run_id, root_thread_id, source, state, title_json, objective,
              initiating_reference_id, snapshot_json, completed_magi_turns,
              started_at, completed_at, updated_at
            ) VALUES (
              ${summary.runId}, ${summary.rootThreadId}, ${summary.source}, ${summary.state},
              ${encodeJson(summary.title)}, ${summary.objective}, ${run.initiatingReferenceId},
              ${encodeJson(run)}, ${summary.completedMagiTurns}, ${summary.startedAt},
              ${summary.completedAt}, ${run.updatedAt}
            )
            ON CONFLICT (run_id) DO UPDATE SET
              state = excluded.state,
              title_json = excluded.title_json,
              objective = excluded.objective,
              snapshot_json = excluded.snapshot_json,
              completed_magi_turns = excluded.completed_magi_turns,
              completed_at = excluded.completed_at,
              updated_at = excluded.updated_at
          `;
          yield* Effect.forEach(
            run.audienceThreadIds,
            (threadId) => sql`
              INSERT OR IGNORE INTO magi_run_audiences (thread_id, run_id)
              VALUES (${threadId}, ${summary.runId})
            `,
            { discard: true },
          );
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
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getRun.query")),
      Effect.flatMap((rows) => firstRun("ProjectionMagi.getRun", rows)),
    );

  const findActiveRun: ProjectionMagiRepositoryShape["findActiveRun"] = (rootThreadId) =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs
      WHERE root_thread_id = ${rootThreadId} AND state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.findActiveRun.query")),
      Effect.flatMap((rows) => firstRun("ProjectionMagi.findActiveRun", rows)),
    );

  const findRunByInitiatingReferenceId: ProjectionMagiRepositoryShape["findRunByInitiatingReferenceId"] =
    (input) =>
      sql<{ readonly snapshot: string }>`
        SELECT snapshot_json AS snapshot FROM magi_runs
        WHERE root_thread_id = ${input.rootThreadId}
          AND initiating_reference_id = ${input.initiatingReferenceId}
        ORDER BY started_at DESC, run_id DESC LIMIT 1
      `.pipe(
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
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRunsByOwner.query")),
      Effect.flatMap((rows) => decodeRunRows("ProjectionMagi.listRunsByOwner", rows)),
    );

  const listRecoverableRuns: ProjectionMagiRepositoryShape["listRecoverableRuns"] = () =>
    sql<{ readonly snapshot: string }>`
      SELECT snapshot_json AS snapshot FROM magi_runs
      WHERE state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
         OR json_extract(snapshot_json, '$.protocol.cleanupPending') = 1
      ORDER BY updated_at ASC, run_id ASC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRecoverableRuns.query")),
      Effect.flatMap((rows) => decodeRunRows("ProjectionMagi.listRecoverableRuns", rows)),
    );

  const listRuns: ProjectionMagiRepositoryShape["listRuns"] = (input) => {
    const cursor = input.cursor ?? "";
    return Effect.gen(function* () {
      const rows = yield* sql<{
        readonly summary: string;
        readonly tokenCount: number | null;
        readonly requiredWeight: number | null;
        readonly startedAt: string;
        readonly runId: string;
      }>`
        SELECT json_object(
          'runId', runs.run_id, 'rootThreadId', runs.root_thread_id,
          'ownerTitle', owners.title, 'source', runs.source,
          'title', json(runs.title_json), 'state', runs.state, 'objective', runs.objective,
          'completedMagiTurns', runs.completed_magi_turns,
          'participantCount', json_array_length(json_extract(runs.snapshot_json, '$.detail.config.participants')),
          'magiTurnLimit', json_extract(runs.snapshot_json, '$.detail.config.magiTurnLimit'),
          'agreedVoteCount', CASE
            WHEN runs.state IN ('succeeded', 'turn-limit-reached', 'failed') THEN (
              SELECT count(*)
              FROM json_each(runs.snapshot_json, '$.protocol.turns[#-1].arbitration.assessments')
              WHERE json_extract(value, '$.stance') = 'supports'
            )
            ELSE NULL
          END,
          'totalVoteCount', CASE
            WHEN runs.state IN ('succeeded', 'turn-limit-reached', 'failed') THEN (
              SELECT count(*)
              FROM json_each(runs.snapshot_json, '$.protocol.turns[#-1].arbitration.assessments')
            )
            ELSE NULL
          END,
          'leadingAgreementWeight', json_extract(runs.snapshot_json, '$.detail.activity.leadingAgreementWeight'),
          'leadingAgreementLabel', json_extract(runs.snapshot_json, '$.detail.activity.leadingAgreementLabel'),
          'startedAt', runs.started_at, 'updatedAt', runs.updated_at, 'completedAt', runs.completed_at
        ) AS summary,
        -- Null when no settlement reported usage, so unknown totals are omitted, not zero.
        (
          SELECT CASE
            WHEN count(json_extract(value, '$.inputTokens')) +
                 count(json_extract(value, '$.outputTokens')) = 0 THEN NULL
            ELSE sum(
              COALESCE(json_extract(value, '$.inputTokens'), 0) +
              COALESCE(json_extract(value, '$.outputTokens'), 0)
            )
          END
          FROM json_each(runs.snapshot_json, '$.detail.settlements')
        ) AS "tokenCount",
        json_extract(runs.snapshot_json, '$.detail.activity.requiredWeight') AS "requiredWeight",
        runs.started_at AS "startedAt", runs.run_id AS "runId"
        FROM magi_run_audiences AS audience
        INNER JOIN magi_runs AS runs ON runs.run_id = audience.run_id
        LEFT JOIN orchestration_v2_projection_threads AS owners
          ON owners.thread_id = runs.root_thread_id
        WHERE audience.thread_id = ${input.rootThreadId}
          AND (${cursor} = '' OR (runs.started_at || '|' || runs.run_id) < ${cursor})
        ORDER BY runs.started_at DESC, runs.run_id DESC LIMIT ${input.limit + 1}
      `;
      const active = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM magi_run_audiences AS audience
        INNER JOIN magi_runs AS runs ON runs.run_id = audience.run_id
        WHERE audience.thread_id = ${input.rootThreadId}
          AND runs.state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
      `;
      const runs = yield* Effect.forEach(rows.slice(0, input.limit), (row) =>
        parseJson("ProjectionMagi.listRuns.json", row.summary).pipe(
          Effect.flatMap((value) =>
            decodeSummary(
              Object.assign(
                {},
                value,
                row.tokenCount === null ? {} : { tokenCount: row.tokenCount },
                row.requiredWeight === null ? {} : { requiredWeight: row.requiredWeight },
              ),
            ).pipe(Effect.mapError(toPersistenceDecodeError("ProjectionMagi.listRuns.decode"))),
          ),
        ),
      );
      const last = rows[input.limit - 1];
      return {
        runs,
        nextCursor: rows.length > input.limit && last ? `${last.startedAt}|${last.runId}` : null,
        activeRunCount: active[0]?.count ?? 0,
      } satisfies MagiListRunsResult;
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PersistenceDecodeError"
          ? error
          : toPersistenceSqlError("ProjectionMagi.listRuns.query")(error),
      ),
    );
  };

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
            DELETE FROM magi_run_audiences WHERE run_id IN (
              SELECT run_id FROM magi_runs WHERE root_thread_id = ${ownerThreadId}
            )
          `;
          yield* sql`
            DELETE FROM magi_run_participants WHERE run_id IN (
              SELECT run_id FROM magi_runs WHERE root_thread_id = ${ownerThreadId}
            )
          `;
          yield* sql`DELETE FROM magi_arms WHERE thread_id = ${ownerThreadId}`;
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
    putArm,
    getArm,
    setArmAttachment,
    deleteArm,
    getArmRevision,
    putRun,
    getRun,
    findActiveRun,
    findRunByInitiatingReferenceId,
    listRunsByOwner,
    listRecoverableRuns,
    listRuns,
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

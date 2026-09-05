import {
  MagiArmThreadResult,
  MagiListRunsResult,
  MagiRunDetail,
  MagiRunId,
  MagiRunSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  PersistedMagiRun,
  ProjectionMagiRepository,
  RECOVERABLE_MAGI_STATES,
  type ProjectionMagiRepositoryShape,
} from "../Services/ProjectionMagi.ts";

const ArmRow = Schema.Struct({
  armId: Schema.String,
  threadId: Schema.String,
  revision: Schema.Number,
  config: Schema.String,
  armedAt: Schema.String,
});
const RunRow = Schema.Struct({ snapshot: Schema.String });

const decodeArm = Schema.decodeUnknownEffect(MagiArmThreadResult);
const decodeRun = Schema.decodeUnknownEffect(PersistedMagiRun);
const decodeSummary = Schema.decodeUnknownEffect(MagiRunSummary);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface ProjectionProtocol {
  readonly members?: ReadonlyArray<{
    readonly participant: MagiRunDetail["config"]["participants"][number];
    readonly personality: MagiRunDetail["participants"][number]["personality"];
    readonly threadId: ThreadId;
    readonly state: string;
  }>;
  readonly turns?: ReadonlyArray<{
    readonly magiTurn: number;
    readonly candidate: MagiRunDetail["candidate"];
    readonly settlements: MagiRunDetail["settlements"];
    readonly arbitration: unknown;
  }>;
  readonly proposals?: ReadonlyArray<{
    readonly proposalId: string;
    readonly proposal: unknown;
    readonly originParticipantIds: ReadonlyArray<string>;
    readonly firstMagiTurn: number;
  }>;
  readonly decisionSets?: ReadonlyArray<{
    readonly decisionSetId: string;
    readonly proposalIds: ReadonlyArray<string>;
    readonly rationale: string;
    readonly firstMagiTurn: number;
  }>;
  readonly pendingBatch?: null | {
    readonly batchId: string;
    readonly magiTurn: number;
    readonly actions: ReadonlyArray<{ readonly actionId: string; readonly status?: string }>;
  };
  readonly reconciliations?: ReadonlyArray<{
    readonly reconciliationId: string;
    readonly batchId: string;
    readonly actions: ReadonlyArray<unknown>;
    readonly recordedAt: string;
  }>;
}

const parseJson = (operation: string, value: string) =>
  decodeUnknownJsonString(value).pipe(Effect.mapError(toPersistenceDecodeError(operation)));

const makeProjectionMagiRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const refreshActiveSummary = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const activeRuns = yield* sql<{
        readonly runId: string;
        readonly source: MagiRunSummary["source"];
        readonly state: MagiRunSummary["state"];
        readonly completedMagiTurns: number;
      }>`
        SELECT
          runs.run_id AS "runId",
          runs.source,
          runs.state,
          runs.completed_magi_turns AS "completedMagiTurns"
        FROM projection_magi_runs AS runs
        WHERE runs.state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
          AND runs.root_thread_id = ${threadId}
        ORDER BY runs.started_at DESC, runs.run_id DESC
      `;
      const current = activeRuns[0];
      const activeSummary = current ?? null;
      yield* sql`
        UPDATE projection_threads
        SET active_magi_run_json = ${
          activeSummary === null ? null : encodeUnknownJson(activeSummary)
        }
        WHERE thread_id = ${threadId}
      `;
    });

  const putArm: ProjectionMagiRepositoryShape["putArm"] = (arm) =>
    sql`
      INSERT INTO projection_magi_arms (thread_id, arm_id, revision, config_json, armed_at)
      VALUES (${arm.threadId}, ${arm.armId}, ${arm.revision}, ${JSON.stringify(arm.config)}, ${arm.armedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        arm_id = excluded.arm_id,
        revision = excluded.revision,
        config_json = excluded.config_json,
        armed_at = excluded.armed_at
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionMagi.putArm")));

  const getArmRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ArmRow,
    execute: ({ threadId }) => sql`
      SELECT arm_id AS "armId", thread_id AS "threadId", revision, config_json AS config,
             armed_at AS "armedAt"
      FROM projection_magi_arms WHERE thread_id = ${threadId}
    `,
  });
  const getArm: ProjectionMagiRepositoryShape["getArm"] = (threadId) =>
    getArmRows({ threadId }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getArm.query")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(Option.none());
        return parseJson("ProjectionMagi.getArm.json", row.config).pipe(
          Effect.flatMap((config) =>
            decodeArm({ ...row, config }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectionMagi.getArm.decode")),
            ),
          ),
          Effect.map(Option.some),
        );
      }),
    );

  const deleteArm: ProjectionMagiRepositoryShape["deleteArm"] = (threadId) =>
    sql`DELETE FROM projection_magi_arms WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.deleteArm")),
    );

  const putRun: ProjectionMagiRepositoryShape["putRun"] = (run) => {
    const { detail } = run;
    const { summary } = detail;
    const protocol = run.protocol as ProjectionProtocol;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const roots = yield* sql<{ readonly deletedAt: string | null }>`
            SELECT deleted_at AS "deletedAt" FROM projection_threads
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
      INSERT INTO projection_magi_runs (
        run_id, root_thread_id, source, state, title_json, objective,
        initiating_reference_id, initiating_instruction, focused_objective,
        main_turn_id, main_message_id, config_json, snapshot_json,
        completed_magi_turns, started_at, completed_at, updated_at
      ) VALUES (
        ${summary.runId}, ${summary.rootThreadId}, ${summary.source}, ${summary.state},
        ${encodeUnknownJson(summary.title)}, ${summary.objective}, ${run.initiatingReferenceId},
        ${run.initiatingInstruction}, ${run.focusedObjective}, ${run.mainTurnId}, ${run.mainMessageId},
        ${encodeUnknownJson(detail.config)},
        ${encodeUnknownJson(run)}, ${summary.completedMagiTurns}, ${summary.startedAt},
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
          // Members provide the only live reverse lookup that is not served by
          // snapshot_json. Replace that index exactly so removed child threads
          // cannot survive a replacement snapshot. The other legacy side tables
          // remain migration-compatible but are no longer rewritten.
          yield* sql`DELETE FROM projection_magi_members WHERE run_id = ${summary.runId}`;
          yield* Effect.forEach(
            protocol.members ?? [],
            (member) => sql`
        INSERT OR REPLACE INTO projection_magi_members
          (run_id, participant_id, child_thread_id, state, member_json, updated_at)
        VALUES (
          ${summary.runId}, ${member.participant.participantId}, ${member.threadId}, ${member.state},
          ${encodeUnknownJson(member)}, ${run.updatedAt}
        )
            `,
            { discard: true },
          );
          yield* refreshActiveSummary(summary.rootThreadId);
        }),
      )
      .pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionMagi.putRun")));
  };

  const decodeRunRow = (operation: string, row: typeof RunRow.Type) =>
    parseJson(`${operation}.json`, row.snapshot).pipe(
      Effect.flatMap((value) =>
        decodeRun(value).pipe(Effect.mapError(toPersistenceDecodeError(`${operation}.decode`))),
      ),
    );

  const getRunRows = SqlSchema.findAll({
    Request: Schema.Struct({ runId: MagiRunId }),
    Result: RunRow,
    execute: ({ runId }) =>
      sql`SELECT snapshot_json AS snapshot FROM projection_magi_runs WHERE run_id = ${runId}`,
  });
  const getRun: ProjectionMagiRepositoryShape["getRun"] = (runId) =>
    getRunRows({ runId }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.getRun.query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? decodeRunRow("ProjectionMagi.getRun", rows[0]).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const findActiveRows = SqlSchema.findAll({
    Request: Schema.Struct({ rootThreadId: ThreadId }),
    Result: RunRow,
    execute: ({ rootThreadId }) => sql`
      SELECT snapshot_json AS snapshot FROM projection_magi_runs
      WHERE root_thread_id = ${rootThreadId}
        AND state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `,
  });
  const findActiveRun: ProjectionMagiRepositoryShape["findActiveRun"] = (rootThreadId) =>
    findActiveRows({ rootThreadId }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.findActiveRun.query")),
      Effect.flatMap((rows) =>
        rows[0]
          ? decodeRunRow("ProjectionMagi.findActiveRun", rows[0]).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );

  const findByReferenceRows = SqlSchema.findAll({
    Request: Schema.Struct({ initiatingReferenceId: Schema.String }),
    Result: RunRow,
    execute: ({ initiatingReferenceId }) => sql`
      SELECT snapshot_json AS snapshot FROM projection_magi_runs
      WHERE initiating_reference_id = ${initiatingReferenceId}
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `,
  });
  const findRunByInitiatingReferenceId: ProjectionMagiRepositoryShape["findRunByInitiatingReferenceId"] =
    (initiatingReferenceId) =>
      findByReferenceRows({ initiatingReferenceId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionMagi.findRunByInitiatingReferenceId.query"),
        ),
        Effect.flatMap((rows) =>
          rows[0]
            ? decodeRunRow("ProjectionMagi.findRunByInitiatingReferenceId", rows[0]).pipe(
                Effect.map(Option.some),
              )
            : Effect.succeed(Option.none()),
        ),
      );

  const findByParticipantThreadRows = SqlSchema.findAll({
    Request: Schema.Struct({ participantThreadId: ThreadId }),
    Result: RunRow,
    execute: ({ participantThreadId }) => sql`
      SELECT runs.snapshot_json AS snapshot
      FROM projection_magi_members AS members
      INNER JOIN projection_magi_runs AS runs ON runs.run_id = members.run_id
      WHERE members.child_thread_id = ${participantThreadId}
      ORDER BY runs.started_at DESC, runs.run_id DESC LIMIT 1
    `,
  });
  const findRunByParticipantThreadId: ProjectionMagiRepositoryShape["findRunByParticipantThreadId"] =
    (participantThreadId) =>
      findByParticipantThreadRows({ participantThreadId }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionMagi.findRunByParticipantThreadId.query")),
        Effect.flatMap((rows) =>
          rows[0]
            ? decodeRunRow("ProjectionMagi.findRunByParticipantThreadId", rows[0]).pipe(
                Effect.map(Option.some),
              )
            : Effect.succeed(Option.none()),
        ),
      );

  const recoverableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunRow,
    execute: () => sql`
      SELECT snapshot_json AS snapshot FROM projection_magi_runs
      WHERE state IN ${sql.in(RECOVERABLE_MAGI_STATES)}
         OR json_extract(snapshot_json, '$.protocol.cleanupPending') = 1
      ORDER BY updated_at ASC, run_id ASC
    `,
  });
  const listRecoverableRuns: ProjectionMagiRepositoryShape["listRecoverableRuns"] = () =>
    recoverableRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRecoverableRuns.query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRunRow("ProjectionMagi.listRecoverableRuns", row)),
      ),
    );

  const listRuns: ProjectionMagiRepositoryShape["listRuns"] = (input) => {
    const cursor = input.cursor ?? "";
    return sql<{ readonly summary: string; readonly startedAt: string; readonly runId: string }>`
      SELECT json_object(
        'runId', run_id, 'rootThreadId', root_thread_id, 'source', source,
        'title', json(title_json), 'state', state, 'objective', objective,
        'completedMagiTurns', completed_magi_turns,
        'participantCount', json_array_length(json_extract(snapshot_json, '$.detail.config.participants')),
        'magiTurnLimit', json_extract(snapshot_json, '$.detail.config.magiTurnLimit'),
        'agreedVoteCount', CASE
          WHEN state IN ('succeeded', 'turn-limit-reached', 'failed') THEN (
            SELECT count(*)
            FROM json_each(projection_magi_runs.snapshot_json, '$.protocol.turns[#-1].arbitration.assessments')
            WHERE json_extract(value, '$.stance') = 'supports'
          )
          ELSE NULL
        END,
        'totalVoteCount', CASE
          WHEN state IN ('succeeded', 'turn-limit-reached', 'failed') THEN (
            SELECT count(*)
            FROM json_each(projection_magi_runs.snapshot_json, '$.protocol.turns[#-1].arbitration.assessments')
          )
          ELSE NULL
        END,
        'tokenCount', COALESCE((
          SELECT sum(
            COALESCE(json_extract(value, '$.inputTokens'), 0) +
            COALESCE(json_extract(value, '$.outputTokens'), 0)
          )
          FROM json_each(projection_magi_runs.snapshot_json, '$.detail.settlements')
        ), 0),
        'startedAt', started_at, 'updatedAt', updated_at, 'completedAt', completed_at
      ) AS summary, started_at AS "startedAt", run_id AS "runId"
      FROM projection_magi_runs
      WHERE root_thread_id = ${input.rootThreadId}
        AND (${cursor} = '' OR (started_at || '|' || run_id) < ${cursor})
      ORDER BY started_at DESC, run_id DESC LIMIT ${input.limit + 1}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.listRuns.query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows.slice(0, input.limit), (row) =>
          parseJson("ProjectionMagi.listRuns.json", row.summary).pipe(
            Effect.flatMap((value) =>
              decodeSummary(value).pipe(
                Effect.mapError(toPersistenceDecodeError("ProjectionMagi.listRuns.decode")),
              ),
            ),
          ),
        ).pipe(
          Effect.map(
            (runs) =>
              ({
                runs,
                nextCursor:
                  rows.length > input.limit
                    ? `${rows[input.limit - 1]?.startedAt}|${rows[input.limit - 1]?.runId}`
                    : null,
              }) satisfies MagiListRunsResult,
          ),
        ),
      ),
    );
  };

  const setActiveSummary: ProjectionMagiRepositoryShape["setActiveSummary"] = (threadId) =>
    refreshActiveSummary(threadId).pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionMagi.setActiveSummary")),
    );

  const deleteByOwnerThreadId: ProjectionMagiRepositoryShape["deleteByOwnerThreadId"] = (
    ownerThreadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const runIds = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId" FROM projection_magi_runs WHERE root_thread_id = ${ownerThreadId}
      `;
          for (const { runId } of runIds) {
            yield* sql`DELETE FROM projection_magi_members WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_responses WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_proposal_evaluations WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_exclusive_set_evaluations WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_turns WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_proposals WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_exclusive_decision_sets WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_action_reconciliations WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_actions WHERE run_id = ${runId}`;
            yield* sql`DELETE FROM projection_magi_action_batches WHERE run_id = ${runId}`;
          }
          yield* sql`DELETE FROM projection_magi_arms WHERE thread_id = ${ownerThreadId}`;
          yield* sql`DELETE FROM projection_magi_runs WHERE root_thread_id = ${ownerThreadId}`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProjectionMagi.deleteByOwnerThreadId")),
      );

  return {
    putArm,
    getArm,
    deleteArm,
    putRun,
    getRun,
    findActiveRun,
    findRunByInitiatingReferenceId,
    findRunByParticipantThreadId,
    listRecoverableRuns,
    listRuns,
    setActiveSummary,
    deleteByOwnerThreadId,
  } satisfies ProjectionMagiRepositoryShape;
});

export const ProjectionMagiRepositoryLive = Layer.effect(
  ProjectionMagiRepository,
  makeProjectionMagiRepository,
);

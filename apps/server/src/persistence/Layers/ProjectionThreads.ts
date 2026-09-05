import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { ActiveMagiRunSummary, ModelSelection, ThreadLinkedPullRequest } from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    activeMagiRun: Schema.optional(Schema.NullOr(Schema.fromJsonString(ActiveMagiRunSummary))),
    linkedPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          parent_kind,
          root_thread_id,
          parent_thread_id,
          parent_turn_id,
          parent_item_id,
          parent_activity_sequence,
          provider_thread_id,
          title_seed,
          subagent_depth,
          subagent_started_at,
          subagent_completed_at,
          subagent_status,
          magi_run_id,
          magi_participant_id,
          active_magi_run_json,
          linked_pull_request_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          title_regeneration_request_id,
          title_regeneration_started_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.parentKind},
          ${row.rootThreadId},
          ${row.parentThreadId},
          ${row.parentTurnId},
          ${row.parentItemId},
          ${row.parentActivitySequence},
          ${row.providerThreadId},
          ${row.titleSeed},
          ${row.subagentDepth},
          ${row.subagentStartedAt},
          ${row.subagentCompletedAt},
          ${row.subagentStatus},
          ${row.magiRunId ?? null},
          ${row.magiParticipantId ?? null},
          ${row.activeMagiRun == null ? null : JSON.stringify(row.activeMagiRun)},
          ${row.linkedPullRequest == null ? null : JSON.stringify(row.linkedPullRequest)},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.unsettledAt ?? null},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.pinnedAt},
          ${row.pinOrderKey ?? null},
          ${row.titleRegenerationRequestId ?? null},
          ${row.titleRegenerationStartedAt ?? null},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          parent_kind = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.parent_kind
            ELSE excluded.parent_kind
          END,
          root_thread_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.root_thread_id
            ELSE excluded.root_thread_id
          END,
          parent_thread_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.parent_thread_id
            ELSE excluded.parent_thread_id
          END,
          parent_turn_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.parent_turn_id
            ELSE excluded.parent_turn_id
          END,
          parent_item_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.parent_item_id
            ELSE excluded.parent_item_id
          END,
          parent_activity_sequence = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.parent_activity_sequence
            ELSE excluded.parent_activity_sequence
          END,
          provider_thread_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.provider_thread_id
            ELSE excluded.provider_thread_id
          END,
          title_seed = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.title_seed
            ELSE excluded.title_seed
          END,
          subagent_depth = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.subagent_depth
            ELSE excluded.subagent_depth
          END,
          subagent_started_at = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.subagent_started_at
            ELSE excluded.subagent_started_at
          END,
          subagent_completed_at = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.subagent_completed_at
            ELSE excluded.subagent_completed_at
          END,
          subagent_status = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.subagent_status
            ELSE excluded.subagent_status
          END,
          magi_run_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.magi_run_id
            ELSE excluded.magi_run_id
          END,
          magi_participant_id = CASE
            WHEN projection_threads.parent_kind != 'root' AND excluded.parent_kind = 'root'
              THEN projection_threads.magi_participant_id
            ELSE excluded.magi_participant_id
          END,
          active_magi_run_json = excluded.active_magi_run_json,
          linked_pull_request_json = excluded.linked_pull_request_json,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          unsettled_at = excluded.unsettled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          pinned_at = excluded.pinned_at,
          pin_order_key = excluded.pin_order_key,
          title_regeneration_request_id = excluded.title_regeneration_request_id,
          title_regeneration_started_at = excluded.title_regeneration_started_at,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          COALESCE(parent_kind, 'root') AS "parentKind",
          COALESCE(NULLIF(TRIM(root_thread_id), ''), thread_id) AS "rootThreadId",
          parent_thread_id AS "parentThreadId",
          parent_turn_id AS "parentTurnId",
          parent_item_id AS "parentItemId",
          COALESCE(parent_activity_sequence, 0) AS "parentActivitySequence",
          provider_thread_id AS "providerThreadId",
          title_seed AS "titleSeed",
          COALESCE(subagent_depth, 0) AS "subagentDepth",
          subagent_started_at AS "subagentStartedAt",
          subagent_completed_at AS "subagentCompletedAt",
          subagent_status AS "subagentStatus",
          magi_run_id AS "magiRunId",
          magi_participant_id AS "magiParticipantId",
          active_magi_run_json AS "activeMagiRun",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          COALESCE(parent_kind, 'root') AS "parentKind",
          COALESCE(NULLIF(TRIM(root_thread_id), ''), thread_id) AS "rootThreadId",
          parent_thread_id AS "parentThreadId",
          parent_turn_id AS "parentTurnId",
          parent_item_id AS "parentItemId",
          COALESCE(parent_activity_sequence, 0) AS "parentActivitySequence",
          provider_thread_id AS "providerThreadId",
          title_seed AS "titleSeed",
          COALESCE(subagent_depth, 0) AS "subagentDepth",
          subagent_started_at AS "subagentStartedAt",
          subagent_completed_at AS "subagentCompletedAt",
          subagent_status AS "subagentStatus",
          magi_run_id AS "magiRunId",
          magi_participant_id AS "magiParticipantId",
          active_magi_run_json AS "activeMagiRun",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);

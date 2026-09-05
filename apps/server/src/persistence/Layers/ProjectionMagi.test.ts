import { assert, it } from "@effect/vitest";
import {
  MagiParticipantId,
  MagiRunId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type MagiRunConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionMagiRepositoryLive } from "./ProjectionMagi.ts";
import { ProjectionMagiRepository, type PersistedMagiRun } from "../Services/ProjectionMagi.ts";

const layer = it.layer(
  ProjectionMagiRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const decodeActiveRunId = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ runId: MagiRunId })),
);

const rootThreadId = ThreadId.make("root-magi-round-trip");
const runId = MagiRunId.make("run-magi-round-trip");
const config: MagiRunConfig = {
  participants: [
    {
      participantId: MagiParticipantId.make("participant-one"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoning", value: "high" }],
      },
      personalityId: null,
      weight: 2,
    },
    {
      participantId: MagiParticipantId.make("participant-two"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-4-6",
      },
      personalityId: null,
      weight: 1,
    },
  ],
  consensusThresholdPercent: 67,
  magiTurnLimit: 2,
};

const persistedRun: PersistedMagiRun = {
  detail: {
    summary: {
      runId,
      rootThreadId,
      source: "agent-tool",
      title: { state: "generated", title: "Magi persistence round trip" },
      state: "awaiting-arbitration",
      objective: "Prove the durable projection round-trips.",
      completedMagiTurns: 0,
      startedAt: "2026-08-21T03:00:00.000Z",
      completedAt: null,
    },
    config,
    totalWeight: 3,
    requiredWeight: 3,
    activity: {
      runId,
      source: "agent-tool",
      state: "awaiting-arbitration",
      completedMagiTurns: 0,
      magiTurnLimit: 2,
      totalWeight: 3,
      leadingAgreementWeight: null,
      leadingAgreementLabel: null,
      requiredWeight: 3,
    },
    participants: config.participants.map((participant, index) => ({
      participantId: participant.participantId,
      modelSelection: participant.modelSelection,
      personality: null,
      weight: participant.weight,
      state: "pending" as const,
      childThreadId: ThreadId.make(`participant-thread-${index + 1}`),
    })),
    settlements: [],
    candidate: null,
    actions: [],
    issuedActionBatch: null,
  },
  initiatingReferenceId: "provider-call-1:root-turn-1",
  initiatingInstruction: "Use Magi to evaluate the persistence design.",
  focusedObjective: "Prove the durable projection round-trips.",
  arbitratorPrompt: "Arbitrate impartially.",
  participantTimeoutMinutes: 20,
  protocol: {
    members: config.participants.map((participant, index) => ({
      participant,
      personality: null,
      threadId: ThreadId.make(`participant-thread-${index + 1}`),
      state: "pending",
    })),
    turns: [],
    appliedDecisions: [],
    unresolvedDisagreements: [],
    proposals: [],
    decisionSets: [],
    actions: [],
    reconciliations: [],
    stateBeforePause: null,
    pendingBatch: null,
  },
  updatedAt: "2026-08-21T03:00:01.000Z",
  mainTurnId: null,
  mainMessageId: null,
};

layer("ProjectionMagiRepository", (it) => {
  it.effect("round-trips a run and its indexed recovery queries", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          ${rootThreadId}, 'project-magi-round-trip', 'Magi root', NULL,
          '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z'
        )
      `;
      yield* repository.putRun(persistedRun);

      assert.deepStrictEqual(Option.getOrNull(yield* repository.getRun(runId)), persistedRun);
      assert.strictEqual(
        Option.getOrNull(yield* repository.findActiveRun(rootThreadId))?.detail.summary.runId,
        runId,
      );
      assert.strictEqual(
        Option.getOrNull(
          yield* repository.findRunByInitiatingReferenceId("provider-call-1:root-turn-1"),
        )?.detail.summary.runId,
        runId,
      );
      assert.strictEqual(
        Option.getOrNull(
          yield* repository.findRunByParticipantThreadId(
            persistedRun.detail.participants[0]!.childThreadId!,
          ),
        )?.detail.summary.runId,
        runId,
      );
      const history = yield* repository.listRuns({ rootThreadId, limit: 10 });
      assert.deepStrictEqual(history.runs, [
        {
          ...persistedRun.detail.summary,
          participantCount: 2,
          magiTurnLimit: 2,
          agreedVoteCount: null,
          totalVoteCount: null,
          tokenCount: 0,
          updatedAt: persistedRun.updatedAt,
        },
      ]);
      assert.strictEqual(history.nextCursor, null);
      assert.strictEqual((yield* repository.listRecoverableRuns()).length, 1);

      const activeRows = yield* sql<{ readonly active: string | null }>`
        SELECT active_magi_run_json AS active FROM projection_threads
        WHERE thread_id = ${rootThreadId}
      `;
      const activeSummary = yield* decodeActiveRunId(activeRows[0]!.active!);
      assert.strictEqual(activeSummary.runId, runId);

      const removedParticipantThreadId = persistedRun.detail.participants[1]!.childThreadId!;
      yield* repository.putRun({
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          participants: persistedRun.detail.participants.slice(0, 1),
        },
        protocol: {
          ...(persistedRun.protocol as Record<string, unknown>),
          members: (
            persistedRun.protocol as { readonly members: ReadonlyArray<unknown> }
          ).members.slice(0, 1),
        },
      });
      assert.isTrue(
        Option.isNone(yield* repository.findRunByParticipantThreadId(removedParticipantThreadId)),
      );

      yield* repository.putRun({
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          summary: {
            ...persistedRun.detail.summary,
            state: "succeeded",
            completedAt: "2026-08-21T03:01:00.000Z",
          },
          activity: { ...persistedRun.detail.activity, state: "succeeded" },
        },
      });
      const terminalRows = yield* sql<{ readonly active: string | null }>`
        SELECT active_magi_run_json AS active FROM projection_threads
        WHERE thread_id = ${rootThreadId}
      `;
      assert.strictEqual(terminalRows[0]!.active, null);
      assert.strictEqual((yield* repository.listRecoverableRuns()).length, 0);

      const terminalRun = Option.getOrThrow(yield* repository.getRun(runId));
      yield* repository.putRun({
        ...terminalRun,
        protocol: {
          ...(terminalRun.protocol as Record<string, unknown>),
          cleanupPending: true,
        },
      });
      assert.strictEqual((yield* repository.listRecoverableRuns()).length, 1);
    }),
  );

  it.effect("summarizes final participant agreement for terminal runs", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const sql = yield* SqlClient.SqlClient;
      const terminalRootThreadId = ThreadId.make("root-magi-terminal-summary");
      const terminalRunId = MagiRunId.make("run-magi-terminal-summary");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          ${terminalRootThreadId}, 'project-magi-terminal', 'Magi terminal root', NULL,
          '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z'
        )
      `;
      const terminalRun: PersistedMagiRun = {
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          summary: {
            ...persistedRun.detail.summary,
            runId: terminalRunId,
            rootThreadId: terminalRootThreadId,
            state: "succeeded",
            completedMagiTurns: 1,
            completedAt: "2026-08-21T03:01:00.000Z",
          },
          activity: {
            ...persistedRun.detail.activity,
            runId: terminalRunId,
            state: "succeeded",
            completedMagiTurns: 1,
          },
          settlements: [
            {
              participantId: config.participants[0]!.participantId,
              participantThreadId: ThreadId.make("participant-thread-1"),
              participantTurnId: TurnId.make("participant-turn-1"),
              rawText: "Approve.",
              parsed: null,
              parseMode: "raw",
              state: "settled",
              durationMs: 1,
              inputTokens: 219_000,
              outputTokens: 561,
              retryCount: 0,
              providerAttempts: 1,
              structuralRepairCount: 0,
              reconstructed: false,
              failureClass: null,
              contextCompressed: false,
            },
          ],
        },
        protocol: {
          ...(persistedRun.protocol as Record<string, unknown>),
          turns: [
            {
              magiTurn: 1,
              candidate: null,
              settlements: [],
              arbitration: {
                assessments: [
                  { stance: "supports" },
                  { stance: "supports" },
                  { stance: "opposes" },
                ],
              },
            },
          ],
        },
        initiatingReferenceId: "provider-call-terminal-summary",
        updatedAt: "2026-08-21T03:01:00.000Z",
      };

      yield* repository.putRun(terminalRun);
      const history = yield* repository.listRuns({ rootThreadId: terminalRootThreadId, limit: 10 });

      assert.strictEqual(history.runs[0]?.agreedVoteCount, 2);
      assert.strictEqual(history.runs[0]?.totalVoteCount, 3);
      assert.strictEqual(history.runs[0]?.tokenCount, 219_561);
    }),
  );

  it.effect("keeps active Magi summaries scoped to their exact conversation", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const sql = yield* SqlClient.SqlClient;
      const visibleRootThreadId = ThreadId.make("root-magi-active-aggregate");
      const nestedRootThreadId = ThreadId.make("nested-magi-active-aggregate");
      const outerRunId = MagiRunId.make("run-magi-active-outer");
      const nestedRunId = MagiRunId.make("run-magi-active-nested");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          ${visibleRootThreadId}, 'project-magi-active', 'Visible root', NULL,
          '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, magi_root_thread_id,
          created_at, updated_at
        ) VALUES (
          ${nestedRootThreadId}, 'project-magi-active', 'Nested root', NULL,
          ${visibleRootThreadId},
          '2026-08-21T03:00:01.000Z', '2026-08-21T03:00:01.000Z'
        )
      `;
      const makeRun = (id: MagiRunId, root: ThreadId, startedAt: string): PersistedMagiRun => ({
        ...persistedRun,
        initiatingReferenceId: `reference-${id}`,
        updatedAt: startedAt,
        detail: {
          ...persistedRun.detail,
          summary: {
            ...persistedRun.detail.summary,
            runId: id,
            rootThreadId: root,
            startedAt,
          },
          activity: { ...persistedRun.detail.activity, runId: id },
        },
      });
      const outerRun = makeRun(outerRunId, visibleRootThreadId, "2026-08-21T03:00:02.000Z");
      const nestedRun = makeRun(nestedRunId, nestedRootThreadId, "2026-08-21T03:00:03.000Z");
      yield* repository.putRun(outerRun);
      yield* repository.putRun(nestedRun);

      const readActive = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly active: string }>`
          SELECT active_magi_run_json AS active FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
          return yield* decodeActiveRunId(rows[0]!.active);
        });
      assert.deepStrictEqual(yield* readActive(visibleRootThreadId), { runId: outerRunId });
      assert.deepStrictEqual(yield* readActive(nestedRootThreadId), { runId: nestedRunId });

      yield* repository.putRun({
        ...nestedRun,
        detail: {
          ...nestedRun.detail,
          summary: {
            ...nestedRun.detail.summary,
            state: "succeeded",
            completedAt: "2026-08-21T03:01:00.000Z",
          },
          activity: { ...nestedRun.detail.activity, state: "succeeded" },
        },
      });
      assert.deepStrictEqual(yield* readActive(visibleRootThreadId), { runId: outerRunId });
    }),
  );

  it.effect("round-trips and deletes an existing-root arm", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const arm = {
        armId: "arm-round-trip" as never,
        threadId: rootThreadId,
        revision: 1,
        config,
        armedAt: "2026-08-21T03:00:00.000Z",
      };
      yield* repository.putArm(arm);
      assert.deepStrictEqual(Option.getOrNull(yield* repository.getArm(rootThreadId)), arm);
      yield* repository.deleteArm(rootThreadId);
      assert.isTrue(Option.isNone(yield* repository.getArm(rootThreadId)));
    }),
  );

  it.effect("deletes every Magi record owned by one exact conversation", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const sql = yield* SqlClient.SqlClient;
      const ownerThreadId = ThreadId.make("magi-delete-owner-subagent");
      const unrelatedOwnerThreadId = ThreadId.make("magi-delete-owner-unrelated");
      const ownedRunId = MagiRunId.make("magi-delete-owned-run");
      const unrelatedRunId = MagiRunId.make("magi-delete-unrelated-run");
      const makeOwnedRun = (nextRunId: MagiRunId, nextOwnerThreadId: ThreadId) => ({
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          summary: {
            ...persistedRun.detail.summary,
            runId: nextRunId,
            rootThreadId: nextOwnerThreadId,
          },
          activity: {
            ...persistedRun.detail.activity,
            runId: nextRunId,
          },
        },
        initiatingReferenceId: `delete:${nextRunId}`,
      });

      for (const owner of [ownerThreadId, unrelatedOwnerThreadId]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, created_at, updated_at
          ) VALUES (
            ${owner}, 'project-magi-delete', ${String(owner)}, NULL,
            '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z'
          )
        `;
      }
      yield* repository.putRun(makeOwnedRun(ownedRunId, ownerThreadId));
      yield* repository.putRun(makeOwnedRun(unrelatedRunId, unrelatedOwnerThreadId));
      yield* repository.putArm({
        armId: "arm-delete-owner" as never,
        threadId: ownerThreadId,
        revision: 1,
        config,
        armedAt: "2026-08-21T03:00:00.000Z",
      });

      const participantId = config.participants[0]!.participantId;
      const seedOwnedRunRows = [
        sql`INSERT INTO projection_magi_turns
          (run_id, magi_turn, state, candidate_fingerprint, turn_json, started_at, completed_at)
          VALUES (${ownedRunId}, 1, 'completed', NULL, '{}', '2026-08-21T03:00:00.000Z', NULL)`,
        sql`INSERT INTO projection_magi_responses
          (run_id, magi_turn, participant_id, participant_thread_id, participant_turn_id,
           state, parse_mode, raw_text, response_json, metrics_json)
          VALUES (${ownedRunId}, 1, ${participantId}, 'participant-thread', 'participant-turn',
                  'completed', 'structured', 'raw', NULL, '{}')`,
        sql`INSERT INTO projection_magi_proposals
          (run_id, proposal_id, first_magi_turn, proposal_json)
          VALUES (${ownedRunId}, 'proposal-delete', 1, '{}')`,
        sql`INSERT INTO projection_magi_proposal_evaluations
          (run_id, proposal_id, magi_turn, participant_id, evaluation_json, weight_contribution)
          VALUES (${ownedRunId}, 'proposal-delete', 1, ${participantId}, '{}', 1)`,
        sql`INSERT INTO projection_magi_exclusive_decision_sets
          (run_id, decision_set_id, magi_turn, decision_json)
          VALUES (${ownedRunId}, 'decision-delete', 1, '{}')`,
        sql`INSERT INTO projection_magi_exclusive_set_evaluations
          (run_id, decision_set_id, magi_turn, participant_id, evaluation_json,
           weight_contribution)
          VALUES (${ownedRunId}, 'decision-delete', 1, ${participantId}, '{}', 1)`,
        sql`INSERT INTO projection_magi_action_batches
          (run_id, batch_id, magi_turn, state, batch_json)
          VALUES (${ownedRunId}, 'batch-delete', 1, 'issued', '{}')`,
        sql`INSERT INTO projection_magi_actions
          (run_id, batch_id, action_id, status, action_json)
          VALUES (${ownedRunId}, 'batch-delete', 'action-delete', 'completed', '{}')`,
        sql`INSERT INTO projection_magi_action_reconciliations
          (run_id, batch_id, reconciliation_id, reconciliation_json, recorded_at)
          VALUES (${ownedRunId}, 'batch-delete', 'reconciliation-delete', '{}',
                  '2026-08-21T03:00:00.000Z')`,
      ];
      yield* Effect.all(seedOwnedRunRows, { discard: true });

      yield* repository.deleteByOwnerThreadId(ownerThreadId);

      assert.isTrue(Option.isNone(yield* repository.getRun(ownedRunId)));
      assert.isTrue(Option.isNone(yield* repository.getArm(ownerThreadId)));
      assert.strictEqual(
        Option.getOrNull(yield* repository.getRun(unrelatedRunId))?.detail.summary.rootThreadId,
        unrelatedOwnerThreadId,
      );
      for (const table of [
        "projection_magi_members",
        "projection_magi_turns",
        "projection_magi_responses",
        "projection_magi_proposals",
        "projection_magi_proposal_evaluations",
        "projection_magi_exclusive_decision_sets",
        "projection_magi_exclusive_set_evaluations",
        "projection_magi_action_batches",
        "projection_magi_actions",
        "projection_magi_action_reconciliations",
      ]) {
        const rows = yield* sql.unsafe(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`, [
          ownedRunId,
        ]);
        assert.deepStrictEqual(rows, [{ count: 0 }], table);
      }
    }),
  );
});

import { assert, it } from "@effect/vitest";
import {
  ContextArtifactId,
  MagiArmId,
  MagiParticipantId,
  MagiRunId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type MagiRunConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "./Sqlite.ts";
import { ProjectionMagiRepositoryLive } from "./ProjectionMagi.ts";
import { ProjectionMagiRepository, type PersistedMagiRun } from "./ProjectionMagi.ts";

const layer = it.layer(ProjectionMagiRepositoryLive.pipe(Layer.provideMerge(Sqlite.layerMemory)));

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
  initiatingReferenceId: "provider-call-1:root-run-1",
  initiatingInstruction: "Use Magi to evaluate the persistence design.",
  focusedObjective: "Prove the durable projection round-trips.",
  arbitratorPrompt: "Arbitrate impartially.",
  protocol: {
    members: config.participants.map((participant, index) => ({
      participant,
      personality: null,
      threadId: ThreadId.make(`participant-thread-${index + 1}`),
      state: "pending",
    })),
    turns: [],
    proposals: [],
    decisionSets: [],
    actions: [],
    reconciliations: [],
    stateBeforePause: null,
    pendingBatch: null,
  },
  updatedAt: "2026-08-21T03:00:01.000Z",
  mainRunId: RunId.make("root-run-1"),
  mainMessageId: null,
  audienceThreadIds: [rootThreadId],
};

const insertThread = (threadId: ThreadId, deletedAt: string | null = null, title = "Owner") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project', ${title}, 'codex', 'full-access', 'default',
        '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z', ${deletedAt}, '{}'
      )
    `;
  });

const ownedBy = (
  owner: ThreadId,
  id: string,
  ancestors: ReadonlyArray<ThreadId> = [],
): PersistedMagiRun => ({
  ...persistedRun,
  detail: {
    ...persistedRun.detail,
    summary: { ...persistedRun.detail.summary, runId: MagiRunId.make(id), rootThreadId: owner },
  },
  audienceThreadIds: [owner, ...ancestors],
});

const artifact = (id: string) => ({
  manifest: {
    artifactId: ContextArtifactId.make(id),
    sourceActivityId: TurnItemId.make(`item-${id}`),
    sourceRunId: RunId.make("root-run-1"),
    kind: "command_execution",
    summary: id,
    byteLength: 10,
  },
  result: { output: id },
});

layer("ProjectionMagiRepository", (it) => {
  it.effect("round-trips a run and counts its owner's active runs", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      yield* insertThread(rootThreadId);
      yield* repository.putRun(persistedRun);

      assert.deepStrictEqual(Option.getOrNull(yield* repository.getRun(runId)), persistedRun);
      assert.isTrue(Option.isSome(yield* repository.findActiveRun(rootThreadId)));
      const initiatingReferenceId = "provider-call-1:root-run-1";
      assert.isTrue(
        Option.isSome(
          yield* repository.findRunByInitiatingReferenceId({ rootThreadId, initiatingReferenceId }),
        ),
      );
      // A reference only identifies runs of the conversation that started them.
      assert.isTrue(
        Option.isNone(
          yield* repository.findRunByInitiatingReferenceId({
            rootThreadId: ThreadId.make("another-owner"),
            initiatingReferenceId,
          }),
        ),
      );
      const listed = yield* repository.listRuns({ rootThreadId, limit: 10 });
      assert.strictEqual(listed.activeRunCount, 1);
      assert.strictEqual(listed.runs[0]?.participantCount, 2);
      // No settlement reported usage, so the count is unknown rather than zero.
      assert.notProperty(listed.runs[0], "tokenCount");
      assert.deepInclude(listed.runs[0], {
        leadingAgreementWeight: null,
        leadingAgreementLabel: null,
        requiredWeight: 3,
      });
      yield* repository.putRun({
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          activity: {
            ...persistedRun.detail.activity,
            leadingAgreementWeight: 2,
            leadingAgreementLabel: "Ship behind a flag.",
          },
        },
      });
      assert.deepInclude((yield* repository.listRuns({ rootThreadId, limit: 10 })).runs[0], {
        leadingAgreementWeight: 2,
        leadingAgreementLabel: "Ship behind a flag.",
        requiredWeight: 3,
      });

      yield* repository.putRun({
        ...persistedRun,
        detail: {
          ...persistedRun.detail,
          summary: { ...persistedRun.detail.summary, state: "succeeded" },
        },
      });
      assert.isTrue(Option.isNone(yield* repository.findActiveRun(rootThreadId)));
      assert.strictEqual(
        (yield* repository.listRuns({ rootThreadId, limit: 10 })).activeRunCount,
        0,
      );
    }),
  );

  it.effect("lists a descendant's runs, attributed to it, in each ancestor's history", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const root = ThreadId.make("lineage-root");
      const delegate = ThreadId.make("lineage-delegate");
      const nested = ThreadId.make("lineage-nested");
      const sibling = ThreadId.make("lineage-sibling");
      yield* insertThread(root, null, "Root");
      yield* insertThread(delegate, null, "Delegate");
      yield* insertThread(nested, null, "Nested");
      yield* insertThread(sibling, null, "Sibling");
      yield* repository.putRun(ownedBy(root, "lineage-root-run"));
      yield* repository.putRun(ownedBy(nested, "lineage-nested-run", [delegate, root]));
      yield* repository.putRun(ownedBy(sibling, "lineage-sibling-run"));

      const rootListing = yield* repository.listRuns({ rootThreadId: root, limit: 10 });
      assert.sameDeepMembers(
        rootListing.runs.map((run) => [run.runId, run.rootThreadId, run.ownerTitle]),
        [
          ["lineage-root-run", root, "Root"],
          ["lineage-nested-run", nested, "Nested"],
        ],
      );
      assert.strictEqual(rootListing.activeRunCount, 2);

      const delegateListing = yield* repository.listRuns({ rootThreadId: delegate, limit: 10 });
      assert.deepStrictEqual(
        delegateListing.runs.map((run) => run.runId),
        ["lineage-nested-run"],
      );

      yield* repository.deleteByOwnerThreadId(nested);
      const afterDelete = yield* repository.listRuns({ rootThreadId: root, limit: 10 });
      assert.deepStrictEqual(
        afterDelete.runs.map((run) => run.runId),
        ["lineage-root-run"],
      );
      assert.strictEqual(afterDelete.activeRunCount, 1);
    }),
  );

  it.effect("finds participant conversations among a lineage", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const owner = ThreadId.make("participant-lookup-owner");
      yield* insertThread(owner);
      yield* repository.putRun(ownedBy(owner, "participant-lookup-run"));

      assert.deepStrictEqual(
        yield* repository.findParticipantThreads([
          ThreadId.make("participant-thread-2"),
          ThreadId.make("ordinary-subagent"),
          owner,
        ]),
        [ThreadId.make("participant-thread-2")],
      );
      assert.deepStrictEqual(
        yield* repository.findParticipantThreads([ThreadId.make("ordinary-subagent"), owner]),
        [],
      );
    }),
  );

  it.effect.each([
    { name: "missing", deletedAt: undefined },
    { name: "deleted", deletedAt: "2026-08-21T04:00:00.000Z" },
  ])("refuses runs for a $name owner conversation", ({ name, deletedAt }) =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const owner = ThreadId.make(`${name}-owner`);
      if (deletedAt !== undefined) yield* insertThread(owner, deletedAt);
      const error = yield* repository.putRun(ownedBy(owner, `run-${name}`)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "PersistenceSqlError");
    }),
  );

  it.effect("lets each participant read only the artifacts addressed to it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const first = ThreadId.make("participant-thread-1");
      const second = ThreadId.make("participant-thread-2");
      yield* repository.putContextArtifacts({
        runId,
        artifacts: [artifact("shared")],
        participantThreadIds: [first, second],
      });
      yield* repository.putContextArtifacts({
        runId,
        artifacts: [artifact("first-only")],
        participantThreadIds: [first],
      });
      const requested = [ContextArtifactId.make("shared"), ContextArtifactId.make("first-only")];

      const firstReads = yield* repository.readContextArtifacts({
        participantThreadId: first,
        artifactIds: requested,
      });
      const secondReads = yield* repository.readContextArtifacts({
        participantThreadId: second,
        artifactIds: requested,
      });
      assert.sameDeepMembers(
        firstReads.map((read) => read.result),
        [{ output: "shared" }, { output: "first-only" }],
      );
      assert.deepStrictEqual(
        secondReads.map((read) => read.result),
        [{ output: "shared" }],
      );
    }),
  );

  it.effect("hides an arm once a message carries it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const owner = ThreadId.make("arm-owner");
      const arm = {
        armId: MagiArmId.make("arm-1"),
        threadId: owner,
        revision: 1,
        config,
        armedAt: "2026-08-21T03:00:00.000Z",
      };
      yield* repository.putArm(arm);
      assert.deepStrictEqual(Option.getOrNull(yield* repository.getArm(owner)), {
        arm,
        attachedMessageId: null,
      });

      const messageId = MessageId.make("message-1");
      yield* repository.setArmAttachment({ threadId: owner, armId: arm.armId, messageId });
      assert.strictEqual(
        Option.getOrNull(yield* repository.getArm(owner))?.attachedMessageId,
        messageId,
      );
    }),
  );

  it.effect("keeps the arm revision after the arm is cleared", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const owner = ThreadId.make("arm-revision-owner");
      const armId = MagiArmId.make("arm-revision-1");
      assert.strictEqual(yield* repository.getArmRevision(owner), 0);
      yield* repository.putArm({
        armId,
        threadId: owner,
        revision: 3,
        config,
        armedAt: "2026-08-21T03:00:00.000Z",
      });

      yield* repository.deleteArm({ threadId: owner, armId: MagiArmId.make("another-arm") });
      assert.isTrue(Option.isSome(yield* repository.getArm(owner)));

      yield* repository.deleteArm({ threadId: owner, armId });
      assert.isTrue(Option.isNone(yield* repository.getArm(owner)));
      assert.strictEqual(yield* repository.getArmRevision(owner), 3);
    }),
  );

  it.effect("deletes every Magi record of an owner conversation", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionMagiRepository;
      const owner = ThreadId.make("deleted-owner-records");
      const participant = ThreadId.make("owned-participant");
      yield* insertThread(owner);
      yield* repository.putArm({
        armId: MagiArmId.make("arm-owned"),
        threadId: owner,
        revision: 1,
        config,
        armedAt: "2026-08-21T03:00:00.000Z",
      });
      const ownedRun = ownedBy(owner, "owned-run");
      yield* repository.putRun({
        ...ownedRun,
        detail: {
          ...ownedRun.detail,
          participants: ownedRun.detail.participants.map((item) => ({
            ...item,
            childThreadId: participant,
          })),
        },
      });
      assert.deepStrictEqual(yield* repository.findParticipantThreads([participant]), [
        participant,
      ]);
      yield* repository.putContextArtifacts({
        runId: MagiRunId.make("owned-run"),
        artifacts: [artifact("owned-artifact")],
        participantThreadIds: [participant],
      });

      yield* repository.deleteByOwnerThreadId(owner);

      assert.isTrue(Option.isNone(yield* repository.getArm(owner)));
      assert.isTrue(Option.isNone(yield* repository.getRun(MagiRunId.make("owned-run"))));
      assert.deepStrictEqual(yield* repository.findParticipantThreads([participant]), []);
      assert.lengthOf(
        yield* repository.readContextArtifacts({
          participantThreadId: participant,
          artifactIds: [ContextArtifactId.make("owned-artifact")],
        }),
        0,
      );
    }),
  );
});

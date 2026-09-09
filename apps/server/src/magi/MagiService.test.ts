import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MagiParticipantId,
  MagiRunId,
  ProviderInstanceId,
  ThreadId,
  type MagiGetOptionsResult,
  type MagiRecoverRunContextResult,
  type MagiRunConfig,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionMagiRepository,
  type PersistedMagiRun,
  type ProjectionMagiRepositoryShape,
} from "../persistence/Services/ProjectionMagi.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  awaitMagiParticipantTurnTerminal,
  isDeletedRootMagiPersistenceError,
  makeMagiOperationLock,
  makeMagiService,
  magiParticipantTurnIdempotencyKey,
  makeMagiOptionCatalogue,
  MAGI_PARTICIPANT_TURN_CONCURRENCY,
  pendingMagiComparableOutcomes,
  recoverInterruptedMagiState,
  recoverMagiRunContextContinuation,
  recoverMagiProviderEvent,
  resolveMagiProviderEventTransition,
  resolveMagiPromptCapacity,
  runMagiTerminalCleanup,
  runMagiInitializationCompensation,
  shouldPersistMagiDeliberationContext,
} from "./MagiService.ts";

it("carries the last arbitrated weighted agreement into an awaiting-arbitration turn", () => {
  expect(
    pendingMagiComparableOutcomes({
      leadingAgreementLabel: "Keep the candidate",
      leadingAgreementWeight: 7,
    }),
  ).toEqual([{ label: "Keep the candidate", weight: 7 }]);
  expect(
    pendingMagiComparableOutcomes({
      leadingAgreementLabel: null,
      leadingAgreementWeight: null,
    }),
  ).toEqual([]);
});

const availabilityConfig: MagiRunConfig = {
  participants: ["available", "unavailable"].map((id) => ({
    participantId: MagiParticipantId.make(id),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: id === "available" ? "gpt" : "missing",
    },
    personalityId: null,
    weight: 1,
  })),
  consensusThresholdPercent: 100,
  magiTurnLimit: 1,
};
const availabilityOptions: MagiGetOptionsResult["providerInstances"] = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    models: ["gpt"],
    modelOptions: [],
    magi: {
      instructions: "prompt-envelope",
      structuredOutput: "native",
      readOnly: "prompt-only",
      controlTools: "mcp-tools",
      webSearch: "native",
      historyCompaction: "explicit-native",
    },
    available: true,
    unavailableReason: null,
  },
];

const unavailableRunId = MagiRunId.make("unavailable-run");
const unavailableRootThreadId = ThreadId.make("root-thread");

const unavailablePersistedRun = {
  detail: {
    summary: {
      runId: unavailableRunId,
      rootThreadId: unavailableRootThreadId,
      state: "awaiting-next-turn",
    },
    config: availabilityConfig,
  },
  protocol: {},
} as unknown as PersistedMagiRun;

const makeAvailabilityService = (input: {
  readonly persistedRun?: PersistedMagiRun;
  readonly listRuns?: ProjectionMagiRepositoryShape["listRuns"];
  readonly getShellSnapshot?: () => Effect.Effect<unknown>;
  readonly persistenceCount: Ref.Ref<number>;
  readonly dispatchCount: Ref.Ref<number>;
  readonly providerTurnCount: Ref.Ref<number>;
}) => {
  let persistedRun = input.persistedRun;
  const repository = {
    putArm: () => Effect.void,
    getArm: () => Effect.succeed(Option.none()),
    deleteArm: () => Effect.void,
    putRun: (run: PersistedMagiRun) =>
      Effect.sync(() => {
        persistedRun = run;
      }).pipe(Effect.andThen(Ref.update(input.persistenceCount, (count) => count + 1))),
    getRun: () =>
      Effect.succeed(persistedRun === undefined ? Option.none() : Option.some(persistedRun)),
    findActiveRun: () => Effect.succeed(Option.none()),
    findRunByInitiatingReferenceId: () => Effect.succeed(Option.none()),
    findRunByParticipantThreadId: () => Effect.succeed(Option.none()),
    listRecoverableRuns: () => Effect.succeed([]),
    listRuns: input.listRuns ?? (() => Effect.succeed({ runs: [], nextCursor: null })),
    setActiveSummary: () => Effect.void,
    deleteByOwnerThreadId: () => Effect.void,
  } as never;
  const providers = {
    getProviders: Effect.succeed([
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        availability: "available",
        unavailableReason: null,
        models: [{ slug: "gpt" }],
      },
    ]),
  } as never;
  const providerService = {
    getCapabilities: () => Effect.succeed({ magi: availabilityOptions[0]!.magi }),
    sendTurn: () =>
      Ref.update(input.providerTurnCount, (count) => count + 1).pipe(
        Effect.andThen(Effect.die("unexpected provider turn")),
      ),
    streamEvents: Stream.empty,
  } as never;
  const orchestration = {
    dispatch: () =>
      Ref.update(input.dispatchCount, (count) => count + 1).pipe(
        Effect.andThen(Effect.succeed({ sequence: 1 })),
      ),
    streamDomainEvents: Stream.empty,
    readEvents: () => Stream.empty,
    latestSequence: Effect.succeed(0),
  } as never;
  const snapshots = {
    getThreadDetailSnapshot: () =>
      Effect.succeed(
        Option.some({
          thread: {
            id: unavailableRootThreadId,
            projectId: "project",
            latestTurn: null,
            messages: [],
            worktreePath: null,
          },
          snapshotSequence: 0,
        }),
      ),
    getShellSnapshot:
      input.getShellSnapshot ??
      (() => Effect.succeed({ projects: [{ id: "project", workspaceRoot: "E:/project" }] })),
  } as never;
  const settings = {
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
  } as never;
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  });

  return Effect.scoped(
    makeMagiService.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ProjectionMagiRepository, repository),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providers),
      Effect.provideService(ProviderService.ProviderService, providerService),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, orchestration),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
      Effect.provideService(TextGeneration.TextGeneration, {} as never),
    ),
  );
};

it.effect("keeps latest summaries owner-scoped and expands only requested panel history", () =>
  Effect.gen(function* () {
    const calls: Array<Parameters<ProjectionMagiRepositoryShape["listRuns"]>[0]> = [];
    let shellReads = 0;
    const service = yield* makeAvailabilityService({
      persistenceCount: yield* Ref.make(0),
      dispatchCount: yield* Ref.make(0),
      providerTurnCount: yield* Ref.make(0),
      listRuns: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { runs: [], nextCursor: null };
        }),
      getShellSnapshot: () =>
        Effect.sync(() => {
          shellReads++;
          return {
            threads: [
              { id: "child", parentRelation: { kind: "subagent", parentThreadId: "parent" } },
              { id: "nested", parentRelation: { kind: "subagent", parentThreadId: "child" } },
              { id: "participant", parentRelation: { kind: "magi", parentThreadId: "parent" } },
            ],
          };
        }),
    });
    const rootThreadId = ThreadId.make("parent");
    yield* service.listRuns({ rootThreadId, limit: 1 });
    expect(calls[0]?.ownerThreadIds).toEqual(["parent"]);
    expect(shellReads).toBe(0);
    yield* service.listRuns({ rootThreadId, limit: 100, includeDescendants: true });
    expect(calls[1]?.ownerThreadIds).toEqual(["parent", "child", "nested"]);
    expect(shellReads).toBe(1);
  }),
);

describe("Magi service availability preflight", () => {
  it.effect("rejects an unavailable start before persistence", () =>
    Effect.gen(function* () {
      const persistenceCount = yield* Ref.make(0);
      const dispatchCount = yield* Ref.make(0);
      const providerTurnCount = yield* Ref.make(0);
      const service = yield* makeAvailabilityService({
        persistenceCount,
        dispatchCount,
        providerTurnCount,
      });
      const error = yield* service
        .startFromTool(
          unavailableRootThreadId,
          { config: availabilityConfig, objective: "Review safely", contextActivityIds: [] },
          "tool-call",
        )
        .pipe(Effect.flip);

      expect(error.reason).toBe("unavailable-model");
      expect(error.field).toBe("participants");
      expect(yield* Ref.get(persistenceCount)).toBe(0);
      expect(yield* Ref.get(dispatchCount)).toBe(0);
      expect(yield* Ref.get(providerTurnCount)).toBe(0);
    }),
  );

  it.effect("rejects an unavailable deliberate preflight without changing the roster", () =>
    Effect.gen(function* () {
      const before = [...availabilityConfig.participants];
      const persistenceCount = yield* Ref.make(0);
      const dispatchCount = yield* Ref.make(0);
      const providerTurnCount = yield* Ref.make(0);
      const service = yield* makeAvailabilityService({
        persistedRun: unavailablePersistedRun,
        persistenceCount,
        dispatchCount,
        providerTurnCount,
      });
      const error = yield* service
        .deliberate(unavailableRootThreadId, {
          runId: unavailableRunId,
          contextActivityIds: [],
        })
        .pipe(Effect.flip);

      expect(error.reason).toBe("unavailable-model");
      expect(availabilityConfig.participants).toEqual(before);
      expect(error.message).toContain("No participant was removed");
      expect(yield* Ref.get(persistenceCount)).toBe(0);
      expect(yield* Ref.get(dispatchCount)).toBe(0);
      expect(yield* Ref.get(providerTurnCount)).toBe(0);
    }),
  );
});

it("starts every Magi participant turn without a roster concurrency limit", () => {
  expect(MAGI_PARTICIPANT_TURN_CONCURRENCY).toBe("unbounded");
});

it("reuses the logical participant-turn key for retries and separates repair", () => {
  const input = { runId: "run", magiTurn: 4, participantId: "reviewer" } as const;
  const first = magiParticipantTurnIdempotencyKey({ ...input, stage: "turn" });
  const retry = magiParticipantTurnIdempotencyKey({ ...input, stage: "turn" });
  const repair = magiParticipantTurnIdempotencyKey({ ...input, stage: "repair" });

  expect(retry).toBe(first);
  expect(repair).not.toBe(first);
});

it("returns only availability data from the Magi option catalogue", () => {
  expect(makeMagiOptionCatalogue([], [])).toEqual({
    providerInstances: [],
    personalities: [],
    bounds: {
      minimumParticipants: 2,
      maximumParticipants: 9,
      minimumWeight: 1,
      maximumWeight: 100,
      maximumContextActivityIds: 32,
    },
  });
});

it.effect("recovers one failed provider event without stopping later events", () =>
  Effect.gen(function* () {
    const handled = yield* Ref.make<Array<number>>([]);
    yield* Effect.forEach(
      [1, 2],
      (value) =>
        recoverMagiProviderEvent(
          { threadId: "thread" as never, type: "runtime.error" },
          value === 1
            ? Effect.fail("projection failed")
            : Ref.update(handled, (current) => [...current, value]),
        ),
      { discard: true },
    );

    expect(yield* Ref.get(handled)).toEqual([2]);
  }),
);

describe("Magi lifecycle recovery", () => {
  it("fails non-replayable initialization and deliberation states", () => {
    expect(recoverInterruptedMagiState("initializing", null)).toEqual({
      state: "failed",
      stateBeforePause: null,
    });
    expect(recoverInterruptedMagiState("deliberating", null)).toEqual({
      state: "failed",
      stateBeforePause: null,
    });
  });

  it("preserves a recorded resume target for main-thread pauses", () => {
    expect(recoverInterruptedMagiState("awaiting-main-input", "awaiting-arbitration")).toEqual({
      state: "paused",
      stateBeforePause: "awaiting-arbitration",
    });
    expect(recoverInterruptedMagiState("awaiting-main-approval", null)).toEqual({
      state: "paused",
      stateBeforePause: "awaiting-next-turn",
    });
  });

  it("routes both action states to recordActions without dropping the issued batch", () => {
    const issuedActionBatch: NonNullable<MagiRecoverRunContextResult["issuedActionBatch"]> = {
      batchId: "batch-recovery" as never,
      magiTurn: 7,
      actions: [
        {
          actionId: "action-recovery" as never,
          summary: "Apply the recovered action",
          relatedProposalIds: [],
          obligation: "required",
        },
      ],
    };

    for (const state of ["awaiting-actions", "awaiting-action-reconciliation"] as const) {
      const continuation = recoverMagiRunContextContinuation(state, issuedActionBatch);
      expect(continuation.nextRequiredTool).toBe("magi_record_actions");
      expect(continuation.issuedActionBatch).toBe(issuedActionBatch);
    }
  });

  it("preserves non-action recovery routing", () => {
    expect(recoverMagiRunContextContinuation("awaiting-next-turn", null)).toEqual({
      issuedActionBatch: null,
      nextRequiredTool: "magi_deliberate",
    });
    expect(recoverMagiRunContextContinuation("awaiting-arbitration", null)).toEqual({
      issuedActionBatch: null,
      nextRequiredTool: "magi_recover_turn_result",
    });
    expect(recoverMagiRunContextContinuation("succeeded", null)).toEqual({
      issuedActionBatch: null,
      nextRequiredTool: "none",
    });
  });

  it("recognizes only the deleted-root persistence precondition", () => {
    expect(
      isDeletedRootMagiPersistenceError(
        new PersistenceSqlError({
          operation: "ProjectionMagi.putRun",
          detail: "The root thread does not exist or was deleted.",
        }),
      ),
    ).toBe(true);
    expect(
      isDeletedRootMagiPersistenceError(
        new PersistenceSqlError({ operation: "ProjectionMagi.putRun", detail: "disk full" }),
      ),
    ).toBe(false);
  });
});

describe("Magi post-compaction capacity", () => {
  it.effect("reads capacity only after native compaction completes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let usageRead = false;
      const capacity = yield* resolveMagiPromptCapacity({
        usage: { usedTokens: 900, limitTokens: 1_000, measuredAt: "2026-08-24T00:00:00.000Z" },
        fullPromptTokens: 200,
        compressedPromptTokens: 50,
        historyCompaction: "explicit-native",
        compact: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(completed)),
          Effect.as(true),
        ),
        readUsage: Effect.sync(() => {
          usageRead = true;
          return { usedTokens: 100, limitTokens: 1_000, measuredAt: "2026-08-24T00:00:01.000Z" };
        }),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(usageRead).toBe(false);
      expect(capacity.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(completed, undefined);
      expect(yield* Fiber.join(capacity)).toMatchObject({
        dispatchPrompt: "full",
        contextCompressed: true,
        exceeded: false,
      });
    }),
  );

  it.effect.each(["automatic-native", "unsupported"] as const)(
    "does not issue manual compaction for %s participants",
    (historyCompaction) =>
      Effect.gen(function* () {
        let compacted = false;
        yield* resolveMagiPromptCapacity({
          usage: { usedTokens: 900, limitTokens: 1_000, measuredAt: "2026-08-24T00:00:00.000Z" },
          fullPromptTokens: 200,
          compressedPromptTokens: 50,
          historyCompaction,
          compact: Effect.sync(() => {
            compacted = true;
            return true;
          }),
          readUsage: Effect.succeed(null),
        });
        expect(compacted).toBe(false);
      }),
  );

  it.effect("suppresses dispatch when the compressed prompt still exceeds capacity", () =>
    Effect.gen(function* () {
      const compactCalls = yield* Ref.make(0);
      const outcome = yield* resolveMagiPromptCapacity({
        usage: {
          usedTokens: 900,
          limitTokens: 1_000,
          measuredAt: "2026-08-24T00:00:00.000Z",
        },
        fullPromptTokens: 200,
        compressedPromptTokens: 50,
        historyCompaction: "explicit-native",
        compact: Ref.update(compactCalls, (count) => count + 1).pipe(Effect.as(true)),
        readUsage: Effect.succeed({
          usedTokens: 960,
          limitTokens: 1_000,
          measuredAt: "2026-08-24T00:00:01.000Z",
        }),
      });

      expect(yield* Ref.get(compactCalls)).toBe(1);
      expect(outcome).toMatchObject({
        dispatchPrompt: "compressed",
        contextCompressed: true,
        exceeded: true,
      });
    }),
  );

  it.effect("dispatches the compressed prompt when post-compaction usage fits", () =>
    Effect.gen(function* () {
      const outcome = yield* resolveMagiPromptCapacity({
        usage: {
          usedTokens: 900,
          limitTokens: 1_000,
          measuredAt: "2026-08-24T00:00:00.000Z",
        },
        fullPromptTokens: 200,
        compressedPromptTokens: 50,
        historyCompaction: "explicit-native",
        compact: Effect.succeed(true),
        readUsage: Effect.succeed({
          usedTokens: 880,
          limitTokens: 1_000,
          measuredAt: "2026-08-24T00:00:01.000Z",
        }),
      });

      expect(outcome).toMatchObject({
        dispatchPrompt: "compressed",
        contextCompressed: true,
        exceeded: false,
      });
    }),
  );
});

describe("Magi lifecycle harness", () => {
  it.effect("settles a missing participant terminal event after the bounded wait", () =>
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<string>();
      const waiter = yield* awaitMagiParticipantTurnTerminal(
        terminal,
        Effect.succeed(false),
        Duration.seconds(1),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(1));

      expect(yield* Fiber.join(waiter)).toBeNull();
    }),
  );

  it.effect("keeps waiting past the watchdog while the dispatched turn is active", () =>
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<string>();
      const waiter = yield* awaitMagiParticipantTurnTerminal(
        terminal,
        Effect.succeed(true),
        Duration.seconds(1),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(2));
      expect(waiter.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(terminal, "completed");
      expect(yield* Fiber.join(waiter)).toBe("completed");
    }),
  );

  it.effect("retains terminal cleanup state across a failed stop and clears it after retry", () =>
    Effect.gen(function* () {
      const pending = yield* Ref.make(false);
      const cancellationClears = yield* Ref.make(0);
      const first = yield* runMagiTerminalCleanup({
        markPending: Ref.set(pending, true),
        stopParticipants: Effect.succeed(false),
        clearCancellation: Ref.update(cancellationClears, (count) => count + 1),
        markComplete: Ref.set(pending, false),
      });
      expect(first).toBe(false);
      expect(yield* Ref.get(pending)).toBe(true);
      expect(yield* Ref.get(cancellationClears)).toBe(0);

      const retried = yield* runMagiTerminalCleanup({
        markPending: Ref.set(pending, true),
        stopParticipants: Effect.succeed(true),
        clearCancellation: Ref.update(cancellationClears, (count) => count + 1),
        markComplete: Ref.set(pending, false),
      });
      expect(retried).toBe(true);
      expect(yield* Ref.get(pending)).toBe(false);
      expect(yield* Ref.get(cancellationClears)).toBe(1);
    }),
  );

  it("refuses stale context persistence after cancellation or terminal state", () => {
    expect(shouldPersistMagiDeliberationContext("awaiting-next-turn", false)).toBe(true);
    expect(shouldPersistMagiDeliberationContext("awaiting-next-turn", true)).toBe(false);
    expect(shouldPersistMagiDeliberationContext("cancelled", false)).toBe(false);
    expect(shouldPersistMagiDeliberationContext(null, false)).toBe(false);
  });

  it.effect("deletes planned members before terminalizing failed initialization", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<Array<string>>([]);
      const record = (step: string) => Ref.update(order, (items) => [...items, step]);
      yield* runMagiInitializationCompensation({
        deletePlannedMembers: record("delete-members"),
        persistFailedRun: record("persist-failed"),
        cleanupTerminalRun: record("cleanup-terminal"),
      });
      expect(yield* Ref.get(order)).toEqual([
        "delete-members",
        "persist-failed",
        "cleanup-terminal",
      ]);
    }),
  );

  it.effect("serializes concurrent arm and start operations for one root", () =>
    Effect.gen(function* () {
      const withRootLock = yield* makeMagiOperationLock;
      const releaseArm = yield* Deferred.make<void>();
      const order = yield* Ref.make<Array<string>>([]);
      const arm = yield* withRootLock(
        "root",
        Ref.update(order, (items) => [...items, "arm-entered"]).pipe(
          Effect.andThen(Deferred.await(releaseArm)),
          Effect.andThen(Ref.update(order, (items) => [...items, "arm-finished"])),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const start = yield* withRootLock(
        "root",
        Ref.update(order, (items) => [...items, "start-entered"]),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(yield* Ref.get(order)).toEqual(["arm-entered"]);
      yield* Deferred.succeed(releaseArm, undefined);
      yield* Fiber.join(arm);
      yield* Fiber.join(start);
      expect(yield* Ref.get(order)).toEqual(["arm-entered", "arm-finished", "start-entered"]);
    }),
  );

  it("preserves the resume target across provider approval timing", () => {
    const opened = resolveMagiProviderEventTransition({
      currentState: "deliberating",
      stateBeforePause: null,
      eventType: "request.opened",
    });
    expect(opened).toEqual({
      state: "awaiting-main-approval",
      stateBeforePause: "deliberating",
    });
    expect(
      resolveMagiProviderEventTransition({
        currentState: "awaiting-main-approval",
        stateBeforePause: opened.stateBeforePause,
        eventType: "request.resolved",
      }),
    ).toEqual({ state: "deliberating", stateBeforePause: null });
  });

  it("pauses on participant runtime failure without losing the current state", () => {
    expect(
      resolveMagiProviderEventTransition({
        currentState: "awaiting-arbitration",
        stateBeforePause: null,
        eventType: "runtime.error",
      }),
    ).toEqual({ state: "paused", stateBeforePause: "awaiting-arbitration" });
  });
});

describe("agent-owned Magi lifecycle", () => {
  const lifecycleRun = (
    state: PersistedMagiRun["detail"]["summary"]["state"],
    stateBeforePause: string | null = null,
  ) =>
    ({
      ...unavailablePersistedRun,
      detail: {
        ...unavailablePersistedRun.detail,
        summary: { ...unavailablePersistedRun.detail.summary, state, completedMagiTurns: 1 },
        candidate: null,
        participants: [],
        activity: { state },
        issuedActionBatch: null,
      },
      protocol: {
        turns: [],
        members: [],
        actions: [],
        stateBeforePause,
        arbitratorInstructions: "",
      },
    }) as unknown as PersistedMagiRun;

  for (const previous of [
    "awaiting-next-turn",
    "awaiting-arbitration",
    "awaiting-actions",
    "awaiting-action-reconciliation",
  ] as const) {
    it.effect(`resumes a persisted pause back to ${previous} without a client command`, () =>
      Effect.gen(function* () {
        const persistenceCount = yield* Ref.make(0);
        const service = yield* makeAvailabilityService({
          persistedRun: lifecycleRun("paused", previous),
          persistenceCount,
          dispatchCount: yield* Ref.make(0),
          providerTurnCount: yield* Ref.make(0),
        });
        const result = yield* service.controlRun(unavailableRootThreadId, {
          runId: unavailableRunId,
          action: "resume",
        });
        expect(result.state).toBe(previous);
        expect(result.nextRequiredTool).toBe(
          previous === "awaiting-next-turn"
            ? "magi_deliberate"
            : previous === "awaiting-arbitration"
              ? "magi_recover_turn_result"
              : "magi_record_actions",
        );
        yield* service.controlRun(unavailableRootThreadId, {
          runId: unavailableRunId,
          action: "resume",
        });
        expect(yield* Ref.get(persistenceCount)).toBe(1);
      }),
    );
  }

  it.effect("pauses idempotently, resumes, and permanently stops the same run", () =>
    Effect.gen(function* () {
      const persistenceCount = yield* Ref.make(0);
      const service = yield* makeAvailabilityService({
        persistedRun: lifecycleRun("awaiting-arbitration"),
        persistenceCount,
        dispatchCount: yield* Ref.make(0),
        providerTurnCount: yield* Ref.make(0),
      });
      for (const action of ["pause", "pause"] as const) {
        const paused = yield* service.controlRun(unavailableRootThreadId, {
          runId: unavailableRunId,
          action,
        });
        expect(paused.state).toBe("paused");
        expect(paused.nextRequiredTool).toBe("magi_control_run");
      }
      expect(yield* Ref.get(persistenceCount)).toBe(1);
      const resumed = yield* service.controlRun(unavailableRootThreadId, {
        runId: unavailableRunId,
        action: "resume",
      });
      expect(resumed.state).toBe("awaiting-arbitration");
      const stopped = yield* service.controlRun(unavailableRootThreadId, {
        runId: unavailableRunId,
        action: "stop",
      });
      expect(stopped.state).toBe("cancelled");
      expect(stopped.nextRequiredTool).toBe("none");
      const error = yield* service
        .controlRun(unavailableRootThreadId, { runId: unavailableRunId, action: "resume" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-protocol-state");
    }),
  );

  it.effect("keeps the underlying continuation when pausing an approval wait", () =>
    Effect.gen(function* () {
      const service = yield* makeAvailabilityService({
        persistedRun: lifecycleRun("awaiting-main-approval", "awaiting-arbitration"),
        persistenceCount: yield* Ref.make(0),
        dispatchCount: yield* Ref.make(0),
        providerTurnCount: yield* Ref.make(0),
      });
      yield* service.controlRun(unavailableRootThreadId, {
        runId: unavailableRunId,
        action: "pause",
      });
      const resumed = yield* service.controlRun(unavailableRootThreadId, {
        runId: unavailableRunId,
        action: "resume",
      });
      expect(resumed.state).toBe("awaiting-arbitration");
    }),
  );

  for (const action of ["pause", "resume", "stop"] as const) {
    it.effect(`rejects ${action} from another conversation before changing the run`, () =>
      Effect.gen(function* () {
        const persistenceCount = yield* Ref.make(0);
        const service = yield* makeAvailabilityService({
          persistedRun: lifecycleRun("paused", "awaiting-next-turn"),
          persistenceCount,
          dispatchCount: yield* Ref.make(0),
          providerTurnCount: yield* Ref.make(0),
        });
        const error = yield* service
          .controlRun(ThreadId.make("foreign-thread"), { runId: unavailableRunId, action })
          .pipe(Effect.flip);
        expect(error.reason).toBe("foreign-turn");
        expect(yield* Ref.get(persistenceCount)).toBe(0);
      }),
    );
  }
});

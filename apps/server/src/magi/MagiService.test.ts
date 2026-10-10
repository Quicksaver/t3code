import { describe, expect, it } from "@effect/vitest";
import {
  MAGI_ARM_CONTEXT_KIND,
  ThreadId,
  type MagiRecoverRunContextResult,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { isMagiThreadNotFound } from "./MagiParticipantPolicy.ts";
import {
  isDeletedRootMagiPersistenceError,
  makeMagiOptionCatalogue,
  recoverInterruptedMagiState,
  recoverMagiRunContextContinuation,
  resolveMagiProviderEventTransition,
  resolveMagiPromptCapacity,
  runMagiTerminalCleanup,
  shouldPersistMagiDeliberationContext,
  withMagiArmContext,
} from "./MagiService.ts";

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

it("treats only a missing thread as not found", () => {
  const threadId = ThreadId.make("thread:missing");
  expect(
    isMagiThreadNotFound(
      new OrchestratorProjectionError({
        threadId,
        cause: new ProjectionStoreThreadNotFoundError({ threadId }),
      }),
    ),
  ).toBe(true);
  expect(isMagiThreadNotFound(new OrchestratorProjectionError({ threadId }))).toBe(false);
  expect(
    isMagiThreadNotFound(
      new OrchestratorProjectionError({ threadId, cause: new Error("database is locked") }),
    ),
  ).toBe(false);
});

describe("Magi arm delivery", () => {
  it("delivers the arm instructions to the provider with the user's message", () => {
    const armed = withMagiArmContext({
      armId: "0f6c2d1e-arm",
      instructions: "Call magi_start with armId 0f6c2d1e-arm.",
      text: "Review this branch",
      context: undefined,
    });

    const providerText = projectComposerContextForProvider({
      text: armed.text,
      records: armed.context.records,
    });
    expect(providerText).toContain("Review this branch");
    expect(providerText).toContain(`kind="${MAGI_ARM_CONTEXT_KIND}"`);
    expect(providerText).toContain("Call magi_start with armId 0f6c2d1e-arm.");
  });
});

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

  it.each(["awaiting-actions", "awaiting-action-reconciliation"] as const)(
    "routes %s to recordActions without dropping the issued batch",
    (state) => {
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
      const continuation = recoverMagiRunContextContinuation(state, issuedActionBatch);
      expect(continuation.nextRequiredTool).toBe("magi_record_actions");
      expect(continuation.issuedActionBatch).toBe(issuedActionBatch);
    },
  );

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

describe("Magi lifecycle transitions", () => {
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

  it("pauses when the owning run aborts without losing the current state", () => {
    expect(
      resolveMagiProviderEventTransition({
        currentState: "awaiting-arbitration",
        stateBeforePause: null,
        eventType: "turn.aborted",
      }),
    ).toEqual({ state: "paused", stateBeforePause: "awaiting-arbitration" });
  });
});

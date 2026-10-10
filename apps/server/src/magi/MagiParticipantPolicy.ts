import {
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionMagiRepositoryLive } from "../persistence/ProjectionMagi.ts";
import { ProjectionMagiRepository } from "../persistence/ProjectionMagi.ts";

/** Actions a Magi participant's subtree is restricted from. */
export type MagiParticipantAction =
  | "start-magi"
  | "create-threads"
  | "launch-thread"
  | "send-to-thread";

const isProjectionThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);

/** Whether a thread-management read failed only because the thread does not exist. */
export const isMagiThreadNotFound = (error: { readonly _tag: string; readonly cause?: unknown }) =>
  error._tag === "ThreadManagementThreadNotFoundError" ||
  (error._tag === "OrchestratorProjectionError" && isProjectionThreadNotFound(error.cause));

export type MagiParticipantDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string };

const denialMessages: Record<MagiParticipantAction, string> = {
  "start-magi":
    "Magi participants and their subagents cannot start Magi runs. Report your assessment to the Magi run you are part of instead.",
  "create-threads":
    "Magi participants and their subagents cannot create top-level threads. Use delegate_task for subagents.",
  "launch-thread":
    "Magi participants and their subagents cannot launch top-level threads. Use delegate_task for subagents.",
  "send-to-thread":
    "Magi participants and their subagents can only message their own delegated subagents.",
};

/**
 * Decides whether a caller may take `action`. `callerLineage` and `targetLineage` list a thread
 * followed by its subagent ancestors. A caller is in a participant's subtree when any thread in its
 * lineage is a Magi participant; provider-native subagents call with the participant's own
 * credential and so are the participant here. That subtree cannot start Magi or create or launch
 * threads, and may message only threads strictly beneath the participant. Other callers are free.
 */
export const decideMagiParticipantAction = (input: {
  readonly action: MagiParticipantAction;
  readonly callerLineage: ReadonlyArray<ThreadId>;
  readonly participantThreadIds: ReadonlySet<ThreadId>;
  readonly targetLineage?: ReadonlyArray<ThreadId>;
}): MagiParticipantDecision => {
  const participant = input.callerLineage.find((threadId) =>
    input.participantThreadIds.has(threadId),
  );
  if (participant === undefined) return { allowed: true };
  if (
    input.action === "send-to-thread" &&
    input.targetLineage !== undefined &&
    input.targetLineage[0] !== participant &&
    input.targetLineage.includes(participant)
  ) {
    return { allowed: true };
  }
  return { allowed: false, message: denialMessages[input.action] };
};

export interface MagiParticipantPolicyShape {
  /** The thread followed by the conversations that delegated to it, nearest first. */
  readonly subagentLineage: (
    thread: OrchestrationV2AppThread,
  ) => Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly decide: (input: {
    readonly action: MagiParticipantAction;
    readonly callerThreadId: ThreadId;
    readonly targetThreadId?: ThreadId;
  }) => Effect.Effect<MagiParticipantDecision>;
  /** `decide` for MCP tools, failing with a capability denial. */
  readonly requireToolAllowed: (input: {
    readonly action: Exclude<MagiParticipantAction, "start-magi">;
    readonly callerThreadId: ThreadId;
    readonly targetThreadId?: ThreadId;
  }) => Effect.Effect<void, OrchestratorMcpFailure>;
}

export class MagiParticipantPolicy extends Context.Service<
  MagiParticipantPolicy,
  MagiParticipantPolicyShape
>()("t3/magi/MagiParticipantPolicy") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const repository = yield* ProjectionMagiRepository;

  // A missing thread ends a lineage walk. Any other read failure dies rather than truncating the
  // chain, which would treat a confined caller as unrestricted.
  const readThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.asSome,
      Effect.catchIf(isMagiThreadNotFound, () => Effect.succeedNone, Effect.die),
    );

  const subagentLineage: MagiParticipantPolicyShape["subagentLineage"] = (thread) =>
    Effect.gen(function* () {
      const chain = [thread.id];
      let lineage = thread.lineage;
      // Forks are independent conversations and end the walk.
      while (
        lineage.relationshipToParent === "subagent" &&
        lineage.parentThreadId !== null &&
        !chain.includes(lineage.parentThreadId)
      ) {
        const parent = yield* readThread(lineage.parentThreadId);
        if (Option.isNone(parent)) break;
        chain.push(parent.value.thread.id);
        lineage = parent.value.thread.lineage;
      }
      return chain;
    });

  const lineageOf = (threadId: ThreadId) =>
    readThread(threadId).pipe(
      Effect.flatMap((records) =>
        Option.isNone(records)
          ? Effect.succeed<ReadonlyArray<ThreadId>>([threadId])
          : subagentLineage(records.value.thread),
      ),
    );

  const decide: MagiParticipantPolicyShape["decide"] = (input) =>
    Effect.gen(function* () {
      const callerLineage = yield* lineageOf(input.callerThreadId);
      const participants = yield* repository
        .findParticipantThreads(callerLineage)
        .pipe(Effect.orDie);
      if (participants.length === 0) return { allowed: true } as const;
      const targetLineage =
        input.targetThreadId === undefined ? undefined : yield* lineageOf(input.targetThreadId);
      return decideMagiParticipantAction({
        action: input.action,
        callerLineage,
        participantThreadIds: new Set(participants),
        ...(targetLineage === undefined ? {} : { targetLineage }),
      });
    });

  const requireToolAllowed: MagiParticipantPolicyShape["requireToolAllowed"] = (input) =>
    decide(input).pipe(
      Effect.flatMap((decision) =>
        decision.allowed
          ? Effect.void
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: decision.message }),
            ),
      ),
    );

  return { subagentLineage, decide, requireToolAllowed } satisfies MagiParticipantPolicyShape;
});

/** The policy over caller-provided thread and Magi repositories. */
export const layerFromServices = Layer.effect(MagiParticipantPolicy, make);

export const layer = layerFromServices.pipe(Layer.provide(ProjectionMagiRepositoryLive));

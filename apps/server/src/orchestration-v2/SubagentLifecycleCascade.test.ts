import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CommandReceiptV2Status } from "./CommandReceiptStore.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";
import {
  cascadeSubagentLifecycle,
  type SubagentLifecycleOperation,
} from "./SubagentLifecycleCascade.ts";

const parentId = ThreadId.make("thread:cascade-parent");
const childId = ThreadId.make("thread:cascade-child");
const grandchildId = ThreadId.make("thread:cascade-grandchild");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const active = (id: ThreadId) =>
  ({ id, archivedAt: null, deletedAt: null }) as OrchestrationV2AppThread;
const archived = (id: ThreadId) => ({ ...active(id), archivedAt: now });
const deleted = (id: ThreadId) => ({ ...active(id), deletedAt: now });
const childCommandId = `command:archive-parent:subagent:${childId}`;

/**
 * Applies the parent's lifecycle against dispatch and receipt fakes that
 * behave like the orchestrator: a stored receipt replays, and a new command id
 * runs `outcome` and stores whether it was accepted or rejected.
 */
const cascade = (input: {
  readonly operation?: SubagentLifecycleOperation;
  readonly threads: ReadonlyArray<OrchestrationV2AppThread>;
  /** What a re-read after a failed dispatch sees, when it differs from the listing. */
  readonly reread?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly receipts?: Record<string, CommandReceiptV2Status>;
  readonly outcome?: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorV2Error>;
}) => {
  const receipts = new Map(Object.entries(input.receipts ?? {}));
  const dispatched: Array<string> = [];
  const thread = (id: ThreadId) => input.threads.find((candidate) => candidate.id === id)!;
  return cascadeSubagentLifecycle({
    commandId: CommandId.make("command:archive-parent"),
    threadId: parentId,
    operation: input.operation ?? "archive",
    projections: {
      getSubagentChildThreads: (threadId) =>
        Effect.succeed(
          threadId === parentId
            ? [thread(childId)]
            : threadId === childId
              ? [thread(grandchildId)]
              : [],
        ),
      getThread: (threadId) =>
        Effect.succeed(
          input.reread?.find((candidate) => candidate.id === threadId) ?? thread(threadId),
        ),
    },
    receipts: {
      getByCommandId: (commandId) =>
        Effect.sync(() =>
          Option.fromNullishOr(receipts.get(commandId)).pipe(
            Option.map((status) => ({ status }) as never),
          ),
        ),
    },
    threads: {
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatched.push(command.commandId);
          const stored = receipts.get(command.commandId);
          if (stored === "rejected") {
            return yield* new OrchestratorCommandPreviouslyRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              detail: "Projection read failed.",
            });
          }
          if (stored === undefined) {
            yield* (input.outcome?.(command) ?? Effect.void).pipe(
              Effect.tapError(() => Effect.sync(() => receipts.set(command.commandId, "rejected"))),
            );
            receipts.set(command.commandId, "accepted");
          }
          return { sequence: 1, storedEvents: [] };
        }),
    },
  }).pipe(Effect.as(dispatched));
};

const rejectedByOrchestrator = (command: OrchestrationV2ServerCommand) =>
  Effect.fail(
    new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Thread is already archived.",
    }),
  );

it.effect("ignores a rejected child command once the child reached the state", () =>
  Effect.gen(function* () {
    // A concurrent command archived the child after the cascade listed it.
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      reread: [archived(childId)],
      outcome: rejectedByOrchestrator,
    });
    assert.deepEqual(dispatched, [childCommandId]);
  }),
);

it.effect("fails a rejected child command while the child is still short of the state", () =>
  Effect.gen(function* () {
    const failure = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      outcome: rejectedByOrchestrator,
    }).pipe(Effect.flip);
    assert.instanceOf(failure, OrchestratorDispatchError);
  }),
);

it.effect("keeps replaying an accepted child command", () =>
  Effect.gen(function* () {
    // The child was archived by this cascade and later unarchived on its own.
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "accepted" },
    });
    assert.deepEqual(dispatched, [childCommandId]);
  }),
);

it.effect("replays an accepted replacement instead of minting another", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "accepted" },
    });
    assert.deepEqual(dispatched, [`${childCommandId}:retry:1`]);
  }),
);

it.effect("moves past rejected replacements to the next unused id", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "rejected" },
    });
    assert.deepEqual(dispatched, [`${childCommandId}:retry:2`]);
  }),
);

it.effect("walks a recovered child's subagents under its accepted replacement id", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [archived(childId), active(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "accepted" },
    });
    // The same id the recovered child's own cascade derives for it.
    assert.deepEqual(dispatched, [`${childCommandId}:retry:1:subagent:${grandchildId}`]);
  }),
);

it.effect("deletes descendants through a deleted child without redispatching it", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      operation: "delete",
      threads: [deleted(childId), active(grandchildId)],
    });
    assert.deepEqual(dispatched, [`${childCommandId}:subagent:${grandchildId}`]);
  }),
);

it.effect("continues deletion after a rejected dispatch rereads a deleted child", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      operation: "delete",
      threads: [active(childId), active(grandchildId)],
      reread: [deleted(childId)],
      outcome: (command) =>
        command.type === "thread.delete" && command.threadId === childId
          ? rejectedByOrchestrator(command)
          : Effect.void,
    });
    assert.deepEqual(dispatched, [
      childCommandId,
      `${childCommandId}:retry:1:subagent:${grandchildId}`,
    ]);
  }),
);

it.effect("stops archive and unarchive recovery when a child was deleted concurrently", () =>
  Effect.gen(function* () {
    for (const operation of ["archive", "unarchive"] as const) {
      const dispatched = yield* cascade({
        operation,
        threads: [
          operation === "archive" ? active(childId) : archived(childId),
          active(grandchildId),
        ],
        reread: [deleted(childId)],
        outcome: rejectedByOrchestrator,
      });
      assert.deepEqual(dispatched, [childCommandId]);
    }
  }),
);

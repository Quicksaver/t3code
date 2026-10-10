import { CommandId, type OrchestrationV2AppThread, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type {
  CommandReceiptStoreV2Error,
  CommandReceiptStoreV2Shape,
} from "./CommandReceiptStore.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProjectionStoreV2Error, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import type { ThreadCommandExecutor } from "./ThreadCommandExecutor.ts";

export type SubagentLifecycleOperation = "archive" | "unarchive" | "delete";

/**
 * The outbox effect a lifecycle command commits whenever its thread has
 * eligible subagent children, including deleted intermediates for deletion.
 * It is committed even when every child already
 * looks done: a pending cascade from an earlier command has not reached the
 * projection yet, and a child already in the state can still have subagents
 * that are not.
 */
export function subagentLifecycleCascadeEffect(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly operation: SubagentLifecycleOperation;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${input.commandId}:subagent-threads.cascade`,
    commandId: input.commandId,
    threadId: input.threadId,
    request: { type: "subagent-threads.cascade", operation: input.operation },
  };
}

function reachedState(thread: OrchestrationV2AppThread, operation: SubagentLifecycleOperation) {
  if (thread.deletedAt !== null) return true;
  switch (operation) {
    case "archive":
      return thread.archivedAt !== null;
    case "unarchive":
      return thread.archivedAt === null;
    case "delete":
      return false;
  }
}

/**
 * Runs a conversation's archive, unarchive, or delete on its subagent threads.
 * Each child that still needs the change gets the same command a client would
 * send, so its runs, provider sessions and terminals are handled exactly like
 * the parent's, and its own cascade effect carries the change further down. A
 * child already in the target state is left alone, but the walk continues into
 * its subagents, which may not be. Forks are independent conversations and are
 * never followed.
 *
 * Child command ids derive from the parent command, so a retried effect
 * replays their receipts instead of repeating the work. A stored rejection
 * would replay the same way forever, so a rejected id is followed by
 * `<id>:retry:1`, `:retry:2`, ... The first of those that is unused or accepted
 * is the child's command id, both for its dispatch and as the prefix of its
 * subagents' ids, which keeps them equal to the ids its own cascade uses.
 */
export function cascadeSubagentLifecycle(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly operation: SubagentLifecycleOperation;
  readonly projections: Pick<ProjectionStoreV2Shape, "getSubagentChildThreads" | "getThread">;
  readonly receipts: Pick<CommandReceiptStoreV2Shape, "getByCommandId">;
  readonly threads: Pick<ThreadManagementServiceShape, "dispatch">;
  readonly executor: Pick<ThreadCommandExecutor["Service"], "withLock">;
}): Effect.Effect<void, OrchestratorV2Error | ProjectionStoreV2Error | CommandReceiptStoreV2Error> {
  const { projections, receipts, threads, operation } = input;
  const commandIdFrom = (
    derived: CommandId,
    replacement = 0,
  ): Effect.Effect<CommandId, CommandReceiptStoreV2Error> => {
    const id = replacement === 0 ? derived : CommandId.make(`${derived}:retry:${replacement}`);
    return receipts
      .getByCommandId(id)
      .pipe(
        Effect.flatMap((receipt) =>
          Option.isSome(receipt) && receipt.value.status === "rejected"
            ? commandIdFrom(derived, replacement + 1)
            : Effect.succeed(id),
        ),
      );
  };
  const cascade = projections
    .getSubagentChildThreads(input.threadId, { includeDeleted: operation === "delete" })
    .pipe(
      Effect.flatMap((children) =>
        Effect.forEach(
          children,
          (child) => {
            const derived = CommandId.make(`${input.commandId}:subagent:${child.id}`);
            const descend = commandIdFrom(derived).pipe(
              Effect.flatMap((commandId) =>
                cascadeSubagentLifecycle({ ...input, commandId, threadId: child.id }),
              ),
            );
            if (reachedState(child, operation)) return descend;
            return commandIdFrom(derived).pipe(
              Effect.flatMap((commandId) =>
                threads.dispatch({ type: `thread.${operation}`, commandId, threadId: child.id }),
              ),
              Effect.asVoid,
              // A concurrent command may have already moved the child, which
              // rejects this one. Only a child still short of the state fails.
              Effect.catch((cause) =>
                projections
                  .getThread(child.id)
                  .pipe(
                    Effect.flatMap((current) =>
                      !reachedState(current, operation)
                        ? Effect.fail(cause)
                        : current.deletedAt === null || operation === "delete"
                          ? descend
                          : Effect.void,
                    ),
                  ),
              ),
            );
          },
          { discard: true },
        ),
      ),
      Effect.withSpan("SubagentLifecycleCascade.cascade"),
    );
  if (operation === "delete") return cascade;
  // Recursive walks run in the ancestor's outbox lane. Serialize each parent
  // with its commands so an older walk cannot outlive that parent's Undo.
  return input.executor.withLock(
    input.threadId,
    projections
      .getThread(input.threadId)
      .pipe(
        Effect.flatMap((parent) =>
          parent.deletedAt === null && reachedState(parent, operation) ? cascade : Effect.void,
        ),
      ),
  );
}

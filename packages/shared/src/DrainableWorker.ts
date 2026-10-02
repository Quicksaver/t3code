/**
 * DrainableWorker - A queue-based worker that exposes `drain()` and `settle()`.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Resolves once every item enqueued before this call has finished
   * processing. Items enqueued later are not awaited, so a reader can wait
   * for the work it knows about while producers keep the queue busy.
   */
  readonly settle: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const enqueued = yield* TxRef.make(0);
    const processed = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(processed, (n) => n + 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const awaitProcessed = (target: number) =>
      TxRef.get(processed).pipe(
        Effect.tap((n) => (n < target ? Effect.txRetry : Effect.void)),
        Effect.tx,
      );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(enqueued).pipe(
      Effect.flatMap((target) =>
        TxRef.get(processed).pipe(Effect.tap((n) => (n < target ? Effect.txRetry : Effect.void))),
      ),
      Effect.tx,
    );

    const settle: DrainableWorker<A>["settle"] = TxRef.get(enqueued).pipe(
      Effect.tx,
      Effect.flatMap(awaitProcessed),
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(enqueued, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain, settle } satisfies DrainableWorker<A>;
  });

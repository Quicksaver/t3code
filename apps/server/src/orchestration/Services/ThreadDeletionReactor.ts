/**
 * ThreadDeletionReactor - Thread deletion cleanup reactor service interface.
 *
 * Owns background workers that react to thread archive/delete domain events
 * and perform runtime cleanup plus durable cold-storage lifecycle work.
 *
 * @module ThreadDeletionReactor
 */
import * as Context from "effect/Context";
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadDeletionReactorShape - Service API for thread deletion cleanup.
 */
export interface ThreadDeletionReactorShape {
  /**
   * Start reacting to thread lifecycle orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Waits until the subscriber reaches the supplied event sequence, then
   * waits for pending cleanup for the supplied thread, or all cleanup when
   * no thread is supplied. Creation fences only the reused thread id so
   * unrelated archives cannot delay its new runtime resources.
   */
  readonly drainThrough: (sequence: number, threadId?: ThreadId) => Effect.Effect<void>;
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}

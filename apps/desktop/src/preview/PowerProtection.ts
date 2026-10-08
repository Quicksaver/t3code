import * as Effect from "effect/Effect";
import { powerSaveBlocker } from "electron";

/** Keeps active preview work running without preventing display sleep or locking. */
export const make = (platform: NodeJS.Platform, native = powerSaveBlocker) =>
  Effect.gen(function* () {
    const activities = new Set<symbol>();
    let blocker: number | undefined;
    let closed = false;
    const supported = platform === "win32" || platform === "darwin";

    const releaseAll = Effect.sync(() => {
      closed = true;
      activities.clear();
      if (blocker !== undefined) {
        native.stop(blocker);
        blocker = undefined;
      }
    });
    yield* Effect.addFinalizer(() => releaseAll);

    const acquire = Effect.sync(() => {
      if (!supported || closed) return Effect.void;
      if (blocker === undefined) blocker = native.start("prevent-app-suspension");
      const activity = Symbol();
      activities.add(activity);
      return Effect.sync(() => {
        if (!activities.delete(activity) || activities.size > 0) return;
        if (blocker !== undefined) {
          native.stop(blocker);
          blocker = undefined;
        }
      });
    });

    return {
      acquire,
      withActivity: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          acquire,
          () => effect,
          (release) => release,
        ),
    };
  });

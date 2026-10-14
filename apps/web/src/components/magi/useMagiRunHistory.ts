import { MAGI_THREAD_RUNS_LIMIT } from "@t3tools/client-runtime/state/magi";
import type { MagiListRunsResult, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { magiEnvironment } from "~/state/magi";

const IDLE_THREAD_RUNS_ATOM = Atom.make(AsyncResult.initial<MagiListRunsResult, never>()).pipe(
  Atom.withLabel("environment-data:magi:thread-runs:idle"),
);

/**
 * Live Magi runs of one conversation and its subagents, shared by the timeline summary,
 * the Magi tab badge, and the Magi panel. Pass `null` when Magi is unavailable.
 */
export function useMagiRunHistory(threadRef: ScopedThreadRef | null): {
  readonly history: MagiListRunsResult | null;
  readonly loading: boolean;
  readonly failed: boolean;
} {
  const target = useMemo(
    () =>
      threadRef === null
        ? null
        : {
            environmentId: threadRef.environmentId,
            input: { rootThreadId: threadRef.threadId, limit: MAGI_THREAD_RUNS_LIMIT },
          },
    [threadRef],
  );
  const result = useAtomValue(
    target === null ? IDLE_THREAD_RUNS_ATOM : magiEnvironment.threadRuns(target),
  );
  const history = Option.getOrNull(AsyncResult.value(result));
  return {
    history,
    loading: target !== null && history === null && !AsyncResult.isFailure(result),
    failed: history === null && AsyncResult.isFailure(result),
  };
}

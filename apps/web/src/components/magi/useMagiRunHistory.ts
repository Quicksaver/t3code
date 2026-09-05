import type { MagiListRunsResult, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { magiEnvironment } from "~/state/magi";
import {
  resolveMagiRunHistory,
  shouldClearRetainedMagiRunHistory,
  startMagiHistoryLiveRefresh,
} from "./MagiPanel.logic";

/** Owns the latest-summary and expanded-history subscriptions shared by timeline and panel. */
export function useMagiRunHistory(input: {
  readonly threadRef: ScopedThreadRef;
  readonly expanded: boolean;
}): MagiListRunsResult | null {
  const latestTarget = useMemo(
    () => ({
      environmentId: input.threadRef.environmentId,
      input: {
        rootThreadId: input.threadRef.threadId,
        limit: 1,
      },
    }),
    [input.threadRef.environmentId, input.threadRef.threadId],
  );
  const expandedTarget = useMemo(
    () =>
      input.expanded
        ? {
            environmentId: input.threadRef.environmentId,
            input: {
              rootThreadId: input.threadRef.threadId,
              limit: 100,
            },
          }
        : latestTarget,
    [input.expanded, input.threadRef.environmentId, input.threadRef.threadId, latestTarget],
  );
  const latestResult = useAtomValue(magiEnvironment.history(latestTarget));
  const expandedResult = useAtomValue(magiEnvironment.history(expandedTarget));
  const latestHistory = Option.getOrNull(AsyncResult.value(latestResult));
  const expandedHistory = Option.getOrNull(AsyncResult.value(expandedResult));
  const scopedThreadKey = `${input.threadRef.environmentId}\0${input.threadRef.threadId}`;
  const retainedExpandedHistoryRef = useRef<{
    readonly scopedThreadKey: string;
    readonly history: MagiListRunsResult;
  } | null>(null);
  const latestRefreshBaselineRef = useRef<typeof latestResult | null>(null);
  const previousExpandedRef = useRef(input.expanded);

  if (retainedExpandedHistoryRef.current?.scopedThreadKey !== scopedThreadKey) {
    retainedExpandedHistoryRef.current = null;
    latestRefreshBaselineRef.current = null;
  }
  if (input.expanded && expandedHistory !== null) {
    retainedExpandedHistoryRef.current = { scopedThreadKey, history: expandedHistory };
  }
  if (
    shouldClearRetainedMagiRunHistory({
      expanded: input.expanded,
      hasRefreshBaseline: latestRefreshBaselineRef.current !== null,
      refreshResultChanged: latestResult !== latestRefreshBaselineRef.current,
      refreshResultIsSuccess: AsyncResult.isSuccess(latestResult),
      refreshResultIsWaiting: latestResult.waiting,
    })
  ) {
    retainedExpandedHistoryRef.current = null;
    latestRefreshBaselineRef.current = null;
  }

  useEffect(
    () =>
      startMagiHistoryLiveRefresh({
        enabled: input.expanded,
        refresh: () => appAtomRegistry.refresh(magiEnvironment.history(expandedTarget)),
        schedule: (callback, intervalMs) => window.setInterval(callback, intervalMs),
        cancel: (timer) => window.clearInterval(timer),
      }),
    [expandedTarget, input.expanded],
  );

  useEffect(() => {
    const wasExpanded = previousExpandedRef.current;
    previousExpandedRef.current = input.expanded;
    if (!wasExpanded || input.expanded) return;

    latestRefreshBaselineRef.current = latestResult;
    appAtomRegistry.refresh(magiEnvironment.history(latestTarget));
  }, [input.expanded, latestResult, latestTarget]);

  return resolveMagiRunHistory({
    expanded: input.expanded,
    latest: latestHistory,
    expandedHistory,
    retainedExpandedHistory: retainedExpandedHistoryRef.current?.history ?? null,
  });
}

import { useEffect, useRef } from "react";

import { reconcileAuthoritativeThreadRefs } from "./authoritativeThreadLifecycle";
import { releaseArchivedComposerDraftUploads } from "./lib/composerDraftUploads";
import { usePreviewMiniPlayerStore } from "./previewMiniPlayerStore";
import { removePreviewThread } from "./previewStateStore";
import { useLiveEnvironmentIds, useThreadRefs } from "./state/entities";
import { useEnvironments } from "./state/environments";

/**
 * Cleans up client state for threads an authoritative shell stops listing,
 * including archives by another client: releases the recreatable uploads of
 * the surviving composer draft and drops the thread's preview state.
 */
export function ThreadRemovalCleanupObserver() {
  const activeThreadRefs = useThreadRefs();
  const liveEnvironmentIds = useLiveEnvironmentIds();
  const { environmentIds: catalogEnvironmentIds, isReady: environmentCatalogReady } =
    useEnvironments();
  const previousActiveThreadRefs = useRef(activeThreadRefs);

  useEffect(() => {
    const reconciliation = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: previousActiveThreadRefs.current,
      activeThreadRefs,
      catalogEnvironmentIds: environmentCatalogReady ? catalogEnvironmentIds : null,
      liveEnvironmentIds,
    });
    previousActiveThreadRefs.current = reconciliation.nextActiveThreadRefs;
    for (const threadRef of reconciliation.removedThreadRefs) {
      releaseArchivedComposerDraftUploads(threadRef);
      removePreviewThread(threadRef);
      usePreviewMiniPlayerStore.getState().removeThread(threadRef);
    }
  }, [activeThreadRefs, catalogEnvironmentIds, environmentCatalogReady, liveEnvironmentIds]);

  return null;
}

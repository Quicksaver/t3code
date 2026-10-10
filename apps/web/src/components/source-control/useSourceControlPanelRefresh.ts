import { panelBranchDetailsFingerprint } from "@t3tools/shared/sourceControl";
import { useCallback, useEffect } from "react";

import {
  drainPanelRefreshQueue,
  enqueuePanelRefresh,
  type PanelRefreshRequest,
  vcsPanelSnapshotFingerprint,
} from "./SourceControlPanel.logic";
import { errorMessage, readCoveringStatus } from "./SourceControlPanelModel";
import { isSourceControlPanelCommandInterrupted } from "~/state/sourceControlPanel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

export function useSourceControlPanelRefresh(state: SourceControlPanelState) {
  const {
    api,
    canWriteSourceControl,
    coveredVcsStatusRef,
    cwd,
    expandedFileDiffs,
    expandedFileDiffsRef,
    expandedTree,
    expandedTreeRef,
    hydrateExpandedBranchDetails,
    hydrateExpandedStashDetails,
    lastFocusRefreshAtRef,
    lastVcsStatusRefreshRef,
    latestVcsStatusRef,
    mutationErrorVersionRef,
    refreshQueueRef,
    reloadExpandedCompareDiffs,
    reloadExpandedWorkingTreeDiffs,
    revalidateWorkingTreeFileEnrichment,
    setError,
    setLoading,
    setMutationError,
    setSnapshot,
    snapshotFingerprintRef,
    snapshotRef,
    sourceControlAllRemotesFetchIntervalMs,
    syncChangedPathSelection,
    syncWorktreeChangedPathSelection,
    vcsStatus,
    vcsStatusFingerprint: currentVcsStatusFingerprint,
  } = state;
  const refresh = useCallback(
    async (
      refreshMode: PanelRefreshRequest["mode"] = "full",
      options: { readonly authoritative?: boolean } = {},
    ) => {
      if (!api) {
        setError("Version Control panel is unavailable for this connection runtime.");
        setLoading(false);
        return;
      }
      const request = { mode: refreshMode, authoritative: options.authoritative ?? false };
      if (refreshQueueRef.current.inFlight) {
        return enqueuePanelRefresh(refreshQueueRef.current, request);
      }
      setLoading(true);
      try {
        await drainPanelRefreshQueue(refreshQueueRef.current, request, {
          run: async ({ mode, authoritative }) => {
            const mutationErrorVersion = mutationErrorVersionRef.current;
            const readSnapshot = authoritative ? api.vcs.readPanelSnapshot : api.vcs.panelSnapshot;
            // Status ticks queue working-tree reads; skip one whose status an earlier read already
            // reflects, such as the first status of a mount.
            const nextSnapshot = await readCoveringStatus({
              coverage: coveredVcsStatusRef,
              latestStatus: () => latestVcsStatusRef.current,
              skipCovered: mode === "working-tree" && !authoritative,
              read: () => {
                setError(null);
                return readSnapshot({ cwd, refresh: mode });
              },
            });
            if (!nextSnapshot) return;
            const nextSnapshotFingerprint = vcsPanelSnapshotFingerprint(cwd, nextSnapshot);
            // A full refresh that started after an action reported its error reconciles the panel,
            // so that error is no longer current. Status ticks keep it visible.
            if (mode === "full" && mutationErrorVersionRef.current === mutationErrorVersion) {
              setMutationError(null);
            }
            if (snapshotFingerprintRef.current === nextSnapshotFingerprint) {
              revalidateWorkingTreeFileEnrichment(snapshotRef.current, nextSnapshot);
              reloadExpandedWorkingTreeDiffs(nextSnapshot, { preserveLoaded: true });
              await hydrateExpandedBranchDetails(nextSnapshot, { authoritative });
              await hydrateExpandedStashDetails(nextSnapshot);
            } else {
              const previous = snapshotRef.current;
              const branchesChanged =
                !previous ||
                panelBranchDetailsFingerprint(previous) !==
                  panelBranchDetailsFingerprint(nextSnapshot);
              const stashesChanged =
                !previous ||
                JSON.stringify(previous.stashes) !== JSON.stringify(nextSnapshot.stashes);
              snapshotFingerprintRef.current = nextSnapshotFingerprint;
              snapshotRef.current = nextSnapshot;
              revalidateWorkingTreeFileEnrichment(previous, nextSnapshot);
              syncChangedPathSelection(nextSnapshot.changeGroups);
              syncWorktreeChangedPathSelection(nextSnapshot.worktreeChangeSets);
              setSnapshot(nextSnapshot);
              reloadExpandedWorkingTreeDiffs(nextSnapshot, { preserveLoaded: true });
              await hydrateExpandedBranchDetails(nextSnapshot, {
                reloadAll: branchesChanged,
                authoritative,
              });
              // Compare patches are keyed by ref names, which may now point elsewhere.
              if (branchesChanged) reloadExpandedCompareDiffs();
              await hydrateExpandedStashDetails(nextSnapshot, { reloadAll: stashesChanged });
            }
          },
          onError: (nextError) => {
            if (isSourceControlPanelCommandInterrupted(nextError)) return;
            setError(errorMessage(nextError));
          },
        });
      } finally {
        setLoading(false);
      }
    },
    [
      api,
      cwd,
      hydrateExpandedBranchDetails,
      hydrateExpandedStashDetails,
      reloadExpandedCompareDiffs,
      reloadExpandedWorkingTreeDiffs,
      revalidateWorkingTreeFileEnrichment,
      syncChangedPathSelection,
      syncWorktreeChangedPathSelection,
    ],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      vcsStatus.data === undefined ||
      vcsStatus.data === null ||
      currentVcsStatusFingerprint === null
    )
      return;
    if (coveredVcsStatusRef.current === vcsStatus.data) return;
    const previous = lastVcsStatusRefreshRef.current;
    if (previous?.data === vcsStatus.data && previous.fingerprint === currentVcsStatusFingerprint)
      return;
    lastVcsStatusRefreshRef.current = {
      data: vcsStatus.data,
      fingerprint: currentVcsStatusFingerprint,
    };
    void refresh("working-tree");
  }, [refresh, vcsStatus.data, currentVcsStatusFingerprint]);

  useEffect(() => {
    expandedTreeRef.current = expandedTree;
  }, [expandedTree]);

  useEffect(() => {
    expandedFileDiffsRef.current = expandedFileDiffs;
  }, [expandedFileDiffs]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < 1_000) return;
      lastFocusRefreshAtRef.current = now;
      if (!api || !canWriteSourceControl || sourceControlAllRemotesFetchIntervalMs <= 0) {
        void refresh();
        return;
      }
      void (async () => {
        try {
          await api.vcs.fetchAllRemotes({ cwd });
        } catch {
          // Focus refresh still reconciles the local repository snapshot when
          // an automatic network refresh is unavailable or policy-gated.
        } finally {
          await refresh();
        }
      })();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [api, canWriteSourceControl, cwd, refresh, sourceControlAllRemotesFetchIntervalMs]);

  return { refresh };
}

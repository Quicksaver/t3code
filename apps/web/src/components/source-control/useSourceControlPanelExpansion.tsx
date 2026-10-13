import type { VcsPanelBranchDetails, VcsPanelStash, VcsRef } from "@t3tools/contracts";

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback } from "react";

import { isSourceControlPanelCommandInterrupted } from "~/state/sourceControlPanel";

import {
  beginPanelDetailRequest,
  isLatestPanelDetailRequest,
  stashIdentityKey,
  stashReadRef,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  SECTION_RESIZE_KEY_STEP,
  appendBranchCommitPage,
  errorMessage,
  resizeSectionWeights,
  type BranchCommitListKind,
  type SectionKey,
  withBranchDetails,
} from "./SourceControlPanelModel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

export function useSourceControlPanelExpansion(state: SourceControlPanelState) {
  const {
    api,
    branchDetailRequestsRef,
    branchDetailsByRef,
    collapsed,
    collapsedDefaultTree,
    compareBaseDialogTarget,
    compareBaseOverrides,
    containerRef,
    cwd,
    expandedTree,
    sectionWeights,
    setBranchDetailsByRef,
    setCollapsed,
    setCollapsedDefaultTree,
    setCompareBaseDialogTarget,
    setCompareBaseOverrides,
    setCompareBaseQuery,
    setError,
    setExpandedTree,
    setLoadingBranchDetails,
    setLoadingStashDetails,
    setSectionWeights,
    setStashDetailsByKey,
    snapshot,
    stashDetailsByKey,
  } = state;
  const defaultCompareRef = snapshot?.defaultCompareRef ?? null;
  const toggleSection = useCallback((key: SectionKey) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isTreeExpanded = useCallback(
    (key: string, defaultExpanded = false) =>
      defaultExpanded ? !collapsedDefaultTree.has(key) : expandedTree.has(key),
    [collapsedDefaultTree, expandedTree],
  );

  const toggleTree = useCallback((key: string, defaultExpanded = false) => {
    if (defaultExpanded) {
      setCollapsedDefaultTree((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    setExpandedTree((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadBranchDetails = useCallback(
    async (branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      if (!api || !snapshot) return;
      if (!compareBaseRef && branchDetailsByRef.has(detailsKey)) return;
      const requestId = beginPanelDetailRequest(branchDetailRequestsRef.current, detailsKey);
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const details = await api.vcs.branchDetails({
          cwd,
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          compareBaseRef:
            compareBaseRef ??
            compareBaseOverrides.get(detailsKey) ??
            compareBaseOverrides.get(branch.name),
        });
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        setBranchDetailsByRef((current) =>
          withBranchDetails(current, { branch, detailsKey }, details),
        );
      } catch (nextError) {
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        if (isSourceControlPanelCommandInterrupted(nextError)) return;
        setError(errorMessage(nextError));
      } finally {
        if (isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          setLoadingBranchDetails((current) => {
            const next = new Set(current);
            next.delete(detailsKey);
            return next;
          });
        }
      }
    },
    [api, branchDetailsByRef, compareBaseOverrides, cwd, snapshot],
  );

  const chooseCompareBase = useCallback(
    (baseRef: string) => {
      const target = compareBaseDialogTarget;
      setCompareBaseDialogTarget(null);
      setCompareBaseQuery("");
      if (!target) return;
      setCompareBaseOverrides((current) => {
        const next = new Map(current);
        next.set(target.detailsKey, baseRef);
        return next;
      });
      void loadBranchDetails(target.branch, baseRef, target.detailsKey);
    },
    [compareBaseDialogTarget, loadBranchDetails],
  );

  const toggleBranchTree = useCallback(
    (key: string, branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadBranchDetails(branch, compareBaseRef, detailsKey);
    },
    [expandedTree, loadBranchDetails, toggleTree],
  );

  const toggleBranchTreeFromKeyboard = useCallback(
    (
      key: string,
      branch: VcsRef,
      event: ReactKeyboardEvent<HTMLDivElement>,
      compareBaseRef?: string,
      detailsKey = branch.name,
    ) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleBranchTree(key, branch, compareBaseRef, detailsKey);
    },
    [toggleBranchTree],
  );

  const loadMoreBranchCommits = useCallback(
    async (
      branch: VcsRef,
      details: VcsPanelBranchDetails,
      kind: BranchCommitListKind,
      detailsKey = branch.name,
    ) => {
      const loadedCount =
        kind === "ahead"
          ? details.aheadCommits.length
          : kind === "behind"
            ? details.behindCommits.length
            : kind === "compare-history"
              ? details.compareCommits.length
              : details.commits.length;
      const remaining =
        kind === "ahead"
          ? details.aheadCommitsRemaining
          : kind === "behind"
            ? details.behindCommitsRemaining
            : kind === "compare-history"
              ? details.compareCommitsRemaining
              : details.commitsRemaining;
      if (!api || remaining <= 0) return;
      const requestId = beginPanelDetailRequest(branchDetailRequestsRef.current, detailsKey);
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const result = await api.vcs.branchCommits({
          cwd,
          branch,
          baseRef: details.baseRef,
          kind,
          defaultCompareRef,
          skip: loadedCount,
          limit: COMMIT_PAGE_SIZE,
        });
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        setBranchDetailsByRef((current) =>
          appendBranchCommitPage(current, { branch, details, detailsKey, kind }, result),
        );
      } catch (nextError) {
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        if (isSourceControlPanelCommandInterrupted(nextError)) return;
        setError(errorMessage(nextError));
      } finally {
        if (isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          setLoadingBranchDetails((current) => {
            const next = new Set(current);
            next.delete(detailsKey);
            return next;
          });
        }
      }
    },
    [api, cwd, defaultCompareRef],
  );

  const loadStashDetails = useCallback(
    async (stash: VcsPanelStash) => {
      const detailsKey = stashIdentityKey(stash);
      if (!api || stashDetailsByKey.has(detailsKey)) return;
      setLoadingStashDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const details = await api.vcs.stashDetails({ cwd, stashRef: stashReadRef(stash) });
        setStashDetailsByKey((current) => {
          const next = new Map(current);
          next.set(detailsKey, details);
          return next;
        });
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setLoadingStashDetails((current) => {
          const next = new Set(current);
          next.delete(detailsKey);
          return next;
        });
      }
    },
    [api, cwd, stashDetailsByKey],
  );

  const toggleStashTree = useCallback(
    (key: string, stash: VcsPanelStash) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadStashDetails(stash);
    },
    [expandedTree, loadStashDetails, toggleTree],
  );

  const toggleTreeFromKeyboard = useCallback(
    (key: string, event: ReactKeyboardEvent<HTMLDivElement>, defaultExpanded = false) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleTree(key, defaultExpanded);
    },
    [toggleTree],
  );

  const startSectionResize = useCallback(
    (key: SectionKey, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startWeights = sectionWeights;
      const containerHeight = containerRef.current?.clientHeight ?? 1;
      let latestY = startY;
      let frame: number | null = null;
      // Pointer moves can outpace frames, so each frame applies only the latest position.
      const apply = () => {
        frame = null;
        setSectionWeights(
          resizeSectionWeights(startWeights, collapsed, key, latestY - startY, containerHeight),
        );
      };
      const onMove = (moveEvent: PointerEvent) => {
        latestY = moveEvent.clientY;
        frame ??= window.requestAnimationFrame(apply);
      };
      const onEnd = () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
          apply();
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [collapsed, sectionWeights],
  );

  const resizeSectionFromKeyboard = useCallback(
    (key: SectionKey, event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const containerHeight = containerRef.current?.clientHeight ?? 1;
      const deltaY = event.key === "ArrowDown" ? SECTION_RESIZE_KEY_STEP : -SECTION_RESIZE_KEY_STEP;
      setSectionWeights((current) =>
        resizeSectionWeights(current, collapsed, key, deltaY, containerHeight),
      );
    },
    [collapsed],
  );

  return {
    chooseCompareBase,
    isTreeExpanded,
    loadBranchDetails,
    loadMoreBranchCommits,
    loadStashDetails,
    resizeSectionFromKeyboard,
    startSectionResize,
    toggleBranchTree,
    toggleBranchTreeFromKeyboard,
    toggleSection,
    toggleStashTree,
    toggleTree,
    toggleTreeFromKeyboard,
  };
}

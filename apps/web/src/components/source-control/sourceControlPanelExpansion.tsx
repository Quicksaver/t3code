import type { VcsPanelBranchDetails, VcsPanelStash, VcsRef } from "@t3tools/contracts";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { isSourceControlPanelCommandInterrupted } from "~/state/sourceControlPanel";

import {
  beginPanelDetailRequest,
  isLatestPanelDetailRequest,
  stashIdentityKey,
  stashReadRef,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  appendBranchCommitPage,
  errorMessage,
  type BranchCommitListKind,
  withBranchDetails,
} from "./SourceControlPanelModel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

export function buildSourceControlPanelExpansion(state: SourceControlPanelState) {
  const {
    api,
    branchDetailRequestsRef,
    branchDetailsByRef,
    collapsedDefaultTree,
    compareBaseDialogTarget,
    compareBaseOverrides,
    cwd,
    expandedTree,
    setBranchDetailsByRef,
    setCollapsedDefaultTree,
    setCompareBaseDialogTarget,
    setCompareBaseOverrides,
    setCompareBaseQuery,
    setError,
    setExpandedTree,
    setLoadingBranchDetails,
    setLoadingStashDetails,
    setStashDetailsByKey,
    snapshot,
    stashDetailsByKey,
  } = state;
  const defaultCompareRef = snapshot?.defaultCompareRef ?? null;
  const isTreeExpanded = (key: string, defaultExpanded = false) =>
    defaultExpanded ? !collapsedDefaultTree.has(key) : expandedTree.has(key);

  const toggleTree = (key: string, defaultExpanded = false) => {
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
  };

  const loadBranchDetails = async (
    branch: VcsRef,
    compareBaseRef?: string,
    detailsKey = branch.name,
  ) => {
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
  };

  const chooseCompareBase = (baseRef: string) => {
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
  };

  const toggleBranchTree = (
    key: string,
    branch: VcsRef,
    compareBaseRef?: string,
    detailsKey = branch.name,
  ) => {
    const expanding = !expandedTree.has(key);
    toggleTree(key);
    if (expanding) void loadBranchDetails(branch, compareBaseRef, detailsKey);
  };

  const toggleBranchTreeFromKeyboard = (
    key: string,
    branch: VcsRef,
    event: ReactKeyboardEvent<HTMLDivElement>,
    compareBaseRef?: string,
    detailsKey = branch.name,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleBranchTree(key, branch, compareBaseRef, detailsKey);
  };

  const loadMoreBranchCommits = async (
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
  };

  const loadStashDetails = async (stash: VcsPanelStash) => {
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
  };

  const toggleStashTree = (key: string, stash: VcsPanelStash) => {
    const expanding = !expandedTree.has(key);
    toggleTree(key);
    if (expanding) void loadStashDetails(stash);
  };

  const toggleTreeFromKeyboard = (
    key: string,
    event: ReactKeyboardEvent<HTMLDivElement>,
    defaultExpanded = false,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleTree(key, defaultExpanded);
  };

  return {
    chooseCompareBase,
    isTreeExpanded,
    loadBranchDetails,
    loadMoreBranchCommits,
    loadStashDetails,
    toggleBranchTree,
    toggleBranchTreeFromKeyboard,
    toggleStashTree,
    toggleTree,
    toggleTreeFromKeyboard,
  };
}

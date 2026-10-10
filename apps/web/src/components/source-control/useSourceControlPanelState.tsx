import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { mergePanelChangeGroups } from "@t3tools/shared/sourceControl";
import { useAtomValue } from "@effect/atom-react";
import * as Duration from "effect/Duration";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { retainBackgroundActivityScope } from "~/lib/backgroundActivityReporter";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  resolveSourceControlPanelPresentationState,
  useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { vcsEnvironment } from "~/state/vcs";

import { shouldIncludeBranchPickerItem } from "../BranchToolbar.logic";
import {
  beginPanelDetailRequest,
  beginPanelFileDiffLoad,
  branchCompareFileDiffRequests,
  completePanelFileDiffLoad,
  failPanelFileDiffLoad,
  isLatestPanelDetailRequest,
  supersedePanelDetailRequests,
  type PanelChangedFile,
  type PanelRefreshQueue,
} from "./SourceControlPanel.logic";
import type { SourceControlPeerSyncTarget } from "./SourceControlPanel.logic";
import {
  readCachedSourceControlPanelState,
  sourceControlPanelStateCacheKey,
  writeCachedSourceControlPanelState,
} from "./SourceControlPanelCache";
import {
  DEFAULT_SECTION_WEIGHTS,
  applyWorkingTreeFileEnrichment,
  branchActivityTimestamp,
  compareBaseRefNames,
  enrichmentFileKey,
  errorMessage,
  expandedBranchesForSnapshot,
  expandedStashesForSnapshot,
  mergeWorkingTreeFileEnrichment,
  operationPathsForFile,
  planWorkingTreeEnrichmentRevalidation,
  renameOriginalPathForFile,
  retainBranchDetailsForReload,
  shouldEnrichWorkingTreeFile,
  sourceControlPanelError,
  splitEnrichmentFileKey,
  uniquePaths,
  vcsStatusFingerprint as fingerprintVcsStatus,
  withBranchDetails,
  withoutObsoleteWorkingTreeRenames,
  worktreeChangeSetId,
  type FileDiffLoadState,
  type FileDiffSource,
  type SectionKey,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly peerSyncTargets: readonly SourceControlPeerSyncTarget[];
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

export function useSourceControlPanelState({
  activeThreadRef,
  cwd,
  environmentId,
  onThreadRefChange,
  peerSyncTargets,
  threadId,
  worktreePath,
}: SourceControlEnvironmentPanelProps) {
  const { resolvedTheme } = useTheme();
  const commitMessageId = useId();
  const stashMessageId = useId();
  const gitActionScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const gitAction = useGitStackedAction(gitActionScope);
  const api = useSourceControlPanelApi(environmentId);
  const canWriteSourceControl = useAtomValue(
    vcsEnvironment.panelStageFiles.permissionAtom(environmentId),
  );
  const sourceControlAllRemotesFetchIntervalMs = useEnvironmentSettings(environmentId, (settings) =>
    Duration.toMillis(
      resolveServerBackgroundActivitySettings(settings).sourceControlAllRemotesFetchInterval,
    ),
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const vcsStatus = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd },
    }),
  );
  const panelStateCacheKey = useMemo(
    () => sourceControlPanelStateCacheKey({ environmentId, threadId, cwd, worktreePath }),
    [cwd, environmentId, threadId, worktreePath],
  );
  const cachedPanelState = useMemo(() => {
    return readCachedSourceControlPanelState(panelStateCacheKey);
  }, [panelStateCacheKey]);
  const cachedSnapshot = cachedPanelState?.snapshot ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const snapshotFingerprintRef = useRef<string | null>(
    cachedPanelState?.snapshotFingerprint ?? null,
  );
  const snapshotRef = useRef<VcsPanelSnapshotResult | null>(cachedSnapshot);
  const branchDetailsByRefRef = useRef<ReadonlyMap<string, VcsPanelBranchDetails>>(
    cachedPanelState?.branchDetailsByRef ?? new Map(),
  );
  const stashDetailsByKeyRef = useRef<ReadonlyMap<string, VcsPanelStashDetails>>(
    cachedPanelState?.stashDetailsByKey ?? new Map(),
  );
  const expandedTreeRef = useRef<ReadonlySet<string>>(cachedPanelState?.expandedTree ?? new Set());
  const expandedFileDiffsRef = useRef<ReadonlySet<string>>(
    cachedPanelState?.expandedFileDiffs ?? new Set(),
  );
  const fileDiffRequestIdsRef = useRef(new Map<string, number>());
  // Latest detail read per branch details key, shared by hydration, expansion, and pagination.
  const branchDetailRequestsRef = useRef(new Map<string, number>());
  const lastFocusRefreshAtRef = useRef(0);
  const initialFetchCwdRef = useRef<string | null>(null);
  const lastVcsStatusRefreshRef = useRef<{
    readonly data: VcsStatusResult;
    readonly fingerprint: string;
  } | null>(null);
  // The status a landed snapshot is known to reflect, so its own status tick needs no re-read.
  const coveredVcsStatusRef = useRef<VcsStatusResult | null>(null);
  const mutationErrorVersionRef = useRef(0);
  const previousChangedPathsRef = useRef<ReadonlySet<string>>(
    cachedSnapshot
      ? new Set(mergePanelChangeGroups(cachedSnapshot.changeGroups).map((file) => file.path))
      : new Set(),
  );
  const previousWorktreeChangedPathsRef = useRef<ReadonlyMap<string, ReadonlySet<string>>>(
    cachedSnapshot
      ? new Map(
          cachedSnapshot.worktreeChangeSets.map((changeSet) => [
            worktreeChangeSetId(changeSet),
            new Set(mergePanelChangeGroups(changeSet.changeGroups).map((file) => file.path)),
          ]),
        )
      : new Map(),
  );
  const refreshQueueRef = useRef<PanelRefreshQueue>({ inFlight: false, queued: null });
  const enrichedWorkingTreeFilesRef = useRef<ReadonlyMap<string, VcsPanelFileChange>>(
    cachedPanelState?.enrichedWorkingTreeFilesByPath ?? new Map(),
  );
  const hiddenWorkingTreePathsRef = useRef<ReadonlySet<string>>(
    cachedPanelState?.hiddenWorkingTreePaths ?? new Set(),
  );
  const pendingWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const inFlightWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  // Pending paths reread even though their enrichment is loaded, because their content may differ.
  const revalidatingWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const workingTreeEnrichmentTimerRef = useRef<number | null>(null);
  const workingTreeEnrichmentGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(cachedSnapshot);
  const [loading, setLoading] = useState(true);
  const [runningActions, setRunningActions] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(
    () => cachedPanelState?.collapsed ?? new Set(["remotes"]),
  );
  const [sectionWeights, setSectionWeights] = useState(
    () => cachedPanelState?.sectionWeights ?? DEFAULT_SECTION_WEIGHTS,
  );
  const [expandedTree, setExpandedTree] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.expandedTree ?? new Set(),
  );
  const [collapsedDefaultTree, setCollapsedDefaultTree] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.collapsedDefaultTree ?? new Set(),
  );
  const [branchDetailsByRef, setBranchDetailsByRef] = useState<
    ReadonlyMap<string, VcsPanelBranchDetails>
  >(() => cachedPanelState?.branchDetailsByRef ?? new Map());
  const [compareBaseOverrides, setCompareBaseOverrides] = useState<ReadonlyMap<string, string>>(
    () => cachedPanelState?.compareBaseOverrides ?? new Map(),
  );
  // Hydration reads overrides here so choosing a base does not change `refresh` identity.
  const compareBaseOverridesRef = useRef(compareBaseOverrides);
  const [loadingBranchDetails, setLoadingBranchDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stashDetailsByKey, setStashDetailsByKey] = useState<
    ReadonlyMap<string, VcsPanelStashDetails>
  >(() => cachedPanelState?.stashDetailsByKey ?? new Map());
  const [loadingStashDetails, setLoadingStashDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedFileDiffs, setExpandedFileDiffs] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.expandedFileDiffs ?? new Set(),
  );
  const [fileDiffsByKey, setFileDiffsByKey] = useState<ReadonlyMap<string, FileDiffLoadState>>(
    () => cachedPanelState?.fileDiffsByKey ?? new Map(),
  );
  const [enrichedWorkingTreeFilesByPath, setEnrichedWorkingTreeFilesByPath] = useState<
    ReadonlyMap<string, VcsPanelFileChange>
  >(() => cachedPanelState?.enrichedWorkingTreeFilesByPath ?? new Map());
  const [hiddenWorkingTreePaths, setHiddenWorkingTreePaths] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.hiddenWorkingTreePaths ?? new Set(),
  );
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  // The diverged-sync dialog and remote picker act on the snapshot they opened from, so a later
  // refresh never moves the remote tip a confirmed force push leases.
  const [divergedSyncTarget, setDivergedSyncTarget] = useState<{
    readonly branch: VcsRef;
    readonly snapshot: VcsPanelSnapshotResult;
  } | null>(null);
  const [publishRemoteTarget, setPublishRemoteTarget] = useState<{
    readonly branch: VcsRef;
    readonly force: boolean;
    readonly snapshot: VcsPanelSnapshotResult;
  } | null>(null);
  const [compareBaseDialogTarget, setCompareBaseDialogTarget] = useState<{
    readonly branch: VcsRef;
    readonly detailsKey: string;
  } | null>(null);
  const [compareBaseQuery, setCompareBaseQuery] = useState("");
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [stashDialogTarget, setStashDialogTarget] = useState<{
    readonly label: string;
    readonly cwd: string;
    readonly actionKey: string;
    readonly paths: readonly string[];
  } | null>(null);
  const [dialogStashMessage, setDialogStashMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedChangePaths, setSelectedChangePaths] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.selectedChangePaths ?? new Set(),
  );
  const [selectedWorktreeChangePaths, setSelectedWorktreeChangePaths] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => cachedPanelState?.selectedWorktreeChangePaths ?? new Map());

  useEffect(
    () => retainBackgroundActivityScope(environmentId, { type: "git-refs", cwd }),
    [cwd, environmentId],
  );
  const displayedChangeGroups = useMemo(
    () =>
      applyWorkingTreeFileEnrichment(
        snapshot?.changeGroups ?? [],
        cwd,
        enrichedWorkingTreeFilesByPath,
        hiddenWorkingTreePaths,
      ),
    [cwd, enrichedWorkingTreeFilesByPath, hiddenWorkingTreePaths, snapshot?.changeGroups],
  );
  const changedFiles = useMemo(
    () => mergePanelChangeGroups(displayedChangeGroups),
    [displayedChangeGroups],
  );
  const worktreeChangeSetViews = useMemo<WorkingTreeChangeSetView[]>(
    () =>
      (snapshot?.worktreeChangeSets ?? [])
        .map((changeSet) => {
          const id = worktreeChangeSetId(changeSet);
          const changeGroups = applyWorkingTreeFileEnrichment(
            changeSet.changeGroups,
            changeSet.worktreePath,
            enrichedWorkingTreeFilesByPath,
            hiddenWorkingTreePaths,
          );
          const files = mergePanelChangeGroups(changeGroups);
          return {
            id,
            label: changeSet.branchName,
            cwd: changeSet.worktreePath,
            branchName: changeSet.branchName,
            worktreePath: changeSet.worktreePath,
            current: false,
            changeGroups,
            files,
            selectedPaths:
              selectedWorktreeChangePaths.get(id) ?? new Set(files.map((file) => file.path)),
            activity: branchActivityTimestamp(changeSet),
          };
        })
        .filter((changeSet) => changeSet.files.length > 0),
    [
      enrichedWorkingTreeFilesByPath,
      hiddenWorkingTreePaths,
      selectedWorktreeChangePaths,
      snapshot?.worktreeChangeSets,
    ],
  );
  const compareBaseRefs = useMemo(() => compareBaseRefNames(snapshot), [snapshot]);
  const deferredCompareBaseQuery = useDeferredValue(compareBaseQuery);
  const normalizedCompareBaseQuery = deferredCompareBaseQuery.trim().toLowerCase();
  const filteredCompareBaseRefs = useMemo(
    () =>
      compareBaseRefs.filter((itemValue) =>
        shouldIncludeBranchPickerItem({
          itemValue,
          normalizedQuery: normalizedCompareBaseQuery,
          createBranchItemValue: null,
          checkoutPullRequestItemValue: null,
        }),
      ),
    [compareBaseRefs, normalizedCompareBaseQuery],
  );
  const changedPaths = useMemo(() => changedFiles.map((file) => file.path), [changedFiles]);
  const selectedChangedFiles = useMemo(
    () => changedFiles.filter((file) => selectedChangePaths.has(file.path)),
    [changedFiles, selectedChangePaths],
  );
  const selectedChangePathList = useMemo(
    () => uniquePaths(selectedChangedFiles.flatMap((file) => operationPathsForFile(file))),
    [selectedChangedFiles],
  );
  const allChangedFilesSelected =
    changedFiles.length > 0 && selectedChangedFiles.length === changedFiles.length;
  const toggleAllChangedFilesSelection = useCallback(() => {
    setSelectedChangePaths(allChangedFilesSelected ? new Set() : new Set(changedPaths));
  }, [allChangedFilesSelected, changedPaths]);
  const vcsStatusFingerprint = useMemo(
    () => (vcsStatus.data ? fingerprintVcsStatus(vcsStatus.data) : null),
    [vcsStatus.data],
  );
  const latestVcsStatusRef = useRef<VcsStatusResult | null>(null);
  // Declared before the refresh hook's effects so a refresh started in the same commit sees it.
  useEffect(() => {
    latestVcsStatusRef.current = vcsStatus.data ?? null;
  }, [vcsStatus.data]);
  const presentationState = useMemo(
    () =>
      resolveSourceControlPanelPresentationState({
        snapshot,
        loading,
        error: sourceControlPanelError(error, mutationError),
        statusPending: vcsStatus.isPending,
        statusError: vcsStatus.error,
      }),
    [error, loading, mutationError, snapshot, vcsStatus.error, vcsStatus.isPending],
  );
  // Bumped whenever an action reports its outcome, so a refresh that started earlier never
  // clears an error reported while it ran.
  const reportMutationError = useCallback((message: string | null) => {
    mutationErrorVersionRef.current += 1;
    setMutationError(message);
  }, []);
  const dismissError = useCallback(() => {
    setError(null);
    reportMutationError(null);
  }, [reportMutationError]);
  const isActionRunning = useCallback(
    (actionKey: string) => runningActions.has(actionKey),
    [runningActions],
  );

  useEffect(() => {
    branchDetailsByRefRef.current = branchDetailsByRef;
  }, [branchDetailsByRef]);

  useEffect(() => {
    stashDetailsByKeyRef.current = stashDetailsByKey;
  }, [stashDetailsByKey]);

  useEffect(() => {
    compareBaseOverridesRef.current = compareBaseOverrides;
  }, [compareBaseOverrides]);

  // Every commit stores its state by reference, so a replacement panel that mounts before this one
  // unmounts, as when federation restructures the parent, still restores it. React flushes this
  // effect before rendering the replacement; reads copy the state, so writes stay cheap.
  useEffect(() => {
    writeCachedSourceControlPanelState(panelStateCacheKey, {
      snapshot,
      snapshotFingerprint: snapshotFingerprintRef.current,
      collapsed,
      sectionWeights,
      expandedTree,
      collapsedDefaultTree,
      branchDetailsByRef,
      compareBaseOverrides,
      stashDetailsByKey,
      expandedFileDiffs,
      fileDiffsByKey,
      enrichedWorkingTreeFilesByPath,
      hiddenWorkingTreePaths,
      selectedChangePaths,
      selectedWorktreeChangePaths,
    });
  }, [
    branchDetailsByRef,
    collapsed,
    collapsedDefaultTree,
    compareBaseOverrides,
    enrichedWorkingTreeFilesByPath,
    expandedFileDiffs,
    expandedTree,
    fileDiffsByKey,
    hiddenWorkingTreePaths,
    panelStateCacheKey,
    sectionWeights,
    selectedChangePaths,
    selectedWorktreeChangePaths,
    snapshot,
    stashDetailsByKey,
  ]);

  const applyWorkingTreeFileEnrichmentResult = useCallback(
    (
      targetCwd: string,
      paths: readonly string[],
      result: VcsPanelWorkingTreeFileEnrichmentResult,
    ) => {
      const next = mergeWorkingTreeFileEnrichment(
        {
          enrichedFilesByPath: enrichedWorkingTreeFilesRef.current,
          hiddenPaths: hiddenWorkingTreePathsRef.current,
        },
        targetCwd,
        paths,
        withoutObsoleteWorkingTreeRenames(result, snapshotRef.current, cwd, targetCwd),
      );
      enrichedWorkingTreeFilesRef.current = next.enrichedFilesByPath;
      hiddenWorkingTreePathsRef.current = next.hiddenPaths;
      setEnrichedWorkingTreeFilesByPath(next.enrichedFilesByPath);
      setHiddenWorkingTreePaths(next.hiddenPaths);
    },
    [cwd],
  );

  const enrichmentRunningRef = useRef(false);
  const flushEnrichmentRef = useRef<() => void>(() => {});
  const flushWorkingTreeFileEnrichmentQueue = useCallback(
    function flushEnrichment() {
      workingTreeEnrichmentTimerRef.current = null;
      if (!api || enrichmentRunningRef.current) return;
      const revalidating = revalidatingWorkingTreeEnrichmentPathsRef.current;
      const keys = [...pendingWorkingTreeEnrichmentPathsRef.current].filter(
        (key) =>
          (revalidating.has(key) ||
            (!enrichedWorkingTreeFilesRef.current.has(key) &&
              !hiddenWorkingTreePathsRef.current.has(key))) &&
          !inFlightWorkingTreeEnrichmentPathsRef.current.has(key),
      );
      keys.splice(64);
      for (const key of keys) {
        pendingWorkingTreeEnrichmentPathsRef.current.delete(key);
        revalidating.delete(key);
      }
      if (keys.length === 0) return;
      enrichmentRunningRef.current = true;

      const requestsByCwd = new Map<string, string[]>();
      for (const key of keys) {
        const parsed = splitEnrichmentFileKey(key);
        if (!parsed.cwd || !parsed.path) continue;
        const paths = requestsByCwd.get(parsed.cwd) ?? [];
        paths.push(parsed.path);
        requestsByCwd.set(parsed.cwd, paths);
        inFlightWorkingTreeEnrichmentPathsRef.current.add(key);
      }
      if (requestsByCwd.size === 0) {
        enrichmentRunningRef.current = false;
        return;
      }

      const generation = workingTreeEnrichmentGenerationRef.current;
      void Promise.all(
        [...requestsByCwd].map(async ([targetCwd, paths]) => ({
          targetCwd,
          paths,
          result: await api.vcs.enrichWorkingTreeFiles({ cwd: targetCwd, paths }),
        })),
      )
        .then((results) => {
          if (workingTreeEnrichmentGenerationRef.current !== generation) return;
          for (const { targetCwd, paths, result } of results) {
            applyWorkingTreeFileEnrichmentResult(targetCwd, paths, result);
          }
        })
        .catch((nextError: unknown) => {
          if (workingTreeEnrichmentGenerationRef.current === generation) {
            setError(errorMessage(nextError));
          }
        })
        .finally(() => {
          for (const key of keys) {
            inFlightWorkingTreeEnrichmentPathsRef.current.delete(key);
          }
          enrichmentRunningRef.current = false;
          if (pendingWorkingTreeEnrichmentPathsRef.current.size > 0) {
            workingTreeEnrichmentTimerRef.current = window.setTimeout(
              () => flushEnrichmentRef.current(),
              50,
            );
          }
        });
    },
    [api, applyWorkingTreeFileEnrichmentResult],
  );

  useEffect(() => {
    flushEnrichmentRef.current = flushWorkingTreeFileEnrichmentQueue;
  }, [flushWorkingTreeFileEnrichmentQueue]);

  const queueWorkingTreeFileEnrichment = useCallback(
    (file: PanelChangedFile, targetCwd: string) => {
      if (!api || !shouldEnrichWorkingTreeFile(file)) return;
      const key = enrichmentFileKey(targetCwd, file.path);
      if (
        enrichedWorkingTreeFilesRef.current.has(key) ||
        hiddenWorkingTreePathsRef.current.has(key) ||
        inFlightWorkingTreeEnrichmentPathsRef.current.has(key)
      ) {
        return;
      }
      pendingWorkingTreeEnrichmentPathsRef.current.add(key);
      if (workingTreeEnrichmentTimerRef.current !== null) return;
      workingTreeEnrichmentTimerRef.current = window.setTimeout(
        flushWorkingTreeFileEnrichmentQueue,
        50,
      );
    },
    [api, flushWorkingTreeFileEnrichmentQueue],
  );

  // Each landed snapshot is a fresh observation of the working tree. Paths it no longer lists, or
  // lists with another status, lose their enrichment, including reads still queued or running.
  // Untracked content can change without changing its status, so every other enriched path is
  // reread while its displayed value stays, and paths with no enrichment are queued again.
  const revalidateWorkingTreeFileEnrichment = useCallback(
    (previous: VcsPanelSnapshotResult | null, next: VcsPanelSnapshotResult) => {
      const pending = pendingWorkingTreeEnrichmentPathsRef.current;
      const inFlight = inFlightWorkingTreeEnrichmentPathsRef.current;
      const revalidating = revalidatingWorkingTreeEnrichmentPathsRef.current;
      const enriched = enrichedWorkingTreeFilesRef.current;
      const hidden = hiddenWorkingTreePathsRef.current;
      const { staleKeys, reread, missing, dropRunningBatch } =
        planWorkingTreeEnrichmentRevalidation({
          previous,
          next,
          cwd,
          enrichedFilesByPath: enriched,
          hiddenPaths: hidden,
          pendingPaths: pending,
          inFlightPaths: inFlight,
        });
      if (dropRunningBatch) {
        // The running batch's results may describe paths or renames this snapshot invalidated,
        // so they are dropped and its still-valid paths are read again.
        workingTreeEnrichmentGenerationRef.current += 1;
        inFlight.clear();
      }
      for (const key of staleKeys) {
        pending.delete(key);
        revalidating.delete(key);
      }
      if ([...staleKeys].some((key) => enriched.has(key) || hidden.has(key))) {
        const nextEnriched = new Map(enriched);
        const nextHidden = new Set(hidden);
        for (const key of staleKeys) {
          nextEnriched.delete(key);
          nextHidden.delete(key);
        }
        enrichedWorkingTreeFilesRef.current = nextEnriched;
        hiddenWorkingTreePathsRef.current = nextHidden;
        setEnrichedWorkingTreeFilesByPath(nextEnriched);
        setHiddenWorkingTreePaths(nextHidden);
      }
      for (const key of reread) {
        pending.add(key);
        revalidating.add(key);
      }
      for (const key of missing) pending.add(key);
      if (pending.size > 0 && workingTreeEnrichmentTimerRef.current === null) {
        workingTreeEnrichmentTimerRef.current = window.setTimeout(
          () => flushEnrichmentRef.current(),
          50,
        );
      }
    },
    [cwd],
  );

  // Totals cover the snapshot, including collapsed trees and offscreen files.
  useEffect(() => {
    if (!snapshot) return;
    for (const file of mergePanelChangeGroups(snapshot.changeGroups)) {
      queueWorkingTreeFileEnrichment(file, cwd);
    }
    for (const changeSet of snapshot.worktreeChangeSets) {
      for (const file of mergePanelChangeGroups(changeSet.changeGroups)) {
        queueWorkingTreeFileEnrichment(file, changeSet.worktreePath);
      }
    }
  }, [cwd, snapshot, queueWorkingTreeFileEnrichment]);

  useEffect(
    () => () => {
      workingTreeEnrichmentGenerationRef.current += 1;
      pendingWorkingTreeEnrichmentPathsRef.current.clear();
      revalidatingWorkingTreeEnrichmentPathsRef.current.clear();
      if (workingTreeEnrichmentTimerRef.current !== null) {
        window.clearTimeout(workingTreeEnrichmentTimerRef.current);
      }
    },
    [],
  );

  const syncChangedPathSelection = useCallback((groups: readonly VcsPanelChangeGroup[]) => {
    const nextChangedPaths = mergePanelChangeGroups(groups).map((file) => file.path);
    const currentPaths = new Set(nextChangedPaths);
    const previousPaths = previousChangedPathsRef.current;
    setSelectedChangePaths((current) => {
      const next = new Set([...current].filter((path) => currentPaths.has(path)));
      for (const path of nextChangedPaths) {
        if (!previousPaths.has(path)) {
          next.add(path);
        }
      }
      return next;
    });
    previousChangedPathsRef.current = currentPaths;
  }, []);

  const syncWorktreeChangedPathSelection = useCallback(
    (changeSets: readonly VcsPanelWorktreeChangeSet[]) => {
      const previousById = previousWorktreeChangedPathsRef.current;
      const nextPreviousById = new Map<string, ReadonlySet<string>>();
      setSelectedWorktreeChangePaths((current) => {
        const next = new Map<string, ReadonlySet<string>>();
        for (const changeSet of changeSets) {
          const id = worktreeChangeSetId(changeSet);
          const paths = mergePanelChangeGroups(changeSet.changeGroups).map((file) => file.path);
          const currentPaths = new Set(paths);
          if (currentPaths.size === 0) continue;
          const previousPaths = previousById.get(id) ?? new Set<string>();
          const selectedPaths = new Set(
            [...(current.get(id) ?? [])].filter((path) => currentPaths.has(path)),
          );
          for (const path of paths) {
            if (!previousPaths.has(path)) {
              selectedPaths.add(path);
            }
          }
          next.set(id, selectedPaths);
          nextPreviousById.set(id, currentPaths);
        }
        return next;
      });
      previousWorktreeChangedPathsRef.current = nextPreviousById;
    },
    [],
  );

  const fileDiffSourceKey = useCallback((source: FileDiffSource) => {
    switch (source.kind) {
      case "working-tree":
        return `working:${source.staged ? "staged" : "unstaged"}`;
      case "commit":
        return `commit:${source.sha}`;
      case "compare":
        return `compare:${source.baseRef}:${source.refName}`;
      case "stash":
        return `stash:${source.stashRef}`;
    }
  }, []);

  const fileDiffKey = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) =>
      `${targetCwd}:${fileDiffSourceKey(source)}:${file.path}:${file.originalPath ?? ""}:${file.status}`,
    [cwd, fileDiffSourceKey],
  );

  const loadFileDiff = useCallback(
    (
      file: VcsPanelFileChange,
      source: FileDiffSource,
      targetCwd = cwd,
      options: { readonly preserveLoaded?: boolean } = {},
    ) => {
      if (!api) return;
      const key = fileDiffKey(file, source, targetCwd);
      const originalPath = renameOriginalPathForFile(file);
      const requestId = beginPanelDetailRequest(fileDiffRequestIdsRef.current, key);
      setFileDiffsByKey((current) => {
        const currentState = current.get(key);
        const nextState = beginPanelFileDiffLoad(currentState, options);
        if (nextState === currentState) return current;
        const next = new Map(current);
        next.set(key, nextState);
        return next;
      });
      void api.vcs
        .readFileDiff({
          cwd: targetCwd,
          path: file.path,
          ...(originalPath ? { originalPath } : {}),
          staged: source.kind === "working-tree" ? source.staged : false,
          source,
        })
        .then((result) => {
          if (!isLatestPanelDetailRequest(fileDiffRequestIdsRef.current, key, requestId)) return;
          setFileDiffsByKey((current) => {
            const currentState = current.get(key);
            const nextState = completePanelFileDiffLoad(currentState, result.patch);
            if (nextState === currentState) return current;
            const next = new Map(current);
            next.set(key, nextState);
            return next;
          });
        })
        .catch((nextError: unknown) => {
          if (!isLatestPanelDetailRequest(fileDiffRequestIdsRef.current, key, requestId)) return;
          setFileDiffsByKey((current) => {
            const currentState = current.get(key);
            const nextState = failPanelFileDiffLoad(currentState, errorMessage(nextError), options);
            if (nextState === currentState) return current;
            const next = new Map(current);
            next.set(key, nextState);
            return next;
          });
        });
    },
    [api, cwd, fileDiffKey],
  );

  const reloadExpandedWorkingTreeDiffs = useCallback(
    (nextSnapshot: VcsPanelSnapshotResult, options: { readonly preserveLoaded?: boolean } = {}) => {
      const expandedKeys = expandedFileDiffsRef.current;
      if (expandedKeys.size === 0) return;

      const reloadChangeSet = (targetCwd: string, files: readonly PanelChangedFile[]) => {
        for (const file of files) {
          const source = {
            kind: "working-tree",
            staged: !file.hasUnstagedChanges && file.hasStagedChanges,
          } satisfies FileDiffSource;
          if (expandedKeys.has(fileDiffKey(file, source, targetCwd))) {
            loadFileDiff(file, source, targetCwd, options);
          }
        }
      };

      reloadChangeSet(cwd, mergePanelChangeGroups(nextSnapshot.changeGroups));
      for (const changeSet of nextSnapshot.worktreeChangeSets) {
        reloadChangeSet(changeSet.worktreePath, mergePanelChangeGroups(changeSet.changeGroups));
      }
    },
    [cwd, fileDiffKey, loadFileDiff],
  );

  // Reloads open compare patches after their refs may have moved; collapsed ones reload when
  // reopened. Per-key request ids keep older responses from restoring a stale patch.
  const reloadExpandedCompareDiffs = useCallback(() => {
    const expandedKeys = expandedFileDiffsRef.current;
    if (expandedKeys.size === 0) return;
    for (const { file, source } of branchCompareFileDiffRequests(
      branchDetailsByRefRef.current.values(),
    )) {
      if (expandedKeys.has(fileDiffKey(file, source, cwd))) {
        loadFileDiff(file, source, cwd, { preserveLoaded: true });
      }
    }
  }, [cwd, fileDiffKey, loadFileDiff]);

  // Authoritative hydration follows a mutation, so it reads fresh instead of joining a details
  // read that may have started before the mutation.
  const hydrateExpandedBranchDetails = useCallback(
    async (
      nextSnapshot: VcsPanelSnapshotResult,
      options: { readonly reloadAll?: boolean; readonly authoritative?: boolean } = {},
    ) => {
      if (!api) return;
      const compareBaseFor = (request: {
        readonly branch: VcsRef;
        readonly detailsKey: string;
        readonly compareBaseRef?: string;
      }) =>
        request.compareBaseRef ??
        compareBaseOverridesRef.current.get(request.detailsKey) ??
        compareBaseOverridesRef.current.get(request.branch.name);
      const expandedBranches = expandedBranchesForSnapshot(nextSnapshot, expandedTreeRef.current);
      const branchRequests = (
        options.reloadAll
          ? expandedBranches
          : expandedBranches.filter((request) => {
              const existing = branchDetailsByRefRef.current.get(request.detailsKey);
              if (!existing) return true;
              const baseRef = compareBaseFor(request);
              return baseRef ? existing.baseRef !== baseRef : false;
            })
      ).map((request) => ({ ...request, requestedBaseRef: compareBaseFor(request) }));
      if (options.reloadAll) {
        // A read still running for a branch this reload does not reread, such as one collapsed
        // since its expansion, would land pre-reload details, so it loses ownership now.
        const superseded = new Set(
          supersedePanelDetailRequests(
            branchDetailRequestsRef.current,
            new Set(branchRequests.map((request) => request.detailsKey)),
          ),
        );
        setLoadingBranchDetails((current) =>
          [...current].some((key) => superseded.has(key))
            ? new Set([...current].filter((key) => !superseded.has(key)))
            : current,
        );
        // A branch-list change makes loaded details obsolete. Dropping them now rather than when
        // the reads land keeps details that expansion writes while these reads run.
        setBranchDetailsByRef((current) => {
          const next = retainBranchDetailsForReload(
            current,
            nextSnapshot.branchDetails,
            branchRequests.map((request) => request.detailsKey),
          );
          branchDetailsByRefRef.current = next;
          return next;
        });
      }
      if (branchRequests.length === 0) return;

      // Each read owns its key until a later hydration, expansion, compare-base choice, or page
      // load for that key starts, so a result never replaces details newer than its request.
      const requestIds = branchRequests.map((request) =>
        beginPanelDetailRequest(branchDetailRequestsRef.current, request.detailsKey),
      );
      const ownsRequest = (index: number) =>
        isLatestPanelDetailRequest(
          branchDetailRequestsRef.current,
          branchRequests[index]!.detailsKey,
          requestIds[index]!,
        );
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        for (const request of branchRequests) {
          next.add(request.detailsKey);
        }
        return next;
      });
      const readDetails = options.authoritative ? api.vcs.readBranchDetails : api.vcs.branchDetails;
      try {
        const details = await Promise.all(
          branchRequests.map((request) =>
            readDetails({
              cwd,
              branch: request.branch,
              defaultCompareRef: nextSnapshot.defaultCompareRef,
              compareBaseRef: request.requestedBaseRef,
            }),
          ),
        );
        const landed = branchRequests.flatMap((request, index) => {
          const detail = details[index];
          return detail && ownsRequest(index) ? [{ request, detail }] : [];
        });
        if (landed.length > 0) {
          setBranchDetailsByRef((current) => {
            let next = current;
            for (const { request, detail } of landed) {
              next = withBranchDetails(next, request, detail);
            }
            branchDetailsByRefRef.current = next;
            return next;
          });
        }
      } finally {
        const settledKeys = branchRequests.flatMap((request, index) =>
          ownsRequest(index) ? [request.detailsKey] : [],
        );
        setLoadingBranchDetails((current) => {
          const next = new Set(current);
          for (const key of settledKeys) next.delete(key);
          return next;
        });
      }
    },
    [api, cwd],
  );

  const hydrateExpandedStashDetails = useCallback(
    async (
      nextSnapshot: VcsPanelSnapshotResult,
      options: { readonly reloadAll?: boolean } = {},
    ) => {
      if (!api) return;
      const expandedStashes = expandedStashesForSnapshot(nextSnapshot, expandedTreeRef.current);
      const stashRequests = options.reloadAll
        ? expandedStashes
        : expandedStashes.filter((stash) => !stashDetailsByKeyRef.current.has(stash.detailsKey));
      if (stashRequests.length === 0) return;

      setLoadingStashDetails((current) => {
        const next = new Set(current);
        for (const stash of stashRequests) {
          next.add(stash.detailsKey);
        }
        return next;
      });
      try {
        const details = await Promise.all(
          stashRequests.map((stash) => api.vcs.stashDetails({ cwd, stashRef: stash.stashRef })),
        );
        setStashDetailsByKey((current) => {
          const next = new Map(current);
          for (const [index, detail] of details.entries()) {
            const request = stashRequests[index];
            if (!request) continue;
            next.set(request.detailsKey, detail);
          }
          stashDetailsByKeyRef.current = next;
          return next;
        });
      } finally {
        setLoadingStashDetails((current) => {
          const next = new Set(current);
          for (const stash of stashRequests) {
            next.delete(stash.detailsKey);
          }
          return next;
        });
      }
    },
    [api, cwd],
  );

  return {
    canWriteSourceControl,
    addRemoteOpen,
    api,
    branchDetailRequestsRef,
    branchDetailsByRef,
    changedFiles,
    collapsed,
    collapsedDefaultTree,
    commitDialogOpen,
    commitMessageId,
    compareBaseDialogTarget,
    compareBaseOverrides,
    compareBaseQuery,
    compareBaseRefs,
    containerRef,
    coveredVcsStatusRef,
    cwd,
    dialogCommitMessage,
    dialogStashMessage,
    displayedChangeGroups,
    dismissError,
    divergedSyncTarget,
    enrichedWorkingTreeFilesByPath,
    environmentId,
    error: sourceControlPanelError(error, mutationError),
    expandedFileDiffs,
    expandedFileDiffsRef,
    expandedTree,
    expandedTreeRef,
    fileDiffKey,
    activeThreadRef,
    fileDiffsByKey,
    filteredCompareBaseRefs,
    gitAction,
    hiddenWorkingTreePaths,
    hydrateExpandedBranchDetails,
    hydrateExpandedStashDetails,
    initialFetchCwdRef,
    isActionRunning,
    lastFocusRefreshAtRef,
    lastVcsStatusRefreshRef,
    latestVcsStatusRef,
    loadFileDiff,
    loading,
    loadingBranchDetails,
    loadingStashDetails,
    mutationErrorVersionRef,
    onThreadRefChange,
    openInPreferredEditor,
    peerSyncTargets,
    presentationState,
    publishRemoteTarget,
    refreshQueueRef,
    reloadExpandedCompareDiffs,
    reloadExpandedWorkingTreeDiffs,
    remoteName,
    remoteUrl,
    reportMutationError,
    revalidateWorkingTreeFileEnrichment,
    resolvedTheme,
    runningActions,
    sectionWeights,
    selectedChangePathList,
    selectedChangePaths,
    selectedChangedFiles,
    selectedWorktreeChangePaths,
    setAddRemoteOpen,
    setBranchDetailsByRef,
    setCollapsed,
    setCollapsedDefaultTree,
    setCommitDialogOpen,
    setCompareBaseDialogTarget,
    setCompareBaseOverrides,
    setCompareBaseQuery,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncTarget,
    setError,
    setExpandedFileDiffs,
    setExpandedTree,
    setLoading,
    setLoadingBranchDetails,
    setLoadingStashDetails,
    setMutationError,
    setPublishRemoteTarget,
    setRemoteName,
    setRemoteUrl,
    setRunningActions,
    setSectionWeights,
    setSelectedChangePaths,
    setSelectedWorktreeChangePaths,
    setSnapshot,
    setStashDetailsByKey,
    setStashDialogTarget,
    snapshot,
    snapshotFingerprintRef,
    snapshotRef,
    sourceControlAllRemotesFetchIntervalMs,
    stashDetailsByKey,
    stashDialogTarget,
    stashMessageId,
    syncChangedPathSelection,
    syncWorktreeChangedPathSelection,
    threadId,
    toggleAllChangedFilesSelection,
    vcsStatus,
    vcsStatusFingerprint,
    worktreeChangeSetViews,
    worktreePath,
  };
}

export type SourceControlPanelState = ReturnType<typeof useSourceControlPanelState>;

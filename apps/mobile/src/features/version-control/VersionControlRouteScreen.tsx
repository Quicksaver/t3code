import { panelBranchDetailsFingerprint } from "@t3tools/shared/sourceControl";
import type {
  VcsPanelBranchDetails,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelStashDetails,
  VcsPanelSnapshotResult,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import {
  panelBranchOperationCwd,
  panelBranchPushTargetSha,
  panelBranchSyncState,
} from "@t3tools/shared/sourceControl";
import { useAtomValue } from "@effect/atom-react";
import * as Duration from "effect/Duration";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { retainMobileBackgroundActivityScope } from "../../connection/background-activity-scopes";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import {
  actionableLocalBranches,
  applyWorkingTreeEnrichments,
  beginVersionControlAction,
  beginDetailRequest,
  clearResolvedDetailError,
  detailRequestIsCurrent,
  discardableFiles,
  discardPathGroups,
  divergedForceSyncMessage,
  localBranchesByUpstream,
  mergeWorkingTreeEnrichment,
  operationPaths,
  panelChangeSets,
  newlyInitializedCurrentChangeSetCwds,
  reconcileSelectedPaths,
  retainWorkingTreeEnrichments,
  snapshotForCwd,
  snapshotIsPendingForCwd,
  stashIdentityKey,
  stashReadRef,
  validateWorkingTreeEnrichment,
  versionControlSupport,
  workingTreeEnrichmentRequests,
  type CwdScopedSnapshot,
  type VersionControlChangeSet,
  type VersionControlSupport,
} from "./versionControlModel";
import {
  VersionControlCommandInterrupted,
  useVersionControlPanelApi,
} from "./useVersionControlPanelApi";
import {
  createSnapshotRequestScope,
  createWorkingTreeEnrichmentQueue,
  requestVersionControlRefresh,
  retainPullRefreshIndicator,
  retryInterruptedVersionControlRequest,
  runAutomaticRemoteFetch,
  type VersionControlRefreshOptions,
  type VersionControlRefreshQueue,
  type WorkingTreeEnrichmentBatch,
  VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS,
} from "./versionControlRequest";
import { type PublishRequest, VersionControlSupportState } from "./VersionControlRouteComponents";
import { VersionControlRouteView } from "./VersionControlRouteView";

type VersionControlRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;

interface FileDiffRequest {
  readonly cwd: string;
  readonly file: VcsPanelFileChange;
  readonly source: FileDiffSource;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The Version Control operation failed.";
}

export function useVersionControlRouteController(props: VersionControlRouteScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const api = useVersionControlPanelApi(environmentId);
  const canWriteSourceControl = useAtomValue(
    vcsEnvironment.panelStageFiles.permissionAtom(environmentId),
  );
  const serverSettings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  const sourceControlAllRemotesFetchIntervalMs = Duration.toMillis(
    resolveServerBackgroundActivitySettings(serverSettings).sourceControlAllRemotesFetchInterval,
  );
  const statusQuery = useEnvironmentQuery(
    selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const [scopedSnapshot, setScopedSnapshot] = useState<{
    readonly cwd: string;
    readonly snapshot: VcsPanelSnapshotResult;
  } | null>(null);
  const rawSnapshot = snapshotForCwd(scopedSnapshot, selectedThreadCwd);
  // Enrichment lives beside the raw snapshot, keyed by change-set cwd, so refreshes keep the
  // results for surviving paths and selection reconciles against the server's own paths.
  const [enrichments, setEnrichments] = useState<
    ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult>
  >(new Map());
  const snapshot = useMemo(
    () =>
      rawSnapshot && selectedThreadCwd && enrichments.size > 0
        ? applyWorkingTreeEnrichments(rawSnapshot, selectedThreadCwd, enrichments)
        : rawSnapshot,
    [enrichments, rawSnapshot, selectedThreadCwd],
  );
  const [loading, setLoading] = useState(true);
  const [settledSnapshotCwd, setSettledSnapshotCwd] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const runningActionKeysRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
    () => new Set(selectedThreadCwd ? [`changes:${selectedThreadCwd}`] : []),
  );
  const expandedRowsRef = useRef<ReadonlySet<string>>(expandedRows);
  const [selectedByCwd, setSelectedByCwd] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  );
  const knownPathsByCwd = useRef(new Map<string, Set<string>>());
  const initializedChangeSetCwds = useRef(new Set<string>());
  const [branchDetails, setBranchDetails] = useState<ReadonlyMap<string, VcsPanelBranchDetails>>(
    new Map(),
  );
  const [stashDetails, setStashDetails] = useState<ReadonlyMap<string, VcsPanelStashDetails>>(
    new Map(),
  );
  const [detailErrors, setDetailErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [publishRequest, setPublishRequest] = useState<PublishRequest | null>(null);
  const [snapshotRequests] = useState(createSnapshotRequestScope);
  const detailRequestIds = useRef(new Map<string, number>());
  const selectedThreadCwdRef = useRef(selectedThreadCwd);
  const snapshotRevision = useRef(0);
  const detailsFingerprint = useRef<string | null>(null);
  const snapshotFingerprint = useRef<string | null>(null);
  // The latest accepted raw snapshot, which enrichment responses are validated against on arrival.
  const latestSnapshotRef = useRef<CwdScopedSnapshot | null>(null);
  const refreshQueue = useRef<VersionControlRefreshQueue | null>(null);
  const automaticFetchesInFlight = useRef(new Set<string>());

  useLayoutEffect(() => {
    selectedThreadCwdRef.current = selectedThreadCwd;
  }, [selectedThreadCwd]);

  useEffect(() => {
    expandedRowsRef.current = expandedRows;
  }, [expandedRows]);

  useEffect(() => {
    if (!selectedThreadCwd) return;
    return retainMobileBackgroundActivityScope(environmentId, {
      type: "git-refs",
      cwd: selectedThreadCwd,
    });
  }, [environmentId, selectedThreadCwd]);

  const syncSelections = useCallback((nextSnapshot: VcsPanelSnapshotResult, cwd: string) => {
    const changeSets = panelChangeSets(nextSnapshot, cwd);
    const newlyInitializedCurrentCwds = newlyInitializedCurrentChangeSetCwds(
      changeSets,
      initializedChangeSetCwds.current,
    );
    const previousKnownPaths = knownPathsByCwd.current;
    const nextKnownPaths = new Map(
      changeSets.map(
        (changeSet) => [changeSet.cwd, new Set(changeSet.files.map((file) => file.path))] as const,
      ),
    );
    knownPathsByCwd.current = nextKnownPaths;

    setExpandedRows((current) => {
      const next = new Set(current);
      for (const changeSetCwd of newlyInitializedCurrentCwds) next.add(`changes:${changeSetCwd}`);
      return next;
    });
    setSelectedByCwd((current) =>
      reconcileSelectedPaths({
        changeSets,
        previousKnownPaths,
        selectedByCwd: current,
      }),
    );
  }, []);

  useEffect(() => {
    if (rawSnapshot && selectedThreadCwd) syncSelections(rawSnapshot, selectedThreadCwd);
  }, [rawSnapshot, selectedThreadCwd, syncSelections]);

  const applyEnrichmentResult = useCallback(
    (batch: WorkingTreeEnrichmentBatch, result: VcsPanelWorkingTreeFileEnrichmentResult) => {
      const valid = validateWorkingTreeEnrichment(result, latestSnapshotRef.current, batch.cwd);
      setEnrichments((current) => mergeWorkingTreeEnrichment(current, batch, valid));
    },
    [],
  );
  const enrichmentQueue = useMemo(
    () =>
      // oxlint-disable-next-line react/refs -- onResult reads the ref when a response lands, not during render.
      createWorkingTreeEnrichmentQueue({
        enrich: (batch) => api.enrichWorkingTreeFiles({ cwd: batch.cwd, paths: [...batch.paths] }),
        onResult: applyEnrichmentResult,
      }),
    [api, applyEnrichmentResult],
  );
  useEffect(() => () => enrichmentQueue.request([]), [enrichmentQueue]);
  // An unmounted controller must neither start reads nor let one in flight request enrichment.
  useEffect(() => {
    snapshotRequests.activate();
    return () => snapshotRequests.dispose();
  }, [snapshotRequests]);

  const performSnapshotRefresh = useCallback(
    async (requestCwd: string | null, options: VersionControlRefreshOptions) => {
      if (requestCwd !== selectedThreadCwdRef.current) return;
      const requestId = snapshotRequests.begin();
      if (requestId === null) return;
      const requestIsCurrent = () =>
        snapshotRequests.isCurrent(requestId, requestCwd, selectedThreadCwdRef.current);
      setRefreshing((current) => retainPullRefreshIndicator(current, options.pull === true));
      if (!requestCwd) {
        if (requestIsCurrent()) {
          setSettledSnapshotCwd(null);
          setLoading(false);
          setRefreshing(false);
        }
        return;
      }
      setSettledSnapshotCwd((current) => (current === requestCwd ? null : current));
      try {
        const rawSnapshot = options.authoritative
          ? await api.readSnapshot({ cwd: requestCwd, refresh: "full" })
          : await api.snapshot({
              cwd: requestCwd,
              refresh: options.refresh ?? "full",
            });
        if (!requestIsCurrent()) return;
        latestSnapshotRef.current = { cwd: requestCwd, snapshot: rawSnapshot };
        const enrichmentRequests = workingTreeEnrichmentRequests(rawSnapshot, requestCwd);
        const nextFingerprint = `${requestCwd}\0${JSON.stringify(rawSnapshot)}`;
        if (snapshotFingerprint.current !== nextFingerprint) {
          snapshotFingerprint.current = nextFingerprint;
          const nextDetailsFingerprint = `${requestCwd}\0${panelBranchDetailsFingerprint(rawSnapshot)}\0${JSON.stringify(rawSnapshot.stashes)}`;
          if (
            detailsFingerprint.current !== nextDetailsFingerprint ||
            options.refresh !== "working-tree"
          ) {
            detailsFingerprint.current = nextDetailsFingerprint;
            snapshotRevision.current += 1;
            setBranchDetails(new Map());
            setStashDetails(new Map());
            setDetailErrors(new Map());
            setExpandedRows(
              (current) =>
                new Set(
                  [...current].filter(
                    (key) =>
                      !key.startsWith("branch:") &&
                      !key.startsWith("fork:") &&
                      !key.startsWith("commit:") &&
                      !key.startsWith("stash:"),
                  ),
                ),
            );
          }
          setEnrichments((current) => retainWorkingTreeEnrichments(current, enrichmentRequests));
          setScopedSnapshot({ cwd: requestCwd, snapshot: rawSnapshot });
        }
        // Untracked rows carry no content identity, so even an unchanged raw snapshot can hide
        // edited files. Every accepted read revalidates enrichment, which also retries batches
        // that failed earlier; visible results stay until their batch replaces them.
        // Totals cover the snapshot, including collapsed and offscreen working trees.
        enrichmentQueue.request(enrichmentRequests);
        setError(null);
      } catch (cause) {
        if (requestIsCurrent() && !(cause instanceof VersionControlCommandInterrupted)) {
          setError(errorMessage(cause));
        }
      } finally {
        if (requestIsCurrent()) {
          setSettledSnapshotCwd(requestCwd);
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api, enrichmentQueue, snapshotRequests],
  );

  const refreshSnapshot = useCallback(
    (options: VersionControlRefreshOptions = {}): Promise<void> => {
      const requestCwd = selectedThreadCwd;
      if (requestCwd !== selectedThreadCwdRef.current) return Promise.resolve();
      if (options.pull === true && refreshQueue.current?.cwd === requestCwd) setRefreshing(true);
      return requestVersionControlRefresh(refreshQueue, requestCwd, options, (nextOptions) =>
        performSnapshotRefresh(requestCwd, nextOptions),
      );
    },
    [performSnapshotRefresh, selectedThreadCwd],
  );

  const refreshStatus = statusQuery.refresh;
  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      if (!canWriteSourceControl) return false;
      if (!beginVersionControlAction(runningActionKeysRef.current, label)) return false;
      setBusyAction(label);
      setError(null);
      setMutationError(null);
      let succeeded = false;
      let actionError: string | null = null;
      try {
        await action();
        succeeded = true;
      } catch (cause) {
        if (!(cause instanceof VersionControlCommandInterrupted)) actionError = errorMessage(cause);
      } finally {
        try {
          await refreshSnapshot({ authoritative: true });
          refreshStatus();
          if (actionError) setMutationError(actionError);
        } finally {
          runningActionKeysRef.current.delete(label);
          setBusyAction((current) => (current === label ? null : current));
        }
      }
      return succeeded;
    },
    [canWriteSourceControl, refreshSnapshot, refreshStatus],
  );

  useFocusEffect(
    useCallback(() => {
      if (!selectedThreadCwd) return;
      const cwd = selectedThreadCwd;
      void refreshSnapshot({ refresh: "working-tree" });
      if (!canWriteSourceControl || sourceControlAllRemotesFetchIntervalMs <= 0) return;

      const refreshAllRemotes = () => {
        void runAutomaticRemoteFetch({
          cwd,
          inFlightCwds: automaticFetchesInFlight.current,
          fetch: () => api.fetchAllRemotes({ cwd }),
          refresh: () => refreshSnapshot(),
        });
      };
      refreshAllRemotes();
      const interval = setInterval(refreshAllRemotes, sourceControlAllRemotesFetchIntervalMs);
      return () => clearInterval(interval);
    }, [
      api,
      canWriteSourceControl,
      refreshSnapshot,
      selectedThreadCwd,
      sourceControlAllRemotesFetchIntervalMs,
    ]),
  );

  const statusFingerprint = statusQuery.data ? JSON.stringify(statusQuery.data) : null;
  const lastStatusRefresh = useRef<{
    readonly data: VcsStatusResult;
    readonly fingerprint: string;
  } | null>(null);
  useEffect(() => {
    if (!statusQuery.data || !statusFingerprint) return;
    const previous = lastStatusRefresh.current;
    if (previous?.data === statusQuery.data && previous.fingerprint === statusFingerprint) return;
    lastStatusRefresh.current = {
      data: statusQuery.data,
      fingerprint: statusFingerprint,
    };
    if (previous) void refreshSnapshot({ refresh: "working-tree" });
  }, [refreshSnapshot, statusFingerprint, statusQuery.data]);

  const changeSets = useMemo(
    () => (snapshot && selectedThreadCwd ? panelChangeSets(snapshot, selectedThreadCwd) : []),
    [selectedThreadCwd, snapshot],
  );
  const localBranches = useMemo(
    () => (snapshot ? actionableLocalBranches(snapshot) : []),
    [snapshot],
  );
  const snapshotLocalBranches = snapshot?.localBranches;
  const localBranchIndex = useMemo(
    () => localBranchesByUpstream(snapshotLocalBranches ?? []),
    [snapshotLocalBranches],
  );
  const actionCount =
    changeSets.length +
    localBranches.length +
    (snapshot?.actionableForkBranches.length ?? 0) +
    (snapshot?.stashes.length ?? 0);
  const busy = busyAction !== null;
  const header = <VersionControlScreenHeader />;

  const toggleExpanded = useCallback((key: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      expandedRowsRef.current = next;
      return next;
    });
  }, []);

  const openFileDiff = useCallback(
    (request: FileDiffRequest) => {
      navigation.navigate("VersionControlDiff", {
        environmentId: String(environmentId),
        cwd: request.cwd,
        file: request.file,
        source: request.source,
      });
    },
    [environmentId, navigation],
  );

  const toggleSelectedFile = useCallback((cwd: string, path: string) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = new Set(next.get(cwd) ?? []);
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      next.set(cwd, selected);
      return next;
    });
  }, []);

  const selectAllFiles = useCallback((changeSet: VersionControlChangeSet) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = next.get(changeSet.cwd) ?? new Set();
      // Selection reconciles against raw paths, so it may also hold rename originals that
      // enrichment hides; compare against the visible rows only.
      next.set(
        changeSet.cwd,
        changeSet.files.every((file) => selected.has(file.path))
          ? new Set()
          : new Set(changeSet.files.map((file) => file.path)),
      );
      return next;
    });
  }, []);

  const selectedFiles = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const selected = selectedByCwd.get(changeSet.cwd) ?? new Set();
      return changeSet.files.filter((file) => selected.has(file.path));
    },
    [selectedByCwd],
  );

  const commitSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("commit", async () => {
        await api.commitStaged({ cwd: changeSet.cwd, paths });
      });
    },
    [api, runAction, selectedFiles],
  );

  const stashSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("stash", () =>
        api.createStash({ cwd: changeSet.cwd, paths, includeUntracked: true }),
      );
    },
    [api, runAction, selectedFiles],
  );

  const discardSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      if (!canWriteSourceControl) return;
      const files = discardableFiles(selectedFiles(changeSet));
      const paths = discardPathGroups(files);
      if (paths.staged.length === 0 && paths.unstaged.length === 0) return;
      Alert.alert(
        "Discard selected changes?",
        `This permanently discards changes in ${files.length} selected file${files.length === 1 ? "" : "s"}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () =>
              void runAction("discard", async () => {
                if (paths.unstaged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.unstaged,
                  });
                }
                if (paths.staged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.staged,
                    staged: true,
                  });
                }
              }),
          },
        ],
      );
    },
    [canWriteSourceControl, api, runAction, selectedFiles],
  );

  const loadBranchDetails = useCallback(
    (branch: VcsRef, key: string, compareBaseRef?: string) => {
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!snapshot || branchDetails.has(key) || wasExpanded) return;
      const previousDetailError = detailErrors.get(key) ?? null;
      const revision = snapshotRevision.current;
      const requestId = beginDetailRequest(detailRequestIds.current, key);
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.branchDetails({
          cwd: selectedThreadCwd ?? "",
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          ...(compareBaseRef ? { compareBaseRef } : {}),
        }),
      )
        .then((details) => {
          if (
            revision !== snapshotRevision.current ||
            !detailRequestIsCurrent(detailRequestIds.current, key, requestId)
          ) {
            return;
          }
          setBranchDetails((current) => new Map(current).set(key, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setError((current) => clearResolvedDetailError(current, previousDetailError));
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            detailRequestIsCurrent(detailRequestIds.current, key, requestId) &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, branchDetails, detailErrors, selectedThreadCwd, snapshot, toggleExpanded],
  );

  const publishBranch = useCallback(
    (branch: VcsRef, targetCwd: string) => {
      if (!canWriteSourceControl) return;
      if (!snapshot) return;
      if (snapshot.remotes.length === 0) {
        setError("Add a remote before publishing this branch.");
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRequest({ branchName: branch.name, targetCwd });
        return;
      }
      const remote = snapshot.remotes[0];
      if (!remote) return;
      void runAction("publish", () =>
        api.pushBranch({
          cwd: targetCwd,
          branchName: branch.name,
          remoteName: remote.name,
        }),
      );
    },
    [canWriteSourceControl, api, runAction, snapshot],
  );

  const publishToRemote = useCallback(
    (remoteName: string) => {
      const request = publishRequest;
      if (!request) return;
      setPublishRequest(null);
      void runAction("publish", () =>
        api.pushBranch({
          cwd: request.targetCwd,
          branchName: request.branchName,
          remoteName,
        }),
      );
    },
    [api, publishRequest, runAction],
  );

  const syncBranch = useCallback(
    (branch: VcsRef) => {
      if (!canWriteSourceControl) return;
      if (!snapshot || !selectedThreadCwd) return;
      const state = panelBranchSyncState(branch, snapshot);
      const targetCwd = panelBranchOperationCwd(branch, selectedThreadCwd);
      if (state === "publish") {
        publishBranch(branch, targetCwd);
        return;
      }
      if (state === "push") {
        void runAction("push", () => api.pushBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "pull") {
        void runAction("pull", () => api.pullBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "fetch") {
        void runAction("fetch", () => api.fetchBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      Alert.alert("Branch has diverged", "Choose how to synchronize this branch.", [
        { text: "Cancel", style: "cancel" },
        // Merge sync runs only in the current checkout, matching web.
        ...(branch.current
          ? [
              {
                text: "Pull & merge",
                onPress: () =>
                  void runAction("merge-sync", async () => {
                    await api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      merge: true,
                    });
                    await api.pushBranch({ cwd: targetCwd, branchName: branch.name });
                  }),
              },
            ]
          : []),
        {
          text: "More…",
          onPress: () =>
            Alert.alert("Destructive sync", divergedForceSyncMessage(branch), [
              { text: "Cancel", style: "cancel" },
              {
                text: "Force pull",
                style: "destructive",
                onPress: () =>
                  void runAction("force-pull", () =>
                    api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                    }),
                  ),
              },
              {
                text: "Force push",
                style: "destructive",
                onPress: () =>
                  void runAction("force-push", () => {
                    // Replace only the remote tip the diverged snapshot showed.
                    const expectedRemoteSha = panelBranchPushTargetSha(branch, snapshot);
                    return api.pushBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                      ...(expectedRemoteSha ? { expectedRemoteSha } : {}),
                    });
                  }),
              },
            ]),
        },
      ]);
    },
    [canWriteSourceControl, api, publishBranch, runAction, selectedThreadCwd, snapshot],
  );

  const switchBranch = useCallback(
    (branch: VcsRef) => {
      void runAction("switch", async () => {
        await gitActions.onCheckoutSelectedThreadBranch(
          branch.name,
          VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS,
        );
      });
    },
    [gitActions, runAction],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef) => {
      if (!canWriteSourceControl) return;
      if (!selectedThreadCwd || branch.current || branch.worktreePath !== null) return;
      const remote = branch.isRemote === true;
      const runDelete = (force: boolean) =>
        void runAction("delete-branch", () =>
          api.deleteBranch({
            cwd: selectedThreadCwd,
            branchName: branch.name,
            ...(remote && branch.remoteName ? { remoteName: branch.remoteName } : {}),
            ...(force ? { force: true } : {}),
          }),
        );
      // The server refuses an unmerged local branch unless forced, so mobile offers the
      // force choice the refusal points to.
      Alert.alert(
        "Delete branch?",
        remote
          ? `Delete remote branch ${branch.name}?`
          : `Delete ${branch.name}? Force delete also discards commits that are not merged.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => runDelete(false) },
          ...(remote
            ? []
            : [
                {
                  text: "Force delete",
                  style: "destructive" as const,
                  onPress: () => runDelete(true),
                },
              ]),
        ],
      );
    },
    [canWriteSourceControl, api, runAction, selectedThreadCwd],
  );

  const mergeBranch = useCallback(
    (refName: string) => {
      if (!canWriteSourceControl) return;
      if (!selectedThreadCwd) return;
      Alert.alert("Merge branch?", `Merge ${refName} into the current branch?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          onPress: () =>
            void runAction("merge-branch", () =>
              api.mergeBranchIntoCurrent({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [canWriteSourceControl, api, runAction, selectedThreadCwd],
  );

  const rebaseBranch = useCallback(
    (refName: string) => {
      if (!canWriteSourceControl) return;
      if (!selectedThreadCwd) return;
      Alert.alert("Rebase branch?", `Rebase the current branch onto ${refName}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rebase",
          onPress: () =>
            void runAction("rebase-branch", () =>
              api.rebaseCurrentOnto({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [canWriteSourceControl, api, runAction, selectedThreadCwd],
  );

  const loadStashDetails = useCallback(
    (stash: VcsPanelSnapshotResult["stashes"][number]) => {
      const detailsKey = stashIdentityKey(stash);
      const key = `stash:${detailsKey}`;
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!selectedThreadCwd || stashDetails.has(detailsKey) || wasExpanded) return;
      const previousDetailError = detailErrors.get(key) ?? null;
      const revision = snapshotRevision.current;
      const requestId = beginDetailRequest(detailRequestIds.current, key);
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.stashDetails({ cwd: selectedThreadCwd, stashRef: stashReadRef(stash) }),
      )
        .then((details) => {
          if (
            revision !== snapshotRevision.current ||
            !detailRequestIsCurrent(detailRequestIds.current, key, requestId)
          ) {
            return;
          }
          setStashDetails((current) => new Map(current).set(detailsKey, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setError((current) => clearResolvedDetailError(current, previousDetailError));
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            detailRequestIsCurrent(detailRequestIds.current, key, requestId) &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, detailErrors, selectedThreadCwd, stashDetails, toggleExpanded],
  );

  return {
    canWriteSourceControl,
    actionableExpanded,
    actionCount,
    api,
    branchDetails,
    busy,
    busyAction,
    changeSets,
    commitSelected,
    deleteBranch,
    detailErrors,
    discardSelected,
    error,
    expandedRows,
    header,
    insets,
    loadBranchDetails,
    loadStashDetails,
    loading: loading || snapshotIsPendingForCwd(snapshot, selectedThreadCwd, settledSnapshotCwd),
    localBranches,
    localBranchIndex,
    mergeBranch,
    mutationError,
    openFileDiff,
    publishRequest,
    publishToRemote,
    rebaseBranch,
    refreshing,
    refreshSnapshot,
    remoteName,
    remotesExpanded,
    remoteUrl,
    runAction,
    selectAllFiles,
    selectedByCwd,
    selectedFiles,
    selectedThread,
    selectedThreadCwd,
    setActionableExpanded,
    setError,
    setMutationError,
    setPublishRequest,
    setRemoteName,
    setRemotesExpanded,
    setRemoteUrl,
    setShowAddRemote,
    showAddRemote,
    snapshot,
    stashDetails,
    stashSelected,
    switchBranch,
    syncBranch,
    toggleExpanded,
    toggleSelectedFile,
  };
}

export type VersionControlRouteController = ReturnType<typeof useVersionControlRouteController>;

export function useVersionControlSupport(environmentId: string): VersionControlSupport {
  return useAtomValue(
    serverEnvironment.configValueAtom(EnvironmentId.make(environmentId)),
    versionControlSupport,
  );
}

function VersionControlScreenHeader() {
  const navigation = useNavigation();
  return (
    <ScreenHeader
      title="Version Control"
      sidebar={false}
      actions={[
        {
          accessibilityLabel: "Close Version Control",
          icon: "xmark",
          onPress: () => navigation.goBack(),
        },
      ]}
    />
  );
}

function SupportedVersionControlRoute(props: VersionControlRouteScreenProps) {
  return <VersionControlRouteView controller={useVersionControlRouteController(props)} />;
}

// Direct entry and restored routes reach this screen without the menu's capability check, and a
// reconnect can land on an older server, so the controller mounts only while it is supported.
export function VersionControlRouteScreen(props: VersionControlRouteScreenProps) {
  const support = useVersionControlSupport(props.route.params.environmentId);
  if (support === "supported") return <SupportedVersionControlRoute {...props} />;
  return (
    <>
      <VersionControlScreenHeader />
      <View className="flex-1 bg-screen px-6">
        <VersionControlSupportState support={support} />
      </View>
    </>
  );
}

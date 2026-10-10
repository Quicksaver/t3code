import type {
  ContextMenuItem,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi, readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { isSourceControlPanelCommandInterrupted } from "~/state/sourceControlPanel";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import {
  panelBranchHasUpstream,
  panelBranchOperationCwd,
  panelBranchPushTargetSha,
  panelBranchSyncCounts,
  panelBranchSyncState,
} from "@t3tools/shared/sourceControl";
import {
  beginPanelAction,
  branchNeedsRepositoryPublish,
  branchIsCheckedOut,
  confirmSourceControlPanelMutation,
  forcedBranchSyncConfirmation,
  forcedBranchSyncReconfirmation,
  isImmutableFileDiffSource,
  namedBranchOperationCwd,
  pushBranchAndSyncPeers,
  resolveBranchSyncSnapshot,
  runPanelActionAndReconcile,
  type ForcedBranchSyncSide,
  type PanelChangedFile,
  type PanelRefreshRequest,
} from "./SourceControlPanel.logic";
import {
  commitUndoActionKey,
  errorMessage,
  fileBasename,
  isActionForced,
  operationPathsForFile,
  shouldFetchBeforePull,
  uniquePaths,
  withBranchForceDeleteHint,
  type FileDiffSource,
} from "./SourceControlPanelModel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";
import { InlineFileDiff } from "./SourceControlPanelRows";

export function useSourceControlPanelActions(
  state: SourceControlPanelState,
  refresh: (
    mode?: PanelRefreshRequest["mode"],
    options?: { readonly authoritative?: boolean },
  ) => Promise<void>,
  onPublishRepository: (cwd: string) => void,
) {
  const runningActionKeysRef = useRef(new Set<string>());
  const [createBranchCommitTarget, setCreateBranchCommitTarget] =
    useState<VcsPanelCommitSummary | null>(null);
  const [createBranchName, setCreateBranchName] = useState("");
  const {
    activeThreadRef,
    api,
    canWriteSourceControl,
    cwd,
    dialogStashMessage,
    divergedSyncTarget,
    expandedFileDiffs,
    fileDiffKey,
    fileDiffsByKey,
    initialFetchCwdRef,
    loadFileDiff,
    onThreadRefChange,
    openInPreferredEditor,
    peerSyncTargets,
    publishRemoteTarget,
    resolvedTheme,
    selectedChangePathList,
    setCommitDialogOpen,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncTarget,
    setError,
    setExpandedFileDiffs,
    reportMutationError,
    setPublishRemoteTarget,
    setRunningActions,
    setStashDialogTarget,
    snapshot,
    sourceControlAllRemotesFetchIntervalMs,
    stashDialogTarget,
    vcsStatus,
    worktreePath,
  } = state;
  const runAction = useCallback(
    async (actionKey: string, label: string, action: () => Promise<void>) => {
      if (!canWriteSourceControl) return;
      if (!beginPanelAction(runningActionKeysRef.current, actionKey)) return;
      setRunningActions((current) => new Map(current).set(actionKey, label));
      setError(null);
      reportMutationError(null);
      try {
        const result = await runPanelActionAndReconcile({
          action,
          // Resolves only after a post-mutation snapshot is applied, so the action key and
          // busy state stay held until the panel shows the mutation's result.
          reconcile: async () => {
            vcsStatus.refresh();
            await refresh("full", { authoritative: true });
          },
        });
        if (result.status === "failure" && !isSourceControlPanelCommandInterrupted(result.error)) {
          reportMutationError(errorMessage(result.error));
        }
      } finally {
        runningActionKeysRef.current.delete(actionKey);
        setRunningActions((current) => {
          const next = new Map(current);
          next.delete(actionKey);
          return next;
        });
      }
    },
    [canWriteSourceControl, refresh, reportMutationError, vcsStatus.refresh],
  );

  const openFilePanel = useCallback(
    (path: string, targetCwd = cwd) => {
      if (!activeThreadRef) return;
      useRightPanelStore
        .getState()
        .openFile(activeThreadRef, path, undefined, targetCwd === cwd ? undefined : targetCwd);
    },
    [activeThreadRef, cwd],
  );

  const openInVsCode = useCallback(
    async (path: string, targetCwd = cwd) => {
      const result = await openInPreferredEditor(resolvePathLinkTarget(path, targetCwd));
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const nextError = squashAtomCommandFailure(result);
      setError(nextError instanceof Error ? nextError.message : "Unable to open file.");
    },
    [cwd, openInPreferredEditor],
  );

  const confirm = useCallback(
    async (message: string) => {
      if (!canWriteSourceControl) return false;
      return confirmSourceControlPanelMutation(ensureLocalApi().dialogs.confirm, message);
    },
    [canWriteSourceControl],
  );

  const copyText = useCallback((value: string, missingMessage = "Nothing to copy.") => {
    if (!value) {
      setError(missingMessage);
      return;
    }
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      setError("Clipboard API unavailable.");
      return;
    }
    setError(null);
    void navigator.clipboard
      .writeText(value)
      .catch((nextError) => setError(errorMessage(nextError)));
  }, []);

  const pushBranch = useCallback(
    async (
      branch: VcsRef,
      sourceSnapshot: VcsPanelSnapshotResult,
      input: {
        readonly cwd: string;
        readonly remoteName?: string;
        readonly force?: boolean;
      },
    ) => {
      if (!api) return;
      // A forced push replaces only the remote tip from the snapshot the user acted on.
      const expectedRemoteSha = input.force
        ? panelBranchPushTargetSha(branch, sourceSnapshot, input.remoteName)
        : undefined;
      await pushBranchAndSyncPeers({
        sourceEnvironmentId: state.environmentId,
        sourceBranch: branch,
        sourceSnapshot,
        force: input.force ?? false,
        peerTargets: peerSyncTargets,
        push: () =>
          api.vcs.pushBranch({
            cwd: input.cwd,
            branchName: branch.name,
            ...(input.remoteName ? { remoteName: input.remoteName } : {}),
            ...(input.force ? { force: true } : {}),
            ...(expectedRemoteSha ? { expectedRemoteSha } : {}),
          }),
        readPeerSnapshot: (target) =>
          api.federatedVcs.panelSnapshot(target.environmentId, {
            cwd: target.cwd,
            refresh: "full",
          }),
        fetchPeerBranch: (target, branchName) =>
          api.federatedVcs.fetchBranch(target.environmentId, {
            cwd: target.cwd,
            branchName,
          }),
        pullPeerBranch: async (target, branchName) => {
          await api.federatedVcs.pullBranch(target.environmentId, {
            cwd: target.cwd,
            branchName,
          });
        },
        onPeerError: (target, error) => {
          console.warn("Could not automatically sync a connected environment after push", {
            environmentId: target.environmentId,
            error,
          });
        },
      });
    },
    [api, peerSyncTargets, state.environmentId],
  );

  const openContextMenu = useCallback(
    <T extends string>(
      event: ReactMouseEvent,
      items: readonly ContextMenuItem<T>[],
      handlers: Partial<Record<T, () => Promise<void> | void>>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const localApi = readLocalApi();
        if (!localApi) return;
        const clicked = await localApi.contextMenu.show(items, {
          x: event.clientX,
          y: event.clientY,
        });
        if (!clicked) return;
        await handlers[clicked]?.();
      })();
    },
    [],
  );

  const openFileChangeContextMenu = useCallback(
    (event: ReactMouseEvent, file: VcsPanelFileChange) => {
      openContextMenu(
        event,
        [
          ...(activeThreadRef ? ([{ id: "open-file", label: "Open file" }] as const) : []),
          { id: "open-vscode", label: "Open in VS Code" },
          {
            id: "copy-filename",
            label: "Copy filename",
            icon: "copy",
            separatorBefore: true,
          },
          { id: "copy-full-path", label: "Copy full path to file", icon: "copy" },
        ],
        {
          ...(activeThreadRef ? { "open-file": () => openFilePanel(file.path) } : {}),
          "open-vscode": () => openInVsCode(file.path),
          "copy-filename": () => copyText(fileBasename(file.path)),
          "copy-full-path": () => copyText(resolvePathLinkTarget(file.path, cwd)),
        },
      );
    },
    [activeThreadRef, copyText, cwd, openContextMenu, openFilePanel, openInVsCode],
  );

  const toggleFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) => {
      const key = fileDiffKey(file, source, targetCwd);
      const expanding = !expandedFileDiffs.has(key);
      setExpandedFileDiffs((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        next.add(key);
        return next;
      });
      if (!api || !expanding) return;
      const existingState = fileDiffsByKey.get(key);
      if (isImmutableFileDiffSource(source) && existingState?.status === "loaded") return;
      // A loaded working-tree patch stays visible while it revalidates.
      loadFileDiff(
        file,
        source,
        targetCwd,
        source.kind === "working-tree" ? { preserveLoaded: true } : undefined,
      );
    },
    [api, cwd, expandedFileDiffs, fileDiffKey, fileDiffsByKey, loadFileDiff],
  );

  const renderFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) => {
      const state = fileDiffsByKey.get(fileDiffKey(file, source, targetCwd));
      if (!state || state.status === "loading") {
        return <div className="px-2 py-1 text-xs text-muted-foreground">Loading diff...</div>;
      }
      if (state.status === "error") {
        return <div className="px-2 py-1 text-xs text-destructive-foreground">{state.message}</div>;
      }
      return <InlineFileDiff patch={state.patch} resolvedTheme={resolvedTheme} />;
    },
    [cwd, fileDiffKey, fileDiffsByKey, resolvedTheme],
  );

  const fileDiffListProps = useCallback(
    (sourceForFile: (file: VcsPanelFileChange) => FileDiffSource, targetCwd = cwd) => ({
      getFileKey: (file: VcsPanelFileChange) => fileDiffKey(file, sourceForFile(file), targetCwd),
      isFileExpanded: (file: VcsPanelFileChange) =>
        expandedFileDiffs.has(fileDiffKey(file, sourceForFile(file), targetCwd)),
      onFileToggle: (file: VcsPanelFileChange) =>
        toggleFileDiff(file, sourceForFile(file), targetCwd),
      renderExpandedFile: (file: VcsPanelFileChange) =>
        renderFileDiff(file, sourceForFile(file), targetCwd),
      ...(activeThreadRef
        ? { onOpenFile: (file: VcsPanelFileChange) => openFilePanel(file.path, targetCwd) }
        : {}),
      onOpenInVsCode: (file: VcsPanelFileChange) => void openInVsCode(file.path, targetCwd),
    }),
    [
      cwd,
      expandedFileDiffs,
      activeThreadRef,
      fileDiffKey,
      openFilePanel,
      openInVsCode,
      renderFileDiff,
      toggleFileDiff,
    ],
  );

  const switchRef = useCallback(
    (refName: string) =>
      runAction(`branch-switch:${refName}`, "Checking out", async () => {
        if (!api) return;
        const result = await api.vcs.switchRef({ cwd, refName });
        await onThreadRefChange?.({ branch: result.refName, worktreePath });
      }),
    [api, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef, force: boolean) =>
      void (async () => {
        const branchLabel = branch.isRemote
          ? `remote branch ${branch.name}`
          : `branch ${branch.name}`;
        if (!(await confirm(`Delete ${branchLabel}?`))) return;
        await runAction(`branch-delete:${branch.name}`, "Deleting", async () => {
          if (!api) return;
          try {
            await api.vcs.deleteBranch({
              cwd,
              branchName: branch.name,
              ...(branch.isRemote && branch.remoteName ? { remoteName: branch.remoteName } : {}),
              force,
            });
          } catch (error) {
            throw withBranchForceDeleteHint(error);
          }
        });
      })(),
    [api, confirm, cwd, runAction],
  );

  const undoCommit = useCallback(
    (branchName: string, commit?: VcsPanelCommitSummary) =>
      void (async () => {
        const actionKey = commitUndoActionKey(branchName, commit?.sha);
        const localBranches = snapshot?.localBranches ?? [];
        const branch = localBranches.find((candidate) => candidate.name === branchName);
        const targetCwd = namedBranchOperationCwd(localBranches, branchName, cwd);
        const confirmed = commit
          ? await confirm(
              `Undo ${commit.shortSha} and any newer commits on ${branchName}?${
                branchIsCheckedOut(branch)
                  ? branch?.current
                    ? " Changes stay in the working tree."
                    : " Changes stay in that branch's worktree."
                  : " This moves the branch back to that commit's parent."
              }`,
            )
          : await confirm(`Undo latest commit on ${branchName}?`);
        if (!confirmed) return;
        await runAction(
          actionKey,
          "Undoing",
          () =>
            api?.vcs.undoLatestCommit({
              cwd: targetCwd,
              branchName,
              ...(commit ? { sha: commit.sha } : {}),
            }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction, snapshot?.localBranches],
  );

  const mergeBranchIntoCurrent = useCallback(
    (branchName: string) =>
      void (async () => {
        if (!(await confirm(`Merge ${branchName} into the current branch?`))) return;
        await runAction(
          `branch-merge:${branchName}`,
          "Merging",
          () => api?.vcs.mergeBranchIntoCurrent({ cwd, refName: branchName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const rebaseCurrentOnto = useCallback(
    (refName: string) =>
      void (async () => {
        if (!(await confirm(`Rebase the current branch onto ${refName}?`))) return;
        await runAction(
          `rebase-current:${refName}`,
          "Rebasing",
          () => api?.vcs.rebaseCurrentOnto({ cwd, refName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const revertCommit = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Revert commit ${commit.shortSha}?`))) return;
        await runAction(
          `commit-revert:${commit.sha}`,
          "Reverting",
          () => api?.vcs.revertCommit({ cwd, sha: commit.sha }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const checkoutCommitDetached = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Checkout ${commit.shortSha} as detached HEAD?`))) return;
        await runAction(`commit-checkout:${commit.sha}`, "Checking out", async () => {
          if (!api) return;
          const result = await api.vcs.checkoutCommit({ cwd, sha: commit.sha });
          await onThreadRefChange?.({ branch: result.refName, worktreePath });
        });
      })(),
    [api, confirm, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const createBranchFromCommit = useCallback(
    (commit: VcsPanelCommitSummary) => {
      if (!canWriteSourceControl) return;
      setCreateBranchName("");
      setCreateBranchCommitTarget(commit);
    },
    [canWriteSourceControl],
  );

  const runCreateBranchFromCommit = useCallback(async () => {
    const target = createBranchCommitTarget;
    const branchName = createBranchName.trim();
    if (!target || !branchName) return;
    await runAction(`commit-create-branch:${target.sha}`, "Creating branch", async () => {
      await api?.vcs.createBranchFromCommit({
        cwd,
        sha: target.sha,
        branchName,
      });
      setCreateBranchCommitTarget(null);
      setCreateBranchName("");
    });
  }, [api, createBranchCommitTarget, createBranchName, cwd, runAction]);

  const closeCreateBranchDialog = useCallback(() => {
    setCreateBranchCommitTarget(null);
    setCreateBranchName("");
  }, []);

  const publishBranch = useCallback(
    (
      branch: VcsRef,
      sourceSnapshot: VcsPanelSnapshotResult,
      remoteName: string | undefined,
      force: boolean,
    ) =>
      runAction(`branch-sync:${branch.name}`, "Pushing", () =>
        pushBranch(branch, sourceSnapshot, {
          cwd: panelBranchOperationCwd(branch, cwd),
          ...(remoteName ? { remoteName } : {}),
          force,
        }),
      ),
    [cwd, pushBranch, runAction],
  );

  const publishBranchWithRemoteChoice = useCallback(
    (branch: VcsRef, force = false) => {
      if (!canWriteSourceControl || !snapshot) return;
      if (panelBranchHasUpstream(branch, snapshot)) {
        void publishBranch(branch, snapshot, undefined, force);
        return;
      }
      if (branchNeedsRepositoryPublish(branch, snapshot)) {
        onPublishRepository(panelBranchOperationCwd(branch, cwd));
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRemoteTarget({ branch, force, snapshot });
        return;
      }
      void publishBranch(branch, snapshot, snapshot.remotes[0]?.name, force);
    },
    [canWriteSourceControl, cwd, onPublishRepository, publishBranch, snapshot],
  );

  const publishToSelectedRemote = useCallback(
    (remoteName: string) => {
      const target = publishRemoteTarget;
      setPublishRemoteTarget(null);
      if (!target) return;
      void publishBranch(target.branch, target.snapshot, remoteName, target.force);
    },
    [publishBranch, publishRemoteTarget],
  );

  const runBranchSync = useCallback(
    (
      branch: VcsRef,
      {
        fetchFirst = false,
        forcedSide = null,
      }: {
        readonly fetchFirst?: boolean;
        // The side the user confirmed forcing; force never applies to the other side.
        readonly forcedSide?: ForcedBranchSyncSide | null;
      } = {},
    ) => {
      if (!canWriteSourceControl || !snapshot) return;
      const state = panelBranchSyncState(branch, snapshot);
      if (state === "diverged") {
        setDivergedSyncTarget({ branch, snapshot });
        return;
      }
      if (state === "publish") {
        publishBranchWithRemoteChoice(branch, forcedSide === "push");
        return;
      }
      if (!branch.current) {
        const actionKey =
          state === "fetch" ? `branch-fetch:${branch.name}` : `branch-sync:${branch.name}`;
        void runAction(
          actionKey,
          state === "push" ? "Pushing" : state === "pull" ? "Pulling" : "Fetching",
          async () => {
            if (!api) return;
            const targetCwd = panelBranchOperationCwd(branch, cwd);
            if (state === "push") {
              await pushBranch(branch, snapshot, {
                cwd: targetCwd,
                force: forcedSide === "push",
              });
              return;
            }
            if (state === "pull") {
              await api.vcs.pullBranch({
                cwd: targetCwd,
                branchName: branch.name,
                force: forcedSide === "pull",
              });
              return;
            }
            await api.vcs.fetchBranch({ cwd: targetCwd, branchName: branch.name });
          },
        );
        return;
      }
      void runAction(`branch-sync:${branch.name}`, "Syncing", async () => {
        if (!api) return;
        const targetCwd = panelBranchOperationCwd(branch, cwd);
        const fetch = () => api.vcs.fetchBranch({ cwd: targetCwd, branchName: branch.name });
        const syncSnapshot = await resolveBranchSyncSnapshot({
          snapshot,
          fetchFirst,
          fetch,
          refreshSnapshot: () => api.vcs.readPanelSnapshot({ cwd: targetCwd, refresh: "full" }),
        });
        const syncState = panelBranchSyncState(branch, syncSnapshot);
        if (syncState === "diverged") {
          setDivergedSyncTarget({ branch, snapshot: syncSnapshot });
          return;
        }
        let syncForcedSide = forcedSide;
        const reconfirmation = forcedBranchSyncReconfirmation(branch, forcedSide, syncState);
        if (reconfirmation) {
          if (!(await confirm(reconfirmation.message))) return;
          syncForcedSide = reconfirmation.side;
        }
        const { aheadCount, behindCount } = panelBranchSyncCounts(branch, syncSnapshot);
        if (aheadCount > 0) {
          await pushBranch(branch, syncSnapshot, {
            cwd: targetCwd,
            force: syncForcedSide === "push",
          });
          return;
        }
        if (behindCount > 0) {
          await api.vcs.pullBranch({
            cwd: targetCwd,
            branchName: branch.name,
            force: syncForcedSide === "pull",
          });
          return;
        }
        if (!fetchFirst) {
          await fetch();
        }
      });
    },
    [
      api,
      canWriteSourceControl,
      confirm,
      cwd,
      publishBranchWithRemoteChoice,
      pushBranch,
      runAction,
      snapshot,
    ],
  );

  const syncBranch = useCallback(
    (branch: VcsRef, event: ReactMouseEvent<HTMLButtonElement>) => {
      const fetchFirst = shouldFetchBeforePull(event);
      const force = isActionForced(event);
      const confirmation =
        force && snapshot
          ? forcedBranchSyncConfirmation(branch, panelBranchSyncState(branch, snapshot), fetchFirst)
          : null;
      if (!confirmation) {
        runBranchSync(branch, { fetchFirst });
        return;
      }
      void (async () => {
        if (!(await confirm(confirmation.message))) return;
        runBranchSync(branch, { fetchFirst, forcedSide: confirmation.side });
      })();
    },
    [confirm, runBranchSync, snapshot],
  );

  const runDivergedSync = useCallback(
    (mode: "force-pull" | "merge" | "force-push") => {
      const target = divergedSyncTarget;
      setDivergedSyncTarget(null);
      if (!target) return;
      const { branch, snapshot: dialogSnapshot } = target;
      void runAction(
        `branch-sync:${branch.name}`,
        mode === "force-push" ? "Pushing" : mode === "force-pull" ? "Pulling" : "Merging",
        async () => {
          if (!api) return;
          const targetCwd = panelBranchOperationCwd(branch, cwd);
          if (mode === "force-push") {
            await pushBranch(branch, dialogSnapshot, { cwd: targetCwd, force: true });
            return;
          }
          if (mode === "force-pull") {
            await api.vcs.pullBranch({ cwd: targetCwd, branchName: branch.name, force: true });
            return;
          }
          if (!branch.current) {
            console.warn("Ignored diverged merge sync for a non-current branch", {
              branchName: branch.name,
            });
            return;
          }
          await api.vcs.pullBranch({ cwd: targetCwd, branchName: branch.name, merge: true });
          await pushBranch(branch, dialogSnapshot, { cwd: targetCwd });
        },
      );
    },
    [api, cwd, divergedSyncTarget, pushBranch, runAction],
  );

  const fetchActionableBranches = useCallback(
    (force = false) =>
      runAction("work-fetch", "Fetching", async () => {
        await api?.vcs.fetchAllRemotes({ cwd, ...(force ? { force: true } : {}) });
      }),
    [api, cwd, runAction],
  );

  const automaticallyFetchActionableBranches = useCallback(async () => {
    if (!api || !canWriteSourceControl) return;
    try {
      const fetched = await api.vcs.fetchAllRemotes({ cwd });
      if (fetched) await refresh();
    } catch {
      // Automatic refresh remains best-effort. Explicit Fetch owns surfaced
      // failures and always bypasses the shared background policy.
    }
  }, [api, canWriteSourceControl, cwd, refresh]);

  useEffect(() => {
    if (!api) return;
    if (!canWriteSourceControl || sourceControlAllRemotesFetchIntervalMs <= 0) {
      initialFetchCwdRef.current = null;
      return;
    }
    if (initialFetchCwdRef.current === cwd) return;
    initialFetchCwdRef.current = cwd;
    void automaticallyFetchActionableBranches();
  }, [
    api,
    automaticallyFetchActionableBranches,
    canWriteSourceControl,
    cwd,
    initialFetchCwdRef,
    sourceControlAllRemotesFetchIntervalMs,
  ]);

  useEffect(() => {
    if (!api) return;
    if (!canWriteSourceControl || sourceControlAllRemotesFetchIntervalMs <= 0) return;
    const interval = window.setInterval(() => {
      if (runningActionKeysRef.current.has("work-fetch")) return;
      void automaticallyFetchActionableBranches();
    }, sourceControlAllRemotesFetchIntervalMs);
    return () => window.clearInterval(interval);
  }, [
    api,
    automaticallyFetchActionableBranches,
    canWriteSourceControl,
    sourceControlAllRemotesFetchIntervalMs,
  ]);

  const runPanelCommit = useCallback(
    (message: string) => {
      const commitMessage = message.trim();
      return runAction("changes-commit", "Committing", async () => {
        setCommitDialogOpen(false);
        setDialogCommitMessage("");
        if (!api) return;
        await api.vcs.commitStaged({
          cwd,
          paths: [...selectedChangePathList],
          ...(commitMessage ? { message: commitMessage } : {}),
        });
      });
    },
    [api, cwd, runAction, selectedChangePathList],
  );

  const openCommitDialog = useCallback(() => {
    if (!canWriteSourceControl) return;
    setDialogCommitMessage("");
    setCommitDialogOpen(true);
  }, [canWriteSourceControl]);

  const createStash = useCallback(
    (paths: readonly string[], message?: string, targetCwd = cwd, actionKey = "changes-stash") => {
      const stashMessage = message?.trim();
      return runAction(actionKey, "Stashing", async () => {
        if (!api) return;
        await api.vcs.createStash({
          cwd: targetCwd,
          mode: "all",
          includeUntracked: true,
          paths: [...paths],
          ...(stashMessage ? { message: stashMessage } : {}),
        });
      });
    },
    [api, cwd, runAction],
  );

  const openStashDialog = useCallback(
    (label: string, paths: readonly string[], targetCwd = cwd, actionKey = "changes-stash") => {
      if (!canWriteSourceControl) return;
      setStashDialogTarget({ label, cwd: targetCwd, actionKey, paths });
      setDialogStashMessage("");
    },
    [canWriteSourceControl, cwd],
  );

  const runPanelStash = useCallback(() => {
    if (!stashDialogTarget) return;
    const paths = stashDialogTarget.paths;
    const message = dialogStashMessage.trim();
    const targetCwd = stashDialogTarget.cwd;
    const actionKey = stashDialogTarget.actionKey;
    setStashDialogTarget(null);
    setDialogStashMessage("");
    void createStash(paths, message, targetCwd, actionKey);
  }, [createStash, dialogStashMessage, stashDialogTarget]);

  const commitSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly files: readonly PanelChangedFile[];
    }) =>
      runAction(input.actionKey, "Committing", async () => {
        if (!api) return;
        const paths = uniquePaths(input.files.flatMap((file) => operationPathsForFile(file)));
        if (paths.length === 0) return;
        await api.vcs.commitStaged({ cwd: input.targetCwd, paths });
      }),
    [api, runAction],
  );

  const stashSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly paths: readonly string[];
      readonly message?: string;
    }) => createStash(input.paths, input.message, input.targetCwd, input.actionKey),
    [createStash],
  );

  const discardSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly files: readonly PanelChangedFile[];
    }) =>
      void (async () => {
        if (input.files.length === 0) return;
        const countLabel =
          input.files.length === 1
            ? "the selected change"
            : `${input.files.length} selected changes`;
        if (!(await confirm(`Discard ${countLabel}?`))) return;
        const stagedPaths = uniquePaths(
          input.files
            .filter((file) => file.hasStagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        const unstagedPaths = uniquePaths(
          input.files
            .filter((file) => file.hasUnstagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        await runAction(input.actionKey, "Discarding", async () => {
          if (!api) return;
          if (unstagedPaths.length > 0) {
            await api.vcs.discardFiles({
              cwd: input.targetCwd,
              paths: unstagedPaths,
              staged: false,
            });
          }
          if (stagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd: input.targetCwd, paths: stagedPaths, staged: true });
          }
        });
      })(),
    [api, confirm, runAction],
  );

  return {
    checkoutCommitDetached,
    commitSelectedInCwd,
    confirm,
    copyText,
    closeCreateBranchDialog,
    createBranchCommitTarget,
    createBranchFromCommit,
    createBranchName,
    createStash,
    deleteBranch,
    discardSelectedInCwd,
    fetchActionableBranches,
    fileDiffListProps,
    mergeBranchIntoCurrent,
    openCommitDialog,
    openContextMenu,
    openFileChangeContextMenu,
    openFilePanel,
    openInVsCode,
    openStashDialog,
    publishBranchWithRemoteChoice,
    publishToSelectedRemote,
    rebaseCurrentOnto,
    renderFileDiff,
    revertCommit,
    runAction,
    runBranchSync,
    runCreateBranchFromCommit,
    runDivergedSync,
    runPanelCommit,
    runPanelStash,
    stashSelectedInCwd,
    setCreateBranchName,
    switchRef,
    syncBranch,
    toggleFileDiff,
    undoCommit,
  };
}

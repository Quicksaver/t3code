import {
  panelItemActivity,
  panelBranchAttention,
  panelBranchHasUpstream,
  panelBranchSyncCounts,
  panelBranchSyncState,
  type AttentionKind,
  type BranchSyncState,
  branchIsCheckedOut,
  formatRelativeDate,
} from "./SourceControlPanel.logic";
import {
  actionableItemClassName,
  SourceControlActionableItem,
} from "./SourceControlActionableItem";
import { SourceControlVirtualList } from "./SourceControlVirtualList";
import { cn } from "~/lib/utils";
import { conversationItemStyles } from "../sidebar/conversationItemStyles";
import { CommitFileChanges } from "./CommitFileChanges";
import type { VcsPanelBranchDetails, VcsPanelCommitSummary, VcsRef } from "@t3tools/contracts";

import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitBranchPlus,
  GitCommit,
  GitCompareArrows,
  Merge,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  commitUndoActionKey,
  isActionForced,
  sumFiles,
  treeKey,
  commitCountLabel,
} from "./SourceControlPanelModel";
import {
  AttentionIcon,
  BranchSyncActionIcon,
  BranchSyncLabels,
  BranchTooltip,
  CommitTooltip,
  CompactBadge,
  IconButton,
  RefLabels,
  RowActions,
  StatLabels,
  branchSyncActionLabel,
} from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import { Download, Upload } from "lucide-react";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AuthorAvatar, BranchMarkerIcon, SyncedIcon } from "./SourceControlPanelPrimitives";
import type { SourceControlItemEnvironment } from "./SourceControlItemEnvironments";
import { FileChangeList, FileChangeSummary, LoadMoreCommitsButton } from "./SourceControlPanelRows";

export function makeSourceControlPanelBranchRenderers(
  controller: ReadySourceControlPanelController,
) {
  const {
    api,
    canWriteSourceControl,
    branchDetailsByRef,
    checkoutCommitDetached,
    copyText,
    createBranchFromCommit,
    cwd,
    deleteBranch,
    expandedTree,
    fileDiffListProps,
    isActionRunning,
    isTreeExpanded,
    loadMoreBranchCommits,
    loadingBranchDetails,
    mergeBranchIntoCurrent,
    openContextMenu,
    openFileChangeContextMenu,
    rebaseCurrentOnto,
    revertCommit,
    runBranchSync,
    setCompareBaseDialogTarget,
    setCompareBaseQuery,
    snapshot,
    switchRef,
    syncBranch,
    toggleBranchTree,
    toggleBranchTreeFromKeyboard,
    toggleTree,
    toggleTreeFromKeyboard,
    undoCommit,
  } = controller;
  const renderCommit = (
    commit: VcsPanelCommitSummary,
    options: { readonly undoBranchName?: string } = {},
  ) => {
    const key = treeKey("commit", commit.sha);
    const expanded = expandedTree.has(key);
    const stats = commit.fileStats ?? sumFiles(commit.files);
    const relativeDate = formatRelativeDate(commit.authoredAt);
    const undoKey = options.undoBranchName
      ? commitUndoActionKey(options.undoBranchName, commit.sha)
      : null;
    const revertKey = `commit-revert:${commit.sha}`;
    const rebaseKey = `rebase-current:${commit.sha}`;
    const checkoutKey = `commit-checkout:${commit.sha}`;
    const createBranchKey = `commit-create-branch:${commit.sha}`;
    const canUndoCommit = options.undoBranchName !== undefined;
    return (
      <div key={commit.sha} className="space-y-0.5">
        <Tooltip preserveOnNestedTriggerHover>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                className={cn(
                  conversationItemStyles.surface,
                  expanded ? conversationItemStyles.active : conversationItemStyles.receded,
                  "group flex h-9 min-w-0 items-center gap-1.5 px-2.5",
                )}
                onClick={() => toggleTree(key)}
                onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      ...(canUndoCommit
                        ? [
                            {
                              id: "undo",
                              label: "Undo",
                              disabled:
                                !canWriteSourceControl ||
                                (undoKey ? isActionRunning(undoKey) : false),
                            },
                          ]
                        : []),
                      { id: "revert", disabled: !canWriteSourceControl, label: "Revert commit" },
                      {
                        id: "rebase",
                        disabled: !canWriteSourceControl,
                        label: "Rebase current branch onto commit",
                      },
                      {
                        id: "checkout",
                        disabled: !canWriteSourceControl,
                        label: "Checkout as detached HEAD",
                      },
                      {
                        id: "create-branch",
                        disabled: !canWriteSourceControl,
                        label: "Create branch from commit",
                      },
                      {
                        id: "copy-sha",
                        label: "Copy SHA",
                        icon: "copy",
                        separatorBefore: true,
                      },
                      { id: "copy-message", label: "Copy message", icon: "copy" },
                    ],
                    {
                      undo: () => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      },
                      revert: () => revertCommit(commit),
                      rebase: () => rebaseCurrentOnto(commit.sha),
                      checkout: () => checkoutCommitDetached(commit),
                      "create-branch": () => createBranchFromCommit(commit),
                      "copy-sha": () => copyText(commit.sha),
                      "copy-message": () => copyText(commit.message),
                    },
                  )
                }
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <AuthorAvatar commit={commit} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    expanded ? conversationItemStyles.title : conversationItemStyles.readTitle,
                  )}
                >
                  {commit.message}
                </span>
                <RefLabels
                  commit={commit}
                  remoteNames={snapshot.remotes.map((remote) => remote.name)}
                />
                {commit.fileStats || !commit.filesDeferred ? (
                  <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
                ) : null}
                {relativeDate ? (
                  <span className={cn("shrink-0", conversationItemStyles.metadata)}>
                    {relativeDate}
                  </span>
                ) : null}
                <RowActions
                  activityLabel={panelItemActivity(controller.runningActions, [
                    undoKey ?? "",
                    revertKey,
                    rebaseKey,
                    checkoutKey,
                    createBranchKey,
                  ])}
                >
                  {canUndoCommit && options.undoBranchName ? (
                    <IconButton
                      label="Undo"
                      disabled={
                        !canWriteSourceControl || (undoKey ? isActionRunning(undoKey) : false)
                      }
                      loading={undoKey ? isActionRunning(undoKey) : false}
                      onClick={() => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      }}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label="Revert commit"
                    disabled={!canWriteSourceControl || isActionRunning(revertKey)}
                    loading={isActionRunning(revertKey)}
                    onClick={() => revertCommit(commit)}
                  >
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Rebase current branch onto commit"
                    disabled={!canWriteSourceControl || isActionRunning(rebaseKey)}
                    loading={isActionRunning(rebaseKey)}
                    onClick={() => rebaseCurrentOnto(commit.sha)}
                  >
                    <GitCompareArrows className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Checkout as detached HEAD"
                    disabled={!canWriteSourceControl || isActionRunning(checkoutKey)}
                    loading={isActionRunning(checkoutKey)}
                    onClick={() => checkoutCommitDetached(commit)}
                  >
                    <GitCommit className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Create branch from commit"
                    disabled={!canWriteSourceControl || isActionRunning(createBranchKey)}
                    loading={isActionRunning(createBranchKey)}
                    onClick={() => createBranchFromCommit(commit)}
                  >
                    <GitBranchPlus className="size-3.5" />
                  </IconButton>
                </RowActions>
              </div>
            }
          />
          <ThreadHoverCardPopup sideOffset={8} side="left" align="start">
            <CommitTooltip
              commit={commit}
              remoteNames={snapshot.remotes.map((remote) => remote.name)}
            />
          </ThreadHoverCardPopup>
        </Tooltip>
        {expanded ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <CommitFileChanges
              key={`${cwd}:${commit.sha}`}
              commit={commit}
              api={api}
              cwd={cwd}
              emptyLabel="No file changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({ kind: "commit", sha: commit.sha }))}
            />
          </div>
        ) : null}
      </div>
    );
  };

  const renderBranchSubsection = ({
    details,
    id,
    title,
    count,
    children,
    icon,
    action,
    defaultExpanded,
  }: {
    readonly details: VcsPanelBranchDetails;
    readonly id: string;
    readonly title: ReactNode;
    readonly count: ReactNode | null;
    readonly children: ReactNode;
    readonly icon?: ReactNode;
    readonly action?: ReactNode;
    readonly defaultExpanded?: boolean;
  }) => {
    const key = treeKey("branch-subsection", `${details.fullRefName}:${id}`);
    const expanded = isTreeExpanded(key, defaultExpanded);
    return (
      <div className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className={cn(
            conversationItemStyles.surface,
            conversationItemStyles.idle,
            "flex h-9 min-w-0 items-center gap-1.5 px-2.5",
          )}
          onClick={() => toggleTree(key, defaultExpanded)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event, defaultExpanded)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {icon}
          <span className={cn("min-w-0 flex-1 truncate", conversationItemStyles.title)}>
            {title}
          </span>
          {action}
          {count !== null ? (
            <span className={cn("shrink-0", conversationItemStyles.metadata)}>{count}</span>
          ) : null}
        </div>
        {expanded ? <div className="ml-2 border-l border-border/60 pl-1">{children}</div> : null}
      </div>
    );
  };

  const renderBranchTree = (branch: VcsRef, details: VcsPanelBranchDetails, detailsKey: string) => {
    const unsyncedCommitShas = new Set(details.unsyncedCommitShas);
    const loadingDetails = loadingBranchDetails.has(detailsKey);
    const aheadTotal = details.aheadCommits.length + details.aheadCommitsRemaining;
    const behindTotal = details.behindCommits.length + details.behindCommitsRemaining;
    const historyTotal = details.commits.length + details.commitsRemaining;
    const openCompareBaseDialog = () => {
      setCompareBaseDialogTarget({ branch, detailsKey });
      setCompareBaseQuery("");
    };
    // Servers flag each returned commit; older servers send only the SHA list.
    const renderBranchCommit = (commit: VcsPanelCommitSummary) =>
      renderCommit(
        commit,
        commit.unsynced === true || unsyncedCommitShas.has(commit.sha)
          ? { undoBranchName: branch.name }
          : undefined,
      );
    return (
      <div className="space-y-0.5">
        <Button
          size="xs"
          variant="ghost-muted"
          className="w-full min-w-0"
          onClick={openCompareBaseDialog}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            vs. {details.baseRef ?? "choose base"}
          </span>
        </Button>
        {aheadTotal > 0
          ? renderBranchSubsection({
              details,
              id: "ahead",
              title: `${aheadTotal} Ahead`,
              count: null,
              icon: <Upload className="size-3.5 shrink-0 text-success-foreground" />,
              children: (
                <div className="space-y-0.5">
                  <SourceControlVirtualList
                    items={details.aheadCommits}
                    getKey={(commit) => commit.sha}
                    renderItem={renderBranchCommit}
                  />
                  <LoadMoreCommitsButton
                    remaining={details.aheadCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() => void loadMoreBranchCommits(branch, details, "ahead", detailsKey)}
                  />
                </div>
              ),
            })
          : null}
        {behindTotal > 0
          ? renderBranchSubsection({
              details,
              id: "behind",
              title: `${behindTotal} Behind`,
              count: null,
              icon: <Download className="size-3.5 shrink-0 text-warning-foreground" />,
              children: (
                <div className="space-y-0.5">
                  <SourceControlVirtualList
                    items={details.behindCommits}
                    getKey={(commit) => commit.sha}
                    renderItem={renderBranchCommit}
                  />
                  <LoadMoreCommitsButton
                    remaining={details.behindCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() =>
                      void loadMoreBranchCommits(branch, details, "behind", detailsKey)
                    }
                  />
                </div>
              ),
            })
          : null}
        {renderBranchSubsection({
          details,
          id: "commits",
          title: "History",
          count: commitCountLabel(historyTotal),
          children: (
            <div className="space-y-0.5">
              {details.commits.length === 0 ? (
                <div className="px-3 py-1 text-xs text-muted-foreground">No commits.</div>
              ) : (
                <SourceControlVirtualList
                  items={details.commits}
                  getKey={(commit) => commit.sha}
                  renderItem={renderBranchCommit}
                />
              )}
              <LoadMoreCommitsButton
                remaining={details.commitsRemaining}
                loading={loadingDetails}
                onClick={() => void loadMoreBranchCommits(branch, details, "history", detailsKey)}
              />
            </div>
          ),
        })}
        {details.baseRef
          ? renderBranchSubsection({
              details,
              id: "compare-changes",
              title: "Changes",
              count: null,
              action: <FileChangeSummary files={details.compareFiles} />,
              children: (
                <FileChangeList
                  files={details.compareFiles}
                  emptyLabel="No changes."
                  onFileContextMenu={openFileChangeContextMenu}
                  {...fileDiffListProps(() => ({
                    kind: "compare",
                    baseRef: details.baseRef!,
                    refName: details.name,
                  }))}
                />
              ),
            })
          : null}
      </div>
    );
  };

  const branchRow = (
    branch: VcsRef,
    options: {
      readonly key?: string;
      readonly detailsKey?: string;
      readonly compareBaseRef?: string;
      readonly syncCounts?: { readonly aheadCount: number; readonly behindCount: number };
      readonly attention?: AttentionKind;
      readonly syncLabel?: string;
      readonly syncState?: BranchSyncState;
      readonly syncActionKey?: string;
      readonly fetchActionKey?: string;
      readonly onSync?: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
      readonly secondaryBadge?: ReactNode;
      readonly pullRequestBadge?: ReactNode;
      readonly environments?: readonly SourceControlItemEnvironment[];
    } = {},
  ) => {
    const detailsKey = options.detailsKey ?? branch.name;
    const details = branchDetailsByRef.get(detailsKey);
    const key = options.key ?? treeKey("branch", branch.name);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(detailsKey);
    const current = branch.current;
    const { aheadCount, behindCount } =
      options.syncCounts ?? panelBranchSyncCounts(branch, snapshot);
    const hasUpstream = panelBranchHasUpstream(branch, snapshot);
    const attention = options.attention ?? panelBranchAttention(branch, snapshot);
    const syncState = options.syncState ?? panelBranchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = options.syncActionKey ?? `branch-sync:${branch.name}`;
    const fetchKey = options.fetchActionKey ?? `branch-fetch:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const syncLabel = options.syncLabel ?? branchSyncActionLabel(syncState);
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    const checkedOut = branchIsCheckedOut(branch);
    const switchDisabled = !canWriteSourceControl || checkedOut || isActionRunning(switchKey);
    const syncDisabled =
      !canWriteSourceControl || isActionRunning(syncKey) || isActionRunning(fetchKey);
    const deleteDisabled = !canWriteSourceControl || checkedOut || isActionRunning(deleteKey);
    const runSync = (event?: ReactMouseEvent<HTMLButtonElement>) =>
      options.onSync
        ? options.onSync(event)
        : event
          ? syncBranch(branch, event)
          : runBranchSync(branch);
    return (
      <div key={key} className="space-y-0.5">
        <Tooltip preserveOnNestedTriggerHover>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                className={cn(
                  actionableItemClassName,
                  expanded ? conversationItemStyles.active : conversationItemStyles.idle,
                )}
                onClick={() => toggleBranchTree(key, branch, options.compareBaseRef, detailsKey)}
                onKeyDown={(event) =>
                  toggleBranchTreeFromKeyboard(
                    key,
                    branch,
                    event,
                    options.compareBaseRef,
                    detailsKey,
                  )
                }
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      { id: "switch", label: "Checkout", disabled: switchDisabled },
                      { id: "sync", label: syncLabel, disabled: syncDisabled },
                      ...(current && aheadCount > 0
                        ? [
                            {
                              id: "undo-latest",
                              label: "Undo latest commit",
                              disabled: !canWriteSourceControl || isActionRunning(undoKey),
                            },
                          ]
                        : []),
                      ...(!current
                        ? [
                            {
                              id: "merge",
                              label: "Merge branch into current",
                              disabled: !canWriteSourceControl || isActionRunning(mergeKey),
                            },
                            {
                              id: "rebase",
                              label: "Rebase current branch onto branch",
                              disabled: !canWriteSourceControl || isActionRunning(rebaseKey),
                            },
                          ]
                        : []),
                      {
                        id: "delete",
                        label: "Delete branch",
                        destructive: true,
                        disabled: deleteDisabled,
                        icon: "trash",
                        separatorBefore: true,
                      },
                      {
                        id: "copy-branch-name",
                        label: "Copy branch name",
                        icon: "copy",
                        separatorBefore: true,
                      },
                    ],
                    {
                      switch: () => switchRef(branch.name),
                      sync: () => runSync(),
                      delete: () => deleteBranch(branch, false),
                      "undo-latest": () => undoCommit(branch.name),
                      merge: () => mergeBranchIntoCurrent(branch.name),
                      rebase: () => rebaseCurrentOnto(branch.name),
                      "copy-branch-name": () => copyText(branch.name),
                    },
                  )
                }
              >
                <SourceControlActionableItem
                  kind={
                    attention === "conflicts"
                      ? "Conflicting"
                      : attention === "diverged"
                        ? "Diverged"
                        : aheadCount > 0 && behindCount > 0
                          ? "Ahead and behind"
                          : behindCount > 0
                            ? "Behind"
                            : aheadCount > 0
                              ? "Ahead"
                              : !hasUpstream
                                ? "Unpublished"
                                : "Up to date"
                  }
                  icon={<AttentionIcon kind={attention} />}
                  activityLabel={panelItemActivity(
                    controller.runningActions,
                    [switchKey, syncKey, fetchKey, deleteKey, undoKey, mergeKey, rebaseKey],
                    [`commit-undo:${branch.name}:`],
                  )}
                  title={branch.name}
                  metadata={
                    <>
                      {hasUpstream && aheadCount === 0 && behindCount === 0 ? (
                        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                          <SyncedIcon />
                        </span>
                      ) : null}
                      {!hasUpstream ? <CompactBadge>local</CompactBadge> : null}
                      {options.secondaryBadge}
                      {current ? <BranchMarkerIcon kind="current" /> : null}
                      {branch.isDefault ? <BranchMarkerIcon kind="default" /> : null}
                      {branch.worktreePath && !current ? (
                        <BranchMarkerIcon kind="worktree" />
                      ) : null}
                    </>
                  }
                  trailingMetadata={
                    <>
                      {options.pullRequestBadge}
                      <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
                    </>
                  }
                  time={relativeDate}
                  environments={options.environments}
                  actions={
                    <>
                      <IconButton
                        label="Checkout"
                        disabled={switchDisabled}
                        loading={isActionRunning(switchKey)}
                        onClick={() => void switchRef(branch.name)}
                      >
                        <GitBranch className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label={syncLabel}
                        disabled={syncDisabled}
                        loading={isActionRunning(syncKey) || isActionRunning(fetchKey)}
                        onClick={(event) => runSync(event)}
                      >
                        <BranchSyncActionIcon state={syncState} />
                      </IconButton>
                      <IconButton
                        label="Delete branch. Shift: force."
                        destructive
                        disabled={deleteDisabled}
                        loading={isActionRunning(deleteKey)}
                        onClick={(event) => deleteBranch(branch, isActionForced(event))}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                      {current && aheadCount > 0 ? (
                        <IconButton
                          label="Undo latest commit"
                          disabled={!canWriteSourceControl || isActionRunning(undoKey)}
                          loading={isActionRunning(undoKey)}
                          onClick={() => undoCommit(branch.name)}
                        >
                          <Undo2 className="size-3.5" />
                        </IconButton>
                      ) : null}
                      {!current ? (
                        <>
                          <IconButton
                            label="Merge branch into current"
                            disabled={!canWriteSourceControl || isActionRunning(mergeKey)}
                            loading={isActionRunning(mergeKey)}
                            onClick={() => mergeBranchIntoCurrent(branch.name)}
                          >
                            <Merge className="size-3.5" />
                          </IconButton>
                          <IconButton
                            label="Rebase current branch onto branch"
                            disabled={!canWriteSourceControl || isActionRunning(rebaseKey)}
                            loading={isActionRunning(rebaseKey)}
                            onClick={() => rebaseCurrentOnto(branch.name)}
                          >
                            <GitCompareArrows className="size-3.5" />
                          </IconButton>
                        </>
                      ) : null}
                    </>
                  }
                />
              </div>
            }
          />
          <BranchTooltip
            branch={branch}
            displayName={branch.name}
            aheadCount={aheadCount}
            behindCount={behindCount}
            environments={options.environments}
          />
        </Tooltip>
        {expanded && details ? (
          <div className="pl-1">{renderBranchTree(branch, details, detailsKey)}</div>
        ) : null}
        {expanded && !details && loadingDetails ? (
          <div className="py-1 pl-1 text-xs text-muted-foreground">Loading...</div>
        ) : null}
      </div>
    );
  };

  return { branchRow, renderCommit };
}

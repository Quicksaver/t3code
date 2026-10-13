import { panelItemActivity } from "./SourceControlPanel.logic";
import {
  actionableItemClassName,
  SourceControlActionableItem,
} from "./SourceControlActionableItem";
import type { VcsPanelRemote, VcsPanelStash, VcsRef } from "@t3tools/contracts";

import { Archive, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";

import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { stashIdentityKey, stashReadRef } from "./SourceControlPanel.logic";
import {
  localBranchForRemoteBranch,
  remoteBranchRef,
  stashBranchName,
  treeKey,
} from "./SourceControlPanelModel";
import {
  IconButton,
  RemoteTooltip,
  RowActions,
  StashTooltip,
} from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import type { makeSourceControlPanelBranchRenderers } from "./SourceControlPanelBranches";
import { Download } from "lucide-react";
import { formatRelativeDate } from "./SourceControlPanel.logic";
import { FileChangeList } from "./SourceControlPanelRows";
import { SourceControlVirtualList } from "./SourceControlVirtualList";

type BranchRenderers = ReturnType<typeof makeSourceControlPanelBranchRenderers>;

export function makeSourceControlPanelRepositoryRenderers(
  controller: ReadySourceControlPanelController,
  branchRenderers: BranchRenderers,
) {
  const {
    api,
    canWriteSourceControl,
    confirm,
    copyText,
    cwd,
    expandedTree,
    fileDiffListProps,
    isActionRunning,
    loadingStashDetails,
    openContextMenu,
    openFileChangeContextMenu,
    runAction,
    snapshot,
    stashDetailsByKey,
    toggleStashTree,
    toggleTree,
    toggleTreeFromKeyboard,
  } = controller;
  const { remoteBranchRow } = branchRenderers;
  const remoteRow = (remote: VcsPanelRemote) => {
    const key = treeKey("remote", remote.name);
    const expanded = expandedTree.has(key);
    const fetchKey = `remote-fetch:${remote.name}`;
    const removeKey = `remote-remove:${remote.name}`;
    const fetchRemote = () =>
      void runAction(
        fetchKey,
        "Fetching",
        () => api?.vcs.fetchRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
      );
    const removeRemote = () =>
      void (async () => {
        if (!(await confirm(`Remove remote ${remote.name}?`))) return;
        await runAction(
          removeKey,
          "Removing",
          () => api?.vcs.removeRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
        );
      })();
    const remoteUrl = remote.fetchUrl ?? remote.pushUrl ?? "";
    return (
      <div key={remote.name} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                {
                  id: "fetch",
                  label: "Fetch remote",
                  disabled: !canWriteSourceControl || isActionRunning(fetchKey),
                },
                {
                  id: "remove",
                  label: "Remove remote",
                  destructive: true,
                  disabled: !canWriteSourceControl || isActionRunning(removeKey),
                  icon: "trash",
                  separatorBefore: true,
                },
                { id: "copy-name", label: "Copy name", icon: "copy", separatorBefore: true },
                { id: "copy-url", label: "Copy url", disabled: !remoteUrl, icon: "copy" },
              ],
              {
                fetch: fetchRemote,
                remove: removeRemote,
                "copy-name": () => copyText(remote.name),
                "copy-url": () => copyText(remoteUrl, "Remote URL unavailable."),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
              {remote.name}
            </TooltipTrigger>
            <RemoteTooltip remote={remote} />
          </Tooltip>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {remote.fetchUrl ?? "No fetch URL"}
          </span>
          <RowActions
            activityLabel={panelItemActivity(controller.runningActions, [fetchKey, removeKey])}
          >
            <IconButton
              label="Fetch remote"
              disabled={!canWriteSourceControl || isActionRunning(fetchKey)}
              loading={isActionRunning(fetchKey)}
              onClick={fetchRemote}
            >
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove remote"
              destructive
              disabled={!canWriteSourceControl || isActionRunning(removeKey)}
              loading={isActionRunning(removeKey)}
              onClick={removeRemote}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            {remote.branches.length === 0 ? (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">No remote branches.</div>
            ) : (
              <SourceControlVirtualList
                items={remote.branches}
                getKey={(branch) => branch.fullRefName}
                renderItem={(branch) => {
                  const localBranch = localBranchForRemoteBranch(snapshot, remote, branch);
                  return remoteBranchRow(
                    localBranch ?? remoteBranchRef(remote, branch),
                    branch.name,
                    localBranch !== null,
                  );
                }}
              />
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const localBranchesRow = (branches: readonly VcsRef[]) => {
    const key = treeKey("unpublished", "local");
    const expanded = expandedTree.has(key);
    return (
      <div key="unpublished" className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
          onContextMenu={(event) =>
            openContextMenu(event, [{ id: "copy-name", label: "Copy name", icon: "copy" }], {
              "copy-name": () => copyText("unpublished"),
            })
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">unpublished</span>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {branches.length === 1 ? "1 branch" : `${branches.length} branches`}
          </span>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            <SourceControlVirtualList
              items={branches}
              getKey={(branch) => branch.name}
              renderItem={(branch) => remoteBranchRow(branch, branch.name, true)}
            />
          </div>
        ) : null}
      </div>
    );
  };

  const stashRow = (stash: VcsPanelStash) => {
    const stashKey = stashIdentityKey(stash);
    const key = treeKey("stash", stashKey);
    const expanded = expandedTree.has(key);
    const details = stashDetailsByKey.get(stashKey);
    const loadingDetails = loadingStashDetails.has(stashKey);
    const mutationKey = `stash-mutation:${stashKey}`;
    const mutationRunning = [...controller.runningActions.keys()].some((key) =>
      key.startsWith("stash-mutation:"),
    );
    const relativeDate = formatRelativeDate(stash.createdAt);
    const branchName = stashBranchName(stash);
    const applyStash = () =>
      void runAction(
        mutationKey,
        "Applying",
        () =>
          api?.vcs.applyStash({ cwd, expectedSha: stash.sha, stashRef: stash.refName }) ??
          Promise.resolve(),
      );
    const popStash = () =>
      void runAction(
        mutationKey,
        "Popping",
        () =>
          api?.vcs.popStash({ cwd, expectedSha: stash.sha, stashRef: stash.refName }) ??
          Promise.resolve(),
      );
    const dropStash = () =>
      void (async () => {
        if (!(await confirm(`Drop ${stash.refName}?`))) return;
        await runAction(
          mutationKey,
          "Dropping",
          () =>
            api?.vcs.dropStash({ cwd, expectedSha: stash.sha, stashRef: stash.refName }) ??
            Promise.resolve(),
        );
      })();
    return (
      <div key={stashKey} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className={actionableItemClassName}
          onClick={() => toggleStashTree(key, stash)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleStashTree(key, stash);
          }}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                {
                  id: "apply",
                  label: "Apply stash",
                  disabled: !canWriteSourceControl || mutationRunning,
                },
                {
                  id: "pop",
                  label: "Pop stash",
                  disabled: !canWriteSourceControl || mutationRunning,
                },
                {
                  id: "drop",
                  label: "Drop stash",
                  destructive: true,
                  disabled: !canWriteSourceControl || mutationRunning,
                  icon: "trash",
                  separatorBefore: true,
                },
                {
                  id: "copy-stash-name",
                  label: "Copy stash name",
                  icon: "copy",
                  separatorBefore: true,
                },
                {
                  id: "copy-branch-name",
                  label: "Copy branch name",
                  disabled: !branchName,
                  icon: "copy",
                },
              ],
              {
                apply: applyStash,
                pop: popStash,
                drop: dropStash,
                "copy-stash-name": () => copyText(stash.refName),
                "copy-branch-name": () => copyText(branchName ?? "", "Stash branch unavailable."),
              },
            )
          }
        >
          <SourceControlActionableItem
            activityLabel={controller.runningActions.get(mutationKey)}
            kind="Stashed changes"
            icon={<Archive className="size-3.5 shrink-0" />}
            title={
              <Tooltip>
                <TooltipTrigger render={<span className="block truncate" />}>
                  {stash.message}
                </TooltipTrigger>
                <StashTooltip stash={stash} branchName={branchName} />
              </Tooltip>
            }
            metadata={
              <>
                <span className="font-mono">{stash.refName}</span>
                {branchName ? <span className="min-w-0 truncate">{branchName}</span> : null}
              </>
            }
            time={relativeDate}
            actions={
              <>
                <IconButton
                  label="Apply stash"
                  disabled={!canWriteSourceControl || mutationRunning}
                  loading={isActionRunning(mutationKey)}
                  onClick={applyStash}
                >
                  <Download className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Pop stash"
                  disabled={!canWriteSourceControl || mutationRunning}
                  loading={isActionRunning(mutationKey)}
                  onClick={popStash}
                >
                  <Archive className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Drop stash"
                  destructive
                  disabled={!canWriteSourceControl || mutationRunning}
                  loading={isActionRunning(mutationKey)}
                  onClick={dropStash}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </>
            }
          />
        </div>
        {expanded && details ? (
          <div className="pl-1">
            <FileChangeList
              files={details.files}
              emptyLabel="No changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({
                kind: "stash",
                stashRef: stashReadRef(stash),
              }))}
            />
          </div>
        ) : null}
        {expanded && !details && loadingDetails ? (
          <div className="py-1 pl-1 text-xs text-muted-foreground">Loading...</div>
        ) : null}
      </div>
    );
  };

  return { localBranchesRow, remoteRow, stashRow };
}

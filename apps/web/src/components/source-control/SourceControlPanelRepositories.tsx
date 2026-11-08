import { formatRelativeDate, stashIdentityKey, stashReadRef } from "./SourceControlPanel.logic";
import {
  actionableItemClassName,
  SourceControlActionableItem,
} from "./SourceControlActionableItem";
import type { VcsPanelStash } from "@t3tools/contracts";

import { Archive, Download, Trash2 } from "lucide-react";
import { cn } from "~/lib/utils";
import { conversationItemStyles } from "../sidebar/conversationItemStyles";

import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { stashBranchName, treeKey } from "./SourceControlPanelModel";
import { IconButton, StashTooltip } from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import { FileChangeList } from "./SourceControlPanelRows";
import type { SourceControlItemEnvironment } from "./SourceControlItemEnvironments";

export function makeSourceControlPanelRepositoryRenderers(
  controller: ReadySourceControlPanelController,
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
    stashDetailsByKey,
    toggleStashTree,
  } = controller;
  const stashRow = (
    stash: VcsPanelStash,
    environments: readonly SourceControlItemEnvironment[] = [],
  ) => {
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
          className={cn(
            actionableItemClassName,
            expanded ? conversationItemStyles.active : conversationItemStyles.idle,
          )}
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
                <StashTooltip stash={stash} branchName={branchName} environments={environments} />
              </Tooltip>
            }
            metadata={
              <>
                <span>{stash.refName}</span>
                {branchName ? <span className="min-w-0 truncate">{branchName}</span> : null}
              </>
            }
            time={relativeDate}
            environments={environments}
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

  return { stashRow };
}

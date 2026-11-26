import { useGT, useMessages, T, msg } from "gt-react";
import type { EnvironmentId, VcsRef } from "@t3tools/contracts";
import { ChevronDown, Copy, GitBranch, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { cn } from "~/lib/utils";
import { conversationItemStyles } from "../sidebar/conversationItemStyles";

import { Button, InlineButton } from "../ui/button";
import { ThreadPullRequestBadgeControl, prStatusIndicator } from "../ThreadStatusIndicators";
import type { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { TooltipProvider } from "../ui/tooltip";

import {
  type FederatedItem,
  type FederatedSourceControlTarget,
  formatPanelRefLabel,
  mergeFederatedItems,
  panelBranchSyncState,
} from "./SourceControlPanel.logic";
import { isActionForced, shouldFetchBeforePull, treeKey } from "./SourceControlPanelModel";
import { CompactBadge, IconButton } from "./SourceControlPanelPrimitives";
import { makeSourceControlPanelBranchRenderers } from "./SourceControlPanelBranches";
import { makeSourceControlPanelRepositoryRenderers } from "./SourceControlPanelRepositories";
import {
  compareSourceControlWorkItems,
  makeSourceControlPanelWorkingTreeRenderers,
  sourceControlWorkItemIdentity,
  type SourceControlWorkItem,
} from "./SourceControlPanelWorkingTree";
import type { SourceControlItemEnvironment } from "./SourceControlItemEnvironments";
import type {
  ReadySourceControlPanelController,
  SourceControlPanelController,
} from "./useSourceControlPanelController";

/** One connected environment's controller, in panel order with the current thread's first. */
export interface SourceControlEnvironmentLink {
  readonly target: FederatedSourceControlTarget;
  readonly controller: SourceControlPanelController;
  readonly openPrLink: ReturnType<typeof useOpenPrLink>;
}

function readyEnvironment(
  link: SourceControlEnvironmentLink,
  gt: ReturnType<typeof useGT>,
  resolve: ReturnType<typeof useMessages>,
) {
  const { snapshot } = link.controller;
  if (!snapshot || link.controller.presentationState.status !== "ready") return null;
  const controller: ReadySourceControlPanelController = { ...link.controller, snapshot };
  const branchRenderers = makeSourceControlPanelBranchRenderers(controller, gt, resolve);
  const { stashRow } = makeSourceControlPanelRepositoryRenderers(controller, gt, resolve);
  const { renderWorkingTreeRow, workItems } = makeSourceControlPanelWorkingTreeRenderers(
    controller,
    gt,
  );
  return {
    link,
    controller,
    branchRow: branchRenderers.branchRow,
    stashRow,
    renderWorkingTreeRow,
    workItems,
  };
}

type ReadyEnvironment = NonNullable<ReturnType<typeof readyEnvironment>>;
type PeerItem = { readonly environment: ReadyEnvironment; readonly item: SourceControlWorkItem };

/**
 * Fetches and pulls reach every environment holding the same branch state. Push and its dialogs
 * stay with the owner, whose push already fast-forwards clean peers; peers then refresh their
 * tracking refs. Forced syncs never spread.
 */
function syncAcrossEnvironments(
  owner: ReadyEnvironment,
  branch: VcsRef,
  peers: readonly PeerItem[],
  event?: ReactMouseEvent<HTMLButtonElement>,
) {
  const peerBranches = peers.flatMap(({ environment, item }) =>
    item.kind === "branch" ? [{ controller: environment.controller, branch: item.branch }] : [],
  );
  if (event && isActionForced(event)) {
    owner.controller.syncBranch(branch, event);
    return;
  }
  const fetchFirst = event ? shouldFetchBeforePull(event) : false;
  const state = panelBranchSyncState(branch, owner.controller.snapshot);
  const ownerSync = owner.controller.runBranchSync(branch, { fetchFirst });
  if (state === "push") {
    void ownerSync.then(() => {
      for (const peer of peerBranches) void peer.controller.fetchBranchRef(peer.branch);
    });
    return;
  }
  if (state !== "pull" && state !== "fetch") return;
  for (const peer of peerBranches) void peer.controller.runBranchSync(peer.branch, { fetchFirst });
}

function fetchForkBranch(environment: ReadyEnvironment, item: SourceControlWorkItem) {
  if (item.kind !== "fork-branch") return Promise.resolve();
  const { api, cwd, runAction } = environment.controller;
  return runAction(
    `fork-fetch:${item.fork.localBranchName}:${item.fork.remoteRefName}`,
    msg("Fetching"),
    () => api?.vcs.fetchBranch({ cwd, branchName: item.fork.remoteRefName }) ?? Promise.resolve(),
  );
}

function renderFederatedItem(
  entry: FederatedItem<SourceControlWorkItem>,
  environmentsById: ReadonlyMap<EnvironmentId, ReadyEnvironment>,
  itemEnvironments: readonly SourceControlItemEnvironment[],
  gt: ReturnType<typeof useGT>,
) {
  const owner = environmentsById.get(entry.environmentId)!;
  const peers = entry.peers.flatMap((peer) => {
    const environment = environmentsById.get(peer.environmentId);
    return environment ? [{ environment, item: peer.item }] : [];
  });
  const item = entry.item;
  const key = `${entry.environmentId}:${item.key}`;
  switch (item.kind) {
    case "working-tree":
      return <div key={key}>{owner.renderWorkingTreeRow(item.changeSet, itemEnvironments)}</div>;
    case "stash":
      return <div key={key}>{owner.stashRow(item.stash, itemEnvironments)}</div>;
    case "branch":
      return (
        <div key={key}>
          {owner.branchRow(item.branch, {
            environments: itemEnvironments,
            ...(peers.length > 0
              ? {
                  onSync: (event?: ReactMouseEvent<HTMLButtonElement>) =>
                    syncAcrossEnvironments(owner, item.branch, peers, event),
                }
              : {}),
          })}
        </div>
      );
    case "fork-branch": {
      const { fork } = item;
      const pr = fork.pr;
      const fetchKey = `fork-fetch:${fork.localBranchName}:${fork.remoteRefName}`;
      const forkKey = `${fork.localBranchName}:${fork.remoteRefName}`;
      return (
        <div key={key}>
          {owner.branchRow(item.branch, {
            key: treeKey("fork-branch", forkKey),
            detailsKey: treeKey("fork-details", forkKey),
            compareBaseRef: fork.remoteRefName,
            syncCounts: { aheadCount: fork.aheadCount, behindCount: fork.behindCount },
            attention: "behind",
            syncLabel: gt("Fetch"),
            syncState: "fetch",
            syncActionKey: fetchKey,
            fetchActionKey: fetchKey,
            environments: itemEnvironments,
            secondaryBadge: (
              <CompactBadge>
                {gt("vs {ref}", { ref: formatPanelRefLabel(fork.remoteRefName) })}
              </CompactBadge>
            ),
            pullRequestBadge: pr ? (
              <span onKeyDown={(event) => event.stopPropagation()}>
                <ThreadPullRequestBadgeControl
                  render={<InlineButton />}
                  badge={null}
                  pullRequests={[]}
                  number={pr.number}
                  url={pr.url}
                  status={prStatusIndicator(
                    pr,
                    owner.controller.snapshot.remotes.find(
                      (remote) => remote.name === fork.remoteName,
                    )?.provider,
                  )}
                  onOpenList={() => {}}
                  onOpenPullRequest={(event) => owner.link.openPrLink(event, pr.url)}
                />
              </span>
            ) : null,
            onSync: () => {
              void fetchForkBranch(owner, item);
              for (const peer of peers) void fetchForkBranch(peer.environment, peer.item);
            },
          })}
        </div>
      );
    }
  }
}

export function SourceControlPanelView({
  links,
}: {
  readonly links: readonly SourceControlEnvironmentLink[];
}) {
  const gt = useGT();
  const resolve = useMessages();
  const environments = links.flatMap((link) => {
    const environment = readyEnvironment(link, gt, resolve);
    return environment ? [environment] : [];
  });
  const environmentsById = new Map(
    environments.map((environment) => [environment.link.target.environmentId, environment]),
  );
  const itemEnvironment = (environmentId: EnvironmentId): SourceControlItemEnvironment => {
    const { target } = environmentsById.get(environmentId)!.link;
    return { environmentId, label: target.label, machine: target.machine, active: target.active };
  };
  const items = mergeFederatedItems(
    environments.map((environment) => ({
      environmentId: environment.link.target.environmentId,
      entries: environment.workItems.map((item) => ({
        item,
        identity: sourceControlWorkItemIdentity(item, environment.controller.snapshot),
      })),
    })),
  ).toSorted((left, right) =>
    compareSourceControlWorkItems(
      left.item,
      right.item,
      environmentsById.get(left.environmentId)!.link.target.active,
      environmentsById.get(right.environmentId)!.link.target.active,
    ),
  );
  const loading = links.some((link) => link.controller.presentationState.status === "loading");
  const showEnvironmentLabels = links.length > 1 || links.some((link) => !link.target.active);
  const fetchLinks = links.filter((link) => link.controller.canWriteSourceControl);
  const fetching = links.some((link) => link.controller.isActionRunning("work-fetch"));

  return (
    <TooltipProvider delay={150} closeDelay={0} timeout={400}>
      <div
        data-source-control-tooltip-boundary
        data-conversation-surface
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
      >
        <div
          data-surface-subheader
          className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-border/60 px-2"
        >
          <IconButton
            label={gt("Fetch")}
            size="icon-sm"
            disabled={fetchLinks.length === 0 || fetching}
            loading={fetching}
            onClick={() => {
              for (const link of fetchLinks) void link.controller.fetchActionableBranches(true);
            }}
          >
            <RefreshCw className="size-3.5" />
          </IconButton>
        </div>
        {links.map((link) => (
          <EnvironmentNotice
            key={link.target.environmentId}
            link={link}
            showLabel={showEnvironmentLabels}
          />
        ))}
        <div data-source-control-section-content className="min-h-0 flex-1 overflow-auto p-2">
          {items.length > 0 ? (
            <div className="space-y-0.5">
              {items.map((entry) =>
                renderFederatedItem(
                  entry,
                  environmentsById,
                  [
                    itemEnvironment(entry.environmentId),
                    ...entry.peers.map((peer) => itemEnvironment(peer.environmentId)),
                  ],
                  gt,
                ),
              )}
            </div>
          ) : loading ? (
            <div
              role="status"
              className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70"
            >
              <T>Loading repository state...</T>
            </div>
          ) : environments.length > 0 ? (
            <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
              <T>Everything is up-to-date.</T>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}

function EnvironmentNotice({
  link,
  showLabel,
}: {
  readonly link: SourceControlEnvironmentLink;
  readonly showLabel: boolean;
}) {
  const gt = useGT();
  const { copyText, dismissError, error, presentationState, refresh } = link.controller;
  const message =
    presentationState.status === "unavailable"
      ? presentationState.message
      : presentationState.status === "ready"
        ? presentationState.syncMessage
        : null;
  if (!message) return null;
  return (
    <div
      role="alert"
      className="relative shrink-0 border-b border-error/32 bg-error-surface py-2 pl-2 pr-20 text-xs text-error-foreground"
    >
      <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
        {showLabel ? <span className="font-medium">{link.target.label}: </span> : null}
        {message}
      </div>
      <div className="absolute right-1 top-1 flex items-center gap-0.5">
        <IconButton
          label={gt("Copy error")}
          disabled={!error}
          onClick={() => copyText(error ?? "", gt("No error to copy."))}
        >
          <Copy className="size-3.5" />
        </IconButton>
        {presentationState.status === "unavailable" ? (
          <IconButton label={gt("Refresh")} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
        ) : error ? (
          <IconButton label={gt("Dismiss")} onClick={dismissError}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

/** Dialogs opened by one environment's rows, acting on that environment. */
export function SourceControlPanelDialogs({
  controller,
}: {
  readonly controller: SourceControlPanelController;
}) {
  const gt = useGT();
  const {
    branchDetailsByRef,
    canWriteSourceControl,
    chooseCompareBase,
    closeCreateBranchDialog,
    commitDialogOpen,
    commitMessageId,
    compareBaseOverrides,
    compareBaseRefs,
    compareBaseDialogTarget,
    compareBaseQuery,
    createBranchCommitTarget,
    createBranchName,
    dialogCommitMessage,
    dialogStashMessage,
    divergedSyncTarget,
    filteredCompareBaseRefs,
    gitAction,
    isActionRunning,
    publishRemoteTarget,
    publishToSelectedRemote,
    runCreateBranchFromCommit,
    runDivergedSync,
    runPanelCommit,
    runPanelStash,
    selectedChangedFiles,
    setCommitDialogOpen,
    setCompareBaseDialogTarget,
    setCompareBaseQuery,
    setCreateBranchName,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncTarget,
    setPublishRemoteTarget,
    setStashDialogTarget,
    snapshot,
    stashDialogTarget,
    stashMessageId,
  } = controller;
  const currentCompareBase = compareBaseDialogTarget
    ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
      compareBaseOverrides.get(compareBaseDialogTarget.detailsKey))
    : undefined;
  return (
    <>
      <Dialog
        open={createBranchCommitTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeCreateBranchDialog();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Create branch</T>
            </DialogTitle>
            <DialogDescription>
              {createBranchCommitTarget
                ? gt("Create a branch from {sha}.", { sha: createBranchCommitTarget.shortSha })
                : gt("Create a branch from this commit.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              size="sm"
              value={createBranchName}
              placeholder="feature/my-branch"
              aria-label={gt("Branch name")}
              disabled={
                !canWriteSourceControl ||
                isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`)
              }
              onChange={(event) => setCreateBranchName(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={closeCreateBranchDialog}>
              <T>Cancel</T>
            </Button>
            <Button
              size="sm"
              disabled={
                !canWriteSourceControl ||
                !createBranchName.trim() ||
                isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`)
              }
              onClick={() => void runCreateBranchFromCommit()}
            >
              {isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Create</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={publishRemoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRemoteTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Publish branch</T>
            </DialogTitle>
            <DialogDescription>
              {publishRemoteTarget
                ? gt("Choose the remote to set as upstream for {branch}.", {
                    branch: formatPanelRefLabel(publishRemoteTarget.branch.name),
                  })
                : gt("Choose the remote to set as upstream for this branch.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div data-conversation-surface className="flex flex-col gap-1">
              {(snapshot?.remotes ?? []).map((remote) => (
                <button
                  key={remote.name}
                  type="button"
                  className={cn(
                    conversationItemStyles.surface,
                    conversationItemStyles.idle,
                    "flex h-9 min-w-0 items-center gap-2 px-2.5 disabled:pointer-events-none disabled:opacity-64",
                  )}
                  disabled={!canWriteSourceControl}
                  onClick={() => publishToSelectedRemote(remote.name)}
                >
                  <Upload className="size-4 shrink-0 text-success-foreground" />
                  <span className={cn("min-w-0 flex-1 truncate", conversationItemStyles.title)}>
                    {formatPanelRefLabel(remote.name)}
                  </span>
                  <span
                    className={cn("min-w-0 flex-[2] truncate", conversationItemStyles.metadata)}
                  >
                    {remote.fetchUrl ?? gt("No fetch URL")}
                  </span>
                </button>
              ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPublishRemoteTarget(null)}>
              <T>Cancel</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={compareBaseDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setCompareBaseDialogTarget(null);
          setCompareBaseQuery("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Choose compare base</T>
            </DialogTitle>
            <DialogDescription>
              {compareBaseDialogTarget
                ? gt("Select the ref to compare with {branch}", {
                    branch: formatPanelRefLabel(compareBaseDialogTarget.branch.name),
                  })
                : gt("Select the ref to compare with this branch")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Combobox
                items={compareBaseRefs}
                filteredItems={filteredCompareBaseRefs}
                autoHighlight
                value={currentCompareBase ?? ""}
                onOpenChange={(open) => {
                  if (!open) setCompareBaseQuery("");
                }}
              >
                <ComboboxTrigger render={<Button variant="outline" size="sm" />}>
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {currentCompareBase
                      ? formatPanelRefLabel(currentCompareBase)
                      : gt("Choose ref")}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                </ComboboxTrigger>
                <ComboboxPopup className="flex w-80 flex-col">
                  <div className="shrink-0 px-3 pt-2.5">
                    <ComboboxInput
                      size="sm"
                      placeholder={gt("Search refs...")}
                      showTrigger={false}
                      value={compareBaseQuery}
                      onChange={(event) => setCompareBaseQuery(event.currentTarget.value)}
                    />
                  </div>
                  <ComboboxEmpty>
                    <T>No refs found.</T>
                  </ComboboxEmpty>
                  <ComboboxList className="max-h-56">
                    {filteredCompareBaseRefs.map((refName) => (
                      <ComboboxItem
                        hideIndicator
                        key={refName}
                        value={refName}
                        onClick={() => chooseCompareBase(refName)}
                      >
                        <div className="flex w-full min-w-0 items-center gap-2">
                          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {formatPanelRefLabel(refName)}
                          </span>
                        </div>
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCompareBaseDialogTarget(null);
                setCompareBaseQuery("");
              }}
            >
              <T>Cancel</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={divergedSyncTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDivergedSyncTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Sync diverged branch</T>
            </DialogTitle>
            <DialogDescription>
              {divergedSyncTarget
                ? gt("Choose how to reconcile local and upstream commits for {branch}.", {
                    branch: formatPanelRefLabel(divergedSyncTarget.branch.name),
                  })
                : gt("Choose how to reconcile local and upstream commits for this branch.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDivergedSyncTarget(null)}>
              <T>Cancel</T>
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={
                !canWriteSourceControl ||
                isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`)
              }
              onClick={() => runDivergedSync("force-pull")}
            >
              {isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Force pull</T>
            </Button>
            <Button
              size="sm"
              disabled={
                !canWriteSourceControl ||
                isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`) ||
                divergedSyncTarget?.branch.current !== true
              }
              onClick={() => runDivergedSync("merge")}
            >
              {isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Merge sync</T>
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={
                !canWriteSourceControl ||
                isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`)
              }
              onClick={() => runDivergedSync("force-push")}
            >
              {isActionRunning(`branch-sync:${divergedSyncTarget?.branch.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Force push</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Commit selected changes</T>
            </DialogTitle>
            <DialogDescription>
              <T>Provide a message, or leave it blank to auto-generate one.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="block text-sm font-medium" htmlFor={commitMessageId}>
                <T>Commit message (optional)</T>
              </label>
              <Textarea
                id={commitMessageId}
                size="sm"
                value={dialogCommitMessage}
                placeholder={gt("Leave empty to auto-generate")}
                aria-label={gt("Commit message (optional)")}
                disabled={
                  !canWriteSourceControl || isActionRunning("changes-commit") || gitAction.isPending
                }
                onChange={(event) => setDialogCommitMessage(event.currentTarget.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCommitDialogOpen(false);
                setDialogCommitMessage("");
              }}
            >
              <T>Cancel</T>
            </Button>
            <Button
              size="sm"
              disabled={
                !canWriteSourceControl ||
                selectedChangedFiles.length === 0 ||
                isActionRunning("changes-commit") ||
                gitAction.isPending
              }
              onClick={() => void runPanelCommit(dialogCommitMessage)}
            >
              {isActionRunning("changes-commit") || gitAction.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Commit</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setStashDialogTarget(null);
          setDialogStashMessage("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{gt("Stash selected changes")}</DialogTitle>
            <DialogDescription>
              <T>Provide a message, or leave it blank to auto-generate one.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="block text-sm font-medium" htmlFor={stashMessageId}>
                <T>Stash message (optional)</T>
              </label>
              <Textarea
                id={stashMessageId}
                size="sm"
                value={dialogStashMessage}
                placeholder={gt("Leave empty to auto-generate")}
                aria-label={gt("Stash message (optional)")}
                disabled={!canWriteSourceControl || isActionRunning("changes-stash")}
                onChange={(event) => setDialogStashMessage(event.currentTarget.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStashDialogTarget(null);
                setDialogStashMessage("");
              }}
            >
              <T>Cancel</T>
            </Button>
            <Button
              size="sm"
              disabled={
                !canWriteSourceControl || isActionRunning("changes-stash") || !stashDialogTarget
              }
              onClick={runPanelStash}
            >
              {isActionRunning("changes-stash") ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              <T>Stash</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

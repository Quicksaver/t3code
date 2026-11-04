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

function readyEnvironment(link: SourceControlEnvironmentLink) {
  const { snapshot } = link.controller;
  if (!snapshot || link.controller.presentationState.status !== "ready") return null;
  const controller: ReadySourceControlPanelController = { ...link.controller, snapshot };
  const branchRenderers = makeSourceControlPanelBranchRenderers(controller);
  const { stashRow } = makeSourceControlPanelRepositoryRenderers(controller);
  const { renderWorkingTreeRow, workItems } =
    makeSourceControlPanelWorkingTreeRenderers(controller);
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
    "Fetching",
    () => api?.vcs.fetchBranch({ cwd, branchName: item.fork.remoteRefName }) ?? Promise.resolve(),
  );
}

function renderFederatedItem(
  entry: FederatedItem<SourceControlWorkItem>,
  environmentsById: ReadonlyMap<EnvironmentId, ReadyEnvironment>,
  itemEnvironments: readonly SourceControlItemEnvironment[],
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
            syncLabel: "Fetch",
            syncState: "fetch",
            syncActionKey: fetchKey,
            fetchActionKey: fetchKey,
            environments: itemEnvironments,
            secondaryBadge: <CompactBadge>vs {fork.remoteRefName}</CompactBadge>,
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
  const environments = links.flatMap((link) => {
    const environment = readyEnvironment(link);
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
            label="Fetch"
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
                renderFederatedItem(entry, environmentsById, [
                  itemEnvironment(entry.environmentId),
                  ...entry.peers.map((peer) => itemEnvironment(peer.environmentId)),
                ]),
              )}
            </div>
          ) : loading ? (
            <div
              role="status"
              className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70"
            >
              Loading repository state...
            </div>
          ) : environments.length > 0 ? (
            <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
              Everything is up-to-date.
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
          label="Copy error"
          disabled={!error}
          onClick={() => copyText(error ?? "", "No error to copy.")}
        >
          <Copy className="size-3.5" />
        </IconButton>
        {presentationState.status === "unavailable" ? (
          <IconButton label="Refresh" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
        ) : error ? (
          <IconButton label="Dismiss" onClick={dismissError}>
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
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Create a branch from {createBranchCommitTarget?.shortSha ?? "this commit"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              size="sm"
              value={createBranchName}
              placeholder="feature/my-branch"
              aria-label="Branch name"
              disabled={
                !canWriteSourceControl ||
                isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`)
              }
              onChange={(event) => setCreateBranchName(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={closeCreateBranchDialog}>
              Cancel
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
              Create
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
            <DialogTitle>Publish branch</DialogTitle>
            <DialogDescription>
              Choose the remote to set as upstream for{" "}
              {publishRemoteTarget?.branch.name ?? "this branch"}.
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
                    {remote.name}
                  </span>
                  <span
                    className={cn("min-w-0 flex-[2] truncate", conversationItemStyles.metadata)}
                  >
                    {remote.fetchUrl ?? "No fetch URL"}
                  </span>
                </button>
              ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPublishRemoteTarget(null)}>
              Cancel
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
            <DialogTitle>Choose compare base</DialogTitle>
            <DialogDescription>
              Select the ref to compare with {compareBaseDialogTarget?.branch.name ?? "this branch"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Combobox
                items={compareBaseRefs}
                filteredItems={filteredCompareBaseRefs}
                autoHighlight
                value={
                  compareBaseDialogTarget
                    ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                      compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                      "")
                    : ""
                }
                onOpenChange={(open) => {
                  if (!open) setCompareBaseQuery("");
                }}
              >
                <ComboboxTrigger render={<Button variant="outline" size="sm" />}>
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {compareBaseDialogTarget
                      ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                        compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                        "Choose ref")
                      : "Choose ref"}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                </ComboboxTrigger>
                <ComboboxPopup className="flex w-80 flex-col">
                  <div className="shrink-0 px-3 pt-2.5">
                    <ComboboxInput
                      size="sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      value={compareBaseQuery}
                      onChange={(event) => setCompareBaseQuery(event.currentTarget.value)}
                    />
                  </div>
                  <ComboboxEmpty>No refs found.</ComboboxEmpty>
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
                          <span className="min-w-0 flex-1 truncate">{refName}</span>
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
              Cancel
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
            <DialogTitle>Sync diverged branch</DialogTitle>
            <DialogDescription>
              Choose how to reconcile local and upstream commits for{" "}
              {divergedSyncTarget?.branch.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDivergedSyncTarget(null)}>
              Cancel
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
              Force pull
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
              Merge sync
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
              Force push
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Commit selected changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="block text-sm font-medium" htmlFor={commitMessageId}>
                Commit message (optional)
              </label>
              <Textarea
                id={commitMessageId}
                size="sm"
                value={dialogCommitMessage}
                placeholder="Leave empty to auto-generate"
                aria-label="Commit message (optional)"
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
              Cancel
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
              Commit
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
            <DialogTitle>Stash {stashDialogTarget?.label ?? ""} changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="block text-sm font-medium" htmlFor={stashMessageId}>
                Stash message (optional)
              </label>
              <Textarea
                id={stashMessageId}
                size="sm"
                value={dialogStashMessage}
                placeholder="Leave empty to auto-generate"
                aria-label="Stash message (optional)"
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
              Cancel
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
              Stash
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

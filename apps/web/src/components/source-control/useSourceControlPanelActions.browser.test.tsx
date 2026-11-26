import type { VcsPanelSnapshotResult, VcsRef } from "@t3tools/contracts";
import { createElement, useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { useSourceControlPanelActions } from "./useSourceControlPanelActions";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

const branch: VcsRef = {
  name: "feature",
  current: false,
  isDefault: false,
  worktreePath: null,
  upstreamName: "origin/feature",
  upstreamRemoteName: "origin",
  aheadCount: 1,
  behindCount: 1,
};

const snapshotWithRemoteTip = (
  sha: string,
  options: {
    readonly branch?: VcsRef;
    readonly extraRemotes?: VcsPanelSnapshotResult["remotes"];
  } = {},
): VcsPanelSnapshotResult => ({
  status: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: false,

    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
  },
  changeGroups: [],
  worktreeChangeSets: [],
  localBranches: [options.branch ?? branch],
  branchDetails: [],
  remotes: [
    {
      name: "origin",
      fetchUrl: null,
      pushUrl: null,
      provider: null,
      branches: [
        { name: "feature", fullRefName: "origin/feature", isDefaultRemoteHead: false, sha },
      ],
    },
    ...(options.extraRemotes ?? []),
  ],
  actionableForkBranches: [],
  stashes: [],
  defaultCompareRef: null,
});

/** Renders the actions hook over panel state whose dialog targets persist across renders. */
function actionsFixture(initialSnapshot: VcsPanelSnapshotResult, writable = true) {
  let pushed!: (input: unknown) => void;
  const pushInput = new Promise<unknown>((resolve) => {
    pushed = resolve;
  });
  const targets: Pick<SourceControlPanelState, "divergedSyncTarget" | "publishRemoteTarget"> = {
    divergedSyncTarget: null,
    publishRemoteTarget: null,
  };
  const baseState = {
    canWriteSourceControl: writable,
    api: { vcs: { pushBranch: async (input: unknown) => pushed(input) } },
    cwd: "/repo",
    environmentId: "environment",
    initialFetchCwdRef: { current: null },
    peerSyncTargets: [],
    reportMutationError: () => {},
    setDivergedSyncTarget: (target: SourceControlPanelState["divergedSyncTarget"]) => {
      targets.divergedSyncTarget = target;
    },
    setPublishRemoteTarget: (target: SourceControlPanelState["publishRemoteTarget"]) => {
      targets.publishRemoteTarget = target;
    },
    setError: () => {},
    setCommitDialogOpen: () => {},
    setDialogCommitMessage: () => {},
    setStashDialogTarget: () => {},
    setDialogStashMessage: () => {},
    setRunningActions: () => {},
    sourceControlAllRemotesFetchIntervalMs: 0,
    vcsStatus: { refresh: () => {} },
  };
  let actions: ReturnType<typeof useSourceControlPanelActions> | undefined;
  function Probe({ state }: { readonly state: SourceControlPanelState }) {
    const next = useSourceControlPanelActions(
      state,
      async () => {},
      () => {},
    );
    useLayoutEffect(() => {
      actions = next;
    }, [next]);
    return null;
  }
  const element = (snapshot: VcsPanelSnapshotResult = initialSnapshot) =>
    createElement(Probe, {
      state: { ...baseState, ...targets, snapshot } as unknown as SourceControlPanelState,
    });
  return {
    actions: () => actions!,
    targets,
    pushInput,
    element,
    setWritable: (allowed: boolean) => {
      baseState.canWriteSourceControl = allowed;
    },
  };
}

describe("read-only panel actions", () => {
  it("blocks mutation callbacks and confirmation entry points, then responds to a grant change", async () => {
    const panel = actionsFixture(snapshotWithRemoteTip("remote-a"), false);
    await using screen = await render(panel.element(), { router: false });
    const mutation = vi.fn(async () => {});
    await act(async () => panel.actions().runAction("test", "Testing", mutation));
    expect(mutation).not.toHaveBeenCalled();
    expect(await panel.actions().confirm("Delete?")).toBe(false);
    panel.actions().runBranchSync(branch);
    expect(panel.targets.divergedSyncTarget).toBeNull();
    panel.setWritable(true);
    await screen.rerender(panel.element());
    await act(async () => panel.actions().runAction("test", "Testing", mutation));
    expect(mutation).toHaveBeenCalledOnce();
    panel.setWritable(false);
    await screen.rerender(panel.element());
    await act(async () => panel.actions().runAction("test", "Testing", mutation));
    expect(mutation).toHaveBeenCalledOnce();
  });
});

describe("diverged branch sync", () => {
  it("leases a confirmed force push to the remote tip the dialog opened with", async () => {
    const panel = actionsFixture(snapshotWithRemoteTip("remote-a"));
    await using screen = await render(panel.element(), { router: false });
    panel.actions().runBranchSync(branch);
    expect(panel.targets.divergedSyncTarget).not.toBeNull();

    // A background fetch advances the remote tip while the dialog stays open.
    await screen.rerender(panel.element(snapshotWithRemoteTip("remote-b")));
    await act(async () => panel.actions().runDivergedSync("force-push"));

    expect(await panel.pushInput).toMatchObject({
      branchName: "feature",
      force: true,
      expectedRemoteSha: "remote-a",
    });
  });
});

describe("publish remote picker", () => {
  it("leases a confirmed force publish to the remote tip the picker opened with", async () => {
    const unpublished: VcsRef = {
      name: "feature",
      current: false,
      isDefault: false,
      worktreePath: null,
    };
    const snapshotAt = (sha: string) =>
      snapshotWithRemoteTip(sha, {
        branch: unpublished,
        extraRemotes: [
          { name: "upstream", fetchUrl: null, pushUrl: null, provider: null, branches: [] },
        ],
      });
    const panel = actionsFixture(snapshotAt("remote-a"));
    await using screen = await render(panel.element(), { router: false });
    panel.actions().runBranchSync(unpublished, { forcedSide: "push" });
    expect(panel.targets.publishRemoteTarget).not.toBeNull();

    // A background fetch advances origin/feature while the picker stays open.
    await screen.rerender(panel.element(snapshotAt("remote-b")));
    await act(async () => panel.actions().publishToSelectedRemote("origin"));

    expect(await panel.pushInput).toMatchObject({
      branchName: "feature",
      remoteName: "origin",
      force: true,
      expectedRemoteSha: "remote-a",
    });
  });
});

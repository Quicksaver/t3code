import { THREAD_LIST_V2_MONO_FONT } from "../threads/thread-list-v2-row-appearance";
import { presentThreadPr } from "../../state/thread-pr-presentation";
import { VersionControlList } from "./VersionControlList";
import { VersionControlCommitFiles } from "./VersionControlCommitFiles";
import type {
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsRef,
} from "@t3tools/contracts";
import { panelBranchSyncCounts, panelBranchSyncState } from "@t3tools/shared/sourceControl";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { SheetActionButton } from "../threads/git/gitSheetComponents";
import {
  branchComparisonTotals,
  branchSyncLabel,
  discardableFiles,
  localBranchForRemoteBranch,
  relativeLabel,
  selectedFileStats,
  stashIdentityKey,
  stashReadRef,
  visibleRemoteBranches,
  workingTreeDiffIsStaged,
} from "./versionControlModel";
import {
  ActionButton,
  BranchCommitRow,
  ChangeCounts,
  CompactTag,
  FileRow,
  PublishRemoteDialog,
  RepositorySummary,
  SectionHeader,
} from "./VersionControlRouteComponents";
import type { VersionControlRouteController } from "./VersionControlRouteScreen";

type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;
interface FileDiffRequest {
  readonly cwd: string;
  readonly file: VcsPanelFileChange;
  readonly source: FileDiffSource;
}

export function VersionControlRouteView({
  controller,
}: {
  readonly controller: VersionControlRouteController;
}) {
  const {
    actionableExpanded,
    actionCount,
    api,
    branchDetails,
    busy,
    busyAction,
    canWriteSourceControl,
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
    loading,
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
  } = controller;
  const mutationDisabled = busy || !canWriteSourceControl;
  const renderBranchCommit = (
    commit: VcsPanelCommitSummary,
    direction: "ahead" | "behind",
    parentKey: string,
    cwd: string,
  ) => {
    const commitKey = `commit:${parentKey}:${commit.sha}`;
    const expanded = expandedRows.has(commitKey);
    return (
      <BranchCommitRow
        key={`${direction}:${commit.sha}`}
        commit={commit}
        direction={direction}
        expanded={expanded}
        onToggle={() => toggleExpanded(commitKey)}
      >
        <VersionControlCommitFiles
          key={`${cwd}:${commit.sha}`}
          commit={commit}
          cwd={cwd}
          api={api}
          renderFile={(file) => {
            const request: FileDiffRequest = {
              cwd,
              file,
              source: { kind: "commit", sha: commit.sha },
            };
            return (
              <FileRow
                key={`${commit.sha}:${file.path}:${file.originalPath ?? ""}`}
                file={file}
                disabled={busy}
                onOpenDiff={() => openFileDiff(request)}
              />
            );
          }}
        />
      </BranchCommitRow>
    );
  };

  if (!selectedThread || !selectedThreadCwd) {
    return (
      <>
        {header}
        <View className="flex-1 bg-screen px-6">
          <EmptyState
            title="Version Control unavailable"
            detail="This thread does not have an active repository checkout."
          />
        </View>
      </>
    );
  }

  if (loading && !snapshot) {
    return (
      <>
        {header}
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <Text className="text-sm font-medium text-foreground-muted">
            Loading repository state…
          </Text>
        </View>
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        {header}
        <View className="flex-1 bg-screen px-6">
          <EmptyState
            title="Version Control unavailable"
            detail={error ?? "The repository snapshot could not be loaded."}
            actionLabel="Retry"
            onAction={() => void refreshSnapshot()}
          />
        </View>
      </>
    );
  }

  return (
    <>
      {header}
      <PublishRemoteDialog
        request={publishRequest}
        remoteNames={snapshot.remotes.map((remote) => remote.name)}
        disabled={mutationDisabled}
        cancelDisabled={busy}
        onCancel={() => setPublishRequest(null)}
        onSelect={publishToRemote}
      />
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-5 px-4 pt-3"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshSnapshot({ pull: true })}
          />
        }
      >
        <RepositorySummary snapshot={snapshot} />

        {(mutationError ?? error) ? (
          <View className="rounded-2xl border border-danger-border bg-danger px-4 py-3">
            <Text selectable className="text-sm font-medium text-danger-foreground">
              {mutationError ?? error}
            </Text>
            <Pressable
              accessibilityLabel="Dismiss error"
              accessibilityRole="button"
              className="mt-2 self-start"
              onPress={() => {
                setMutationError(null);
                setError(null);
              }}
            >
              <Text className="text-xs font-t3-bold text-danger-foreground">Dismiss</Text>
            </Pressable>
          </View>
        ) : null}

        {busyAction ? (
          <View className="rounded-2xl border border-border bg-subtle px-4 py-3">
            <Text className="text-sm font-t3-bold text-foreground">{busyAction}</Text>
            <Text className="text-xs text-foreground-muted">
              Refreshing repository state when done…
            </Text>
          </View>
        ) : null}

        <View className="gap-2">
          <SectionHeader
            title="Actionable"
            subtitle={`${actionCount}`}
            expanded={actionableExpanded}
            onToggle={() => setActionableExpanded((value) => !value)}
            action={
              <ActionButton
                label="Fetch"
                icon="arrow.clockwise"
                disabled={mutationDisabled}
                onPress={() =>
                  void runAction("fetch-all", () =>
                    api.fetchAllRemotes({ cwd: selectedThreadCwd, force: true }),
                  )
                }
              />
            }
          />
          {actionableExpanded ? (
            <View className="gap-3">
              {changeSets.map((changeSet) => {
                const rowKey = `changes:${changeSet.cwd}`;
                const expanded = expandedRows.has(rowKey);
                const selected = selectedFiles(changeSet);
                const discardable = discardableFiles(selected);
                const stats = selectedFileStats(selected);
                return (
                  <View
                    key={changeSet.id}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      accessibilityLabel={
                        changeSet.current
                          ? "Working tree changes"
                          : `${changeSet.branchName} worktree changes`
                      }
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => toggleExpanded(rowKey)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground">
                          {changeSet.current ? "Working tree" : changeSet.branchName}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {selected.length} of {changeSet.files.length} files selected
                          {changeSet.current ? "" : ` · ${changeSet.cwd}`}
                        </Text>
                      </View>
                      <ChangeCounts insertions={stats.insertions} deletions={stats.deletions} />
                    </Pressable>
                    {expanded ? (
                      <>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          <ActionButton
                            label={
                              selected.length === changeSet.files.length
                                ? "Select none"
                                : "Select all"
                            }
                            icon={
                              selected.length === changeSet.files.length
                                ? "circle"
                                : "checkmark.circle"
                            }
                            disabled={busy}
                            onPress={() => selectAllFiles(changeSet)}
                          />
                          <ActionButton
                            label="Commit"
                            icon="checkmark.circle"
                            disabled={mutationDisabled || selected.length === 0}
                            onPress={() => commitSelected(changeSet)}
                          />
                          <ActionButton
                            label="Stash"
                            icon="archivebox"
                            disabled={mutationDisabled || selected.length === 0}
                            onPress={() => stashSelected(changeSet)}
                          />
                          <ActionButton
                            label="Discard"
                            icon="trash"
                            danger
                            disabled={mutationDisabled || discardable.length === 0}
                            onPress={() => discardSelected(changeSet)}
                          />
                        </View>
                        <VersionControlList
                          items={changeSet.files}
                          getKey={(file) => file.path}
                          renderItem={(file) => {
                            const diffRequest: FileDiffRequest = {
                              cwd: changeSet.cwd,
                              file,
                              source: {
                                kind: "working-tree",
                                staged: workingTreeDiffIsStaged(file),
                              },
                            };
                            return (
                              <FileRow
                                key={file.path}
                                file={file}
                                selected={(selectedByCwd.get(changeSet.cwd) ?? new Set()).has(
                                  file.path,
                                )}
                                disabled={busy}
                                onSelect={() => toggleSelectedFile(changeSet.cwd, file.path)}
                                onOpenDiff={() => openFileDiff(diffRequest)}
                              />
                            );
                          }}
                        />
                      </>
                    ) : null}
                  </View>
                );
              })}

              {localBranches.map((branch) => {
                const key = `branch:${branch.name}`;
                const details = branchDetails.get(key);
                const state = panelBranchSyncState(branch, snapshot);
                const counts = panelBranchSyncCounts(branch, snapshot);
                const date = relativeLabel(branch.lastActivityAt);
                return (
                  <View
                    key={key}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      accessibilityLabel={`${branch.name} branch`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: expandedRows.has(key) }}
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadBranchDetails(branch, key)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {branch.name}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {branch.current
                            ? "Current branch"
                            : branch.worktreePath
                              ? "Checked out"
                              : "Local branch"}
                          {date ? ` · ${date}` : ""}
                        </Text>
                      </View>
                      {counts.aheadCount > 0 ? (
                        <Text className="text-xs font-t3-bold text-emerald-500">
                          ↑{counts.aheadCount}
                        </Text>
                      ) : null}
                      {counts.behindCount > 0 ? (
                        <Text className="text-xs font-t3-bold text-amber-500">
                          ↓{counts.behindCount}
                        </Text>
                      ) : null}
                    </Pressable>
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          {!branch.current && !branch.worktreePath ? (
                            <ActionButton
                              label="Checkout"
                              icon="arrow.branch"
                              disabled={mutationDisabled}
                              onPress={() => switchBranch(branch)}
                            />
                          ) : null}
                          <ActionButton
                            label={branchSyncLabel({ state, busy })}
                            icon="arrow.clockwise"
                            disabled={mutationDisabled}
                            onPress={() => syncBranch(branch)}
                          />
                          {!branch.current ? (
                            <>
                              <ActionButton
                                label="Merge"
                                icon="point.topleft.down.curvedto.point.bottomright.up"
                                disabled={mutationDisabled}
                                onPress={() => mergeBranch(branch.name)}
                              />
                              <ActionButton
                                label="Rebase"
                                icon="arrow.triangle.pull"
                                disabled={mutationDisabled}
                                onPress={() => rebaseBranch(branch.name)}
                              />
                              <ActionButton
                                label="Delete"
                                icon="trash"
                                danger
                                disabled={mutationDisabled || branch.worktreePath !== null}
                                onPress={() => deleteBranch(branch)}
                              />
                            </>
                          ) : null}
                        </View>
                        {details ? (
                          <>
                            <View className="border-t border-border px-4 py-3">
                              <Text className="text-2xs font-t3-bold tracking-[0.9px] uppercase text-foreground-muted">
                                vs.{" "}
                                {details.baseRef ?? snapshot.defaultCompareRef ?? "default branch"}
                              </Text>
                              <Text className="mt-1 text-xs text-foreground-secondary">
                                {branchComparisonTotals(details).ahead} ahead ·{" "}
                                {branchComparisonTotals(details).behind} behind ·{" "}
                                {details.compareFiles.length} changed
                              </Text>
                            </View>
                            {details.aheadCommits.map((commit) =>
                              renderBranchCommit(commit, "ahead", key, selectedThreadCwd),
                            )}
                            {details.behindCommits.map((commit) =>
                              renderBranchCommit(commit, "behind", key, selectedThreadCwd),
                            )}
                            {details.aheadCommits.length === 0 &&
                            details.behindCommits.length === 0 ? (
                              <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                                No commits differ from the comparison branch.
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load branch details: ${detailErrors.get(key)}`
                              : "Loading branch details…"}
                          </Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}

              {snapshot.actionableForkBranches.map((fork) => {
                const branch = snapshot.localBranches.find(
                  (candidate) => candidate.name === fork.localBranchName,
                );
                if (!branch) return null;
                const key = `fork:${fork.localBranchName}:${fork.remoteRefName}`;
                const pr = fork.pr
                  ? presentThreadPr(
                      fork.pr,
                      snapshot.remotes.find((remote) => remote.name === fork.remoteName)?.provider,
                    )
                  : null;
                return (
                  <View
                    key={key}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      accessibilityLabel={`${fork.localBranchName} branch behind ${fork.remoteRefName}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: expandedRows.has(key) }}
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadBranchDetails(branch, key, fork.remoteRefName)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {fork.localBranchName}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          Behind {fork.remoteRefName}
                        </Text>
                      </View>
                      {pr ? (
                        <Text
                          accessibilityLabel={pr.accessibilityLabel}
                          className={`text-xs ${pr.textClassName}`}
                          style={{ fontFamily: THREAD_LIST_V2_MONO_FONT }}
                        >
                          #{pr.label}
                        </Text>
                      ) : null}
                      <Text className="text-xs font-t3-bold text-amber-500">
                        ↓{fork.behindCount}
                      </Text>
                    </Pressable>
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          <ActionButton
                            label="Fetch"
                            icon="arrow.clockwise"
                            disabled={mutationDisabled}
                            onPress={() =>
                              void runAction("fetch-fork", () =>
                                api.fetchBranch({
                                  cwd: selectedThreadCwd,
                                  branchName: fork.remoteRefName,
                                }),
                              )
                            }
                          />
                        </View>
                        {branchDetails.get(key) ? (
                          <>
                            {branchDetails
                              .get(key)
                              ?.aheadCommits.map((commit) =>
                                renderBranchCommit(commit, "ahead", key, selectedThreadCwd),
                              )}
                            {branchDetails
                              .get(key)
                              ?.behindCommits.map((commit) =>
                                renderBranchCommit(commit, "behind", key, selectedThreadCwd),
                              )}
                          </>
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load comparison: ${detailErrors.get(key)}`
                              : "Loading comparison…"}
                          </Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}

              {snapshot.stashes.map((stash) => {
                const detailsKey = stashIdentityKey(stash);
                const key = `stash:${detailsKey}`;
                const details = stashDetails.get(detailsKey);
                return (
                  <View
                    key={detailsKey}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      accessibilityLabel={`${stash.message}, ${stash.refName}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: expandedRows.has(key) }}
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadStashDetails(stash)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {stash.message}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {stash.refName}
                          {relativeLabel(stash.createdAt)
                            ? ` · ${relativeLabel(stash.createdAt)}`
                            : ""}
                        </Text>
                      </View>
                    </Pressable>
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          <ActionButton
                            label="Apply"
                            icon="arrow.down.circle"
                            disabled={mutationDisabled}
                            onPress={() =>
                              void runAction("apply-stash", () =>
                                api.applyStash({
                                  cwd: selectedThreadCwd,
                                  expectedSha: stash.sha,
                                  stashRef: stash.refName,
                                }),
                              )
                            }
                          />
                          <ActionButton
                            label="Pop"
                            icon="arrow.down.circle"
                            disabled={mutationDisabled}
                            onPress={() =>
                              void runAction("pop-stash", () =>
                                api.popStash({
                                  cwd: selectedThreadCwd,
                                  expectedSha: stash.sha,
                                  stashRef: stash.refName,
                                }),
                              )
                            }
                          />
                          <ActionButton
                            label="Drop"
                            icon="trash"
                            danger
                            disabled={mutationDisabled}
                            onPress={() =>
                              Alert.alert("Drop stash?", `Permanently drop ${stash.refName}?`, [
                                { text: "Cancel", style: "cancel" },
                                {
                                  text: "Drop",
                                  style: "destructive",
                                  onPress: () =>
                                    void runAction("drop-stash", () =>
                                      api.dropStash({
                                        cwd: selectedThreadCwd,
                                        expectedSha: stash.sha,
                                        stashRef: stash.refName,
                                      }),
                                    ),
                                },
                              ])
                            }
                          />
                        </View>
                        {details ? (
                          <VersionControlList
                            items={details.files}
                            getKey={(file) => file.path}
                            renderItem={(file) => {
                              const request: FileDiffRequest = {
                                cwd: selectedThreadCwd,
                                file,
                                source: {
                                  kind: "stash",
                                  stashRef: stashReadRef(stash),
                                },
                              };
                              return (
                                <FileRow
                                  key={`${file.path}:${file.originalPath ?? ""}`}
                                  file={file}
                                  disabled={busy}
                                  onOpenDiff={() => openFileDiff(request)}
                                />
                              );
                            }}
                          />
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load stash details: ${detailErrors.get(key)}`
                              : "Loading stash details…"}
                          </Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}

              {actionCount === 0 ? (
                <View className="rounded-[20px] border border-border bg-card px-4 py-5">
                  <Text className="text-base font-t3-bold text-foreground">
                    Nothing needs attention
                  </Text>
                  <Text className="mt-1 text-sm text-foreground-muted">
                    The working tree and tracked branches are synchronized.
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View className="gap-2">
          <SectionHeader
            title="Remotes"
            subtitle={`${snapshot.remotes.length}`}
            expanded={remotesExpanded}
            onToggle={() => setRemotesExpanded((value) => !value)}
            action={
              <ActionButton
                label={showAddRemote ? "Cancel" : "Add"}
                icon={showAddRemote ? "xmark" : "plus"}
                disabled={busy || (!showAddRemote && !canWriteSourceControl)}
                onPress={() => {
                  if (!showAddRemote && !canWriteSourceControl) return;
                  setRemotesExpanded(true);
                  setShowAddRemote((value) => !value);
                }}
              />
            }
          />
          {remotesExpanded ? (
            <View className="gap-3">
              {showAddRemote ? (
                <View className="gap-3 rounded-[20px] border border-border bg-card px-4 py-4">
                  <TextInput
                    value={remoteName}
                    onChangeText={setRemoteName}
                    placeholder="Remote name"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TextInput
                    value={remoteUrl}
                    onChangeText={setRemoteUrl}
                    placeholder="https://host/owner/repository.git"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <SheetActionButton
                    icon="plus"
                    label="Add remote"
                    tone="primary"
                    disabled={
                      mutationDisabled ||
                      remoteName.trim().length === 0 ||
                      remoteUrl.trim().length === 0
                    }
                    onPress={() =>
                      void runAction("add-remote", () =>
                        api.addRemote({
                          cwd: selectedThreadCwd,
                          name: remoteName.trim(),
                          url: remoteUrl.trim(),
                        }),
                      ).then((succeeded) => {
                        if (!succeeded) return;
                        setRemoteName("");
                        setRemoteUrl("");
                        setShowAddRemote(false);
                      })
                    }
                  />
                </View>
              ) : null}
              {snapshot.remotes.map((remote) => {
                const key = `remote:${remote.name}`;
                const remoteExpanded = expandedRows.has(key);
                return (
                  <View
                    key={remote.name}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      accessibilityLabel={`${remote.name} remote`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: remoteExpanded }}
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => toggleExpanded(key)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <View className="flex-row items-center gap-2">
                          <SymbolView
                            name="point.3.connected.trianglepath.dotted"
                            size={15}
                            tintColorClassName="accent-icon-subtle"
                            type="monochrome"
                          />
                          <Text className="text-base font-t3-bold text-foreground">
                            {remote.name}
                          </Text>
                        </View>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {remote.fetchUrl ?? "No fetch URL"} · {remote.branches.length} branches
                        </Text>
                      </View>
                    </Pressable>
                    {remoteExpanded ? (
                      <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                        <ActionButton
                          label="Fetch"
                          icon="arrow.clockwise"
                          disabled={mutationDisabled}
                          onPress={() =>
                            void runAction("fetch-remote", () =>
                              api.fetchRemote({
                                cwd: selectedThreadCwd,
                                remoteName: remote.name,
                              }),
                            )
                          }
                        />
                        <ActionButton
                          label="Remove"
                          icon="trash"
                          danger
                          disabled={mutationDisabled}
                          onPress={() =>
                            Alert.alert(
                              "Remove remote?",
                              `Remove ${remote.name} from this repository?`,
                              [
                                { text: "Cancel", style: "cancel" },
                                {
                                  text: "Remove",
                                  style: "destructive",
                                  onPress: () =>
                                    void runAction("remove-remote", () =>
                                      api.removeRemote({
                                        cwd: selectedThreadCwd,
                                        remoteName: remote.name,
                                      }),
                                    ),
                                },
                              ],
                            )
                          }
                        />
                      </View>
                    ) : null}
                    <VersionControlList
                      items={visibleRemoteBranches(remote, remoteExpanded)}
                      getKey={(remoteBranch) => remoteBranch.fullRefName}
                      renderItem={(remoteBranch) => {
                        const localBranch = localBranchForRemoteBranch(
                          localBranchIndex,
                          remote,
                          remoteBranch,
                        );
                        const branch: VcsRef = localBranch ?? {
                          name: remoteBranch.fullRefName,
                          isRemote: true,
                          remoteName: remote.name,
                          current: false,
                          isDefault: remoteBranch.isDefaultRemoteHead,
                          worktreePath: null,
                          lastActivityAt: remoteBranch.lastActivityAt ?? null,
                        };
                        const branchKey = `remote-branch:${remote.name}:${remoteBranch.name}`;
                        const branchExpanded = expandedRows.has(branchKey);
                        const counts = localBranch
                          ? panelBranchSyncCounts(localBranch, snapshot)
                          : { aheadCount: 0, behindCount: 0 };
                        const syncState = localBranch
                          ? panelBranchSyncState(localBranch, snapshot)
                          : null;
                        return (
                          <View
                            key={remoteBranch.fullRefName}
                            className="border-t border-border/70"
                          >
                            <Pressable
                              accessibilityLabel={`${remote.name}/${remoteBranch.name} branch`}
                              accessibilityRole="button"
                              accessibilityState={{ expanded: branchExpanded }}
                              className="min-h-12 flex-row items-center gap-2 px-4 py-3"
                              onPress={() => toggleExpanded(branchKey)}
                            >
                              <SymbolView
                                name={
                                  localBranch
                                    ? "arrow.branch"
                                    : "point.3.connected.trianglepath.dotted"
                                }
                                size={14}
                                tintColorClassName="accent-icon-subtle"
                                type="monochrome"
                              />
                              <View className="min-w-0 flex-1 gap-1">
                                <Text
                                  className="text-sm font-t3-bold text-foreground"
                                  numberOfLines={1}
                                >
                                  {remoteBranch.name}
                                </Text>
                                <View className="flex-row flex-wrap items-center gap-1">
                                  <CompactTag label={localBranch ? "local" : "remote"} />
                                  {localBranch?.current ? <CompactTag label="current" /> : null}
                                  {localBranch?.worktreePath && !localBranch.current ? (
                                    <CompactTag label="worktree" />
                                  ) : null}
                                  {remoteBranch.isDefaultRemoteHead || localBranch?.isDefault ? (
                                    <CompactTag label="default" />
                                  ) : null}
                                </View>
                              </View>
                              {counts.aheadCount > 0 ? (
                                <Text className="text-xs font-t3-bold text-emerald-500">
                                  ↑{counts.aheadCount}
                                </Text>
                              ) : null}
                              {counts.behindCount > 0 ? (
                                <Text className="text-xs font-t3-bold text-amber-500">
                                  ↓{counts.behindCount}
                                </Text>
                              ) : null}
                            </Pressable>
                            {branchExpanded ? (
                              <View className="flex-row flex-wrap gap-2 border-t border-border/70 px-3 py-3">
                                {!branch.current && !branch.worktreePath ? (
                                  <ActionButton
                                    label="Checkout"
                                    icon="arrow.branch"
                                    disabled={mutationDisabled}
                                    onPress={() => switchBranch(branch)}
                                  />
                                ) : null}
                                {localBranch && syncState ? (
                                  <ActionButton
                                    label={branchSyncLabel({
                                      state: syncState,
                                      busy,
                                    })}
                                    icon="arrow.clockwise"
                                    disabled={mutationDisabled}
                                    onPress={() => syncBranch(localBranch)}
                                  />
                                ) : (
                                  <ActionButton
                                    label="Fetch"
                                    icon="arrow.clockwise"
                                    disabled={mutationDisabled}
                                    onPress={() =>
                                      void runAction("fetch-remote-branch", () =>
                                        api.fetchBranch({
                                          cwd: selectedThreadCwd,
                                          branchName: remoteBranch.fullRefName,
                                        }),
                                      )
                                    }
                                  />
                                )}
                                {!branch.current ? (
                                  <>
                                    <ActionButton
                                      label="Merge"
                                      icon="point.topleft.down.curvedto.point.bottomright.up"
                                      disabled={mutationDisabled}
                                      onPress={() => mergeBranch(branch.name)}
                                    />
                                    <ActionButton
                                      label="Rebase"
                                      icon="arrow.triangle.pull"
                                      disabled={mutationDisabled}
                                      onPress={() => rebaseBranch(branch.name)}
                                    />
                                    <ActionButton
                                      label="Delete"
                                      icon="trash"
                                      danger
                                      disabled={mutationDisabled || branch.worktreePath !== null}
                                      onPress={() => deleteBranch(branch)}
                                    />
                                  </>
                                ) : null}
                              </View>
                            ) : null}
                          </View>
                        );
                      }}
                    />
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

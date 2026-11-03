import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type ConfirmDialogOptions,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../../lib/archivedThreadsState";
import { permanentlyDiscardComposerDraft } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import { threadEnvironment } from "../../state/threads";
import { readEnvironmentThreadRefs, readThreadShell } from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { clearThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useDiffPanelStore } from "../../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  archivedProjectBulkActionExceptionDescription,
  archivedProjectBulkScopeLabel,
  archivedProjectBulkFailureDescription,
  archivedThreadTimestampValue,
  archivedThreadActionKey,
  type ArchivedProjectBulkFailure,
  type ArchivedProjectBulkScope,
  type ArchivedProjectBulkThread,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
  buildArchivedProjectContextMenuItems,
  buildArchivedThreadContextMenuItems,
  buildArchivedThreadGroups,
  hasArchivedThreads as archiveHasThreads,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  resolveArchivedProjectEnvironmentLabel,
  runArchivedProjectThreadActions,
  scopeArchivedThreadSnapshots,
  tryAcquireArchivedThreadActionLock,
} from "./ArchiveSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import type { ResolvedSettingsScope } from "./settingsScope";

function ArchivedSortButton({
  field,
  label,
  sort,
  onClick,
}: {
  readonly field: ArchivedThreadSortField;
  readonly label: string;
  readonly sort: ArchivedThreadSortState;
  readonly onClick: () => void;
}) {
  const active = sort.field === field;
  const SortIcon = sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <Button
      type="button"
      variant={active ? "outline" : "ghost-muted"}
      size="sm"
      aria-pressed={active}
      aria-label={`Sort by ${label}${
        active ? `, ${sort.direction === "asc" ? "ascending" : "descending"}` : ""
      }`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
      {active ? <SortIcon /> : null}
    </Button>
  );
}

function ArchivedIconButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={destructive ? "ghost-destructive" : "ghost-muted"}
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ArchivedThreadsSearch({
  settingId,
  query,
  onQueryChange,
}: {
  readonly settingId: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}) {
  const searchTargetRef = useSettingsSearchTarget<HTMLInputElement>(settingId);

  return (
    <Input
      ref={searchTargetRef}
      id={settingId}
      nativeInput
      type="search"
      value={query}
      onChange={(event) => onQueryChange(event.currentTarget.value)}
      placeholder="Search archived conversations"
      aria-label="Search archived conversations"
    />
  );
}

// React Compiler cannot compile finally clauses inside a component.
async function runWithArchivedThreadCleanup(action: () => Promise<void>, cleanup: () => void) {
  try {
    await action();
  } finally {
    cleanup();
  }
}

function useArchivedThreadPresentation(
  scope: ResolvedSettingsScope,
  archiveSearchQuery: string,
  sort: ArchivedThreadSortState,
) {
  const {
    snapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);
  const archivedSnapshots = scopeArchivedThreadSnapshots(snapshots, scope);
  const archiveSearch = parseArchivedThreadSearchInput(archiveSearchQuery);
  const hasArchivedThreads = archiveHasThreads(archivedSnapshots);
  const archivedGroups = buildArchivedThreadGroups({
    snapshots: archivedSnapshots,
    normalizedSearchQuery: archiveSearch.normalizedQuery,
    searchTokens: archiveSearch.tokens,
    isSearching: archiveSearch.isSearching,
    sort,
  });
  return {
    archiveError,
    isLoadingArchive,
    refreshArchivedThreads,
    archiveSearch,
    hasArchivedThreads,
    archivedGroups,
  };
}

export function ArchivedThreadsPanel() {
  const { scope } = useSettingsScope();
  const archiveSetting = searchableSetting("archive");
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const loadThreadFamily = useAtomQueryRunner(orchestrationEnvironment.threadFamily, {
    reportFailure: false,
    refresh: true,
  });
  const operableEnvironmentIds = useEnvironmentsWithScope(
    environments,
    AuthOrchestrationOperateScope,
  );
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const unarchiveThread = async (threadRef: ScopedThreadRef) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection cannot change threads.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("archive", scopedThreadKey(threadRef));
    return unarchiveThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
  };
  const deleteThread = async (threadRef: ScopedThreadRef) => {
    let threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [{ id: shell.id, lineage: shell.lineage }];
    });
    if (
      appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId)
        ?.shellThreadFamilies
    ) {
      const family = await loadThreadFamily({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (family._tag === "Success") threads = [...family.value.threads];
    }
    const result = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      for (const kind of ["settle", "snooze", "pin", "archive"]) {
        ThreadUndo.invalidate(kind, scopedThreadKey(threadRef));
      }
      permanentlyDiscardComposerDraft(threadRef);
      for (const thread of threads) {
        if (
          thread.lineage.sideChat === true &&
          thread.lineage.parentThreadId === threadRef.threadId
        ) {
          permanentlyDiscardComposerDraft(scopeThreadRef(threadRef.environmentId, thread.id));
        }
      }
      clearTerminalUiState(threadRef);
      clearThreadPreviewState(threadRef);
      useRightPanelStore.getState().removeThread(threadRef);
      useDiffPanelStore.getState().removeThread(threadRef);
      usePreviewMiniPlayerStore.getState().removeThread(threadRef);
    }
    return result;
  };
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const inFlightArchivedThreadKeysRef = useRef(new Set<string>());
  const [inFlightArchivedThreadKeys, setInFlightArchivedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [archiveSearchQuery, setArchiveSearchQuery] = useState("");
  const [sort, setSort] = useState<ArchivedThreadSortState>({
    field: "archivedAt",
    direction: "desc",
  });
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const archiveEnvironmentsById = new Map(
    environments.map((environment) => [
      environment.environmentId,
      {
        environmentId: environment.environmentId,
        label: environment.label,
        isPrimary: environment.environmentId === primaryEnvironmentId,
      },
    ]),
  );
  const {
    archiveError,
    isLoadingArchive,
    refreshArchivedThreads,
    archiveSearch,
    hasArchivedThreads,
    archivedGroups,
  } = useArchivedThreadPresentation(scope, archiveSearchQuery, sort);

  const tryReserveArchivedThreadActions = (
    threadRefs: ReadonlyArray<ScopedThreadRef>,
  ): { readonly start: () => void; readonly finish: () => void } | null => {
    if (
      threadRefs.some(
        (threadRef) =>
          !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
      )
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Archive action unavailable",
          description: "This connection cannot change threads.",
        }),
      );
      return null;
    }
    const lock = tryAcquireArchivedThreadActionLock(
      inFlightArchivedThreadKeysRef.current,
      threadRefs,
    );
    if (!lock) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Archive action already in progress",
          description: "Wait for the current archived thread action to finish.",
        }),
      );
      return null;
    }
    let started = false;
    return {
      start: () => {
        if (started) return;
        started = true;
        setInFlightArchivedThreadKeys((current) => {
          const next = new Set(current);
          for (const key of lock.keys) next.add(key);
          return next;
        });
      },
      finish: () => {
        releaseArchivedThreadActionLock(inFlightArchivedThreadKeysRef.current, lock);
        if (!started) return;
        setInFlightArchivedThreadKeys((current) => {
          const next = new Set(current);
          for (const key of lock.keys) next.delete(key);
          return next;
        });
      },
    };
  };

  const toggleProjectExpanded = (projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  };

  const handleSortClick = (field: ArchivedThreadSortField) => {
    setSort((current) => nextArchivedThreadSortState(current, field));
  };

  const confirmArchivedAction = async (message: string, options?: ConfirmDialogOptions) => {
    const localApi = readLocalApi();
    if (!localApi) return true;
    const confirmationResult = await settlePromise(() =>
      localApi.dialogs.confirm(message, options),
    );
    if (confirmationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(confirmationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Archived thread confirmation failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return false;
    }
    return confirmationResult.value;
  };

  const showArchivedActionFailure = (
    title: string,
    result: AtomCommandResult<unknown, unknown>,
  ) => {
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const showArchivedBulkActionFailure = (
    title: string,
    failures: ReadonlyArray<ArchivedProjectBulkFailure>,
    totalCount: number,
  ) => {
    const description = archivedProjectBulkFailureDescription(failures, totalCount);
    if (!description) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description,
      }),
    );
  };

  const showArchivedBulkActionException = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: archivedProjectBulkActionExceptionDescription(error),
      }),
    );
  };

  const handleUnarchiveThread = async (threadRef: ScopedThreadRef) => {
    const reservation = tryReserveArchivedThreadActions([threadRef]);
    if (!reservation) return;
    reservation.start();
    return runWithArchivedThreadCleanup(async () => {
      const attempt = await settlePromise(() => unarchiveThread(threadRef));
      const result = attempt._tag === "Success" ? attempt.value : attempt;
      showArchivedActionFailure("Failed to unarchive thread", result);
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      }
    }, reservation.finish);
  };

  const handleDeleteArchivedThread = async (threadRef: ScopedThreadRef, title: string) => {
    const reservation = tryReserveArchivedThreadActions([threadRef]);
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            `Delete archived conversation "${title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      reservation.start();
      const attempt = await settlePromise(() => deleteThread(threadRef));
      const result = attempt._tag === "Success" ? attempt.value : attempt;
      showArchivedActionFailure("Failed to delete thread", result);
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      }
    }, reservation.finish);
  };

  const handleUnarchiveProjectThreads = async (
    projectName: string,
    threads: ReadonlyArray<ArchivedProjectBulkThread>,
    bulkScope: ArchivedProjectBulkScope,
  ) => {
    const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
    const reservation = tryReserveArchivedThreadActions(threadRefs);
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      const scopeLabel = archivedProjectBulkScopeLabel(bulkScope);
      // Bulk unarchive always asks because there is no unarchive confirmation preference.
      const confirmed = await confirmArchivedAction(
        [
          `Unarchive ${scopeLabel} in "${projectName}"?`,
          `This will restore ${threads.length} conversation${threads.length === 1 ? "" : "s"}.`,
        ].join("\n"),
      );
      if (!confirmed) return;
      reservation.start();
      await runWithArchivedThreadCleanup(
        async () => {
          try {
            const failures = await runArchivedProjectThreadActions(threads, (thread) =>
              unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)),
            );
            if (failures.length > 0) {
              showArchivedBulkActionFailure(
                "Archived threads not fully unarchived",
                failures,
                threads.length,
              );
            }
          } catch (error) {
            showArchivedBulkActionException("Archived threads not fully unarchived", error);
          }
        },
        () => {
          const environmentId = threads[0]?.environmentId;
          if (environmentId) refreshArchivedThreadsForEnvironment(environmentId);
        },
      );
    }, reservation.finish);
  };

  const handleDeleteProjectThreads = async (
    projectName: string,
    threads: ReadonlyArray<ArchivedProjectBulkThread>,
    bulkScope: ArchivedProjectBulkScope,
  ) => {
    const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
    const reservation = tryReserveArchivedThreadActions(threadRefs);
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      const scopeLabel = archivedProjectBulkScopeLabel(bulkScope);
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            `Delete ${scopeLabel} in "${projectName}"?`,
            `This permanently clears conversation history for ${threads.length} conversation${threads.length === 1 ? "" : "s"}.`,
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      reservation.start();
      await runWithArchivedThreadCleanup(
        async () => {
          try {
            const failures = await runArchivedProjectThreadActions(threads, (thread) =>
              deleteThread(scopeThreadRef(thread.environmentId, thread.id)),
            );
            if (failures.length > 0) {
              showArchivedBulkActionFailure(
                "Archived threads not fully deleted",
                failures,
                threads.length,
              );
            }
          } catch (error) {
            showArchivedBulkActionException("Archived threads not fully deleted", error);
          }
        },
        () => {
          const environmentId = threads[0]?.environmentId;
          if (environmentId) refreshArchivedThreadsForEnvironment(environmentId);
        },
      );
    }, reservation.finish);
  };

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    title: string,
    position: { x: number; y: number },
  ) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(buildArchivedThreadContextMenuItems(), position);

    if (clicked === "unarchive") {
      await handleUnarchiveThread(threadRef);
      return;
    }

    if (clicked === "delete") {
      await handleDeleteArchivedThread(threadRef, title);
    }
  };

  const handleArchivedProjectContextMenu = async (
    projectName: string,
    threads: ReadonlyArray<ArchivedProjectBulkThread>,
    bulkScope: ArchivedProjectBulkScope,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    if (
      threads.some(
        (thread) => !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
      )
    )
      return;
    const clicked = await api.contextMenu.show(
      buildArchivedProjectContextMenuItems(bulkScope),
      position,
    );

    if (clicked === "unarchive-all") {
      await handleUnarchiveProjectThreads(projectName, threads, bulkScope);
      return;
    }

    if (clicked === "delete-all") {
      await handleDeleteProjectThreads(projectName, threads, bulkScope);
    }
  };

  const handleArchivedProjectMenuButton = async (
    projectName: string,
    threads: ReadonlyArray<ArchivedProjectBulkThread>,
    bulkScope: ArchivedProjectBulkScope,
    trigger: HTMLElement,
  ) => {
    const rect = trigger.getBoundingClientRect();
    const result = await settlePromise(() =>
      handleArchivedProjectContextMenu(projectName, threads, bulkScope, {
        x: rect.right,
        y: rect.bottom,
      }),
    );
    showArchivedActionFailure("Archived project action failed", result);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title={archiveSetting.title} variant="plain">
        <div className="px-3 py-3 sm:px-4">
          <ArchivedThreadsSearch
            settingId={archiveSetting.id}
            query={archiveSearchQuery}
            onQueryChange={setArchiveSearchQuery}
          />
        </div>
      </SettingsSection>
      {archiveError ? (
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon />
          <AlertTitle>Could not load every archive</AlertTitle>
          <AlertDescription>{archiveError}</AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              aria-label="Try again to load archives"
              onClick={refreshArchivedThreads}
            >
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {archivedGroups.length === 0 &&
      (!archiveError || isLoadingArchive || (archiveSearch.isSearching && hasArchivedThreads)) ? (
        <SettingsGroup>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-4 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveSearch.isSearching && hasArchivedThreads
                    ? "No matching archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : archiveSearch.isSearching && hasArchivedThreads
                  ? `No archived conversation titles match "${archiveSearchQuery.trim()}".`
                  : "Archived threads will appear here."
            }
          />
        </SettingsGroup>
      ) : (
        <div className="space-y-8">
          {archivedGroups.map(({ key: projectKey, project, threads: projectThreads }) => {
            const canOperateProject = operableEnvironmentIds.has(project.environmentId);
            const isExpanded = archiveSearch.isSearching || expandedProjectKeys.has(projectKey);
            const bulkScope = archiveSearch.isSearching ? "matching" : "all";
            const projectHasInFlightAction = projectThreads.some((thread) =>
              inFlightArchivedThreadKeys.has(
                archivedThreadActionKey(scopeThreadRef(thread.environmentId, thread.id)),
              ),
            );
            const environmentLabel = resolveArchivedProjectEnvironmentLabel({
              environment: archiveEnvironmentsById.get(project.environmentId) ?? null,
              hasMultipleEnvironments: environments.length > 1,
            });
            return (
              <SettingsGroup key={projectKey} aria-busy={projectHasInFlightAction}>
                <SettingsRow
                  title={
                    <button
                      type="button"
                      className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      disabled={archiveSearch.isSearching}
                      aria-expanded={isExpanded}
                      onClick={() => toggleProjectExpanded(projectKey)}
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <ProjectFavicon project={project} />
                      <span className="min-w-0 break-words">{project.title}</span>
                    </button>
                  }
                  description={[
                    `${projectThreads.length} archived ${projectThreads.length === 1 ? "thread" : "threads"}`,
                    environmentLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!canOperateProject || projectHasInFlightAction) return;
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedProjectContextMenu(project.title, projectThreads, bulkScope, {
                          x: event.clientX,
                          y: event.clientY,
                        }),
                      );
                      showArchivedActionFailure("Archived project action failed", result);
                    })();
                  }}
                  control={
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost-muted"
                            size="icon-sm"
                            aria-label={`Project actions for ${project.title}`}
                            disabled={!canOperateProject || projectHasInFlightAction}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleArchivedProjectMenuButton(
                                project.title,
                                projectThreads,
                                bulkScope,
                                event.currentTarget,
                              );
                            }}
                          >
                            <EllipsisIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Project actions</TooltipPopup>
                    </Tooltip>
                  }
                />
                {isExpanded ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
                      <span className="mr-auto text-xs text-muted-foreground">Sort by</span>
                      <ArchivedSortButton
                        field="archivedAt"
                        label="Archived"
                        sort={sort}
                        onClick={() => handleSortClick("archivedAt")}
                      />
                      <ArchivedSortButton
                        field="createdAt"
                        label="Created"
                        sort={sort}
                        onClick={() => handleSortClick("createdAt")}
                      />
                    </div>
                    {projectThreads.map((thread) => {
                      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                      const threadHasInFlightAction = inFlightArchivedThreadKeys.has(
                        archivedThreadActionKey(threadRef),
                      );
                      return (
                        <SettingsRow
                          key={thread.id}
                          title={thread.title}
                          description={
                            <span className="tabular-nums">
                              Archived{" "}
                              {formatRelativeTimeLabel(
                                archivedThreadTimestampValue(thread, "archivedAt"),
                                nowMs,
                              )}{" "}
                              · Created {formatRelativeTimeLabel(thread.createdAt, nowMs)}
                            </span>
                          }
                          aria-busy={threadHasInFlightAction}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (!canOperateProject || threadHasInFlightAction) return;
                            void (async () => {
                              const result = await settlePromise(() =>
                                handleArchivedThreadContextMenu(threadRef, thread.title, {
                                  x: event.clientX,
                                  y: event.clientY,
                                }),
                              );
                              showArchivedActionFailure("Archived thread action failed", result);
                            })();
                          }}
                          control={
                            <>
                              <ArchivedIconButton
                                label="Unarchive"
                                disabled={!canOperateProject || threadHasInFlightAction}
                                onClick={() => {
                                  void handleUnarchiveThread(threadRef);
                                }}
                              >
                                <ArchiveRestoreIcon />
                              </ArchivedIconButton>
                              <ArchivedIconButton
                                label="Delete"
                                destructive
                                disabled={!canOperateProject || threadHasInFlightAction}
                                onClick={() => {
                                  void handleDeleteArchivedThread(threadRef, thread.title);
                                }}
                              >
                                <Trash2Icon />
                              </ArchivedIconButton>
                            </>
                          }
                        />
                      );
                    })}
                  </>
                ) : null}
              </SettingsGroup>
            );
          })}
        </div>
      )}
    </SettingsPageContainer>
  );
}

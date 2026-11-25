import { T, useGT, useMessages } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { ArchivedThreadActionReceipt } from "@t3tools/client-runtime/state/threads";
import {
  getArchivedSideChatsByParent,
  type ArchivedThreadBulkTarget,
} from "@t3tools/client-runtime/state/archivedThreadList";
import { m } from "~/i18n/messages";
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
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type ConfirmDialogOptions,
  type ContextMenuSource,
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
  hasPendingArchivedThreadCascade,
  isArchivedDeleteBlocked,
  recordArchivedThreadCascades,
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../../lib/archivedThreadsState";
import { permanentlyDiscardComposerDraft } from "../../lib/composerDraftUploads";
import { observeIntersection } from "../../lib/observeIntersection";
import { readLocalApi } from "../../localApi";
import { contextMenuSourceOf, openContextMenuFromKeyboard } from "../../contextMenuSource";
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
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  archivedProjectBulkActionExceptionDescription,
  archivedProjectBulkFailureDescription,
  archivedThreadTimestampValue,
  archivedThreadActionKey,
  type ArchivedProjectBulkFailure,
  type ArchivedProjectBulkScope,
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
import { useSearchableSetting } from "./settingsSearch";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import type { ResolvedSettingsScope } from "./settingsScope";

const ARCHIVED_ROW_CHUNK_SIZE = 50;
const ESTIMATED_ARCHIVED_ROW_PX = 67;

function ArchivedThreadChunk({
  rowCount,
  initiallyMounted,
  renderRows,
}: {
  readonly rowCount: number;
  readonly initiallyMounted: boolean;
  readonly renderRows: () => ReactNode;
}) {
  const [view, setView] = useState({
    near: initiallyMounted,
    rowHeight: ESTIMATED_ARCHIVED_ROW_PX,
  });
  const observeChunk = (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeIntersection(
      node,
      (entry) => {
        const near = entry.isIntersecting;
        const rowHeight = entry.boundingClientRect.height / rowCount;
        setView((current) =>
          current.near === near && current.rowHeight === rowHeight ? current : { near, rowHeight },
        );
      },
      { root: node.closest("[data-settings-page-scroll]"), rootMargin: "1200px 0px" },
    );
  };
  return (
    <div
      ref={observeChunk}
      className="*:not-first:border-t *:not-first:border-border/50 [&>[data-slot=settings-row]]:rounded-none"
      style={view.near ? undefined : { height: view.rowHeight * rowCount }}
    >
      {view.near ? renderRows() : null}
    </div>
  );
}

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
  const gt = useGT();
  const active = sort.field === field;
  const SortIcon = sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <Button
      type="button"
      variant={active ? "outline" : "ghost-muted"}
      size="sm"
      aria-pressed={active}
      aria-label={
        !active
          ? gt("Sort by {field}", { field: label })
          : sort.direction === "asc"
            ? gt("Sort by {field}, ascending", { field: label })
            : gt("Sort by {field}, descending", { field: label })
      }
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
  accessibilityLabel,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: ReactNode;
  readonly accessibilityLabel: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
}) {
  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          variant={destructive ? "ghost-destructive" : "ghost-muted"}
          size="icon-sm"
          aria-label={accessibilityLabel}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClick(event);
          }}
        />
      }
      label={label}
    >
      {children}
    </SharedTooltipTrigger>
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
  const gt = useGT();
  const searchTargetRef = useSettingsSearchTarget<HTMLInputElement>(settingId);

  return (
    <Input
      ref={searchTargetRef}
      id={settingId}
      nativeInput
      type="search"
      value={query}
      onChange={(event) => onQueryChange(event.currentTarget.value)}
      placeholder={gt("Search archived conversations")}
      aria-label={gt("Search archived conversations")}
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
    snapshots,
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
  const archiveSetting = useSearchableSetting()("archive");
  const gt = useGT();
  const resolveMessage = useMessages();
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
  const unarchiveThread = async (
    threadRef: ScopedThreadRef,
    recordSuccess: (receipt: ArchivedThreadActionReceipt) => void,
  ) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: gt("This connection cannot change threads."),
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("archive", scopedThreadKey(threadRef));
    const result = await unarchiveThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      recordSuccess({ ...threadRef, sequence: result.value.sequence });
    }
    return result;
  };
  const deleteThread = async (
    threadRef: ScopedThreadRef,
    reservation: NonNullable<ReturnType<typeof tryReserveArchivedThreadActions>>,
  ) => {
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
    if (reservation.deleteBlocked(threadRef)) {
      return AsyncResult.failure(Cause.fail(new Error(gt("This conversation has left Archive."))));
    }
    const result = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      reservation.recordSuccess({ ...threadRef, sequence: result.value.sequence });
      for (const kind of ["settle", "snooze", "pin", "archive"]) {
        ThreadUndo.invalidate(kind, scopedThreadKey(threadRef));
      }
      permanentlyDiscardComposerDraft(threadRef);
      const sideChatIds = new Set(
        reservation.sideChatsFor(threadRef).map(({ threadId }) => threadId),
      );
      for (const thread of threads) {
        if (
          thread.lineage.sideChat === true &&
          thread.lineage.parentThreadId === threadRef.threadId
        ) {
          sideChatIds.add(thread.id);
        }
      }
      for (const sideChatId of sideChatIds) {
        permanentlyDiscardComposerDraft(scopeThreadRef(threadRef.environmentId, sideChatId));
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
    snapshots,
    archiveError,
    isLoadingArchive,
    refreshArchivedThreads,
    archiveSearch,
    hasArchivedThreads,
    archivedGroups,
  } = useArchivedThreadPresentation(scope, archiveSearchQuery, sort);

  const tryReserveArchivedThreadActions = (
    threadRefs: ReadonlyArray<ScopedThreadRef>,
    action: "unarchive" | "delete",
  ) => {
    if (
      threadRefs.some(
        (threadRef) =>
          !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
      )
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Archive action unavailable"),
          description: gt("This connection cannot change threads."),
        }),
      );
      return null;
    }
    const sideChatsByParent = getArchivedSideChatsByParent(snapshots, threadRefs, action);
    const lock = hasPendingArchivedThreadCascade(threadRefs)
      ? null
      : tryAcquireArchivedThreadActionLock(inFlightArchivedThreadKeysRef.current, [
          ...threadRefs,
          ...Array.from(sideChatsByParent.values()).flat(),
        ]);
    if (!lock) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt("Archive action already in progress"),
          description: gt("Wait for the current archived thread action to finish."),
        }),
      );
      return null;
    }
    let started = false;
    const receipts: ArchivedThreadActionReceipt[] = [];
    const sequences = new Map(
      snapshots.map(({ environmentId, snapshot }) => [environmentId, snapshot.snapshotSequence]),
    );
    return {
      deleteBlocked: (threadRef: ScopedThreadRef) =>
        isArchivedDeleteBlocked(threadRef, sequences.get(threadRef.environmentId)),
      sideChatsFor: (threadRef: ScopedThreadRef) =>
        sideChatsByParent.get(archivedThreadActionKey(threadRef)) ?? [],
      start: () => {
        if (started) return;
        started = true;
        setInFlightArchivedThreadKeys((current) => {
          const next = new Set(current);
          for (const key of lock.keys) next.add(key);
          return next;
        });
      },
      recordSuccess: (receipt: ArchivedThreadActionReceipt) => {
        receipts.push(receipt);
      },
      finish: () => {
        recordArchivedThreadCascades(action, receipts);
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
          title: gt("Archived thread confirmation failed"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
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
        description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
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
    const reservation = tryReserveArchivedThreadActions([threadRef], "unarchive");
    if (!reservation) return;
    reservation.start();
    return runWithArchivedThreadCleanup(async () => {
      const attempt = await settlePromise(() =>
        unarchiveThread(threadRef, reservation.recordSuccess),
      );
      const result = attempt._tag === "Success" ? attempt.value : attempt;
      showArchivedActionFailure(gt("Failed to unarchive thread"), result);
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      }
    }, reservation.finish);
  };

  const handleDeleteArchivedThread = async (threadRef: ScopedThreadRef, title: string) => {
    const reservation = tryReserveArchivedThreadActions([threadRef], "delete");
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            gt('Delete archived conversation "{title}"?', { title }),
            gt("This permanently clears conversation history for this thread."),
            gt("Deleting a parent also deletes its side chats."),
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      reservation.start();
      const attempt = await settlePromise(() => deleteThread(threadRef, reservation));
      const result = attempt._tag === "Success" ? attempt.value : attempt;
      showArchivedActionFailure(gt("Failed to delete thread"), result);
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      }
    }, reservation.finish);
  };

  const handleUnarchiveProjectThreads = async (
    projectName: string,
    threads: ReadonlyArray<ArchivedThreadBulkTarget>,
    bulkScope: ArchivedProjectBulkScope,
  ) => {
    const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
    const reservation = tryReserveArchivedThreadActions(threadRefs, "unarchive");
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      // Bulk unarchive always asks because there is no unarchive confirmation preference.
      const confirmed = await confirmArchivedAction(
        [
          bulkScope === "matching"
            ? gt('Unarchive matching archived conversations in "{projectName}"?', { projectName })
            : gt('Unarchive all archived conversations in "{projectName}"?', { projectName }),
          gt(
            "This will restore {count, plural, one {{count} conversation} other {{count} conversations}}.",
            { count: threads.length },
          ),
          gt("Restoring a parent may also restore side chats outside the selection."),
        ].join("\n"),
      );
      if (!confirmed) return;
      reservation.start();
      await runWithArchivedThreadCleanup(
        async () => {
          try {
            const failures = await runArchivedProjectThreadActions(threads, (thread) =>
              unarchiveThread(
                scopeThreadRef(thread.environmentId, thread.id),
                reservation.recordSuccess,
              ),
            );
            if (failures.length > 0) {
              showArchivedBulkActionFailure(
                gt("Archived threads not fully unarchived"),
                failures,
                threads.length,
              );
            }
          } catch (error) {
            showArchivedBulkActionException(gt("Archived threads not fully unarchived"), error);
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
    threads: ReadonlyArray<ArchivedThreadBulkTarget>,
    bulkScope: ArchivedProjectBulkScope,
  ) => {
    const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
    const reservation = tryReserveArchivedThreadActions(threadRefs, "delete");
    if (!reservation) return;
    return runWithArchivedThreadCleanup(async () => {
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            bulkScope === "matching"
              ? gt('Delete matching archived conversations in "{projectName}"?', { projectName })
              : gt('Delete all archived conversations in "{projectName}"?', { projectName }),
            gt(
              "This permanently clears conversation history for {count, plural, one {{count} conversation} other {{count} conversations}}.",
              { count: threads.length },
            ),
            gt("Deleting a parent also deletes its side chats."),
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
              deleteThread(scopeThreadRef(thread.environmentId, thread.id), reservation),
            );
            if (failures.length > 0) {
              showArchivedBulkActionFailure(
                gt("Archived threads not fully deleted"),
                failures,
                threads.length,
              );
            }
          } catch (error) {
            showArchivedBulkActionException(gt("Archived threads not fully deleted"), error);
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
    source: ContextMenuSource,
  ) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      buildArchivedThreadContextMenuItems(),
      position,
      source,
    );

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
    threads: ReadonlyArray<ArchivedThreadBulkTarget>,
    bulkScope: ArchivedProjectBulkScope,
    position: { x: number; y: number },
    source: ContextMenuSource,
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
      source,
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
    threads: ReadonlyArray<ArchivedThreadBulkTarget>,
    bulkScope: ArchivedProjectBulkScope,
    trigger: HTMLElement,
    source: ContextMenuSource,
  ) => {
    const rect = trigger.getBoundingClientRect();
    const result = await settlePromise(() =>
      handleArchivedProjectContextMenu(
        projectName,
        threads,
        bulkScope,
        { x: rect.right, y: rect.bottom },
        source,
      ),
    );
    showArchivedActionFailure(gt("Archived project action failed"), result);
  };

  const firstExpandedProjectKey = archivedGroups.find(
    ({ key }) => archiveSearch.isSearching || expandedProjectKeys.has(key),
  )?.key;

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
          <AlertTitle>
            <T>Could not load every archive</T>
          </AlertTitle>
          <AlertDescription>{resolveMessage(archiveError)}</AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              aria-label={gt("Try again to load archives")}
              onClick={refreshArchivedThreads}
            >
              <T>Try again</T>
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
                  ? gt("Loading archived threads")
                  : archiveSearch.isSearching && hasArchivedThreads
                    ? gt("No matching archived threads")
                    : gt("No archived threads")}
              </span>
            }
            description={
              isLoadingArchive
                ? gt("Checking connected environments.")
                : archiveSearch.isSearching && hasArchivedThreads
                  ? gt('No archived conversation titles match "{query}".', {
                      query: archiveSearchQuery.trim(),
                    })
                  : gt("Archived threads will appear here.")
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
            const renderThreadRow = (thread: (typeof projectThreads)[number]) => {
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
                      {gt("Archived {archivedAge} · Created {createdAge}", {
                        archivedAge: formatRelativeTimeLabel(
                          archivedThreadTimestampValue(thread, "archivedAt"),
                          nowMs,
                          resolveMessage,
                        ),
                        createdAge: formatRelativeTimeLabel(
                          thread.createdAt,
                          nowMs,
                          resolveMessage,
                        ),
                      })}
                    </span>
                  }
                  aria-busy={threadHasInFlightAction}
                  onKeyDown={openContextMenuFromKeyboard}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!canOperateProject || threadHasInFlightAction) return;
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedThreadContextMenu(
                          threadRef,
                          thread.title,
                          { x: event.clientX, y: event.clientY },
                          contextMenuSourceOf(event),
                        ),
                      );
                      showArchivedActionFailure(gt("Archived thread action failed"), result);
                    })();
                  }}
                  control={
                    <>
                      <ArchivedIconButton
                        label={gt("Unarchive")}
                        accessibilityLabel={gt("Unarchive {title}", {
                          title: thread.title,
                        })}
                        disabled={!canOperateProject || threadHasInFlightAction}
                        onClick={() => {
                          void handleUnarchiveThread(threadRef);
                        }}
                      >
                        <ArchiveRestoreIcon />
                      </ArchivedIconButton>
                      <ArchivedIconButton
                        label={gt("Delete", { $context: "verb, deletes a thread" })}
                        accessibilityLabel={gt("Delete {title}", { title: thread.title })}
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
            };
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
                    gt(
                      "{count, plural, one {{count} archived thread} other {{count} archived threads}}",
                      { count: projectThreads.length },
                    ),
                    environmentLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onKeyDown={openContextMenuFromKeyboard}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!canOperateProject || projectHasInFlightAction) return;
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedProjectContextMenu(
                          project.title,
                          projectThreads,
                          bulkScope,
                          { x: event.clientX, y: event.clientY },
                          contextMenuSourceOf(event),
                        ),
                      );
                      showArchivedActionFailure(gt("Archived project action failed"), result);
                    })();
                  }}
                  control={
                    <ArchivedIconButton
                      label={<T>Project actions</T>}
                      accessibilityLabel={gt("Project actions for {project}", {
                        project: project.title,
                      })}
                      disabled={!canOperateProject || projectHasInFlightAction}
                      onClick={(event) => {
                        void handleArchivedProjectMenuButton(
                          project.title,
                          projectThreads,
                          bulkScope,
                          event.currentTarget,
                          contextMenuSourceOf(event),
                        );
                      }}
                    >
                      <EllipsisIcon />
                    </ArchivedIconButton>
                  }
                />
                {isExpanded ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
                      <span className="mr-auto text-xs text-muted-foreground">
                        <T>Sort by</T>
                      </span>
                      <ArchivedSortButton
                        field="archivedAt"
                        label={gt("Archived", { $context: "archive sort field" })}
                        sort={sort}
                        onClick={() => handleSortClick("archivedAt")}
                      />
                      <ArchivedSortButton
                        field="createdAt"
                        label={gt("Created", { $context: "archive sort field" })}
                        sort={sort}
                        onClick={() => handleSortClick("createdAt")}
                      />
                    </div>
                    {Array.from(
                      { length: Math.ceil(projectThreads.length / ARCHIVED_ROW_CHUNK_SIZE) },
                      (_, chunkIndex) => {
                        const start = chunkIndex * ARCHIVED_ROW_CHUNK_SIZE;
                        const rows = projectThreads.slice(start, start + ARCHIVED_ROW_CHUNK_SIZE);
                        return (
                          <ArchivedThreadChunk
                            key={chunkIndex}
                            rowCount={rows.length}
                            initiallyMounted={
                              projectKey === firstExpandedProjectKey && chunkIndex === 0
                            }
                            renderRows={() => rows.map(renderThreadRow)}
                          />
                        );
                      },
                    )}
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

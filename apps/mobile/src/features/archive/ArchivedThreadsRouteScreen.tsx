import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ArchivedThreadActionReceipt } from "@t3tools/client-runtime/state/threads";
import {
  archivedThreadActionKey,
  getArchivedSideChatsByParent,
  tryAcquireArchivedThreadActionLock,
} from "@t3tools/client-runtime/state/archivedThreadList";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { msg } from "gt-react-native";
import { useCallback, useMemo, useRef, useState } from "react";

import { m } from "../../i18n/messages";
import { readEnvironmentScope } from "../../state/session";
import * as Dialog from "../../components/ui/Dialog";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import {
  archivedThreadActionExceptionDescription,
  archivedThreadActionSummaryDescription,
  buildArchivedThreadGroups,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  runArchivedThreadActions,
  type ArchivedThreadActionResult,
  type ArchivedThreadSortState,
} from "./archivedThreadList";
import {
  hasPendingArchivedThreadCascade,
  isArchivedDeleteBlocked,
  recordArchivedThreadCascades,
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

function confirmArchivedProjectAction(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.confirm({
      title: input.title,
      message: input.message,
      confirmText: input.confirmText,
      destructive: input.destructive,
      onCancel: () => resolve(false),
      onConfirm: () => resolve(true),
    });
  });
}

async function runWithArchivedThreadCleanup(action: () => Promise<void>, cleanup: () => void) {
  try {
    await action();
  } finally {
    cleanup();
  }
}

async function runArchivedProjectAction(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  action: (thread: EnvironmentThreadShell) => Promise<ArchivedThreadActionResult>,
  actionName: "unarchive" | "delete",
  failureMessages: ReadonlyArray<string>,
) {
  const title =
    actionName === "unarchive"
      ? m(msg("Archived threads not fully unarchived"))
      : m(msg("Archived threads not fully deleted"));
  try {
    const summary = await runArchivedThreadActions(threads, action);
    if (summary.failed > 0 || summary.skipped > 0) {
      Dialog.alert(title, archivedThreadActionSummaryDescription(summary, failureMessages));
    }
  } catch (error) {
    Dialog.alert(title, archivedThreadActionExceptionDescription(error, failureMessages));
  } finally {
    const environmentId = threads[0]?.environmentId;
    if (environmentId) refreshArchivedThreadsForEnvironment(environmentId);
  }
}

export function ArchivedThreadsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sort, setSort] = useState<ArchivedThreadSortState>({
    field: "archivedAt",
    direction: "desc",
  });
  const reservedThreadKeysRef = useRef(new Set<string>());
  const [reservedThreadKeys, setReservedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyThreadKeys, setBusyThreadKeys] = useState<ReadonlySet<string>>(() => new Set());
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const search = useMemo(() => parseArchivedThreadSearchInput(searchQuery), [searchQuery]);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentId: selectedEnvironmentId,
        search,
        sort,
      }),
    [search, selectedEnvironmentId, snapshots, sort],
  );
  const { unarchiveThread, deleteThread } = useArchivedThreadListActions();
  const tryReserveThreadActions = useCallback(
    (threads: ReadonlyArray<EnvironmentThreadShell>, action: "unarchive" | "delete") => {
      if (
        threads.some(
          (thread) => !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
        )
      ) {
        Dialog.alert(
          m(msg("Archive action unavailable")),
          m(msg("This connection cannot change threads.")),
        );
        return null;
      }
      const targets = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
      const sideChatsByParent = getArchivedSideChatsByParent(snapshots, targets, action);
      const lock = hasPendingArchivedThreadCascade(targets)
        ? null
        : tryAcquireArchivedThreadActionLock(reservedThreadKeysRef.current, [
            ...targets,
            ...Array.from(sideChatsByParent.values()).flat(),
          ]);
      if (!lock) {
        Dialog.alert(
          m(msg("Archive action already in progress")),
          m(msg("Wait for the current archived thread action to finish.")),
        );
        return null;
      }
      setReservedThreadKeys(new Set(reservedThreadKeysRef.current));
      let started = false;
      const receipts: ArchivedThreadActionReceipt[] = [];
      const sequences = new Map(
        snapshots.map(({ environmentId, snapshot }) => [environmentId, snapshot.snapshotSequence]),
      );
      return {
        deleteBlocked: ({ environmentId, id }: EnvironmentThreadShell) =>
          isArchivedDeleteBlocked(scopeThreadRef(environmentId, id), sequences.get(environmentId)),
        sideChatIdsFor: ({ environmentId, id }: EnvironmentThreadShell) =>
          sideChatsByParent
            .get(archivedThreadActionKey({ environmentId, threadId: id }))
            ?.map(({ threadId }) => threadId) ?? [],
        start: () => {
          if (started) return;
          started = true;
          setBusyThreadKeys((current) => {
            const next = new Set(current);
            for (const key of lock.keys) next.add(key);
            return next;
          });
        },
        recordSuccess: ({ environmentId, id }: EnvironmentThreadShell, sequence: number) => {
          receipts.push({ environmentId, threadId: id, sequence });
        },
        finish: () => {
          recordArchivedThreadCascades(action, receipts);
          releaseArchivedThreadActionLock(reservedThreadKeysRef.current, lock);
          setReservedThreadKeys(new Set(reservedThreadKeysRef.current));
          if (!started) return;
          setBusyThreadKeys((current) => {
            const next = new Set(current);
            for (const key of lock.keys) next.delete(key);
            return next;
          });
        },
      };
    },
    [snapshots],
  );
  const showSkippedActionFeedback = useCallback(() => {
    Dialog.alert(
      m(msg("Archive action already in progress")),
      m(msg("Wait for the current archived thread action to finish.")),
    );
  }, []);
  const handleUnarchiveThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const reservation = tryReserveThreadActions([thread], "unarchive");
      if (!reservation) return;
      reservation.start();
      return runWithArchivedThreadCleanup(async () => {
        const result = await unarchiveThread(thread, {
          onSucceeded: ({ sequence }) => reservation.recordSuccess(thread, sequence),
        });
        if (result === "skipped") showSkippedActionFeedback();
      }, reservation.finish);
    },
    [showSkippedActionFeedback, tryReserveThreadActions, unarchiveThread],
  );
  const handleDeleteThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const reservation = tryReserveThreadActions([thread], "delete");
      if (!reservation) return;
      return runWithArchivedThreadCleanup(async () => {
        const confirmed = await confirmArchivedProjectAction({
          title: m(msg("Delete thread?")),
          message: [
            m(msg("“{title}” will be permanently deleted, including its terminal history."), {
              title: thread.title,
            }),
            m(msg("Deleting a parent also deletes its side chats.")),
          ].join("\n"),
          confirmText: m(msg("Delete", { $context: "verb, confirms deleting a thread" })),
          destructive: true,
        });
        if (!confirmed) return;
        reservation.start();
        const result = await deleteThread(thread, {
          deletedSideChatIds: reservation.sideChatIdsFor(thread),
          deleteBlocked: () => reservation.deleteBlocked(thread),
          onSucceeded: ({ sequence }) => reservation.recordSuccess(thread, sequence),
        });
        if (result === "skipped") showSkippedActionFeedback();
      }, reservation.finish);
    },
    [deleteThread, showSkippedActionFeedback, tryReserveThreadActions],
  );
  const handleProjectAction = useCallback(
    async (
      projectTitle: string,
      threads: ReadonlyArray<EnvironmentThreadShell>,
      scope: "all" | "matching",
      action: "unarchive" | "delete",
    ) => {
      const reservation = tryReserveThreadActions(threads, action);
      if (!reservation) return;
      return runWithArchivedThreadCleanup(async () => {
        const restoring = action === "unarchive";
        const count = threads.length;
        const title = restoring
          ? scope === "matching"
            ? m(msg("Unarchive matching archived conversations?"))
            : m(msg("Unarchive all archived conversations?"))
          : scope === "matching"
            ? m(msg("Delete matching archived conversations?"))
            : m(msg("Delete all archived conversations?"));
        const confirmed = await confirmArchivedProjectAction({
          title,
          message: [
            restoring
              ? m(
                  msg(
                    "Restore {count, plural, one {{count} conversation} other {{count} conversations}} from “{projectTitle}”?",
                  ),
                  { count, projectTitle },
                )
              : m(
                  msg(
                    "Permanently delete {count, plural, one {{count} conversation} other {{count} conversations}} from “{projectTitle}”? This also clears their terminal history.",
                  ),
                  { count, projectTitle },
                ),
            restoring
              ? m(msg("Restoring a parent may also restore side chats outside the selection."))
              : m(msg("Deleting a parent also deletes its side chats.")),
          ].join("\n"),
          confirmText: restoring
            ? m(msg("Unarchive"))
            : m(msg("Delete", { $context: "verb, confirms deleting a thread" })),
          destructive: !restoring,
        });
        if (!confirmed) return;

        reservation.start();
        const failureMessages: string[] = [];
        const actionOptions = {
          reportFailure: false,
          refreshArchivedThreads: false,
          onFailure: (message: string) => failureMessages.push(message),
        };
        await runArchivedProjectAction(
          threads,
          (thread) => {
            const options = {
              ...actionOptions,
              onSucceeded: ({ sequence }: { readonly sequence: number }) =>
                reservation.recordSuccess(thread, sequence),
            };
            return action === "unarchive"
              ? unarchiveThread(thread, options)
              : deleteThread(thread, {
                  ...options,
                  deletedSideChatIds: reservation.sideChatIdsFor(thread),
                  deleteBlocked: () => reservation.deleteBlocked(thread),
                });
          },
          action,
          failureMessages,
        );
      }, reservation.finish);
    },
    [deleteThread, tryReserveThreadActions, unarchiveThread],
  );

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={(thread) => void handleDeleteThread(thread)}
      onEnvironmentChange={setSelectedEnvironmentId}
      onProjectAction={(projectTitle, threads, scope, action) =>
        void handleProjectAction(projectTitle, threads, scope, action)
      }
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortChange={setSort}
      onUnarchiveThread={(thread) => void handleUnarchiveThread(thread)}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sort={sort}
      busyThreadKeys={busyThreadKeys}
      reservedThreadKeys={reservedThreadKeys}
    />
  );
}

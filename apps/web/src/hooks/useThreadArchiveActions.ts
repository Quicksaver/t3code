import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  archiveEligibleThreadEntries,
  getArchiveOutcomeNotices,
  getCompletedArchiveThreadKeys,
  withCoordinatedThreadArchiveEntries,
} from "../components/threadArchive.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { readThreadShell } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { useThreadActions } from "./useThreadActions";

export type ThreadArchiveEntry = {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
};

export type CoordinatedArchiveOptions = {
  readonly confirmationMessage: (entries: readonly ThreadArchiveEntry[]) => string;
  readonly canArchive?: (entry: ThreadArchiveEntry) => boolean;
};

type ThreadArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly confirmThreadArchive: boolean;
};

function checkArchivePermissions(entries: readonly ThreadArchiveEntry[]): boolean {
  if (
    entries.every(({ threadRef }) =>
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    )
  )
    return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more of these threads.",
  });
  return false;
}

/**
 * Shared archive policy for every web surface. The reservation pool lives in
 * the pure coordination module, so separate hook instances (for example the
 * sidebar and chat header) cannot race the same thread.
 */
export function useThreadArchiveActions({
  archiveThread,
  confirmThreadArchive,
}: ThreadArchiveActionsInput) {
  const confirmArchive = useCallback(
    async (message: string) => {
      if (!confirmThreadArchive) return true;
      const api = readLocalApi();
      if (!api) return false;
      const result = await settlePromise(() => api.dialogs.confirm(message));
      return result._tag === "Success" && result.value;
    },
    [confirmThreadArchive],
  );

  const archiveThreadEntries = useCallback(
    async (
      entries: readonly ThreadArchiveEntry[],
      options: {
        readonly canArchive?: (entry: ThreadArchiveEntry) => boolean;
        readonly onCompleted?: (threadKey: string) => void;
      } = {},
    ) => {
      const outcome = await archiveEligibleThreadEntries({
        entries,
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        ...(options.canArchive ? { canArchive: options.canArchive } : {}),
        // Clear each row from selection as it archives: Undo can restore it
        // while later entries run, and the user may select it again.
        onArchived: ({ threadKey }) => {
          useThreadSelectionStore.getState().removeFromSelection([threadKey]);
          options.onCompleted?.(threadKey);
        },
        onSkipped: ({ threadKey }) => options.onCompleted?.(threadKey),
      });
      const notices = getArchiveOutcomeNotices({
        outcome,
        entryCount: entries.length,
        isInterrupted: isAtomCommandInterrupted,
      });
      for (const notice of notices) {
        if (notice.type === "warning") {
          toastManager.add(stackedThreadToast(notice));
          continue;
        }
        const error = squashAtomCommandFailure(notice.failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: notice.title,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return outcome;
    },
    [archiveThread],
  );

  const archiveCoordinatedEntries = useCallback(
    async (entries: readonly ThreadArchiveEntry[], options: CoordinatedArchiveOptions) => {
      await withCoordinatedThreadArchiveEntries({
        entries,
        run: async (ownedEntries, onCompleted) => {
          if (!checkArchivePermissions(ownedEntries)) return [];
          if (!(await confirmArchive(options.confirmationMessage(ownedEntries)))) return [];
          if (!checkArchivePermissions(ownedEntries)) return [];
          const outcome = await archiveThreadEntries(ownedEntries, {
            onCompleted,
            ...(options.canArchive ? { canArchive: options.canArchive } : {}),
          });
          return getCompletedArchiveThreadKeys(outcome);
        },
      });
    },
    [archiveThreadEntries, confirmArchive],
  );

  const attemptArchive = useCallback(
    (threadRef: ScopedThreadRef) => {
      void archiveCoordinatedEntries([{ threadKey: scopedThreadKey(threadRef), threadRef }], {
        confirmationMessage: ([entry]) => {
          const thread = entry ? readThreadShell(entry.threadRef) : null;
          return thread ? `Archive thread "${thread.title}"?` : "Archive this thread?";
        },
      });
    },
    [archiveCoordinatedEntries],
  );

  return { archiveCoordinatedEntries, attemptArchive };
}

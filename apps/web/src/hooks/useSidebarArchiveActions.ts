import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useRef, useState } from "react";

import type { useThreadActions } from "./useThreadActions";
import { readThreadShell } from "../state/entities";
import { canArchiveSettledSidebarThread } from "../components/SidebarArchiveControls.logic";
import { useThreadArchiveActions, type ThreadArchiveEntry } from "./useThreadArchiveActions";

export type SidebarArchiveEntry = ThreadArchiveEntry;

type SidebarArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly archivableSettledThreads: readonly EnvironmentThreadShell[];
  readonly confirmThreadArchive: boolean;
  readonly settledThreadKeysRef: { readonly current: ReadonlySet<string> };
};

/**
 * Adds the default sidebar's bulk and settled-membership policies to the
 * shared archive lifecycle. Keeping those policies out of the upstream-owned
 * sidebar component limits future reconciliations to its integration points.
 */
export function useSidebarArchiveActions({
  archiveThread,
  archivableSettledThreads,
  confirmThreadArchive,
  settledThreadKeysRef,
}: SidebarArchiveActionsInput) {
  const { archiveCoordinatedEntries, attemptArchive } = useThreadArchiveActions({
    archiveThread,
    confirmThreadArchive,
  });

  const archiveSelectedEntries = useCallback(
    (entries: readonly SidebarArchiveEntry[]) =>
      archiveCoordinatedEntries(entries, {
        confirmationMessage: (ownedEntries) => {
          const count = ownedEntries.length;
          return `Archive ${count} thread${count === 1 ? "" : "s"}?`;
        },
        canArchive: ({ threadRef }) => threadRuntimeCanArchive(readThreadShell(threadRef)?.runtime),
      }),
    [archiveCoordinatedEntries],
  );

  const [isArchivingAllSettled, setIsArchivingAllSettled] = useState(false);
  const archivingAllSettledRef = useRef(false);
  const archiveAllSettled = useCallback(() => {
    if (archivingAllSettledRef.current || archivableSettledThreads.length === 0) return;
    archivingAllSettledRef.current = true;
    setIsArchivingAllSettled(true);
    const entries = archivableSettledThreads.map((thread) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      return { threadKey: scopedThreadKey(threadRef), threadRef };
    });
    void archiveCoordinatedEntries(entries, {
      confirmationMessage: (ownedEntries) => {
        const count = ownedEntries.length;
        return `Archive all ${count} settled thread${count === 1 ? "" : "s"}?`;
      },
      canArchive: ({ threadKey, threadRef }) =>
        canArchiveSettledSidebarThread({
          threadKey,
          settledThreadKeys: settledThreadKeysRef.current,
          shell: readThreadShell(threadRef),
          now: new Date().toISOString(),
        }),
    }).finally(() => {
      archivingAllSettledRef.current = false;
      setIsArchivingAllSettled(false);
    });
  }, [archivableSettledThreads, archiveCoordinatedEntries, settledThreadKeysRef]);

  return {
    archiveAllSettled,
    archiveSelectedEntries,
    attemptArchive,
    isArchivingAllSettled,
  };
}

import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRef, useState } from "react";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";

import type { useThreadActions } from "./useThreadActions";
import { readThreadShell } from "../state/entities";
import {
  canArchiveSettledSidebarThread,
  isSidebarThreadInScope,
} from "../components/SidebarArchiveControls.logic";
import { createThreadArchiveActions, type ThreadArchiveEntry } from "./createThreadArchiveActions";
import { toastManager } from "../components/ui/toast";

export type SidebarArchiveEntry = ThreadArchiveEntry;

type SidebarArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly loadSettledThreads: () => Promise<{
    readonly threads: readonly EnvironmentThreadShell[];
    readonly release: () => void;
  }>;
  readonly confirmThreadArchive: boolean;
  readonly settledScopesRef: { readonly current: readonly OlderSettledScope[] };
};

/**
 * Adds the default sidebar's bulk and settled-membership policies to the
 * shared archive lifecycle. Keeping those policies out of the upstream-owned
 * sidebar component limits future reconciliations to its integration points.
 */
export function useSidebarArchiveActions({
  archiveThread,
  loadSettledThreads,
  confirmThreadArchive,
  settledScopesRef,
}: SidebarArchiveActionsInput) {
  const { archiveCoordinatedEntries, attemptArchive } = createThreadArchiveActions({
    archiveThread,
    confirmThreadArchive,
  });

  const archiveSelectedEntries = (entries: readonly SidebarArchiveEntry[]) =>
    archiveCoordinatedEntries(entries, {
      confirmationMessage: (ownedEntries) => {
        const count = ownedEntries.length;
        return `Archive ${count} thread${count === 1 ? "" : "s"}?`;
      },
      canArchive: ({ threadRef }) => threadRuntimeCanArchive(readThreadShell(threadRef)?.runtime),
    });

  const [isArchivingAllSettled, setIsArchivingAllSettled] = useState(false);
  const archivingAllSettledRef = useRef(false);
  const archiveAllSettled = async () => {
    if (archivingAllSettledRef.current) return;
    archivingAllSettledRef.current = true;
    setIsArchivingAllSettled(true);
    let release: (() => void) | undefined;
    try {
      const loaded = await loadSettledThreads();
      release = loaded.release;
      const isInScope = ({ threadRef }: ThreadArchiveEntry) => {
        const shell = readThreadShell(threadRef);
        return (
          shell !== null &&
          isSidebarThreadInScope(
            { environmentId: threadRef.environmentId, projectId: shell.projectId },
            settledScopesRef.current,
          )
        );
      };
      const entries = loaded.threads
        .map((thread) => {
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          return { threadKey: scopedThreadKey(threadRef), threadRef };
        })
        .filter(isInScope);
      if (entries.length === 0) {
        toastManager.add({ type: "info", title: "No settled threads to archive" });
        return;
      }
      await archiveCoordinatedEntries(entries, {
        isInScope,
        confirmationMessage: (ownedEntries) => {
          const count = ownedEntries.length;
          return `Archive all ${count} settled thread${count === 1 ? "" : "s"}?`;
        },
        canArchive: ({ threadRef }) =>
          canArchiveSettledSidebarThread({
            environmentId: threadRef.environmentId,
            scopes: settledScopesRef.current,
            shell: readThreadShell(threadRef),
            now: new Date().toISOString(),
          }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not archive settled threads",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      release?.();
      archivingAllSettledRef.current = false;
      setIsArchivingAllSettled(false);
    }
  };

  return {
    archiveAllSettled,
    archiveSelectedEntries,
    attemptArchive,
    isArchivingAllSettled,
  };
}

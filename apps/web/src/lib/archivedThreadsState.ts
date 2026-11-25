import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  type ArchivedThreadActionReceipt,
  createArchivedThreadSnapshots,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../state/orchestration";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archive = createArchivedThreadSnapshots({
  getSnapshotAtom: archivedSnapshotAtom,
  getLiveShellAtom: environmentShell.stateValueAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function recordArchivedThreadCascades(
  action: "unarchive" | "delete",
  receipts: ReadonlyArray<ArchivedThreadActionReceipt>,
): void {
  archive.recordCascades(appAtomRegistry, action, receipts);
}

export function hasPendingArchivedThreadCascade(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): boolean {
  return archive.hasPendingCascade(appAtomRegistry, threadRefs);
}

export function isArchivedDeleteBlocked(
  threadRef: ScopedThreadRef,
  selectedSequence: number | undefined,
): boolean {
  return archive.isDeleteBlocked(appAtomRegistry, threadRef, selectedSequence);
}

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = makeArchivedThreadsEnvironmentKey(environmentIds);
  const result = useAtomValue(archive.snapshotsAtom(environmentKey));
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  };

  return {
    ...result,
    refresh,
  };
}

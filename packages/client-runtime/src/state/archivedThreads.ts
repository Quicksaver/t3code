import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ShellSnapshot,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-i18n";

import { getArchivedSideChatsByParent } from "./archivedThreadList.ts";
import { threadKey } from "./entities.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { hiddenThreadKeys, type TagFilteredEnvironment } from "./threadTagFilter.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

type ArchiveCascadeAction = "unarchive" | "delete";
type ArchiveCascadeReceipt = { readonly action: ArchiveCascadeAction; readonly sequence: number };
export type ArchivedThreadActionReceipt = ScopedThreadRef & { readonly sequence: number };

function pendingArchiveThreadIds(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ArchivedShellSnapshot,
  receipts: ReadonlyMap<ThreadId, ArchiveCascadeReceipt>,
): ReadonlySet<ThreadId> {
  const parents: Record<ArchiveCascadeAction, ScopedThreadRef[]> = { unarchive: [], delete: [] };
  const ids = new Set<ThreadId>();
  for (const [threadId, { action, sequence }] of receipts) {
    if (sequence > snapshot.snapshotSequence) {
      ids.add(threadId);
      parents[action].push({ environmentId, threadId });
    }
  }
  for (const action of ["unarchive", "delete"] as const) {
    if (parents[action].length === 0) continue;
    const sideChatsByParent = getArchivedSideChatsByParent(
      [{ environmentId, snapshot }],
      parents[action],
      action,
    );
    for (const children of sideChatsByParent.values()) {
      for (const { threadId } of children) ids.add(threadId);
    }
  }
  return ids;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshots<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly getLiveShellAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly hiddenThreadTagsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<string> | null>;
  /** Live threads the tag filter hides, so archived children of hidden parents stay hidden. */
  readonly hiddenThreadKeysAtom: Atom.Atom<ReadonlySet<string>>;
  /** Live threads, so archived children of loaded, visible parents stay visible. */
  readonly liveThreadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  /** Whether any connected environment hides tags, including ones outside this archive's scope. */
  readonly anyEnvironmentHidingAtom: Atom.Atom<boolean>;
  readonly labelPrefix: string;
}) {
  const cascadeReceipts = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyMap<ThreadId, ArchiveCascadeReceipt>>(new Map()).pipe(Atom.keepAlive),
  );
  const readSnapshot = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    AsyncResult.getOrElse(registry.get(options.getSnapshotAtom(environmentId)), () => null);
  const pendingCascadeIds = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const receipts = get(cascadeReceipts(environmentId));
      if (receipts.size === 0) return null;
      const snapshot = AsyncResult.getOrElse(
        get(options.getSnapshotAtom(environmentId)),
        () => null,
      );
      return snapshot === null ? null : pendingArchiveThreadIds(environmentId, snapshot, receipts);
    }),
  );
  const archivedIdsBySnapshot = new WeakMap<
    OrchestrationV2ArchivedShellSnapshot,
    ReadonlySet<ThreadId>
  >();
  const liveIdsBySnapshot = new WeakMap<OrchestrationV2ShellSnapshot, ReadonlySet<ThreadId>>();
  const isDeleteBlocked = (
    registry: AtomRegistry.AtomRegistry,
    { environmentId, threadId }: ScopedThreadRef,
    selectedSequence: number | undefined,
  ) => {
    if (registry.get(pendingCascadeIds(environmentId))?.has(threadId)) return true;
    if (selectedSequence === undefined) return false;
    const snapshot = readSnapshot(registry, environmentId);
    const shell = registry.get(options.getLiveShellAtom(environmentId));
    const live = shell.status === "live" ? Option.getOrNull(shell.snapshot) : null;
    // The live shell can receive a restore without invalidating the archived page.
    if (
      live !== null &&
      live.snapshotSequence >
        Math.max(selectedSequence, snapshot?.snapshotSequence ?? selectedSequence)
    ) {
      let liveIds = liveIdsBySnapshot.get(live);
      if (liveIds === undefined) {
        liveIds = new Set(
          live.threads.filter(({ archivedAt }) => archivedAt === null).map(({ id }) => id),
        );
        liveIdsBySnapshot.set(live, liveIds);
      }
      if (liveIds.has(threadId)) return true;
    }
    if (snapshot === null || snapshot.snapshotSequence <= selectedSequence) return false;
    let archivedIds = archivedIdsBySnapshot.get(snapshot);
    if (archivedIds === undefined) {
      archivedIds = new Set(
        snapshot.threads.filter(({ archivedAt }) => archivedAt !== null).map(({ id }) => id),
      );
      archivedIdsBySnapshot.set(snapshot, archivedIds);
    }
    return !archivedIds.has(threadId);
  };
  const recordCascades = (
    registry: AtomRegistry.AtomRegistry,
    action: ArchiveCascadeAction,
    receipts: ReadonlyArray<ArchivedThreadActionReceipt>,
  ) => {
    const byEnvironment = new Map<EnvironmentId, ArchivedThreadActionReceipt[]>();
    for (const receipt of receipts) {
      let forEnvironment = byEnvironment.get(receipt.environmentId);
      if (forEnvironment === undefined) {
        forEnvironment = [];
        byEnvironment.set(receipt.environmentId, forEnvironment);
      }
      forEnvironment.push(receipt);
    }
    for (const [environmentId, forEnvironment] of byEnvironment) {
      const snapshotSequence = readSnapshot(registry, environmentId)?.snapshotSequence ?? -1;
      registry.update(cascadeReceipts(environmentId), (current) => {
        const next = new Map<ThreadId, ArchiveCascadeReceipt>();
        for (const [id, receipt] of current) {
          if (receipt.sequence > snapshotSequence) next.set(id, receipt);
        }
        for (const { threadId, sequence } of forEnvironment) {
          if (sequence > (next.get(threadId)?.sequence ?? snapshotSequence)) {
            next.set(threadId, { action, sequence });
          }
        }
        return next;
      });
    }
  };
  const hasPendingCascade = (
    registry: AtomRegistry.AtomRegistry,
    refs: ReadonlyArray<ScopedThreadRef>,
  ) =>
    refs.some(({ environmentId, threadId }) =>
      registry.get(pendingCascadeIds(environmentId))?.has(threadId),
    );
  const snapshotsAtom = Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      const environments: TagFilteredEnvironment[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));
        isLoading ||= result.waiting;

        const snapshot = AsyncResult.getOrElse(result, () => null);
        if (snapshot !== null) {
          const pending = get(pendingCascadeIds(environmentId));
          snapshots.push({
            environmentId,
            snapshot: !pending?.size
              ? snapshot
              : { ...snapshot, threads: snapshot.threads.filter(({ id }) => !pending.has(id)) },
          });
        }
        // A page that has not arrived still counts, so its tags apply to children elsewhere.
        environments.push({
          environmentId,
          threads: snapshot?.threads ?? [],
          hiddenTags: get(options.hiddenThreadTagsAtom(environmentId)),
        });

        if (error === null && result._tag === "Failure") {
          error = msg("Failed to load archived threads.");
        }
      }

      // One pass over every environment's page, so archived tasks follow parents archived elsewhere.
      // Any connected machine may hide an unloaded parent, so the global flag decides, not the scope.
      const hidingAnywhere = get(options.anyEnvironmentHidingAtom);
      const hidden = hiddenThreadKeys(
        environments,
        get(options.hiddenThreadKeysAtom),
        hidingAnywhere ? new Set(get(options.liveThreadRefsAtom).map(threadKey)) : undefined,
        hidingAnywhere,
      );
      if (hidden.size === 0) return { snapshots, error, isLoading };
      return {
        snapshots: snapshots.map(({ environmentId, snapshot }) => ({
          environmentId,
          snapshot: {
            ...snapshot,
            threads: snapshot.threads.filter(
              (thread) => !hidden.has(threadKey({ environmentId, threadId: thread.id })),
            ),
          },
        })),
        error,
        isLoading,
      };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
  return { snapshotsAtom, recordCascades, hasPendingCascade, isDeleteBlocked };
}

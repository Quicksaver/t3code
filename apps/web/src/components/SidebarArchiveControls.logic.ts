import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";

type ThreadRuntime = EnvironmentThreadShell["runtime"] | undefined;
type SettledArchiveShell = ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "projectId" | "settledOverride" | "runtime">;

export function isSidebarThreadInScope(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  scopes: readonly OlderSettledScope[],
): boolean {
  return scopes.some(
    (scope) =>
      scope.environmentId === thread.environmentId &&
      (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
  );
}

/**
 * Archive all re-checks the live shell, not only the last rendered settled
 * partition: it must still be settled and unsnoozed, inside the rendered
 * project scope, and archivable under upstream's runtime rule.
 */
export function canArchiveSettledSidebarThread(input: {
  readonly environmentId: EnvironmentId;
  readonly scopes: readonly OlderSettledScope[];
  readonly shell: SettledArchiveShell | null;
  readonly now: string;
}): boolean {
  const { shell } = input;
  return (
    shell !== null &&
    isSidebarThreadInScope(
      { environmentId: input.environmentId, projectId: shell.projectId },
      input.scopes,
    ) &&
    shell.settledOverride === "settled" &&
    !effectiveSnoozed(shell, { now: input.now }) &&
    threadRuntimeCanArchive(shell.runtime)
  );
}

export function filterArchivableSidebarThreads<T extends { readonly runtime: ThreadRuntime }>(
  threads: readonly T[],
  canOperate: (thread: T) => boolean,
): T[] {
  return threads.filter((thread) => canOperate(thread) && threadRuntimeCanArchive(thread.runtime));
}

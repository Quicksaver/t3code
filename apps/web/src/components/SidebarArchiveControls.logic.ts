import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

type ThreadRuntime = EnvironmentThreadShell["runtime"] | undefined;
type SettledArchiveShell = ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "settledOverride" | "runtime">;

/**
 * Archive all re-checks the live shell, not only the last rendered settled
 * partition: it must still be settled and unsnoozed, inside the rendered
 * project scope, and archivable under upstream's runtime rule.
 */
export function canArchiveSettledSidebarThread(input: {
  readonly threadKey: string;
  readonly settledThreadKeys: ReadonlySet<string>;
  readonly shell: SettledArchiveShell | null;
  readonly now: string;
}): boolean {
  const { shell } = input;
  return (
    shell !== null &&
    input.settledThreadKeys.has(input.threadKey) &&
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

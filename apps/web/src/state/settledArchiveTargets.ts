import type { OlderSettledPages, OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  filterArchivableSidebarThreads,
  isSidebarThreadInScope,
} from "../components/SidebarArchiveControls.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "./entities";
import { readEnvironmentScope } from "./session";
import { olderSettledThreads, threadFamilies } from "./threads";

const INCOMPLETE_LOAD_MESSAGE =
  "Could not load all settled threads. No threads were archived. Try again.";

function waitForArchivePages(atom: Atom.Atom<OlderSettledPages>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let readCount = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (failed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe?.();
      signal.removeEventListener("abort", abort);
      if (failed) reject(new Error(INCOMPLETE_LOAD_MESSAGE));
      else resolve();
    };
    const abort = () => finish(true);
    const observe = (pages: OlderSettledPages) => {
      if (finished) return;
      if (pages.status !== "pending") {
        finish(pages.status === "failed");
        return;
      }
      // A healthy page chain can take minutes; only a stalled page has a deadline.
      if (timeout === undefined || pages.reads.length > readCount) {
        clearTimeout(timeout);
        timeout = setTimeout(abort, 30_000);
      }
      readCount = pages.reads.length;
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    unsubscribe = appAtomRegistry.subscribe(atom, observe);
    if (finished) unsubscribe();
    else observe(appAtomRegistry.get(atom));
  });
}

/** Mount all older pages only for the explicit bulk action, through confirmation and mutation. */
export async function loadSettledArchiveTargets(scopes: readonly OlderSettledScope[]) {
  const releases: (() => void)[] = [];
  const release = () => {
    for (const dispose of releases.splice(0)) dispose();
  };
  try {
    const participants = scopes
      .filter((scope) => readEnvironmentScope(scope.environmentId, AuthOrchestrationOperateScope))
      .map((scope) => {
        // The upstream page chain stops at the first short page, regardless of the requested count.
        const pages = Number.MAX_SAFE_INTEGER;
        const atom = olderSettledThreads.pagesAtom(scope, pages);
        releases.push(appAtomRegistry.mount(atom));
        releases.push(
          threadFamilies.mountRows(
            appAtomRegistry,
            scope.environmentId,
            olderSettledThreads.rowsKey(scope, pages),
            olderSettledThreads.pageRowsAtom(scope, pages),
          ),
        );
        olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
        return { scope, atom };
      });

    const controller = new AbortController();
    try {
      await Promise.all(
        participants.map(({ atom }) => waitForArchivePages(atom, controller.signal)),
      );
    } finally {
      controller.abort();
    }
    // A reconnect can invalidate an earlier scope while another scope's pages load.
    for (const { scope, atom } of participants) {
      const result = appAtomRegistry.get(atom);
      const older = appAtomRegistry.get(olderSettledThreads.olderSettledAtom(scope.environmentId));
      if (result.status !== "ready" || (older !== null && result.reads.length === 0)) {
        throw new Error(INCOMPLETE_LOAD_MESSAGE);
      }
    }
    const now = new Date().toISOString();
    const participantScopes = participants.map(({ scope }) => scope);
    const threads = filterArchivableSidebarThreads(
      readThreadShells().filter(
        (thread) =>
          thread.source.lineage.relationshipToParent !== "subagent" &&
          thread.settledOverride === "settled" &&
          !effectiveSnoozed(thread, { now }) &&
          isSidebarThreadInScope(thread, participantScopes),
      ),
      (thread) => readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    );
    return { threads, release };
  } catch (error) {
    release();
    throw error;
  }
}

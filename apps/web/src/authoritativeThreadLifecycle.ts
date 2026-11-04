import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

interface ReconcileAuthoritativeThreadRefsInput {
  readonly previousActiveThreadRefs: readonly ScopedThreadRef[];
  readonly activeThreadRefs: readonly ScopedThreadRef[];
  readonly catalogEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly partialEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly removedThreadKeys?: ReadonlySet<string>;
}

interface ReconcileAuthoritativeThreadRefsResult {
  readonly removedThreadRefs: readonly ScopedThreadRef[];
  readonly nextActiveThreadRefs: readonly ScopedThreadRef[];
}

/**
 * Partial shells need explicit removals; absence can mean an omitted active
 * thread. Synchronizing shells retain their baseline, and catalog removal
 * becomes authoritative after hydration.
 */
export function reconcileAuthoritativeThreadRefs(
  input: ReconcileAuthoritativeThreadRefsInput,
): ReconcileAuthoritativeThreadRefsResult {
  const activeThreadKeys = new Set(input.activeThreadRefs.map(scopedThreadKey));
  const baselineEnvironmentIds = new Set(
    input.previousActiveThreadRefs.map((threadRef) => threadRef.environmentId),
  );
  const removedThreadRefs = input.previousActiveThreadRefs.filter(
    (threadRef) =>
      (input.catalogEnvironmentIds !== null &&
        !input.catalogEnvironmentIds.has(threadRef.environmentId)) ||
      (input.liveEnvironmentIds.has(threadRef.environmentId) &&
        (!input.partialEnvironmentIds?.has(threadRef.environmentId) ||
          input.removedThreadKeys?.has(scopedThreadKey(threadRef))) &&
        !activeThreadKeys.has(scopedThreadKey(threadRef))),
  );
  const nextActiveThreadRefs = [
    ...input.previousActiveThreadRefs.filter(
      (threadRef) =>
        (input.catalogEnvironmentIds === null ||
          input.catalogEnvironmentIds.has(threadRef.environmentId)) &&
        (!input.liveEnvironmentIds.has(threadRef.environmentId) ||
          (input.partialEnvironmentIds?.has(threadRef.environmentId) &&
            !input.removedThreadKeys?.has(scopedThreadKey(threadRef)) &&
            !activeThreadKeys.has(scopedThreadKey(threadRef)))),
    ),
    ...input.activeThreadRefs.filter(
      (threadRef) =>
        (input.catalogEnvironmentIds === null ||
          input.catalogEnvironmentIds.has(threadRef.environmentId)) &&
        (input.liveEnvironmentIds.has(threadRef.environmentId) ||
          !baselineEnvironmentIds.has(threadRef.environmentId)),
    ),
  ];
  return { removedThreadRefs, nextActiveThreadRefs };
}

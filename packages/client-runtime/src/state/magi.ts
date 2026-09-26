import { MAGI_WS_METHODS, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { scopedThreadKey } from "../environment/index.ts";
import type { EnvironmentThreadShell } from "./shell.ts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Environment-scoped Magi state. Roster form drafts deliberately live in each
 * client: these atoms represent only server-owned arms, runs, and settings.
 */
export function createMagiEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  return {
    options: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:options",
      tag: MAGI_WS_METHODS.getOptions,
      staleTimeMs: 30_000,
    }),
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:settings",
      tag: MAGI_WS_METHODS.getSettings,
      staleTimeMs: 30_000,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:history",
      tag: MAGI_WS_METHODS.listRuns,
      staleTimeMs: 5_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:detail",
      tag: MAGI_WS_METHODS.getRunDetail,
      staleTimeMs: 5_000,
    }),
    arm: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:arm",
      tag: MAGI_WS_METHODS.getArm,
      staleTimeMs: 5_000,
    }),
    diagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:diagnostics",
      tag: MAGI_WS_METHODS.exportDiagnostics,
      staleTimeMs: 10_000,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:update-settings",
      tag: MAGI_WS_METHODS.updateSettings,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    resetSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:reset-settings",
      tag: MAGI_WS_METHODS.resetSettings,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    armThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:arm-thread",
      tag: MAGI_WS_METHODS.armThread,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    disarmThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:disarm-thread",
      tag: MAGI_WS_METHODS.disarmThread,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

// Native lineage is supplied by the separately integrated subagent-threading branch.
const isNativeParent = Schema.is(
  Schema.Struct({ kind: Schema.Literal("subagent"), parentThreadId: ThreadId }),
);

/** Mark owners and native ancestors without assigning a child's run to its parent. */
export function activeMagiThreadKeys(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "id" | "environmentId" | "activeMagiRun"> & {
      readonly parentRelation?: unknown;
    }
  >,
): ReadonlySet<string> {
  const parents = new Map<string, string>();
  const active = new Set<string>();
  for (const thread of threads) {
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    if (thread.activeMagiRun) active.add(key);
    const parent = thread.parentRelation;
    if (isNativeParent(parent)) {
      parents.set(
        key,
        scopedThreadKey({
          environmentId: thread.environmentId,
          threadId: parent.parentThreadId,
        }),
      );
    }
  }
  // Set iteration visits newly added ancestors and terminates even for malformed cycles.
  for (const key of active) {
    const parent = parents.get(key);
    if (parent !== undefined) active.add(parent);
  }
  return active;
}

export function createActiveMagiThreadAtom(
  threads: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
) {
  const active = Atom.make((get) => activeMagiThreadKeys(get(threads)));
  const family = Atom.family((key: string) => Atom.make((get) => get(active).has(key)));
  return (ref: ScopedThreadRef) => family(scopedThreadKey(ref));
}

import { MAGI_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** Page size of the live run list shared by a conversation's timeline and Magi panel. */
export const MAGI_THREAD_RUNS_LIMIT = 50;

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
    /** Live run list for one conversation; the server pushes a full result after every change. */
    threadRuns: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:magi:thread-runs",
      tag: MAGI_WS_METHODS.subscribeThreadRuns,
    }),
    /** Live detail for one run while it is shown. Full snapshots are large, so drop it promptly. */
    runDetail: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:magi:run-detail",
      tag: MAGI_WS_METHODS.subscribeRunDetail,
      idleTtlMs: 0,
    }),
    /** One older page of a conversation's run history, addressed by the live list's cursor. */
    runsPage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:runs-page",
      tag: MAGI_WS_METHODS.listRuns,
      staleTimeMs: 30_000,
    }),
    arm: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:arm",
      tag: MAGI_WS_METHODS.getArm,
      staleTimeMs: 5_000,
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

import { MAGI_WS_METHODS } from "@t3tools/contracts";
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
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:cancel-run",
      tag: MAGI_WS_METHODS.cancelRun,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    continueRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:continue-run",
      tag: MAGI_WS_METHODS.continueRun,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    reconcileActions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:magi:reconcile-actions",
      tag: MAGI_WS_METHODS.reconcileActions,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

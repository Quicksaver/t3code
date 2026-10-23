import { MAGI_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** Remove obsolete Magi selections from parsed draft documents, including signed-out drafts. */
export function removeLegacyMagiDraftConfiguration(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "magiArm") {
      Reflect.deleteProperty(value, key);
      changed = true;
    } else if (removeLegacyMagiDraftConfiguration(child)) {
      changed = true;
    }
  }
  return changed;
}

/** Environment-scoped arbitrator settings. */
export function createMagiEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  return {
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:magi:settings",
      tag: MAGI_WS_METHODS.getSettings,
      staleTimeMs: 30_000,
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
  };
}

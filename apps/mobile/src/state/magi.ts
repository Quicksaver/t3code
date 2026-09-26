import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createActiveMagiThreadAtom,
  createMagiEnvironmentAtoms,
} from "@t3tools/client-runtime/state/magi";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

export const magiEnvironment = createMagiEnvironmentAtoms(connectionAtomRuntime);

const activeMagiThread = createActiveMagiThreadAtom(environmentThreadShells.threadShellsAtom);

export function useHasActiveMagi(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return useAtomValue(
    activeMagiThread({ environmentId: thread.environmentId, threadId: thread.id }),
  );
}

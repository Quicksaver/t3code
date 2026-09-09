import { createMagiEnvironmentAtoms } from "@t3tools/client-runtime/state/magi";

import { connectionAtomRuntime } from "../connection/runtime";

export const magiEnvironment = createMagiEnvironmentAtoms(connectionAtomRuntime);

import { createThreadActivityEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-activities";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadActivityEnvironment =
  createThreadActivityEnvironmentAtoms(connectionAtomRuntime);

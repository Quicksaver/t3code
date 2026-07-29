import type {
  ServerProviderSkillsListError,
  ServerProviderSkillsListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeProviderSkillsLister, type ProviderSkillsListInput } from "./ProviderSkillsLister.ts";

export interface ProviderSkillsRpcHandler {
  readonly list: (
    input: ProviderSkillsListInput,
  ) => Effect.Effect<ServerProviderSkillsListResult, ServerProviderSkillsListError>;
}

/**
 * Connection-agnostic WebSocket seam for provider-skill requests.
 *
 * The route constructs one handler so the lister's bounded cache and
 * concurrency limit are shared across connections.
 */
export const makeProviderSkillsRpcHandler = Effect.fn("makeProviderSkillsRpcHandler")(function* () {
  const listProviderSkills = yield* makeProviderSkillsLister();
  return {
    list: listProviderSkills,
  } satisfies ProviderSkillsRpcHandler;
});

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

export const makeProviderSkillsRpcHandler = Effect.fn("makeProviderSkillsRpcHandler")(function* () {
  const listProviderSkills = yield* makeProviderSkillsLister();
  return {
    list: Effect.fn("ProviderSkillsRpcHandler.list")(function* (input: ProviderSkillsListInput) {
      return yield* listProviderSkills(input);
    }),
  } satisfies ProviderSkillsRpcHandler;
});

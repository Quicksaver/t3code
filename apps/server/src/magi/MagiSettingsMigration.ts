import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import { DEFAULT_MAGI_ARBITRATOR_PROMPT } from "@t3tools/contracts";

// Previous bundled prompts are obsolete; custom instructions must survive cleanup.
const legacyPromptDigests = new Set([
  "a7ba26bed86a3a971eabaeb27e3a090bd42abe409c76f4863a3ceb0ac866eea9",
  "63089d69bcc4ede4c39feee0e554e0a3e2139a1bfd20c1fbd67f10403785f167",
  "66b84e6756a60c9bffe3379f00f6ae70e9ed02b9bfc27db1519b92ea4afbe6d1",
]);

export const migrateMagiArbitratorPrompt = Effect.fn("magi.migrateArbitratorPrompt")(function* (
  prompt: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(prompt))
    .pipe(Effect.orDie);
  return legacyPromptDigests.has(Hex.encode(digest)) ? DEFAULT_MAGI_ARBITRATOR_PROMPT : prompt;
});

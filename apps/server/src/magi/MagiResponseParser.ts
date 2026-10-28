import { MagiParticipantResponse, type MagiParseMode } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Every ballot, approval included, must be justified; a bare "I agree" gets a repair turn. The
// check lives here rather than on the stored schema so earlier persisted responses still decode.
const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    MagiParticipantResponse.check(
      Schema.makeFilter((response) =>
        response.rationale.length > 0 ? undefined : "rationale must not be empty",
      ),
    ),
  ),
);

function balancedJsonObjectStrings(rawText: string): ReadonlyArray<string> {
  const ranges: Array<readonly [start: number, end: number]> = [];
  const starts: Array<number> = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rawText.length; index += 1) {
    const character = rawText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      starts.push(index);
      continue;
    }
    if (character !== "}" || starts.length === 0) continue;
    const start = starts.pop();
    if (start !== undefined) ranges.push([start, index + 1]);
  }

  // The final answer wins: the object that ends last first, outermost before its nested objects.
  return ranges
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftEnd === rightEnd ? leftStart - rightStart : rightEnd - leftEnd,
    )
    .map(([start, end]) => rawText.slice(start, end));
}

/**
 * Candidate response objects in decoding order. Participants finish with one fenced object, so
 * only the last fence is considered when any fence exists; earlier fences may quote a peer, an
 * example, or a draft the participant replaced. Without a fence, the last object wins.
 */
function candidateJsonStrings(rawText: string): ReadonlyArray<string> {
  const trimmed = rawText.trim();
  const lastFence = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1]?.trim();
  const finalSection = lastFence ?? trimmed;
  const candidates = [trimmed, finalSection, ...balancedJsonObjectStrings(finalSection)];
  return [...new Set(candidates.filter(Boolean))];
}

export function parseMagiParticipantResponse(rawText: string): {
  readonly parsed: MagiParticipantResponse | null;
  readonly parseMode: MagiParseMode;
} {
  const candidates = candidateJsonStrings(rawText);
  for (let index = 0; index < candidates.length; index += 1) {
    const decoded = decodeJson(candidates[index] ?? "");
    if (Option.isSome(decoded)) {
      return { parsed: decoded.value, parseMode: index === 0 ? "structured" : "repaired" };
    }
  }
  return { parsed: null, parseMode: "raw" };
}

import { MagiParticipantResponse, type MagiParseMode } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(MagiParticipantResponse));

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

  return ranges
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftStart === rightStart ? rightEnd - leftEnd : leftStart - rightStart,
    )
    .map(([start, end]) => rawText.slice(start, end));
}

function candidateJsonStrings(rawText: string): ReadonlyArray<string> {
  const trimmed = rawText.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  candidates.push(...balancedJsonObjectStrings(trimmed));
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

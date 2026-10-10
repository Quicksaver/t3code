import {
  MAGI_MAX_CONTEXT_ACTIVITY_BYTES,
  magiContextArtifactId,
  MagiValidationError,
  type ContextArtifactId,
  type ContextReadResult,
  type MagiActivityReference,
  type MagiContextActivityOption,
  type MagiRunId,
  type OrchestrationV2TurnItem,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { MagiContextArtifactRecord } from "../persistence/ProjectionMagi.ts";

const validation = (
  reason: ConstructorParameters<typeof MagiValidationError>[0]["reason"],
  message: string,
  field = "contextActivityIds",
) =>
  new MagiValidationError({
    reason,
    message,
    field,
  });

/** Turn items that carry a tool result Magi can hand to participants. */
export const MAGI_EVIDENCE_TURN_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/** Statuses that mean the tool result is final. */
export const MAGI_EVIDENCE_TURN_ITEM_STATUSES = [
  "completed",
  "failed",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["status"]>;

type EvidenceItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: (typeof MAGI_EVIDENCE_TURN_ITEM_TYPES)[number] }
>;

const isEvidenceItem = (item: OrchestrationV2TurnItem): item is EvidenceItem =>
  (MAGI_EVIDENCE_TURN_ITEM_TYPES as ReadonlyArray<string>).includes(item.type);

const isFinal = (item: OrchestrationV2TurnItem) =>
  (MAGI_EVIDENCE_TURN_ITEM_STATUSES as ReadonlyArray<string>).includes(item.status);

export const magiContextResultByteLength = (result: unknown): number =>
  new TextEncoder().encode(JSON.stringify(result) ?? "null").byteLength;

const itemKind = (item: EvidenceItem): string =>
  item.type === "dynamic_tool" && item.toolName !== null
    ? `${item.type}:${item.toolName}`.slice(0, 200)
    : item.type;

const itemSummary = (item: EvidenceItem): string => {
  const detail =
    item.type === "command_execution"
      ? item.input
      : item.type === "file_change"
        ? item.fileName
        : item.type === "file_search"
          ? item.pattern
          : item.type === "web_search"
            ? item.patterns?.join(", ")
            : undefined;
  const parts = [item.title, detail].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const summary = parts.length > 0 ? parts.join(": ") : itemKind(item);
  return summary.replace(/\s+/g, " ").trim().slice(0, 2_000);
};

/** Completed tool results of one run, in the order the provider produced them. */
export const listMagiContextActivities = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<MagiContextActivityOption> =>
  items
    .filter(isEvidenceItem)
    .filter(isFinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .flatMap((item) =>
      item.runId === null
        ? []
        : [
            {
              activityId: item.id,
              runId: item.runId,
              kind: itemKind(item),
              summary: itemSummary(item),
              byteLength: magiContextResultByteLength(item),
            },
          ],
    );

/**
 * Validates selected ids against the caller's current run and snapshots each complete item.
 * The snapshot is the artifact participants read; later item updates cannot change it.
 */
export const resolveMagiContextActivities = (input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly currentRunId: RunId;
  readonly activityIds: ReadonlyArray<TurnItemId>;
  readonly runId: MagiRunId;
  readonly magiTurn: number;
}): Effect.Effect<
  {
    readonly references: ReadonlyArray<MagiActivityReference>;
    readonly artifacts: ReadonlyArray<MagiContextArtifactRecord>;
  },
  MagiValidationError
> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const references: Array<MagiActivityReference> = [];
    const artifacts: Array<MagiContextArtifactRecord> = [];
    for (const activityId of input.activityIds) {
      if (seen.has(activityId)) {
        return yield* validation(
          "duplicate-activity",
          `Activity ${activityId} was referenced twice.`,
        );
      }
      seen.add(activityId);
      const item = input.items.find((candidate) => candidate.id === activityId);
      if (!item) {
        return yield* validation(
          "unknown-activity",
          `Activity ${activityId} does not exist in this conversation.`,
        );
      }
      if (item.runId !== input.currentRunId) {
        return yield* validation(
          "foreign-activity",
          `Activity ${activityId} is not from this conversation's current run.`,
        );
      }
      if (!isEvidenceItem(item)) {
        return yield* validation(
          "invalid-protocol-state",
          `Activity ${activityId} is not a tool result.`,
        );
      }
      if (!isFinal(item)) {
        return yield* validation(
          "unfinished-activity",
          `Activity ${activityId} has not finished yet.`,
        );
      }
      const byteLength = magiContextResultByteLength(item);
      if (byteLength > MAGI_MAX_CONTEXT_ACTIVITY_BYTES) {
        return yield* validation(
          "oversized-activity",
          `Activity ${activityId} is ${byteLength} bytes; the maximum is ${MAGI_MAX_CONTEXT_ACTIVITY_BYTES} bytes. Create semantically focused smaller tool results and submit their activity ids instead.`,
        );
      }
      const reference: MagiActivityReference = {
        artifactId: magiContextArtifactId(input.runId, input.magiTurn, activityId),
        activityId,
        runId: input.currentRunId,
        kind: itemKind(item),
        summary: itemSummary(item),
        byteLength,
      };
      references.push(reference);
      artifacts.push({
        manifest: {
          artifactId: reference.artifactId,
          sourceActivityId: reference.activityId,
          sourceRunId: reference.runId,
          kind: reference.kind,
          summary: reference.summary,
          byteLength,
        },
        result: item,
      });
    }
    return { references, artifacts };
  });

/** Orders the caller's granted artifacts as requested; ids it was not granted are unknown. */
export const orderMagiContextArtifacts = (input: {
  readonly granted: ReadonlyArray<MagiContextArtifactRecord>;
  readonly artifactIds: ReadonlyArray<ContextArtifactId>;
}): Effect.Effect<ContextReadResult, MagiValidationError> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const artifacts: Array<ContextReadResult["artifacts"][number]> = [];
    for (const artifactId of input.artifactIds) {
      if (seen.has(artifactId)) {
        return yield* validation(
          "duplicate-activity",
          "Each context artifact id may be requested only once per read.",
          "artifactIds",
        );
      }
      seen.add(artifactId);
      const granted = input.granted.find((record) => record.manifest.artifactId === artifactId);
      if (!granted) {
        return yield* validation(
          "unknown-activity",
          `Context artifact ${artifactId} is not addressed to this conversation.`,
          "artifactIds",
        );
      }
      artifacts.push({ artifact: granted.manifest, result: granted.result });
    }
    return { artifacts };
  });

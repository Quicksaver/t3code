import {
  MAGI_MAX_CONTEXT_ACTIVITY_BYTES,
  magiContextArtifactId,
  MagiValidationError,
  type ContextArtifactId,
  type ContextReadResult,
  type EventId,
  type MagiActivityReference,
  type MagiContextActivityOption,
  type MagiRunId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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

export const magiContextResultByteLength = (result: unknown): number =>
  new TextEncoder().encode(JSON.stringify(result) ?? "null").byteLength;

/**
 * V1 adapter from projected thread activities to the provider-neutral Magi
 * artifact manifest. Orchestrator V2 replaces this adapter's source, not the
 * artifact ids or participant-facing read contract.
 */
export const listMagiContextActivities = (
  thread: OrchestrationThread,
): ReadonlyArray<MagiContextActivityOption> => {
  if (thread.latestTurn === null) return [];
  const currentTurnId = thread.latestTurn.turnId;
  return thread.activities
    .filter((activity) => activity.turnId === currentTurnId && activity.kind === "tool.completed")
    .map((activity) => ({
      activityId: activity.id,
      turnId: currentTurnId,
      kind: activity.kind,
      summary: activity.summary,
      byteLength: magiContextResultByteLength(activity.payload),
    }));
};

export const resolveMagiContextActivities = (input: {
  readonly thread: OrchestrationThread;
  readonly activityIds: ReadonlyArray<EventId>;
  readonly runId: MagiRunId;
  readonly magiTurn: number;
}): Effect.Effect<ReadonlyArray<MagiActivityReference>, MagiValidationError> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const references: Array<MagiActivityReference> = [];
    for (const activityId of input.activityIds) {
      if (seen.has(activityId)) {
        return yield* validation(
          "duplicate-activity",
          `Activity ${activityId} was referenced twice.`,
        );
      }
      seen.add(activityId);
      const activity = input.thread.activities.find((candidate) => candidate.id === activityId);
      if (!activity) {
        return yield* validation(
          "unknown-activity",
          `Activity ${activityId} does not exist on this thread.`,
        );
      }
      if (input.thread.latestTurn === null || activity.turnId !== input.thread.latestTurn.turnId) {
        return yield* validation(
          "foreign-activity",
          `Activity ${activityId} is not from the current root turn.`,
        );
      }
      if (activity.kind !== "tool.completed") {
        return yield* validation(
          "invalid-protocol-state",
          `Activity ${activityId} is not a completed tool result.`,
        );
      }
      const byteLength = magiContextResultByteLength(activity.payload);
      if (byteLength > MAGI_MAX_CONTEXT_ACTIVITY_BYTES) {
        return yield* validation(
          "oversized-activity",
          `Activity ${activityId} is ${byteLength} bytes; the maximum is ${MAGI_MAX_CONTEXT_ACTIVITY_BYTES} bytes. Create semantically focused smaller tool results and submit their activity ids instead.`,
        );
      }
      references.push({
        artifactId: magiContextArtifactId(input.runId, input.magiTurn, activityId),
        activityId,
        turnId: activity.turnId,
        kind: activity.kind,
        summary: activity.summary,
        byteLength,
        result: activity.payload,
      });
    }
    return references;
  });

export const readMagiContextArtifacts = (input: {
  readonly availableActivities: ReadonlyArray<MagiActivityReference>;
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
      const activity = input.availableActivities.find(
        (candidate) => candidate.artifactId === artifactId,
      );
      if (!activity || activity.artifactId === undefined || activity.byteLength === undefined) {
        return yield* validation(
          "unknown-activity",
          `Context artifact ${artifactId} does not exist for this participant's Magi run.`,
          "artifactIds",
        );
      }
      artifacts.push({
        artifact: {
          artifactId: activity.artifactId,
          sourceActivityId: activity.activityId,
          sourceTurnId: activity.turnId,
          kind: activity.kind,
          summary: activity.summary,
          byteLength: activity.byteLength,
        },
        result: activity.result,
      });
    }
    return { artifacts };
  });

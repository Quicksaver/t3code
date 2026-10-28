import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";

export interface MagiTokenTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Totals the tokens a participant spent across the conversation runs Magi dispatched for one
 * Magi turn, including retries, repairs, and compaction. Each provider turn of a run's root node
 * counts once: its completed-turn usage when the provider reports one, otherwise the live usage
 * it last reported. A total stays null when no provider turn reported that figure.
 */
export const sumMagiRunTokenUsage = (input: {
  readonly runIds: ReadonlyArray<RunId>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "rootNodeId">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "nodeId" | "tokenUsage" | "turnTokenUsage">
  >;
}): MagiTokenTotals => {
  const runIds = new Set<string>(input.runIds);
  const rootNodeIds = new Set<string>();
  for (const run of input.runs) {
    if (runIds.has(run.id) && run.rootNodeId !== null) rootNodeIds.add(run.rootNodeId);
  }
  for (const attempt of input.attempts) {
    if (runIds.has(attempt.runId)) rootNodeIds.add(attempt.rootNodeId);
  }
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const turn of input.providerTurns) {
    if (!rootNodeIds.has(turn.nodeId)) continue;
    const turnInput = turn.turnTokenUsage?.inputTokens ?? turn.tokenUsage?.inputTokens;
    const turnOutput = turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens;
    if (turnInput !== undefined) inputTokens = (inputTokens ?? 0) + turnInput;
    if (turnOutput !== undefined) outputTokens = (outputTokens ?? 0) + turnOutput;
  }
  return { inputTokens, outputTokens };
};

import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sumMagiRunTokenUsage } from "./MagiTokenUsage.ts";

const turnRun = RunId.make("run-turn");
const repairRun = RunId.make("run-repair");
const otherRun = RunId.make("run-other");
const node = (id: string) => NodeId.make(id);
const usage = (inputTokens: number, outputTokens: number) => ({
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  hasSubagents: false,
  inputTokens,
  outputTokens,
});

describe("sumMagiRunTokenUsage", () => {
  it("totals every provider turn of the dispatched runs and nothing else", () => {
    expect(
      sumMagiRunTokenUsage({
        runIds: [turnRun, repairRun],
        runs: [
          { id: turnRun, rootNodeId: node("node-turn") },
          { id: repairRun, rootNodeId: node("node-repair") },
          { id: otherRun, rootNodeId: node("node-other") },
        ],
        // A retried attempt runs under its own root node.
        attempts: [{ runId: turnRun, rootNodeId: node("node-turn-retry") }],
        providerTurns: [
          { nodeId: node("node-turn"), turnTokenUsage: usage(1_000, 200) },
          { nodeId: node("node-turn-retry"), turnTokenUsage: usage(1_100, 250) },
          { nodeId: node("node-repair"), turnTokenUsage: usage(1_500, 80) },
          { nodeId: node("node-other"), turnTokenUsage: usage(9_999, 9_999) },
        ],
      }),
    ).toEqual({ inputTokens: 3_600, outputTokens: 530 });
  });

  it("falls back to live usage when a provider reports no completed-turn usage", () => {
    expect(
      sumMagiRunTokenUsage({
        runIds: [turnRun],
        runs: [{ id: turnRun, rootNodeId: node("node-turn") }],
        attempts: [],
        providerTurns: [
          {
            nodeId: node("node-turn"),
            tokenUsage: {
              usedTokens: 1_400,
              inputTokens: 1_200,
              outputTokens: 150,
              updatedAt: "2026-10-04T00:00:00.000Z",
            },
          },
        ],
      }),
    ).toEqual({ inputTokens: 1_200, outputTokens: 150 });
  });

  it("reports unknown totals rather than zero when no usage was reported", () => {
    expect(
      sumMagiRunTokenUsage({
        runIds: [turnRun],
        runs: [{ id: turnRun, rootNodeId: node("node-turn") }],
        attempts: [],
        providerTurns: [{ nodeId: node("node-turn") }],
      }),
    ).toEqual({ inputTokens: null, outputTokens: null });
  });
});

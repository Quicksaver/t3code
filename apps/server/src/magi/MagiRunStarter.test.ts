import { describe, expect, it } from "@effect/vitest";
import {
  calculateMagiDirectTransition,
  MagiArmId,
  MagiParticipantId,
  ProviderInstanceId,
  ThreadId,
  type MagiGetOptionsResult,
  type MagiRunConfig,
} from "@t3tools/contracts";

import {
  listUnavailableMagiParticipants,
  normalizeMagiStartConfig,
  resolveMagiStartSnapshot,
} from "./MagiRunStarter.ts";

const config: MagiRunConfig = {
  participants: ["one", "two"].map((id) => ({
    participantId: MagiParticipantId.make(id),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
    personalityId: null,
    weight: 1,
  })),
  consensusThresholdPercent: 100,
  magiTurnLimit: 1,
};

describe("resolveMagiStartSnapshot", () => {
  it("normalizes zero turn limits to the canonical unlimited value", () => {
    const normalized = normalizeMagiStartConfig({ ...config, magiTurnLimit: 0 });
    expect(normalized.magiTurnLimit).toBeNull();
    expect(
      calculateMagiDirectTransition({
        consensusReached: false,
        pendingEvaluations: true,
        completedMagiTurns: 1,
        magiTurnLimit: normalized.magiTurnLimit,
      }),
    ).toBe("continue");
    expect(
      resolveMagiStartSnapshot({
        arm: null,
        requestedConfig: { ...config, magiTurnLimit: 0 },
        toolCallId: "tool-1",
      }).config.magiTurnLimit,
    ).toBeNull();
    expect(
      resolveMagiStartSnapshot({
        arm: {
          armId: MagiArmId.make("arm-1"),
          threadId: ThreadId.make("root"),
          revision: 1,
          config: { ...config, magiTurnLimit: 0 },
          armedAt: "2026-08-21T00:00:00.000Z",
        },
        requestedConfig: config,
        toolCallId: "tool-1",
      }).config.magiTurnLimit,
    ).toBeNull();
  });

  it("reports unavailable roster entries without constructing a smaller electorate", () => {
    const providerInstances: MagiGetOptionsResult["providerInstances"] = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        displayName: "Codex",
        models: ["gpt"],
        modelOptions: [],
        magi: {
          instructions: "prompt-envelope",
          structuredOutput: "native",
          readOnly: "prompt-only",
          controlTools: "mcp-tools",
          webSearch: "native",
          historyCompaction: "explicit-native",
        },
        available: true,
        unavailableReason: null,
      },
    ];
    const requested = [
      ...config.participants,
      {
        ...config.participants[0]!,
        participantId: MagiParticipantId.make("missing-model"),
        modelSelection: {
          ...config.participants[0]!.modelSelection,
          model: "missing",
        },
      },
    ];

    expect(listUnavailableMagiParticipants(requested, providerInstances)).toEqual([
      {
        participantId: MagiParticipantId.make("missing-model"),
        model: "missing",
        reason: "Provider or model 'missing' is unavailable.",
      },
    ]);
    expect(requested).toHaveLength(3);
  });

  it("gives a client arm authority over a tool-supplied replacement config", () => {
    const resolved = resolveMagiStartSnapshot({
      arm: {
        armId: MagiArmId.make("arm-1"),
        threadId: ThreadId.make("root"),
        revision: 1,
        config,
        armedAt: "2026-08-21T00:00:00.000Z",
      },
      requestedConfig: { ...config, consensusThresholdPercent: 75 },
      toolCallId: "tool-1",
    });
    expect(resolved.source).toBe("user-arm");
    expect(resolved.config.consensusThresholdPercent).toBe(100);
    expect(resolved.initiatingReferenceId).toBe("arm-1");
  });
});

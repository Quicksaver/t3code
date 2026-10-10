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
  participantDispatchModelSelection,
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

describe("participantDispatchModelSelection", () => {
  const cursor = ProviderInstanceId.make("cursor");
  const providerInstances: MagiGetOptionsResult["providerInstances"] = [
    {
      instanceId: cursor,
      displayName: "Cursor",
      models: ["grok-4.7"],
      modelOptions: [
        {
          model: "grok-4.7",
          optionDescriptors: [
            {
              id: "contextWindow",
              label: "Context",
              type: "select",
              options: [
                { id: "256k", label: "256K" },
                { id: "500k", label: "500K", isDefault: true },
              ],
            },
            {
              id: "reasoning_effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
            { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
          ],
        },
      ],
      available: true,
      unavailableReason: null,
    },
  ];

  it("omits select choices at the model default and keeps every other choice", () => {
    expect(
      participantDispatchModelSelection(
        {
          instanceId: cursor,
          model: "grok-4.7",
          options: [
            { id: "reasoning_effort", value: "medium" },
            { id: "contextWindow", value: "500k" },
            { id: "fastMode", value: false },
          ],
        },
        providerInstances,
      ),
    ).toEqual({
      instanceId: cursor,
      model: "grok-4.7",
      options: [
        { id: "reasoning_effort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("keeps a non-default choice and drops the options list when only defaults remain", () => {
    expect(
      participantDispatchModelSelection(
        {
          instanceId: cursor,
          model: "grok-4.7",
          options: [{ id: "contextWindow", value: "256k" }],
        },
        providerInstances,
      ).options,
    ).toEqual([{ id: "contextWindow", value: "256k" }]);
    expect(
      participantDispatchModelSelection(
        {
          instanceId: cursor,
          model: "grok-4.7",
          options: [
            { id: "contextWindow", value: "500k" },
            { id: "reasoning_effort", value: "high" },
          ],
        },
        providerInstances,
      ),
    ).toEqual({ instanceId: cursor, model: "grok-4.7" });
  });

  it("rejects options for a model that advertises none but leaves undescribed models unchecked", () => {
    const participant = (
      model: string,
      options?: ReadonlyArray<{ id: string; value: string }>,
    ) => ({
      ...config.participants[0]!,
      modelSelection: { instanceId: cursor, model, ...(options === undefined ? {} : { options }) },
    });
    const instances: MagiGetOptionsResult["providerInstances"] = [
      {
        ...providerInstances[0]!,
        models: ["grok-4.7", "plain", "undescribed"],
        modelOptions: [{ model: "plain", optionDescriptors: [] }],
      },
    ];
    const effort = [{ id: "reasoning_effort", value: "high" }];

    expect(listUnavailableMagiParticipants([participant("plain", effort)], instances)).toEqual([
      expect.objectContaining({
        reason: "Option 'reasoning_effort' = \"high\" is not supported by model 'plain'.",
      }),
    ]);
    expect(
      listUnavailableMagiParticipants(
        [participant("plain"), participant("plain", []), participant("undescribed", effort)],
        instances,
      ),
    ).toEqual([]);
  });

  it("reports selections the model does not advertise before any participant starts", () => {
    const withOptions = (options: ReadonlyArray<{ id: string; value: string | boolean }>) => ({
      ...config.participants[0]!,
      modelSelection: { instanceId: cursor, model: "grok-4.7", options },
    });
    const promptInjected = providerInstances.map((provider) => ({
      ...provider,
      modelOptions: provider.modelOptions?.map((model) => ({
        ...model,
        optionDescriptors: model.optionDescriptors.map((descriptor) =>
          descriptor.type === "select" && descriptor.id === "reasoning_effort"
            ? { ...descriptor, promptInjectedValues: ["ultrathink"] }
            : descriptor,
        ),
      })),
    }));

    expect(
      listUnavailableMagiParticipants(
        [
          withOptions([
            { id: "reasoning_effort", value: "ultrathink" },
            { id: "fastMode", value: true },
          ]),
        ],
        promptInjected,
      ),
    ).toEqual([]);
    for (const options of [
      [{ id: "reasoning_effort", value: true }],
      [{ id: "reasoning_effort", value: "max" }],
      [{ id: "fastMode", value: "yes" }],
      [{ id: "obsoleteOption", value: "on" }],
    ]) {
      expect(listUnavailableMagiParticipants([withOptions(options)], providerInstances)).toEqual([
        expect.objectContaining({ participantId: config.participants[0]!.participantId }),
      ]);
    }
  });
});

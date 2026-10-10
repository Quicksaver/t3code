import { describe, expect, it } from "@effect/vitest";
import {
  MagiActionBatchId,
  MagiActionRecordId,
  MagiParticipantId,
  ProviderInstanceId,
  type MagiParticipantDraft,
  type MagiRunConfig,
} from "@t3tools/contracts";

import {
  createMagiArmConfigAdoption,
  exactDuplicateMagiParticipantIds,
  magiParticipantIndicator,
  magiParticipantStatusLabel,
  magiRunElapsedMs,
  type MagiParticipantStatusInput,
  unrecordedMagiActionBatch,
} from "./magiPresentation.ts";

const status = (input: MagiParticipantStatusInput) => ({
  indicator: magiParticipantIndicator(input),
  label: magiParticipantStatusLabel(input),
});

describe("magiParticipantIndicator", () => {
  it("shows progress, not votes, while the run is deliberating", () => {
    const deliberating = {
      runState: "deliberating",
      finalStance: null,
      finalBallot: null,
    } as const;
    expect(status({ ...deliberating, memberState: "pending" })).toEqual({
      indicator: "neutral",
      label: "Waiting",
    });
    expect(status({ ...deliberating, memberState: "running" })).toEqual({
      indicator: "working",
      label: "Working",
    });
    expect(status({ ...deliberating, memberState: "settled" })).toEqual({
      indicator: "neutral",
      label: "Finished",
    });
    expect(status({ ...deliberating, memberState: "timed-out" })).toEqual({
      indicator: "warning",
      label: "timed out",
    });
  });

  it("shows the counted stance once consensus is reached", () => {
    const succeeded = { runState: "succeeded", memberState: "settled" } as const;
    expect(status({ ...succeeded, finalStance: "supports", finalBallot: "approve" })).toEqual({
      indicator: "supports",
      label: "Voted for consensus",
    });
    expect(status({ ...succeeded, finalStance: "opposes", finalBallot: "reject" })).toEqual({
      indicator: "opposes",
      label: "Voted against consensus",
    });
  });

  it("distinguishes an explicit abstention from an unresolved vote after consensus", () => {
    const succeeded = { runState: "succeeded", finalStance: "unclear" } as const;
    expect(status({ ...succeeded, memberState: "settled", finalBallot: "abstain" })).toEqual({
      indicator: "abstained",
      label: "Abstained",
    });
    expect(status({ ...succeeded, memberState: "settled", finalBallot: "not-applicable" })).toEqual(
      { indicator: "warning", label: "No valid final vote" },
    );
    expect(status({ ...succeeded, memberState: "failed", finalBallot: null })).toEqual({
      indicator: "warning",
      label: "No valid final vote",
    });
  });

  it("hides stances when a run ends without consensus, keeping only failures", () => {
    const limitReached = { runState: "turn-limit-reached", memberState: "settled" } as const;
    expect(
      magiParticipantIndicator({
        ...limitReached,
        finalStance: "supports",
        finalBallot: "approve",
      }),
    ).toBe("neutral");
    expect(
      magiParticipantIndicator({ ...limitReached, finalStance: "unclear", finalBallot: "abstain" }),
    ).toBe("neutral");
    expect(
      magiParticipantIndicator({
        runState: "turn-limit-reached",
        memberState: "failed",
        finalStance: "unclear",
        finalBallot: null,
      }),
    ).toBe("warning");
  });
});

describe("exactDuplicateMagiParticipantIds", () => {
  const participant = (
    id: string,
    overrides: Partial<Omit<MagiParticipantDraft, "participantId">> = {},
  ): MagiParticipantDraft => ({
    participantId: MagiParticipantId.make(id),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    personalityId: null,
    weight: 1,
    ...overrides,
  });

  it("flags rows sharing model, options and personality regardless of weight", () => {
    expect([
      ...exactDuplicateMagiParticipantIds([
        participant("one"),
        participant("two", { weight: 3 }),
        participant("three", {
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      ]),
    ]).toEqual(["one", "two"]);
  });
});

describe("unrecordedMagiActionBatch", () => {
  const issued = (id: string) => ({
    actionId: MagiActionRecordId.make(id),
    summary: `Action ${id}`,
    relatedProposalIds: [],
    obligation: "required" as const,
  });
  const recorded = (id: string) => ({
    ...issued(id),
    status: "completed" as const,
    details: "done",
    unforeseenConsequence: null,
  });
  const batch = {
    batchId: MagiActionBatchId.make("batch-2"),
    magiTurn: 2,
    actions: [issued("turn-2-a"), issued("turn-2-b")],
  };

  it("shows an issued batch only until the main agent records it", () => {
    expect(unrecordedMagiActionBatch({ issuedActionBatch: null, actions: [] })).toBeNull();
    // Awaiting actions, or paused or stopped there: earlier turns' records do not cover it.
    expect(
      unrecordedMagiActionBatch({ issuedActionBatch: batch, actions: [recorded("turn-1")] }),
    ).toBe(batch);
    // Awaiting reconciliation: the server keeps the batch, but its actions are recorded.
    expect(
      unrecordedMagiActionBatch({
        issuedActionBatch: batch,
        actions: [recorded("turn-1"), recorded("turn-2-a"), recorded("turn-2-b")],
      }),
    ).toBeNull();
  });
});

describe("elapsed time", () => {
  it("advances active runs from the current clock", () => {
    expect(
      magiRunElapsedMs(
        { startedAt: "2026-08-26T10:00:00.000Z", completedAt: null },
        Date.parse("2026-08-26T10:00:07.250Z"),
      ),
    ).toBe(7_250);
  });

  it("freezes terminal runs at their completion time", () => {
    expect(
      magiRunElapsedMs(
        {
          startedAt: "2026-08-26T10:00:00.000Z",
          completedAt: "2026-08-26T10:00:03.500Z",
        },
        Date.parse("2026-08-26T11:00:00.000Z"),
      ),
    ).toBe(3_500);
  });
});

describe("server arm configuration adoption", () => {
  const serverConfig: MagiRunConfig = {
    participants: [],
    consensusThresholdPercent: 80,
    magiTurnLimit: 3,
  };

  it("loads delayed server configuration into an untouched form and resets for a new target", () => {
    const adoption = createMagiArmConfigAdoption();
    expect(adoption.adopt(serverConfig)).toEqual(serverConfig);
    adoption.markEdited();
    expect(adoption.adopt(serverConfig)).toBeNull();
    adoption.reset();
    expect(adoption.adopt(serverConfig)).toEqual(serverConfig);
  });

  it("keeps unsent form edits across successive server snapshots", () => {
    const adoption = createMagiArmConfigAdoption();
    adoption.markEdited();
    expect(adoption.hasUnsentEdits).toBe(true);
    expect(adoption.adopt(serverConfig)).toBeNull();
    expect(adoption.adopt({ ...serverConfig, consensusThresholdPercent: 90 })).toBeNull();
  });

  it("accepts remote changes after the matching own write succeeds", () => {
    const adoption = createMagiArmConfigAdoption();
    adoption.markEdited();
    const editVersion = adoption.beginWrite();
    adoption.acknowledge(editVersion);
    expect(adoption.hasUnsentEdits).toBe(false);
    expect(adoption.adopt({ ...serverConfig, consensusThresholdPercent: 90 })).not.toBeNull();
  });

  it("preserves a newer unsent edit when a predecessor write finishes after cancellation", async () => {
    const adoption = createMagiArmConfigAdoption();
    adoption.markEdited();
    const editVersion = adoption.beginWrite();
    let finishWrite = () => {};
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const acknowledgment = write.then(() => adoption.acknowledge(editVersion));
    adoption.cancelPendingWrite();
    adoption.markEdited(); // The form is optimistically disarmed; this edit is not submitted.
    finishWrite();
    await acknowledgment;
    expect(adoption.hasUnsentEdits).toBe(true);
    expect(adoption.adopt(serverConfig)).toBeNull();
  });

  it("adopts the authoritative config after canceled synchronization without newer edits", () => {
    const adoption = createMagiArmConfigAdoption();
    adoption.markEdited();
    adoption.beginWrite();
    adoption.cancelPendingWrite();
    expect(adoption.adopt(serverConfig)).toEqual(serverConfig);
  });

  it("does not discard newer unsent edits when an older synchronization is canceled or acknowledged", () => {
    const adoption = createMagiArmConfigAdoption();
    adoption.markEdited();
    const predecessor = adoption.beginWrite();
    adoption.markEdited();
    adoption.cancelPendingWrite();
    adoption.acknowledge(predecessor);
    expect(adoption.hasUnsentEdits).toBe(true);
    expect(adoption.adopt(serverConfig)).toBeNull();
    adoption.reset();
    adoption.markEdited();
    adoption.acknowledge(predecessor);
    expect(adoption.adopt(serverConfig)).toBeNull();
  });
});

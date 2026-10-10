import {
  MagiParticipantId,
  MagiProposalId,
  type MagiRunTurnDetail,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createMobileMagiArmQueue,
  mobileMagiArmBlockedReason,
  mobileMagiProposalEvaluations,
  mobileMagiRosterInstanceNames,
  mobileMagiThresholdFromInput,
} from "./MagiPanelSheet.logic";

describe("mobile Magi arming", () => {
  it("commits typed thresholds only inside the panel bounds", () => {
    expect(mobileMagiThresholdFromInput("75", 100)).toBe(75);
    expect(mobileMagiThresholdFromInput("150", 100)).toBe(100);
    expect(mobileMagiThresholdFromInput("7", 100)).toBe(51);
    expect(mobileMagiThresholdFromInput("", 80)).toBe(80);
  });

  it("explains why a busy conversation cannot be armed", () => {
    expect(mobileMagiArmBlockedReason({ activeMagiRun: false })).toBeNull();
    expect(mobileMagiArmBlockedReason({ activeMagiRun: false, activeTurn: true })).toBe(
      "Wait for the current turn to finish before arming Magi.",
    );
    expect(
      mobileMagiArmBlockedReason({ activeMagiRun: false, activeTurn: true, pendingApproval: true }),
    ).toBe("Answer the pending approval before arming Magi.");
    expect(mobileMagiArmBlockedReason({ activeMagiRun: false, submitting: true })).toBe(
      "Wait for the first message to finish sending.",
    );
  });

  it("names each provider instance a roster sends data to once", () => {
    const participant = (id: string, instanceId: string) => ({
      participantId: MagiParticipantId.make(id),
      modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "model" },
      personalityId: null,
      weight: 1,
    });
    expect(
      mobileMagiRosterInstanceNames(
        {
          participants: [
            participant("a", "codex"),
            participant("b", "work"),
            participant("c", "codex"),
          ],
          consensusThresholdPercent: 100,
          magiTurnLimit: 1,
        },
        [{ instanceId: "codex", displayName: "Codex" }],
      ),
    ).toEqual(["Codex", "work"]);
  });
});

describe("mobile Magi proposal records", () => {
  it("collects every participant evaluation of a proposal across turns", () => {
    const proposalId = MagiProposalId.make("proposal-1");
    const settlement = (participantId: string, ballot: "approve" | "reject") => ({
      participantId: MagiParticipantId.make(participantId),
      participantThreadId: ThreadId.make(`thread-${participantId}`),
      participantRunId: RunId.make(`run-${participantId}`),
      rawText: "",
      parsed: {
        recommendation: "ship",
        rationale: [],
        assumptions: [],
        risks: [],
        confidence: 80,
        candidateFingerprint: null,
        ballot: "approve" as const,
        proposals: [],
        proposalEvaluations: [
          { proposalId, ballot, rationale: `${participantId} reason` },
          { proposalId: MagiProposalId.make("other"), ballot, rationale: "unrelated" },
        ],
        exclusiveSetEvaluations: [],
      },
      parseMode: "structured" as const,
      state: "settled" as const,
      durationMs: 1,
      inputTokens: null,
      outputTokens: null,
      retryCount: 0,
      providerAttempts: 1,
      structuralRepairCount: 0,
      reconstructed: false,
      failureClass: null,
      contextCompressed: false,
    });
    const turns: ReadonlyArray<MagiRunTurnDetail> = [
      {
        magiTurn: 1,
        candidate: null,
        settlements: [settlement("a", "approve")],
        arbitration: null,
        activities: [],
      },
      {
        magiTurn: 2,
        candidate: null,
        settlements: [settlement("b", "reject")],
        arbitration: null,
        activities: [],
      },
    ];
    expect(
      mobileMagiProposalEvaluations(turns, proposalId).map((evaluation) => [
        evaluation.magiTurn,
        evaluation.participantId,
        evaluation.ballot,
        evaluation.rationale,
      ]),
    ).toEqual([
      [1, "a", "approve", "a reason"],
      [2, "b", "reject", "b reason"],
    ]);
  });
});

describe("mobile Magi arm queue", () => {
  it("reapplies an unchanged null arm after permission loss supersedes a rejected optimistic Arm", async () => {
    let armed = true;
    let generation = 0;
    let rejectArm = () => {};
    const queue = createMobileMagiArmQueue((reconcile) => {
      if (reconcile) armed = false; // The authoritative server arm is still null.
    });
    const intent = generation;
    const arm = queue.enqueue(async () => {
      await new Promise<void>((resolve) => {
        rejectArm = resolve;
      });
      if (intent !== generation) return; // Superseded failure does not request reconciliation.
      queue.requestReconcile();
    });
    await Promise.resolve();
    generation += 1;
    queue.requestReconcile();
    expect(armed).toBe(true);
    rejectArm();
    await arm;
    expect(armed).toBe(false);
  });

  it("reconciles permission loss immediately when canceled edits leave no queued write", () => {
    const drains: Array<boolean> = [];
    const queue = createMobileMagiArmQueue((reconcile) => drains.push(reconcile));
    queue.requestReconcile();
    expect(drains).toEqual([true]);
  });

  it("runs writes in order and reports one drain after the last", async () => {
    const order: Array<string> = [];
    const drains: Array<boolean> = [];
    const queue = createMobileMagiArmQueue((reconcile) => drains.push(reconcile));
    let releaseFirst = () => {};
    const first = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push("first");
            resolve();
          };
        }),
    );
    const second = queue.enqueue(async () => {
      order.push("second");
    });
    expect(queue.pending).toBe(2);
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(queue.pending).toBe(0);
    expect(drains).toEqual([false]);
  });

  it("asks a drain to reapply the server arm after a rejected write", async () => {
    const drains: Array<boolean> = [];
    const queue = createMobileMagiArmQueue((reconcile) => drains.push(reconcile));
    // A rejected first arm requests reconciliation while an edit is still queued behind it.
    const rejected = queue.enqueue(async () => queue.requestReconcile());
    const edit = queue.enqueue(async () => {});
    await Promise.all([rejected, edit]);
    expect(drains).toEqual([true]);
    await queue.enqueue(async () => {});
    expect(drains).toEqual([true, false]);
  });

  it("counts the running write, so a write can tell whether newer ones follow it", async () => {
    const seen: Array<number> = [];
    const queue = createMobileMagiArmQueue(() => {});
    const disarm = queue.enqueue(async () => {
      seen.push(queue.pending);
    });
    await disarm;
    const rejected = queue.enqueue(async () => {
      seen.push(queue.pending);
    });
    const newerArm = queue.enqueue(async () => {});
    await Promise.all([rejected, newerArm]);
    expect(seen).toEqual([1, 2]);
  });

  it("keeps running writes after one throws", async () => {
    const drains: Array<boolean> = [];
    const queue = createMobileMagiArmQueue((reconcile) => drains.push(reconcile));
    const failed = queue.enqueue(async () => {
      throw new Error("lost connection");
    });
    let ran = false;
    const next = queue.enqueue(async () => {
      ran = true;
    });
    await expect(failed).rejects.toThrow("lost connection");
    await next;
    expect(ran).toBe(true);
    expect(drains).toEqual([false]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MagiParticipantId,
  ProviderInstanceId,
  MagiRunId,
  ThreadId,
  type MagiGetOptionsResult,
  type MagiRunConfig,
  type MagiRunSummary,
} from "@t3tools/contracts";

import {
  addDefaultMagiParticipant,
  clampMagiWeight,
  duplicateMagiParticipant,
  formatCompactTokenCount,
  formatMagiAgreementProgress,
  formatMagiRunMetadata,
  initialMagiConfig,
  makeWebMagiParticipantId,
  magiArmBlockedReason,
  magiConfigError,
  magiRosterInstanceNames,
  magiTurnLimitFromSliderIndex,
  magiTurnLimitSliderIndex,
  magiWeightSummary,
  moveMagiParticipant,
  ownActiveMagiRun,
  parseMagiWeightInput,
  preferredMagiRunForAutomaticExpansion,
  reconcileMagiArmAfterWrites,
} from "./MagiPanel.logic";

const options = {
  providerInstances: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      models: ["gpt-5"],
      available: true,
      unavailableReason: null,
    },
  ],
  personalities: [],
  bounds: {
    minimumParticipants: 2,
    maximumParticipants: 9,
    minimumWeight: 1,
    maximumWeight: 100,
    maximumContextActivityIds: 32,
  },
} satisfies MagiGetOptionsResult;

const emptyConfig: MagiRunConfig = {
  participants: [],
  consensusThresholdPercent: 67,
  magiTurnLimit: 3,
};

describe("permission-loss arm reconciliation", () => {
  it("reapplies an equal-revision arm after a generation-canceled Disarm", async () => {
    let finishUpdate = () => {};
    let serverRevision = 1;
    let localRevision = 1;
    let armed = true;
    let permission = true;
    let generation = 0;
    const update = new Promise<void>((resolve) => {
      finishUpdate = () => {
        serverRevision = 2;
        localRevision = 2;
        resolve();
      };
    });
    armed = false; // Optimistic Disarm, queued behind the update.
    const disarmGeneration = generation;
    const disarm = update.then(() => {
      if (permission && generation === disarmGeneration) serverRevision = 0;
    });
    permission = false;
    generation += 1; // Grant loss already canceled the queued Disarm.
    const reconcile = reconcileMagiArmAfterWrites(
      disarm,
      () => true, // No newer user intent or lifecycle change.
      () => {
        localRevision = serverRevision;
        armed = serverRevision !== 0;
      },
    );
    await Promise.resolve();
    expect(armed).toBe(false);
    permission = true;
    finishUpdate();
    await reconcile;
    expect(localRevision).toBe(2);
    expect(armed).toBe(true);
  });

  it("skips reconciliation when its predicate becomes stale before writes settle", async () => {
    let finishWrite = () => {};
    let intent = 1;
    const capturedIntent = intent;
    const reconcile = vi.fn();
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const reconciliation = reconcileMagiArmAfterWrites(
      pending,
      () => capturedIntent === intent,
      reconcile,
    );
    intent += 1;
    finishWrite();
    await reconciliation;
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("new-run sliders", () => {
  it("maps slider stops to turn limits, ending with unlimited", () => {
    expect(magiTurnLimitFromSliderIndex(0)).toBe(1);
    expect(magiTurnLimitFromSliderIndex(14)).toBe(610);
    expect(magiTurnLimitFromSliderIndex(15)).toBeNull();
  });

  it("keeps either one-turn stop selected", () => {
    expect(magiTurnLimitSliderIndex(1)).toBe(0);
    expect(magiTurnLimitSliderIndex(1, 1)).toBe(1);
  });
});

describe("Magi panel roster logic", () => {
  it("mints distinct ids for rapid participant creation", () => {
    const ids = Array.from({ length: 100 }, () => makeWebMagiParticipantId());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds a valid first-use roster when panel settings have no roster", () => {
    const config = initialMagiConfig(options, {
      arbitratorPrompt: "Arbitrate.",
      lastPanelRoster: [],
      lastPanelConsensusThresholdPercent: 67,
      lastPanelMagiTurnLimit: 3,
      showRunDetailsAndDiagnostics: false,
      personalities: [],
    });
    expect(config.participants).toHaveLength(2);
    expect(magiConfigError(config)).toBeNull();
  });

  it("takes remembered panel configuration from settings, not the option catalogue", () => {
    const rememberedParticipants = [
      {
        participantId: MagiParticipantId.make("remembered-1"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        personalityId: null,
        weight: 2,
      },
      {
        participantId: MagiParticipantId.make("remembered-2"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        personalityId: null,
        weight: 1,
      },
    ];

    expect(
      initialMagiConfig(options, {
        arbitratorPrompt: "Arbitrate.",
        lastPanelRoster: rememberedParticipants,
        lastPanelConsensusThresholdPercent: 50,
        lastPanelMagiTurnLimit: null,
        showRunDetailsAndDiagnostics: false,
        personalities: [],
      }),
    ).toEqual({
      participants: rememberedParticipants,
      consensusThresholdPercent: 51,
      magiTurnLimit: null,
    });
  });

  it("caps the roster at nine participants", () => {
    const participants = Array.from({ length: 9 }, (_, index) => ({
      participantId: MagiParticipantId.make(`p-${index}`),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      personalityId: null,
      weight: 1,
    }));
    const config: MagiRunConfig = {
      participants,
      consensusThresholdPercent: 67,
      magiTurnLimit: 3,
    };
    expect(addDefaultMagiParticipant(config, options, "extra")).toBe(config);
  });

  it("duplicates and reorders a participant without sharing its identity", () => {
    const one = addDefaultMagiParticipant(emptyConfig, options, "one");
    const two = duplicateMagiParticipant(one, options, "one", "two");
    expect(two.participants.map((participant) => participant.participantId)).toEqual([
      "one",
      "two",
    ]);
    expect(
      moveMagiParticipant(two, "two", -1).participants.map((item) => item.participantId),
    ).toEqual(["two", "one"]);
  });

  it("explains the weighted threshold", () => {
    const one = addDefaultMagiParticipant(emptyConfig, options, "one");
    const two = duplicateMagiParticipant(one, options, "one", "two");
    expect(magiWeightSummary({ ...two, consensusThresholdPercent: 100 })).toEqual({
      totalWeight: 2,
      requiredWeight: 2,
    });
  });

  it("surfaces shared threshold validation", () => {
    const first = addDefaultMagiParticipant(emptyConfig, options, "one");
    const second = addDefaultMagiParticipant(first, options, "two");
    expect(magiConfigError({ ...second, consensusThresholdPercent: 49 })).toContain("50");
  });

  it("formats token totals with three significant digits", () => {
    expect(formatCompactTokenCount(999)).toBe("999 tokens");
    expect(formatCompactTokenCount(1_289)).toBe("1.29k tokens");
    expect(formatCompactTokenCount(12_345)).toBe("12.3k tokens");
    expect(formatCompactTokenCount(219_561)).toBe("220k tokens");
    expect(formatCompactTokenCount(999_999)).toBe("1M tokens");
    expect(formatCompactTokenCount(1_250_000_000)).toBe("1.25G tokens");
  });

  describe("run metadata", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows running turns, compact tokens, and age without a participant count", () => {
      expect(
        formatMagiRunMetadata(
          {
            runId: MagiRunId.make("running-run"),
            rootThreadId: ThreadId.make("root-thread"),
            source: "user-arm",
            title: { state: "generated", title: "Running run" },
            state: "deliberating",
            objective: null,
            completedMagiTurns: 1,
            participantCount: 3,
            magiTurnLimit: 3,
            tokenCount: 219_561,
            startedAt: "2026-08-22T11:45:00.000Z",
            completedAt: null,
          },
          ThreadId.make("root-thread"),
        ),
      ).toEqual(["1/3 turns", "220k tokens", "15m"]);
    });

    it("omits the denominator for an unlimited running run", () => {
      expect(
        formatMagiRunMetadata(
          {
            runId: MagiRunId.make("unlimited-run"),
            rootThreadId: ThreadId.make("root-thread"),
            source: "agent-tool",
            title: { state: "generated", title: "Unlimited run" },
            state: "awaiting-arbitration",
            objective: null,
            completedMagiTurns: 2,
            participantCount: 3,
            magiTurnLimit: null,
            startedAt: "2026-08-22T11:45:00.000Z",
            completedAt: null,
          },
          ThreadId.make("root-thread"),
        ),
      ).toEqual(["2 turns", "15m"]);
    });

    it("shortens terminal turn copy and includes agreed votes", () => {
      expect(
        formatMagiRunMetadata(
          {
            runId: MagiRunId.make("finished-run"),
            rootThreadId: ThreadId.make("root-thread"),
            source: "user-arm",
            title: { state: "generated", title: "Finished run" },
            state: "succeeded",
            objective: null,
            completedMagiTurns: 2,
            participantCount: 3,
            magiTurnLimit: 3,
            agreedVoteCount: 3,
            totalVoteCount: 3,
            tokenCount: 219_561,
            startedAt: "2026-08-20T12:00:00.000Z",
            completedAt: "2026-08-20T12:05:00.000Z",
          },
          ThreadId.make("root-thread"),
        ),
      ).toEqual(["2 turns", "3/3 agreed votes", "220k tokens", "2d"]);
    });

    it("names the subagent that owns a run listed in an ancestor's history", () => {
      expect(
        formatMagiRunMetadata(
          {
            runId: MagiRunId.make("subagent-run"),
            rootThreadId: ThreadId.make("subagent-thread"),
            ownerTitle: "Delegated reviewer",
            source: "agent-tool",
            title: { state: "generated", title: "Subagent run" },
            state: "awaiting-arbitration",
            objective: null,
            completedMagiTurns: 1,
            participantCount: 2,
            magiTurnLimit: null,
            startedAt: "2026-08-22T11:45:00.000Z",
            completedAt: null,
          },
          ThreadId.make("root-thread"),
        ),
      ).toEqual(["Subagent: Delegated reviewer", "1 turn", "15m"]);
    });
  });

  describe("agreement progress", () => {
    const run = (overrides: Partial<MagiRunSummary>): MagiRunSummary => ({
      runId: MagiRunId.make("progress-run"),
      rootThreadId: ThreadId.make("root-thread"),
      source: "user-arm",
      title: { state: "generated", title: "Progress run" },
      state: "awaiting-arbitration",
      objective: null,
      completedMagiTurns: 1,
      startedAt: "2026-08-22T11:45:00.000Z",
      completedAt: null,
      ...overrides,
    });

    it("shows the leading outcome and the weight still needed while active", () => {
      expect(
        formatMagiAgreementProgress(
          run({ leadingAgreementLabel: "Ship it", leadingAgreementWeight: 2, requiredWeight: 5 }),
        ),
      ).toEqual({ leading: "Leading: Ship it (2 weight)", remaining: "3 more weight needed" });
    });

    it("needs the full required weight before any comparable outcome", () => {
      expect(
        formatMagiAgreementProgress(
          run({ leadingAgreementLabel: null, leadingAgreementWeight: null, requiredWeight: 4 }),
        ),
      ).toEqual({ leading: "No comparable outcome yet", remaining: "4 more weight needed" });
    });

    it("never reports negative remaining weight", () => {
      expect(
        formatMagiAgreementProgress(
          run({
            state: "awaiting-actions",
            leadingAgreementLabel: "Ship it",
            leadingAgreementWeight: 6,
            requiredWeight: 4,
          }),
        ).remaining,
      ).toBe("Threshold weight reached");
    });

    it("omits remaining weight for terminal runs and summaries without a threshold", () => {
      expect(
        formatMagiAgreementProgress(
          run({
            state: "succeeded",
            leadingAgreementLabel: "Ship it",
            leadingAgreementWeight: 5,
            requiredWeight: 4,
          }),
        ),
      ).toEqual({ leading: "Leading: Ship it (5 weight)", remaining: null });
      expect(formatMagiAgreementProgress(run({ state: "failed" }))).toEqual({
        leading: null,
        remaining: null,
      });
      expect(formatMagiAgreementProgress(run({}))).toEqual({
        leading: "No comparable outcome yet",
        remaining: null,
      });
    });
  });

  describe("run ownership", () => {
    const viewer = ThreadId.make("root-thread");
    const makeRun = (
      runId: string,
      state: MagiRunSummary["state"],
      owner: ThreadId = viewer,
    ): MagiRunSummary => ({
      runId: MagiRunId.make(runId),
      rootThreadId: owner,
      source: "agent-tool",
      title: { state: "generated", title: runId },
      state,
      objective: null,
      completedMagiTurns: 0,
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: state === "deliberating" ? null : "2026-08-22T00:01:00.000Z",
    });

    it("auto-expands the conversation's active run, else its most recent run", () => {
      const latestCompleted = makeRun("latest-completed", "succeeded");
      const active = makeRun("active", "awaiting-arbitration");
      const olderCompleted = makeRun("older-completed", "turn-limit-reached");

      expect(
        preferredMagiRunForAutomaticExpansion([latestCompleted, active, olderCompleted], viewer)
          ?.runId,
      ).toBe(active.runId);
      expect(
        preferredMagiRunForAutomaticExpansion([latestCompleted, olderCompleted], viewer)?.runId,
      ).toBe(latestCompleted.runId);
      expect(preferredMagiRunForAutomaticExpansion([], viewer)).toBeNull();
    });

    it("never treats a subagent's run as the conversation's own", () => {
      const subagent = ThreadId.make("subagent-thread");
      const subagentActive = makeRun("subagent-active", "deliberating", subagent);
      const ownCompleted = makeRun("own-completed", "succeeded");

      expect(ownActiveMagiRun([subagentActive, ownCompleted], viewer)).toBeNull();
      expect(
        preferredMagiRunForAutomaticExpansion([subagentActive, ownCompleted], viewer)?.runId,
      ).toBe(ownCompleted.runId);
      expect(preferredMagiRunForAutomaticExpansion([subagentActive], viewer)).toBeNull();

      const ownActive = makeRun("own-active", "paused");
      expect(ownActiveMagiRun([subagentActive, ownActive], viewer)?.runId).toBe(ownActive.runId);
    });
  });

  describe("arm readiness", () => {
    const idle = {
      activeTurn: false,
      pendingApproval: false,
      pendingUserInput: false,
      submissionInFlight: false,
    };

    it("allows arming an idle conversation", () => {
      expect(magiArmBlockedReason({ readiness: idle, ownActiveRun: false })).toBeNull();
      expect(magiArmBlockedReason({ readiness: undefined, ownActiveRun: false })).toBeNull();
    });

    it("names the condition that blocks arming, approvals first", () => {
      expect(
        magiArmBlockedReason({
          readiness: { ...idle, activeTurn: true, pendingApproval: true },
          ownActiveRun: false,
        }),
      ).toBe("Resolve the pending approval before arming Magi.");
      expect(
        magiArmBlockedReason({
          readiness: { ...idle, pendingUserInput: true },
          ownActiveRun: false,
        }),
      ).toBe("Answer the pending question before arming Magi.");
      expect(magiArmBlockedReason({ readiness: idle, ownActiveRun: true })).toBe(
        "This conversation already has an active Magi run.",
      );
      expect(
        magiArmBlockedReason({
          readiness: { ...idle, activeTurn: true, submissionInFlight: true },
          ownActiveRun: false,
        }),
      ).toBe("Wait for the message being sent to be accepted.");
      expect(
        magiArmBlockedReason({ readiness: { ...idle, activeTurn: true }, ownActiveRun: false }),
      ).toBe("Wait for the current turn to finish before arming Magi.");
    });
  });

  it("lists each provider instance the roster sends the conversation to once", () => {
    const claude = ProviderInstanceId.make("claude-work");
    const config: MagiRunConfig = {
      ...emptyConfig,
      participants: [
        {
          participantId: MagiParticipantId.make("a"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          personalityId: null,
          weight: 1,
        },
        {
          participantId: MagiParticipantId.make("b"),
          modelSelection: { instanceId: claude, model: "sonnet" },
          personalityId: null,
          weight: 1,
        },
        {
          participantId: MagiParticipantId.make("c"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-mini" },
          personalityId: null,
          weight: 1,
        },
      ],
    };

    expect(magiRosterInstanceNames(config, options)).toEqual(["Codex", "claude-work"]);
  });

  describe("weight input", () => {
    const bounds = options.bounds;

    it("applies only whole numbers while typing", () => {
      expect(parseMagiWeightInput("")).toBeNull();
      expect(parseMagiWeightInput("1.5")).toBeNull();
      expect(parseMagiWeightInput(" 15 ")).toBe(15);
    });

    it("clamps to the bounds when the field is left, keeping the weight when empty", () => {
      expect(clampMagiWeight("", bounds, 4)).toBe(4);
      expect(clampMagiWeight("0", bounds, 4)).toBe(1);
      expect(clampMagiWeight("150", bounds, 4)).toBe(100);
      expect(clampMagiWeight("2.6", bounds, 4)).toBe(3);
    });
  });
});

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
  duplicateMagiParticipant,
  exactDuplicateMagiParticipants,
  formatCompactTokenCount,
  formatMagiRunMetadata,
  initialMagiConfig,
  MAGI_PANEL_MAX_THRESHOLD_PERCENT,
  MAGI_PANEL_MIN_THRESHOLD_PERCENT,
  MAGI_HISTORY_LIVE_REFRESH_INTERVAL_MS,
  MAGI_TURN_LIMIT_SLIDER_VALUES,
  makeWebMagiParticipantId,
  magiConfigError,
  magiParticipantIndicator,
  magiRunElapsedMs,
  magiTurnLimitFromSliderIndex,
  magiTurnLimitSliderIndex,
  magiWeightSummary,
  moveMagiParticipant,
  preferredMagiRunForAutomaticExpansion,
  resolveMagiRunHistory,
  shouldClearRetainedMagiRunHistory,
  startMagiHistoryLiveRefresh,
} from "./MagiPanel.logic";

const options = {
  providerInstances: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      models: ["gpt-5"],
      magi: {
        instructions: "native",
        structuredOutput: "native",
        readOnly: "native-policy",
        controlTools: "mcp-tools",
        webSearch: "native",
        historyCompaction: "explicit-native",
      },
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

describe("live refresh", () => {
  it("refreshes on the scheduled interval while the panel is visible", () => {
    const refresh = vi.fn();
    const cancel = vi.fn();
    const scheduled: Array<() => void> = [];
    const cleanup = startMagiHistoryLiveRefresh({
      enabled: true,
      refresh,
      schedule: (callback, intervalMs) => {
        expect(intervalMs).toBe(MAGI_HISTORY_LIVE_REFRESH_INTERVAL_MS);
        scheduled.push(callback);
        return 37;
      },
      cancel,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(refresh).toHaveBeenCalledTimes(1);

    cleanup();
    expect(cancel).toHaveBeenCalledWith(37);
  });

  it("does not schedule refreshes while the panel is hidden", () => {
    const refresh = vi.fn();
    const schedule = vi.fn(() => 37);
    const cancel = vi.fn();
    const cleanup = startMagiHistoryLiveRefresh({
      enabled: false,
      refresh,
      schedule,
      cancel,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    cleanup();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("run history selection", () => {
  const latest = { runs: [], nextCursor: null };
  const expandedHistory = { runs: [], nextCursor: null };

  it("keeps the latest summary visible while expanded history is pending", () => {
    expect(
      resolveMagiRunHistory({
        expanded: true,
        latest,
        expandedHistory: null,
        retainedExpandedHistory: null,
      }),
    ).toBe(latest);
  });

  it("uses expanded history after it loads and the latest query while collapsed", () => {
    expect(
      resolveMagiRunHistory({
        expanded: true,
        latest,
        expandedHistory,
        retainedExpandedHistory: null,
      }),
    ).toBe(expandedHistory);
    expect(
      resolveMagiRunHistory({
        expanded: false,
        latest,
        expandedHistory,
        retainedExpandedHistory: null,
      }),
    ).toBe(latest);
  });

  it("retains terminal history across collapse until the latest query catches up", () => {
    expect(
      resolveMagiRunHistory({
        expanded: false,
        latest,
        expandedHistory: null,
        retainedExpandedHistory: expandedHistory,
      }),
    ).toBe(expandedHistory);
  });

  it("clears retained history only after the reconciliation refresh settles", () => {
    const base = {
      expanded: false,
      hasRefreshBaseline: true,
      refreshResultChanged: true,
      refreshResultIsSuccess: true,
    };

    expect(shouldClearRetainedMagiRunHistory({ ...base, refreshResultIsWaiting: true })).toBe(
      false,
    );
    expect(shouldClearRetainedMagiRunHistory({ ...base, refreshResultIsWaiting: false })).toBe(
      true,
    );
  });
});

describe("new-run sliders", () => {
  it("offers every majority threshold percentage", () => {
    expect(MAGI_PANEL_MIN_THRESHOLD_PERCENT).toBe(51);
    expect(MAGI_PANEL_MAX_THRESHOLD_PERCENT).toBe(100);
  });

  it("uses evenly spaced Fibonacci turn-limit stops", () => {
    expect(MAGI_TURN_LIMIT_SLIDER_VALUES).toEqual([
      1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 0,
    ]);
    expect(magiTurnLimitFromSliderIndex(0)).toBe(1);
    expect(magiTurnLimitFromSliderIndex(14)).toBe(610);
    expect(magiTurnLimitFromSliderIndex(15)).toBeNull();
  });

  it("keeps either one-turn stop selected", () => {
    expect(magiTurnLimitSliderIndex(1)).toBe(0);
    expect(magiTurnLimitSliderIndex(1, 1)).toBe(1);
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

describe("Magi panel roster logic", () => {
  it("mints distinct ids for rapid participant creation", () => {
    const ids = Array.from({ length: 100 }, () => makeWebMagiParticipantId());

    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("participant indicators", () => {
    it("uses neutral placeholders until a participant is actively working or fails", () => {
      expect(
        magiParticipantIndicator({
          runState: "deliberating",
          memberState: "pending",
          finalStance: null,
          finalBallot: null,
        }),
      ).toBe("neutral");
      expect(
        magiParticipantIndicator({
          runState: "deliberating",
          memberState: "settled",
          finalStance: null,
          finalBallot: null,
        }),
      ).toBe("neutral");
      expect(
        magiParticipantIndicator({
          runState: "deliberating",
          memberState: "running",
          finalStance: null,
          finalBallot: null,
        }),
      ).toBe("working");
      expect(
        magiParticipantIndicator({
          runState: "deliberating",
          memberState: "failed",
          finalStance: null,
          finalBallot: null,
        }),
      ).toBe("warning");
    });

    it("shows authoritative support and opposition after the final tally", () => {
      expect(
        magiParticipantIndicator({
          runState: "succeeded",
          memberState: "settled",
          finalStance: "supports",
          finalBallot: "approve",
        }),
      ).toBe("supports");
      expect(
        magiParticipantIndicator({
          runState: "succeeded",
          memberState: "settled",
          finalStance: "opposes",
          finalBallot: "reject",
        }),
      ).toBe("opposes");
    });

    it("distinguishes an explicit abstention from an unresolved vote after consensus", () => {
      expect(
        magiParticipantIndicator({
          runState: "succeeded",
          memberState: "settled",
          finalStance: "unclear",
          finalBallot: "abstain",
        }),
      ).toBe("abstained");
      expect(
        magiParticipantIndicator({
          runState: "succeeded",
          memberState: "settled",
          finalStance: "unclear",
          finalBallot: "not-applicable",
        }),
      ).toBe("warning");
      expect(
        magiParticipantIndicator({
          runState: "succeeded",
          memberState: "failed",
          finalStance: "unclear",
          finalBallot: null,
        }),
      ).toBe("warning");
    });

    it("uses neutral placeholders when a run ends without consensus", () => {
      expect(
        magiParticipantIndicator({
          runState: "turn-limit-reached",
          memberState: "settled",
          finalStance: "supports",
          finalBallot: "approve",
        }),
      ).toBe("neutral");
      expect(
        magiParticipantIndicator({
          runState: "turn-limit-reached",
          memberState: "settled",
          finalStance: "opposes",
          finalBallot: "reject",
        }),
      ).toBe("neutral");
      expect(
        magiParticipantIndicator({
          runState: "turn-limit-reached",
          memberState: "settled",
          finalStance: "unclear",
          finalBallot: "abstain",
        }),
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

  it("warns for exact duplicate rows without rejecting them", () => {
    const base = addDefaultMagiParticipant(emptyConfig, options, "one");
    const duplicate = { ...base.participants[0]!, participantId: MagiParticipantId.make("two") };
    expect([...exactDuplicateMagiParticipants([...base.participants, duplicate])]).toEqual([
      "one",
      "two",
    ]);
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
        formatMagiRunMetadata({
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
        }),
      ).toEqual(["1/3 turns", "220k tokens", "15m"]);
    });

    it("omits the denominator for an unlimited running run", () => {
      expect(
        formatMagiRunMetadata({
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
        }),
      ).toEqual(["2 turns", "15m"]);
    });

    it("shortens terminal turn copy and includes agreed votes", () => {
      expect(
        formatMagiRunMetadata({
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
        }),
      ).toEqual(["2 turns", "3/3 agreed votes", "220k tokens", "2d"]);
    });
  });

  it("auto-expands the selected conversation's active or most recent run", () => {
    const selectedThreadId = ThreadId.make("root-thread");
    const childThreadId = ThreadId.make("child-thread");
    const makeRun = (
      runId: string,
      rootThreadId: ThreadId,
      state: MagiRunSummary["state"],
      source: MagiRunSummary["source"],
    ): MagiRunSummary => ({
      runId: MagiRunId.make(runId),
      rootThreadId,
      source,
      title: { state: "generated", title: runId },
      state,
      objective: null,
      completedMagiTurns: 0,
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: state === "succeeded" ? "2026-08-22T00:01:00.000Z" : null,
    });
    const childRun = makeRun("child-run", childThreadId, "deliberating", "agent-tool");
    const ownRun = makeRun("own-run", selectedThreadId, "awaiting-arbitration", "agent-tool");
    const completedRun = makeRun("completed-run", selectedThreadId, "succeeded", "agent-tool");

    expect(
      preferredMagiRunForAutomaticExpansion(
        [childRun, completedRun, ownRun],
        selectedThreadId,
        (state) => state === "succeeded",
      )?.runId,
    ).toBe(ownRun.runId);

    expect(
      preferredMagiRunForAutomaticExpansion(
        [childRun],
        selectedThreadId,
        (state) => state === "succeeded",
      ),
    ).toBeNull();
    expect(
      preferredMagiRunForAutomaticExpansion(
        [completedRun, childRun],
        selectedThreadId,
        (state) => state === "succeeded",
      )?.runId,
    ).toBe(completedRun.runId);
    expect(
      preferredMagiRunForAutomaticExpansion(
        [childRun, completedRun],
        selectedThreadId,
        (state) => state === "succeeded",
      )?.runId,
    ).toBe(completedRun.runId);
  });
});

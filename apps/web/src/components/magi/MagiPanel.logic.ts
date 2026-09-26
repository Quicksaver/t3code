import {
  isMagiRunTerminal,
  MagiParticipantId,
  requiredMagiWeight,
  totalMagiWeight,
  validateMagiRoster,
  type MagiGetOptionsResult,
  type MagiListRunsResult,
  type MagiArbitrationStance,
  type MagiBallot,
  type MagiMemberState,
  type MagiParticipantDraft,
  type MagiRunConfig,
  type MagiRunState,
  type MagiRunSummary,
  type MagiSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { formatRelativeTime } from "~/timestampFormat";
import { randomUUID } from "~/lib/utils";

export type MagiParticipantIndicator =
  | "neutral"
  | "working"
  | "warning"
  | "supports"
  | "opposes"
  | "abstained";

export const MAGI_HISTORY_LIVE_REFRESH_INTERVAL_MS = 1_000;
export const MAGI_PANEL_MIN_THRESHOLD_PERCENT = 51;
export const MAGI_PANEL_MAX_THRESHOLD_PERCENT = 100;
export const MAGI_TURN_LIMIT_SLIDER_VALUES = [
  1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 0,
] as const;

export function magiTurnLimitFromSliderIndex(index: number): number | null {
  const boundedIndex = Math.min(
    MAGI_TURN_LIMIT_SLIDER_VALUES.length - 1,
    Math.max(0, Math.round(index)),
  );
  const value = MAGI_TURN_LIMIT_SLIDER_VALUES[boundedIndex] ?? 1;
  return value === 0 ? null : value;
}

export function magiTurnLimitSliderIndex(
  turnLimit: number | null,
  preferredIndex?: number,
): number {
  const target = turnLimit ?? 0;
  if (preferredIndex !== undefined && MAGI_TURN_LIMIT_SLIDER_VALUES[preferredIndex] === target) {
    return preferredIndex;
  }

  return MAGI_TURN_LIMIT_SLIDER_VALUES.reduce<number>(
    (nearestIndex, value, index) =>
      Math.abs(value - target) < Math.abs(MAGI_TURN_LIMIT_SLIDER_VALUES[nearestIndex]! - target)
        ? index
        : nearestIndex,
    0,
  );
}

export function normalizeMagiPanelConfig(config: MagiRunConfig): MagiRunConfig {
  return {
    ...config,
    consensusThresholdPercent: Math.min(
      MAGI_PANEL_MAX_THRESHOLD_PERCENT,
      Math.max(MAGI_PANEL_MIN_THRESHOLD_PERCENT, config.consensusThresholdPercent),
    ),
    magiTurnLimit: magiTurnLimitFromSliderIndex(magiTurnLimitSliderIndex(config.magiTurnLimit)),
  };
}

export function magiRunElapsedMs(
  run: Pick<MagiRunSummary, "startedAt" | "completedAt">,
  nowMs: number,
): number {
  return Math.max(
    0,
    (run.completedAt === null ? nowMs : Date.parse(run.completedAt)) - Date.parse(run.startedAt),
  );
}

export function startMagiHistoryLiveRefresh(input: {
  readonly enabled: boolean;
  readonly refresh: () => void;
  readonly schedule: (callback: () => void, intervalMs: number) => number;
  readonly cancel: (timer: number) => void;
}): () => void {
  if (!input.enabled) return () => {};
  const timer = input.schedule(input.refresh, MAGI_HISTORY_LIVE_REFRESH_INTERVAL_MS);
  return () => input.cancel(timer);
}

export function resolveMagiRunHistory(input: {
  readonly expanded: boolean;
  readonly latest: MagiListRunsResult | null;
  readonly expandedHistory: MagiListRunsResult | null;
  readonly retainedExpandedHistory: MagiListRunsResult | null;
}): MagiListRunsResult | null {
  return input.expanded
    ? (input.expandedHistory ?? input.latest)
    : (input.retainedExpandedHistory ?? input.latest);
}

export function shouldClearRetainedMagiRunHistory(input: {
  readonly expanded: boolean;
  readonly hasRefreshBaseline: boolean;
  readonly refreshResultChanged: boolean;
  readonly refreshResultIsSuccess: boolean;
  readonly refreshResultIsWaiting: boolean;
}): boolean {
  return (
    !input.expanded &&
    input.hasRefreshBaseline &&
    input.refreshResultChanged &&
    input.refreshResultIsSuccess &&
    !input.refreshResultIsWaiting
  );
}

export const makeWebMagiParticipantId = (): MagiParticipantId =>
  MagiParticipantId.make(`participant-${randomUUID()}`);

export function magiParticipantIndicator(input: {
  readonly runState: MagiRunState;
  readonly memberState: MagiMemberState;
  readonly finalStance: MagiArbitrationStance | null;
  readonly finalBallot: MagiBallot | null;
}): MagiParticipantIndicator {
  if (input.runState === "succeeded" && input.finalStance !== null) {
    if (input.finalStance === "supports") return "supports";
    if (input.finalStance === "opposes") return "opposes";
    return input.memberState === "settled" && input.finalBallot === "abstain"
      ? "abstained"
      : "warning";
  }

  if (isMagiRunTerminal(input.runState)) {
    return input.memberState === "failed" ||
      input.memberState === "timed-out" ||
      input.memberState === "cancelled"
      ? "warning"
      : "neutral";
  }

  if (input.memberState === "running") return "working";
  if (
    input.memberState === "failed" ||
    input.memberState === "timed-out" ||
    input.memberState === "cancelled"
  ) {
    return "warning";
  }
  return "neutral";
}

export function initialMagiConfig(
  options: MagiGetOptionsResult,
  settings: MagiSettings,
): MagiRunConfig {
  const rememberedParticipants =
    settings.lastPanelRoster.length >= options.bounds.minimumParticipants
      ? settings.lastPanelRoster
      : [];
  const provider = options.providerInstances.find(
    (candidate) => candidate.available && candidate.models.length > 0,
  );
  const participants =
    rememberedParticipants.length >= options.bounds.minimumParticipants || !provider?.models[0]
      ? rememberedParticipants
      : Array.from({ length: options.bounds.minimumParticipants }, (_, index) => ({
          participantId: MagiParticipantId.make(`web-default-${index + 1}`),
          modelSelection: { instanceId: provider.instanceId, model: provider.models[0]! },
          personalityId:
            options.personalities.filter((personality) => personality.included)[index]?.id ?? null,
          weight: 1,
        }));
  return normalizeMagiPanelConfig({
    participants,
    consensusThresholdPercent: settings.lastPanelConsensusThresholdPercent,
    magiTurnLimit: settings.lastPanelMagiTurnLimit,
  });
}

export function addDefaultMagiParticipant(
  config: MagiRunConfig,
  options: MagiGetOptionsResult,
  participantId: string,
): MagiRunConfig {
  if (config.participants.length >= options.bounds.maximumParticipants) return config;
  const provider = options.providerInstances.find(
    (candidate) => candidate.available && candidate.models.length > 0,
  );
  if (!provider?.models[0]) return config;
  const participant: MagiParticipantDraft = {
    participantId: MagiParticipantId.make(participantId),
    modelSelection: { instanceId: provider.instanceId, model: provider.models[0] },
    personalityId: options.personalities.find((personality) => personality.included)?.id ?? null,
    weight: 1,
  };
  return { ...config, participants: [...config.participants, participant] };
}

export function exactDuplicateMagiParticipants(
  participants: ReadonlyArray<MagiParticipantDraft>,
): ReadonlySet<string> {
  const identities = new Map<string, string[]>();
  for (const participant of participants) {
    const key = JSON.stringify([
      participant.modelSelection.instanceId,
      participant.modelSelection.model,
      participant.modelSelection.options ?? [],
      participant.personalityId,
    ]);
    identities.set(key, [...(identities.get(key) ?? []), participant.participantId]);
  }
  return new Set([...identities.values()].filter((ids) => ids.length > 1).flatMap((ids) => ids));
}

export function duplicateMagiParticipant(
  config: MagiRunConfig,
  options: MagiGetOptionsResult,
  participantId: string,
  newParticipantId: string,
): MagiRunConfig {
  if (config.participants.length >= options.bounds.maximumParticipants) return config;
  const index = config.participants.findIndex((item) => item.participantId === participantId);
  const source = config.participants[index];
  if (index < 0 || !source) return config;
  const copy = { ...source, participantId: MagiParticipantId.make(newParticipantId) };
  return {
    ...config,
    participants: [
      ...config.participants.slice(0, index + 1),
      copy,
      ...config.participants.slice(index + 1),
    ],
  };
}

export function moveMagiParticipant(
  config: MagiRunConfig,
  participantId: string,
  direction: -1 | 1,
): MagiRunConfig {
  const index = config.participants.findIndex((item) => item.participantId === participantId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= config.participants.length) return config;
  const participants = [...config.participants];
  [participants[index], participants[target]] = [participants[target]!, participants[index]!];
  return { ...config, participants };
}

export function magiWeightSummary(config: MagiRunConfig): {
  readonly totalWeight: number;
  readonly requiredWeight: number;
} {
  const totalWeight = totalMagiWeight(config.participants);
  return {
    totalWeight,
    requiredWeight: requiredMagiWeight(totalWeight, config.consensusThresholdPercent),
  };
}

export function magiConfigError(config: MagiRunConfig): string | null {
  return validateMagiRoster(config)[0]?.message ?? null;
}

export function formatCompactTokenCount(tokenCount: number): string {
  const suffixes = ["", "k", "M", "G", "T"] as const;
  let exponent = tokenCount < 1_000 ? 0 : Math.floor(Math.log(tokenCount) / Math.log(1_000));
  exponent = Math.min(exponent, suffixes.length - 1);
  let scaled = tokenCount / 1_000 ** exponent;
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  scaled = Number(scaled.toFixed(precision));
  if (scaled >= 1_000 && exponent < suffixes.length - 1) {
    scaled /= 1_000;
    exponent += 1;
  }
  return `${scaled}${suffixes[exponent]} tokens`;
}

export function formatMagiRunMetadata(run: MagiRunSummary): ReadonlyArray<string> {
  const terminal = isMagiRunTerminal(run.state);
  const turnCopy =
    terminal || run.magiTurnLimit === null || run.magiTurnLimit === undefined
      ? `${run.completedMagiTurns} turn${run.completedMagiTurns === 1 ? "" : "s"}`
      : `${run.completedMagiTurns}/${run.magiTurnLimit} turns`;
  const agreementCopy =
    terminal &&
    run.agreedVoteCount !== undefined &&
    run.agreedVoteCount !== null &&
    run.totalVoteCount !== undefined &&
    run.totalVoteCount !== null
      ? `${run.agreedVoteCount}/${run.totalVoteCount} agreed votes`
      : null;
  const tokenCopy = run.tokenCount === undefined ? null : formatCompactTokenCount(run.tokenCount);
  const relativeAge = formatRelativeTime(run.startedAt);
  const ageCopy = relativeAge?.value === "just now" ? "now" : (relativeAge?.value ?? "");

  return [turnCopy, agreementCopy, tokenCopy, ageCopy].filter(
    (copy): copy is string => copy !== null && copy !== "",
  );
}

export function preferredMagiRunForAutomaticExpansion(
  runs: ReadonlyArray<MagiRunSummary>,
  selectedThreadId: ThreadId,
  isTerminal: (state: MagiRunSummary["state"]) => boolean,
): MagiRunSummary | null {
  const activeOwnRun = runs.find(
    (run) => run.rootThreadId === selectedThreadId && !isTerminal(run.state),
  );
  return activeOwnRun ?? runs.find((run) => run.rootThreadId === selectedThreadId) ?? null;
}

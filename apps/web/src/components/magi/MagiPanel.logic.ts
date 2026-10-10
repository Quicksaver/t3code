import {
  isMagiRunTerminal,
  MagiParticipantId,
  requiredMagiWeight,
  totalMagiWeight,
  validateMagiRoster,
  type MagiGetOptionsResult,
  type MagiParticipantDraft,
  type MagiRunConfig,
  type MagiRunSummary,
  type MagiSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { formatRelativeTime } from "~/timestampFormat";
import { randomUUID } from "~/lib/utils";

export const MAGI_PANEL_MIN_THRESHOLD_PERCENT = 51;

/** Reapply the server arm only after canceled writes settle, unless a newer intent supersedes it. */
export async function reconcileMagiArmAfterWrites(
  writes: Promise<unknown>,
  isCurrent: () => boolean,
  reconcile: () => void,
): Promise<void> {
  await writes.catch(() => undefined);
  if (isCurrent()) reconcile();
}

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

export const makeWebMagiParticipantId = (): MagiParticipantId =>
  MagiParticipantId.make(`participant-${randomUUID()}`);

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

/** Run list metadata; a run owned by a subagent of `viewerThreadId` names that subagent first. */
export function formatMagiRunMetadata(
  run: MagiRunSummary,
  viewerThreadId: ThreadId,
): ReadonlyArray<string> {
  const ownerCopy =
    run.rootThreadId === viewerThreadId ? null : `Subagent: ${run.ownerTitle ?? "Untitled"}`;
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

  return [ownerCopy, turnCopy, agreementCopy, tokenCopy, ageCopy].filter(
    (copy): copy is string => copy !== null && copy !== "",
  );
}

/**
 * Timeline progress copy: the leading comparable outcome with its weight and, while the run is
 * active, the agreement weight still needed to reach the threshold.
 */
export function formatMagiAgreementProgress(run: MagiRunSummary): {
  readonly leading: string | null;
  readonly remaining: string | null;
} {
  const active = !isMagiRunTerminal(run.state);
  const leadingWeight = run.leadingAgreementWeight ?? null;
  const leadingLabel = run.leadingAgreementLabel ?? null;
  const leading =
    leadingWeight !== null && leadingLabel !== null
      ? `Leading: ${leadingLabel} (${leadingWeight} weight)`
      : active
        ? "No comparable outcome yet"
        : null;
  const requiredWeight = run.requiredWeight ?? null;
  if (!active || requiredWeight === null) return { leading, remaining: null };
  const remainingWeight = Math.max(0, requiredWeight - (leadingWeight ?? 0));
  return {
    leading,
    remaining:
      remainingWeight === 0 ? "Threshold weight reached" : `${remainingWeight} more weight needed`,
  };
}

/**
 * The conversation's own active run, else its own most recent one. Runs arrive newest first;
 * runs owned by subagents stay in the history but never expand automatically.
 */
export function preferredMagiRunForAutomaticExpansion(
  runs: ReadonlyArray<MagiRunSummary>,
  ownerThreadId: ThreadId,
): MagiRunSummary | null {
  const ownRuns = runs.filter((run) => run.rootThreadId === ownerThreadId);
  return ownRuns.find((run) => !isMagiRunTerminal(run.state)) ?? ownRuns[0] ?? null;
}

/** A run state in the Lineage status vocabulary that subagent rows use. */
export function magiRunLineageStatus(
  state: MagiRunSummary["state"],
): "running" | "idle" | "completed" | "failed" | "cancelled" {
  switch (state) {
    case "paused":
      return "idle";
    case "succeeded":
      return "completed";
    case "failed":
    case "turn-limit-reached":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/** The nonterminal run owned by this conversation; subagent-owned runs never block its arm. */
export function ownActiveMagiRun(
  runs: ReadonlyArray<MagiRunSummary>,
  ownerThreadId: ThreadId,
): MagiRunSummary | null {
  return (
    runs.find((run) => run.rootThreadId === ownerThreadId && !isMagiRunTerminal(run.state)) ?? null
  );
}

/** What keeps the conversation from arming its next message, in the order a user resolves it. */
export interface MagiArmReadiness {
  readonly activeTurn: boolean;
  readonly pendingApproval: boolean;
  readonly pendingUserInput: boolean;
  readonly submissionInFlight: boolean;
}

/** Arming is idle-only; configuration stays editable while this returns a reason. */
export function magiArmBlockedReason(input: {
  readonly readiness: MagiArmReadiness | undefined;
  readonly ownActiveRun: boolean;
}): string | null {
  if (input.readiness?.pendingApproval) return "Resolve the pending approval before arming Magi.";
  if (input.readiness?.pendingUserInput) return "Answer the pending question before arming Magi.";
  if (input.ownActiveRun) return "This conversation already has an active Magi run.";
  if (input.readiness?.submissionInFlight) return "Wait for the message being sent to be accepted.";
  if (input.readiness?.activeTurn) return "Wait for the current turn to finish before arming Magi.";
  return null;
}

/** Display names of the provider instances a roster sends the conversation to, in roster order. */
export function magiRosterInstanceNames(
  config: MagiRunConfig,
  options: Pick<MagiGetOptionsResult, "providerInstances">,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const participant of config.participants) {
    const instanceId = participant.modelSelection.instanceId;
    names.add(
      options.providerInstances.find((candidate) => candidate.instanceId === instanceId)
        ?.displayName ?? instanceId,
    );
  }
  return [...names];
}

/** The integer weight a weight field holds, or null while it is empty or not a whole number. */
export function parseMagiWeightInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A committed weight: the field's value rounded and clamped to the bounds, else `fallback`. */
export function clampMagiWeight(
  text: string,
  bounds: Pick<MagiGetOptionsResult["bounds"], "minimumWeight" | "maximumWeight">,
  fallback: number,
): number {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return fallback;
  return Math.min(bounds.maximumWeight, Math.max(bounds.minimumWeight, Math.round(value)));
}

import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { isBackgroundTaskActivity } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";
import {
  extractWorkLogActivityIdentity,
  mergeChangedFiles,
  mergeCumulativeOutput,
  mergeCumulativePatch,
  normalizeCompactToolLabel,
  parseWorkLogActivityPayload,
  requestKindFromRequestType,
} from "./lib/workLogActivity";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  /** Stable provider identity across in-progress and completed lifecycle updates. */
  toolCallId?: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  /** Full command output remains server-side until this activity is expanded. */
  commandOutputAvailable?: boolean;
  /** Activities that own deferred command output, before lifecycle rows are merged. */
  commandOutputActivityIds?: ReadonlyArray<string>;
  patch?: string;
  changedFiles?: ReadonlyArray<string>;
  subagentPrompt?: string;
  subagentChildren?: ReadonlyArray<SubagentWorkLogChild>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** Agent role (subagent_type) for labeled timeline rows. */
  agentRole?: string;
  /**
   * Present on agent-spawn CTA rows: one per workflow run or per-turn batch
   * of direct spawns. The row renders as a call-to-action ("Kicked off N
   * subagents") whose live status is derived from the agent panel model at
   * render time; clicking opens the Agents panel.
   */
  agentSpawn?: {
    /** Workflow coordinator taskId, or null for a direct-spawn batch. */
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export interface SubagentWorkLogChild {
  threadId: ThreadId;
  parentItemId?: string;
  titleSeed?: string;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn CTAs. */
  isBackgroundTask?: boolean;
}
export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change" | "mcp-elicitation";
  createdAt: string;
  detail?: string;
  appName?: string;
  options?: ReadonlyArray<{
    decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
    label: string;
  }>;
}

function isPendingApprovalRequestKind(value: unknown): value is PendingApproval["requestKind"] {
  return (
    value === "command" ||
    value === "file-read" ||
    value === "file-change" ||
    value === "mcp-elicitation"
  );
}

function isPendingApprovalOption(
  value: unknown,
): value is NonNullable<PendingApproval["options"]>[number] {
  if (value === null || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.label === "string" &&
    (option.decision === "accept" ||
      option.decision === "acceptForSession" ||
      option.decision === "acceptAlways" ||
      option.decision === "decline" ||
      option.decision === "cancel")
  );
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "turn-plan";
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) {
    return true;
  }
  if (t.includes("no files found")) {
    return true;
  }
  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }
  if (t.includes("cannot find path") && t.includes("because it does not exist")) {
    return true;
  }
  if (t.includes("commandnotfoundexception")) {
    return true;
  }
  if (t.includes("is not recognized as the name of a cmdlet")) {
    return true;
  }
  if (t.includes("is not recognized") && t.includes("the term '")) {
    return true;
  }
  if (t.includes("a parameter cannot be found that matches parameter name")) {
    return true;
  }
  if (t.includes("command not found")) {
    return true;
  }
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) {
    return true;
  }
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) {
    return true;
  }
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) {
    return true;
  }
  return false;
}

/** True when the row should show a failure affordance (explicit status/tone or error-shaped tool output). */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (entry.exitCode != null && entry.exitCode !== 0) {
    return true;
  }
  const parts: string[] = [];
  if (entry.detail) {
    parts.push(entry.detail);
  }
  if (entry.command) {
    parts.push(entry.command);
  }
  const blob = parts.join("\n");
  if (blob.length === 0) {
    return false;
  }
  return toolDetailTextLooksLikeFailure(blob);
}

/** True when the rendered result indicates failure. The command itself is user intent, not output. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const lifecycleStatus = entry.toolLifecycleStatus;
  if (lifecycleStatus === "failed" || lifecycleStatus === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (entry.exitCode != null && entry.exitCode !== 0) {
    return true;
  }
  const renderedOutput = [entry.detail, entry.output, entry.stdout, entry.stderr]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return renderedOutput.length > 0 && toolDetailTextLooksLikeFailure(renderedOutput);
}

/** Tool/command row completed without failure (blue check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return false;
  }
  if (ls === "inProgress") {
    return false;
  }
  if (ls === "stopped") {
    return false;
  }
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  // Spawn CTA rows are never neutral-hidden: mid-run they derive from
  // task.progress (tone "thinking") and the neutral filter was swallowing
  // them exactly while the fleet ran — the one moment they matter most.
  if (entry.agentSpawn !== undefined) {
    return false;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (entry.itemType === "collab_agent_tool_call" && (entry.subagentChildren?.length ?? 0) > 0) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return false;
  }
  return true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs === 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<NonNullable<Thread["session"]>, "status" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.status === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId = session?.status === "running" ? session.activeTurnId : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload && isPendingApprovalRequestKind(payload.requestKind)
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const appName = payload && typeof payload.appName === "string" ? payload.appName : undefined;
    const options = Array.isArray(payload?.options)
      ? payload.options.filter(isPendingApprovalOption)
      : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(appName ? { appName } : {}),
        ...(options && options.length > 0 ? { options } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function planStateFromActivity(activity: OrchestrationThreadActivity): ActivePlanState | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({
      step: record.step,
      status,
    });
  }
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  return planStateFromActivity(latest);
}

export interface TurnPlanEntry {
  /** Stable per-turn row id (plans rewrite constantly; the row must not churn). */
  id: string;
  /** Anchor timestamp: the turn's FIRST plan activity, so the chip renders where planning began. */
  createdAt: string;
  turnId: TurnId | null;
  plan: ActivePlanState;
}

/**
 * One inline plan chip per turn that produced plan/todo steps: the latest
 * snapshot for the turn, anchored at the first snapshot's timestamp. Turn-less
 * plan activities collapse into a single chip keyed by thread order.
 */
export function deriveTurnPlans(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnPlanEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const byTurn = new Map<string, TurnPlanEntry>();
  for (const activity of ordered) {
    if (activity.kind !== "turn.plan.updated") {
      continue;
    }
    const plan = planStateFromActivity(activity);
    const key = activity.turnId ?? "no-turn";
    if (!plan) {
      // A later snapshot with no steps clears the turn's plan; keeping the
      // stale entry would freeze the chip on a withdrawn plan.
      byTurn.delete(key);
      continue;
    }
    const existing = byTurn.get(key);
    if (existing) {
      existing.plan = plan;
    } else {
      byTurn.set(key, {
        id: `turn-plan:${key}`,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        plan,
      });
    }
  }
  return [...byTurn.values()];
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

/**
 * Quiet-timeline guarantee: the work log carries the parent's narrative plus
 * at most one row per agent. Everything an agent does internally lives in the
 * Agents surface:
 * - timelineBypass rows (Codex children, workflow members) never render here;
 * - tool rows attributed to an owning agent (payload.agentId) are re-homed;
 * - task.progress ticks collapse into one row per taskId;
 * - task.updated is fold input only (status patches are not narrative).
 * Unattributed rows always stay: over-hiding loses the only terminal signal.
 */
/** Agent (non-background) task.started rows seed spawn CTA batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.taskId !== "string") {
    return false;
  }
  return !isBackgroundTaskActivity(payload);
}

function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }
  const isTaskRow =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.updated" ||
    activity.kind === "task.completed";
  // Task rows classify by the server stamp: a subagent's own background
  // shell (agentId + "background") is agent-internal, but a nested AGENT
  // (agentId + "agent") stays visible so its rows can anchor a spawn CTA
  // (review finding: hiding on agentId alone removed nested agents and
  // their anchors). Bypassed agent lifecycle rows also pass — collapse
  // folds every such row into its batch's single CTA row, which is how
  // Codex children (whose rows are ALL bypassed) get an anchor at the
  // spawn point.
  if (isTaskRow) {
    const ownedByAgent = typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
    if (ownedByAgent || payload.timelineBypass === true) {
      const isAgentTaskRow =
        activity.kind !== "task.updated" &&
        typeof payload.taskId === "string" &&
        !isBackgroundTaskActivity(payload);
      return !isAgentTaskRow;
    }
    return false;
  }
  if (payload.timelineBypass === true) {
    return true;
  }
  // Non-task rows (attributed tool activity) owned by an agent are internal.
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    // Agent task.started rows are CTA seeds: they carry the true spawn turn,
    // which is the batch key (completions of background subagents arrive
    // under later synthetic turns and must not start new batches). They
    // collapse into the batch's single CTA row, never render standalone.
    if (activity.kind === "task.started" && !isAgentTaskStartedActivity(activity)) continue;
    if (activity.kind === "task.updated") continue;
    if (activity.kind === "tool.progress") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return dedupeSubagentChildWorkEntries(
    collapseDerivedWorkLogEntries(entries.filter((entry) => !isEmptySubagentWorkLogEntry(entry))),
  ).map((entry) => {
    const { activityKind, collapseKey: _collapseKey, ...rest } = entry;
    return Object.assign(rest, { sourceActivityKind: activityKind });
  });
}

export function mergeDeferredCommandOutput(
  workEntry: WorkLogEntry,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry {
  let output = workEntry.output;
  let stdout = workEntry.stdout;
  let stderr = workEntry.stderr;
  for (const detailEntry of deriveWorkLogEntries(activities)) {
    const activityKind = detailEntry.sourceActivityKind ?? "tool.completed";
    output = mergeCumulativeOutput(output, detailEntry.output, activityKind);
    stdout = mergeCumulativeOutput(stdout, detailEntry.stdout, activityKind);
    stderr = mergeCumulativeOutput(stderr, detailEntry.stderr, activityKind);
  }
  return {
    ...workEntry,
    ...(output ? { output } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  if (!payload) {
    return undefined;
  }
  const s = payload.status;
  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }
  return undefined;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const parsedPayload = parseWorkLogActivityPayload(payload, {
    heading: activity.summary,
    preserveBlankRawOutputStreams: activity.kind === "tool.updated",
  });
  const title = parsedPayload.title;
  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? parsedPayload.strippedDetail
      : null
    : parsedPayload.detail;
  const toolCallId = isTaskActivity
    ? null
    : (parsedPayload.toolCallId ?? extractSubagentToolCallId(payload));
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = parsedPayload.itemType;
  const requestKind = parsedPayload.requestKind;
  const subagentOutput =
    itemType === "collab_agent_tool_call" ? extractSubagentOutput(payload) : null;
  const subagentPrompt =
    itemType === "collab_agent_tool_call" ? extractSubagentPrompt(payload, detail) : null;
  const subagentChildren =
    itemType === "collab_agent_tool_call" ? extractSubagentChildren(payload) : [];
  if (detail) {
    entry.detail = detail;
  }
  if (parsedPayload.command) {
    entry.command = parsedPayload.command;
  }
  if (parsedPayload.rawCommand) {
    entry.rawCommand = parsedPayload.rawCommand;
  }
  if (subagentOutput) {
    entry.output = subagentOutput;
  }
  const isCommandEntry =
    itemType === "command_execution" ||
    requestKind === "command" ||
    Boolean(parsedPayload.command || parsedPayload.rawCommand);
  if (
    parsedPayload.output &&
    !parsedPayload.stdout &&
    !parsedPayload.stderr &&
    !entry.output &&
    isCommandEntry
  ) {
    entry.output = parsedPayload.output;
  }
  if (parsedPayload.stdout) {
    entry.stdout = parsedPayload.stdout;
  }
  if (parsedPayload.stderr) {
    entry.stderr = parsedPayload.stderr;
  }
  if (parsedPayload.exitCode !== null) {
    entry.exitCode = parsedPayload.exitCode;
  }
  if (parsedPayload.durationMs !== null) {
    entry.durationMs = parsedPayload.durationMs;
  }
  if (parsedPayload.commandOutputAvailable) {
    entry.commandOutputAvailable = true;
    entry.commandOutputActivityIds = [entry.id];
  }
  if (parsedPayload.patch) {
    entry.patch = parsedPayload.patch;
  }
  if (parsedPayload.changedFiles.length > 0) {
    entry.changedFiles = parsedPayload.changedFiles;
  }
  if (subagentPrompt) {
    entry.subagentPrompt = subagentPrompt;
  }
  if (subagentChildren.length > 0) {
    entry.subagentChildren = subagentChildren;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (parsedPayload.toolData !== undefined) {
    entry.toolData = parsedPayload.toolData;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }
  if (isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0) {
    entry.taskId = payload.taskId;
  }
  if (isTaskActivity && typeof payload?.role === "string" && payload.role.length > 0) {
    entry.agentRole = payload.role;
  }
  if (
    isTaskActivity &&
    (payload?.taskType === "local_workflow" ||
      (typeof payload?.workflowName === "string" && payload.workflowName.length > 0))
  ) {
    entry.isWorkflowCoordinator = true;
  }
  if (isTaskActivity && payload && isBackgroundTaskActivity(payload)) {
    entry.isBackgroundTask = true;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * One CTA row per group (A1 design): "Kicked off N subagents".
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (entry.agentSpawn?.workflowId) {
    return `wf:${entry.agentSpawn.workflowId}`;
  }
  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }
  // No turn id means no batch signal at all: fall back to one group per
  // task. Unrelated turn-less spawns (separate fleets whose rows lost their
  // turn) must not collapse into one immortal "direct:no-turn" CTA
  // accumulating every agent the thread ever ran (review finding). Adapters
  // stamp spawn turns (Codex spawnTurnId; Claude rows ride real turns), so
  // this path is defensive.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by spawn group, not adjacency: a workflow run (or
  // a turn's batch of direct spawns) is ONE narrative event in the chat — a
  // CTA row that opens the Agents panel — no matter how many agents it
  // contains or how their progress rows interleave (quiet-timeline
  // guarantee).
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId.
  // Claude background subagents settle between turns, so their completion
  // rows carry fresh synthetic turn ids (or none) — keying each row by its
  // own turn splintered one batch into a stream of "Kicked off N subagents"
  // rows (live-test finding, thread 7ac7ef05).
  const groupKeyByTaskId = new Map<string, string>();
  const toolLifecycleRowIndex = new Map<string, number>();
  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.activityKind === "task.started" ||
        entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed");
    if (isTaskRow && entry.taskId !== undefined) {
      const rememberedKey = groupKeyByTaskId.get(entry.taskId);
      const groupKey = rememberedKey ?? agentSpawnGroupKey(entry);
      if (rememberedKey === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }
      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;
        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];
        collapsed[existingIndex] = {
          ...mergeDerivedWorkLogEntries(existing, entry),
          // The CTA row keeps the group's ANCHOR identity, not the last
          // agent's: id/createdAt/turnId stay pinned to the spawn point so
          // the row renders where the run launched instead of drifting to
          // the newest progress tick (mid-run it drifted below the whole
          // conversation, reading as "no visualization"), and the stable id
          // keeps React state/virtualization sane.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds },
        };
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({
        ...entry,
        agentSpawn: { workflowId, agentTaskIds: [entry.taskId] },
      });
      continue;
    }
    const lifecycleKey = entry.collapseKey;
    if (lifecycleKey !== undefined) {
      const matchingLifecycleIndex = toolLifecycleRowIndex.get(lifecycleKey);
      const matchingEntry =
        matchingLifecycleIndex === undefined ? undefined : collapsed[matchingLifecycleIndex];
      if (
        matchingLifecycleIndex !== undefined &&
        matchingEntry &&
        shouldCollapseToolLifecycleEntries(matchingEntry, entry)
      ) {
        collapsed[matchingLifecycleIndex] = mergeDerivedWorkLogEntries(matchingEntry, entry);
        continue;
      }
      toolLifecycleRowIndex.delete(lifecycleKey);
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const previousIndex = collapsed.length - 1;
      if (previous.collapseKey !== undefined) {
        toolLifecycleRowIndex.delete(previous.collapseKey);
      }
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[previousIndex] = merged;
      if (merged.collapseKey !== undefined) {
        toolLifecycleRowIndex.set(merged.collapseKey, previousIndex);
      }
      continue;
    }
    collapsed.push(entry);
    if (lifecycleKey !== undefined) {
      toolLifecycleRowIndex.set(lifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function dedupeSubagentChildWorkEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const lastIndexByChildActivityKey = new Map<string, number>();
  const childByActivityKey = new Map<string, SubagentWorkLogChild>();

  for (const [index, entry] of entries.entries()) {
    if (entry.itemType !== "collab_agent_tool_call" || !entry.subagentChildren?.length) {
      continue;
    }
    for (const child of entry.subagentChildren) {
      const activityScope = child.parentItemId ?? entry.turnId ?? "";
      const key = `${child.threadId}:${activityScope}`;
      const existing = childByActivityKey.get(key);
      childByActivityKey.set(key, {
        threadId: child.threadId,
        ...(child.parentItemId ? { parentItemId: child.parentItemId } : {}),
        ...((existing?.titleSeed ?? child.titleSeed)
          ? { titleSeed: existing?.titleSeed ?? child.titleSeed }
          : {}),
      });
      lastIndexByChildActivityKey.set(key, index);
    }
  }

  return entries.flatMap((entry, index) => {
    if (entry.itemType !== "collab_agent_tool_call" || !entry.subagentChildren?.length) {
      return [entry];
    }
    const retainedChildren: SubagentWorkLogChild[] = [];
    const retainedKeys = new Set<string>();
    for (const child of entry.subagentChildren) {
      const activityScope = child.parentItemId ?? entry.turnId ?? "";
      const key = `${child.threadId}:${activityScope}`;
      if (retainedKeys.has(key) || lastIndexByChildActivityKey.get(key) !== index) {
        continue;
      }
      retainedKeys.add(key);
      retainedChildren.push(childByActivityKey.get(key) ?? child);
    }
    if (retainedChildren.length === 0) {
      return [];
    }
    return [
      {
        ...entry,
        subagentChildren: retainedChildren,
      },
    ];
  });
}

function isEmptySubagentWorkLogEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    entry.itemType === "collab_agent_tool_call" &&
    !entry.detail &&
    !entry.subagentPrompt &&
    !entry.output &&
    (entry.subagentChildren?.length ?? 0) === 0
  );
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
    return false;
  }
  const isLateSubagentOutput =
    previous.activityKind === "tool.completed" &&
    next.activityKind === "tool.updated" &&
    previous.itemType === "collab_agent_tool_call" &&
    next.itemType === "collab_agent_tool_call";
  if (
    previous.turnId !== next.turnId ||
    (previous.activityKind === "tool.completed" && !isLateSubagentOutput)
  ) {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const itemType = next.itemType ?? previous.itemType;
  const detail =
    itemType === "collab_agent_tool_call"
      ? (previous.detail ?? next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const output =
    itemType === "collab_agent_tool_call"
      ? mergeTextOutputChunk(previous.output, next.output)
      : mergeCumulativeOutput(previous.output, next.output, next.activityKind);
  const stdout = mergeCumulativeOutput(previous.stdout, next.stdout, next.activityKind);
  const stderr = mergeCumulativeOutput(previous.stderr, next.stderr, next.activityKind);
  const exitCode = next.exitCode ?? previous.exitCode;
  const durationMs = next.durationMs ?? previous.durationMs;
  const patch = mergeCumulativePatch(previous.patch, next.patch);
  const subagentPrompt =
    itemType === "collab_agent_tool_call"
      ? (previous.subagentPrompt ?? next.subagentPrompt)
      : (next.subagentPrompt ?? previous.subagentPrompt);
  const subagentChildren =
    itemType === "collab_agent_tool_call"
      ? mergeSubagentChildren(previous.subagentChildren, next.subagentChildren)
      : (next.subagentChildren ?? previous.subagentChildren);
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const requestKind = next.requestKind ?? previous.requestKind;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  const commandOutputActivityIds = [
    ...new Set([
      ...(previous.commandOutputActivityIds ??
        (previous.commandOutputAvailable ? [previous.id] : [])),
      ...(next.commandOutputActivityIds ?? (next.commandOutputAvailable ? [next.id] : [])),
    ]),
  ];
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(output ? { output } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(patch ? { patch } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(subagentPrompt ? { subagentPrompt } : {}),
    ...(subagentChildren && subagentChildren.length > 0 ? { subagentChildren } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
    ...(commandOutputActivityIds.length > 0
      ? { commandOutputAvailable: true, commandOutputActivityIds }
      : {}),
  };
}

function mergeSubagentChildren(
  previous: ReadonlyArray<SubagentWorkLogChild> | undefined,
  next: ReadonlyArray<SubagentWorkLogChild> | undefined,
): ReadonlyArray<SubagentWorkLogChild> | undefined {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  const byChildActivity = new Map<string, SubagentWorkLogChild>();
  for (const child of merged) {
    const key = `${child.threadId}:${child.parentItemId ?? ""}`;
    const existing = byChildActivity.get(key);
    const titleSeed = existing?.titleSeed ?? child.titleSeed;
    byChildActivity.set(key, {
      threadId: child.threadId,
      ...(child.parentItemId ? { parentItemId: child.parentItemId } : {}),
      ...(titleSeed ? { titleSeed } : {}),
    });
  }
  return [...byChildActivity.values()];
}

function mergeTextOutputChunk(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return `${previous}${next}`;
}
function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  // Subagent lifecycle rows collapse by agent identity: one row per agent,
  // progress ticks fold into it, the terminal row wins the label.
  if (
    entry.taskId &&
    (entry.activityKind === "task.progress" || entry.activityKind === "task.completed")
  ) {
    return `task${entry.taskId}`;
  }
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? entry.command?.trim() ?? entry.rawCommand?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstRawStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function extractSubagentOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  return firstRawStringFromRecord(rawOutput, ["content", "output", "text", "stdout", "result"]);
}

function extractSubagentToolCallId(payload: Record<string, unknown> | null): string | null {
  if (payload?.itemType !== "collab_agent_tool_call") return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const parentCollab = asRecord(data?.parentCollab);
  return (
    asTrimmedString(data?.toolCallId) ??
    asTrimmedString(parentCollab?.itemId) ??
    asTrimmedString(data?.itemId) ??
    asTrimmedString(item?.id)
  );
}

function extractSubagentPrompt(
  payload: Record<string, unknown> | null,
  fallbackDetail: string | null,
): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const rawInput = asRecord(data?.rawInput);
  const parentCollab = asRecord(data?.parentCollab);
  return (
    asTrimmedString(parentCollab?.detail) ??
    firstStringFromRecord(itemInput, ["prompt", "message", "description", "task"]) ??
    firstStringFromRecord(rawInput, ["prompt", "message", "description", "task"]) ??
    firstStringFromRecord(item, ["prompt", "message", "description", "task"]) ??
    fallbackDetail
  );
}

function extractSubagentChildren(
  payload: Record<string, unknown> | null,
): ReadonlyArray<SubagentWorkLogChild> {
  const data = asRecord(payload?.data);
  const children = Array.isArray(data?.subagentChildren) ? data.subagentChildren : [];
  const result: SubagentWorkLogChild[] = [];
  const seen = new Set<string>();
  for (const value of children) {
    const record = asRecord(value);
    const rawThreadId = asTrimmedString(record?.childThreadId) ?? asTrimmedString(record?.threadId);
    if (!rawThreadId) {
      continue;
    }
    const titleSeed = asTrimmedString(record?.titleSeed);
    const parentItemId = asTrimmedString(record?.parentItemId);
    const key = `${rawThreadId}:${parentItemId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      threadId: ThreadId.make(rawThreadId),
      ...(parentItemId ? { parentItemId } : {}),
      ...(titleSeed ? { titleSeed } : {}),
    });
  }
  return result;
}
function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  if (shouldPreserveSameTimestampToolUpdateOrder(left, right)) {
    return 0;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

function shouldPreserveSameTimestampToolUpdateOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): boolean {
  if (left.kind !== "tool.updated" || right.kind !== "tool.updated") {
    return false;
  }
  const leftIdentity = extractWorkLogActivityIdentity(left.payload);
  const rightIdentity = extractWorkLogActivityIdentity(right.payload);
  if (leftIdentity.toolCallId && rightIdentity.toolCallId) {
    return leftIdentity.toolCallId === rightIdentity.toolCallId;
  }
  return (
    (leftIdentity.itemType != null || leftIdentity.title !== null) &&
    leftIdentity.itemType === rightIdentity.itemType &&
    leftIdentity.title === rightIdentity.title
  );
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  turnPlans: ReadonlyArray<TurnPlanEntry> = [],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const turnPlanRows: TimelineEntry[] = turnPlans.map((turnPlan) => ({
    id: turnPlan.id,
    kind: "turn-plan",
    createdAt: turnPlan.createdAt,
    turnPlan,
  }));
  const workRows: TimelineEntry[] = workEntries
    // Persisted child-reference events remain available to lineage, title,
    // and routing consumers, but upstream's agentSpawn CTA is the sole
    // parent-timeline visualization for subagent work.
    .filter(
      (entry) =>
        entry.itemType !== "collab_agent_tool_call" || (entry.subagentChildren?.length ?? 0) === 0,
    )
    .map((entry) => ({
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    }));
  return [...messageRows, ...proposedPlanRows, ...turnPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: ReadonlyArray<TurnDiffSummary>,
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (
    !session ||
    session.status === "stopped" ||
    session.status === "interrupted" ||
    session.status === "error"
  ) {
    return "disconnected";
  }
  if (session.status === "starting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

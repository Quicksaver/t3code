import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  type ActiveMagiRunSummary,
  type EnvironmentId,
  isMagiRunTerminal,
  type MagiArbitrationStance,
  type MagiBallot,
  type MagiRunConfig,
  type MagiRunDetail,
  type MagiRunId,
  type MagiListRunsResult,
  type MagiRunSummary,
  type MagiRunState,
  magiParticipantVoteWeights,
  type ProviderDriverKind,
  type ServerProvider,
  type ThreadId,
  type UnifiedSettings,
  validateMagiRoster,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ChevronDown,
  Network,
  Plus,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { magiEnvironment } from "~/state/magi";
import { threadEnvironment } from "~/state/threads";
import { useThreadDetail } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Slider } from "~/components/ui/slider";
import { cn } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { ComposerPendingApprovalActions } from "~/components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "~/components/chat/ComposerPendingApprovalPanel";
import { derivePendingApprovals, formatDuration } from "~/session-logic";

import {
  addDefaultMagiParticipant,
  exactDuplicateMagiParticipants,
  formatMagiRunMetadata,
  initialMagiConfig,
  MAGI_PANEL_MAX_THRESHOLD_PERCENT,
  MAGI_PANEL_MIN_THRESHOLD_PERCENT,
  MAGI_TURN_LIMIT_SLIDER_VALUES,
  makeWebMagiParticipantId,
  magiParticipantIndicator,
  magiRunElapsedMs,
  magiTurnLimitFromSliderIndex,
  magiTurnLimitSliderIndex,
  magiWeightSummary,
  type MagiParticipantIndicator,
  moveMagiParticipant,
  normalizeMagiPanelConfig,
  preferredMagiRunForAutomaticExpansion,
} from "./MagiPanel.logic";

const inputClass =
  "h-8 rounded-md border border-transparent bg-transparent px-2 text-sm outline-none hover:bg-muted/60 focus:border-border focus:ring-2 focus:ring-ring disabled:cursor-default disabled:opacity-100";

function withOccurrenceKeys<T>(items: ReadonlyArray<T>, identify: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const identity = identify(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { item, key: `${identity}:${occurrence}` };
  });
}

const participantStatus = (indicator: MagiParticipantIndicator, label: string) => {
  switch (indicator) {
    case "neutral":
      return { label, className: "text-muted-foreground", Icon: Circle };
    case "working":
      return { label, className: "text-info-foreground", Icon: CircleDashed };
    case "warning":
      return { label, className: "text-warning", Icon: TriangleAlert };
    case "supports":
      return { label, className: "text-success-foreground", Icon: CircleCheck };
    case "opposes":
      return { label, className: "text-destructive", Icon: CircleX };
    case "abstained":
      return { label, className: "text-muted-foreground", Icon: CircleMinus };
  }
};

export function ParticipantStatusLight(props: {
  readonly indicator: MagiParticipantIndicator;
  readonly label: string;
}) {
  const status = participantStatus(props.indicator, props.label);
  const StatusIcon = status.Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex size-5 shrink-0 items-center justify-center"
            role="img"
            aria-label={`Participant status: ${status.label}`}
          >
            <StatusIcon className={cn("size-4", status.className)} aria-hidden="true" />
          </span>
        }
      />
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

const magiRunVisualState = (state: MagiRunState) => {
  if (!isMagiRunTerminal(state)) {
    const labels: Record<MagiRunState, string> = {
      initializing: "Initializing",
      "awaiting-main-tool": "Awaiting main agent",
      deliberating: "Deliberating",
      "awaiting-arbitration": "Awaiting arbitration",
      "awaiting-actions": "Awaiting actions",
      "awaiting-next-turn": "Awaiting next turn",
      "awaiting-main-approval": "Awaiting approval",
      "awaiting-main-input": "Awaiting input",
      "awaiting-action-reconciliation": "Awaiting action review",
      paused: "Paused",
      cancelling: "Cancelling",
      succeeded: "Consensus reached",
      "turn-limit-reached": "Failed to reach consensus",
      cancelled: "Cancelled",
      failed: "Failed",
    };
    return {
      label: labels[state],
      className: state === "paused" ? "text-muted-foreground" : "text-info-foreground",
      iconState: state === "paused" ? ("idle" as const) : ("running" as const),
    };
  }
  if (state === "succeeded") {
    return {
      label: "Consensus reached",
      className: "text-success-foreground",
      iconState: "succeeded" as const,
    };
  }
  return {
    label:
      state === "turn-limit-reached"
        ? "Failed to reach consensus"
        : state === "cancelled"
          ? "Cancelled"
          : "Failed",
    className: "text-destructive",
    iconState: "failed" as const,
  };
};

type MagiRunIconState = "idle" | "running" | "succeeded" | "failed";

export function MagiRunStatusIcon(props: {
  readonly state: MagiRunIconState;
  readonly label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="relative inline-flex size-5 shrink-0 items-center justify-center"
            role="img"
            aria-label={`Magi run status: ${props.label}`}
          >
            {props.state === "running" ? (
              <>
                <CircleDashed className="absolute size-5 text-info-foreground" aria-hidden="true" />
                <Network className="size-3 text-info-foreground" aria-hidden="true" />
              </>
            ) : (
              <Network
                className={cn(
                  "size-4",
                  props.state === "idle" && "text-muted-foreground",
                  props.state === "succeeded" && "text-success-foreground",
                  props.state === "failed" && "text-destructive",
                )}
                aria-hidden="true"
              />
            )}
          </span>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function MagiRunListItem(props: {
  readonly run: MagiRunSummary;
  readonly expanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const status = magiRunVisualState(props.run.state);
  const metadataCopy = formatMagiRunMetadata(props.run).join(" · ");

  return (
    <div className="rounded-xl">
      <button
        type="button"
        className="flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-sidebar-row-hover"
        aria-expanded={props.expanded}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <MagiRunStatusIcon state={status.iconState} label={status.label} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{props.run.title.title}</span>
            <span className={cn("shrink-0", status.className)}>{status.label}</span>
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground/80">
            {metadataCopy}
          </span>
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", props.expanded && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      <Collapsible open={props.expanded} onOpenChange={props.onExpandedChange}>
        <CollapsibleContent>{props.children}</CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function NewMagiRunListItem(props: {
  readonly participantCount: number;
  readonly turnLimit: number | null;
  readonly expanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-xl">
      <button
        type="button"
        className="flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-sidebar-row-hover"
        aria-expanded={props.expanded}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <MagiRunStatusIcon state="idle" label="Idle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">New</span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground/80">
            {props.participantCount} participant{props.participantCount === 1 ? "" : "s"} ·{" "}
            {props.turnLimit === null ? "Unlimited turns" : `${props.turnLimit}-turn limit`}
          </span>
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", props.expanded && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      <Collapsible open={props.expanded} onOpenChange={props.onExpandedChange}>
        <CollapsibleContent>{props.children}</CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ParticipantPendingApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const activities =
    useThreadDetail(scopeThreadRef(props.environmentId, props.threadId))?.activities ?? [];
  const approvals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const active = approvals[0] ?? null;
  const [responding, setResponding] = useState(false);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  if (!active) return null;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-warning/40 bg-warning/5">
      <ComposerPendingApprovalPanel approval={active} pendingCount={approvals.length} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 px-4 py-3">
        <ComposerPendingApprovalActions
          requestId={active.requestId}
          isResponding={responding}
          onRespondToApproval={async (requestId, decision) => {
            setResponding(true);
            const result = await respond({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, requestId, decision },
            });
            setResponding(false);
            return result;
          }}
        />
      </div>
    </div>
  );
}

function ParticipantWarnings(props: { readonly duplicate: boolean }) {
  return (
    <span className="flex h-5 min-w-5 shrink-0 items-center justify-end gap-1">
      {props.duplicate ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex size-5 items-center justify-center text-warning"
                role="img"
                aria-label="Exact duplicate detected"
              >
                <TriangleAlert className="size-3.5" aria-hidden="true" />
              </span>
            }
          />
          <TooltipPopup side="top">Exact duplicate detected</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

function participantCardClass(duplicate: boolean, readOnly = false) {
  return cn(
    "group rounded-lg border",
    readOnly ? "space-y-1 py-1" : "space-y-1 py-1 transition-colors",
    duplicate ? "border-warning/70 outline outline-1 outline-warning/25" : "border-transparent",
  );
}

function ReadonlyParticipantCard(props: {
  readonly environmentId: EnvironmentId;
  readonly participant: MagiRunDetail["participants"][number];
  readonly runState: MagiRunState;
  readonly finalStance: MagiArbitrationStance | null;
  readonly finalBallot: MagiBallot | null;
  readonly duplicate: boolean;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly settings: UnifiedSettings;
}) {
  const personality = props.participant.personality?.name ?? "No personality";
  const activeEntry = props.instanceEntries.find(
    (candidate) => candidate.instanceId === props.participant.modelSelection.instanceId,
  );
  const participantState = props.participant.state;
  const visualState =
    props.runState === "cancelled" &&
    (participantState === "pending" || participantState === "running")
      ? "cancelled"
      : participantState;
  const indicator = magiParticipantIndicator({
    runState: props.runState,
    memberState: visualState,
    finalStance: props.finalStance,
    finalBallot: props.finalBallot,
  });
  const indicatorLabel =
    indicator === "supports"
      ? "Voted for consensus"
      : indicator === "opposes"
        ? "Voted against consensus"
        : indicator === "abstained"
          ? "Abstained"
          : indicator === "warning"
            ? props.finalStance === "unclear"
              ? "No valid final vote"
              : visualState.replaceAll("-", " ")
            : indicator === "working"
              ? "Working"
              : visualState === "pending"
                ? "Waiting"
                : "Finished";
  return (
    <div className={participantCardClass(props.duplicate, true)}>
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1">
        <ParticipantStatusLight indicator={indicator} label={indicatorLabel} />
        <ProviderModelPicker
          activeInstanceId={props.participant.modelSelection.instanceId}
          model={props.participant.modelSelection.model}
          lockedProvider={null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={props.modelOptionsByInstance}
          disabled
          triggerVariant="ghost"
          triggerClassName="pointer-events-none h-7 min-h-7 w-fit max-w-full shrink justify-start px-1.5 text-sm text-foreground disabled:opacity-100 [&_svg[data-composer-control-chevron]]:hidden"
          triggerAriaLabel="Participant provider and model"
          onInstanceModelChange={() => {}}
        />
        {activeEntry ? (
          <TraitsPicker
            provider={activeEntry.driverKind as ProviderDriverKind}
            instanceId={activeEntry.instanceId}
            models={activeEntry.models}
            model={props.participant.modelSelection.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={props.participant.modelSelection.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={props.settings.planModeEnabled}
            disabled
            triggerVariant="ghost"
            triggerClassName="pointer-events-none h-7 min-h-7 w-fit max-w-full shrink justify-start px-1.5 text-sm text-foreground disabled:opacity-100 [&_svg[data-composer-control-chevron]]:hidden"
            triggerAriaLabel="Participant reasoning and model options"
            onModelOptionsChange={() => {}}
          />
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          <ParticipantWarnings duplicate={props.duplicate} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1 pl-[1.5rem]">
        <span className="min-w-0 truncate px-1.5 text-sm text-foreground">{personality}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
          Weight
          <span className="min-w-6 text-right text-foreground">{props.participant.weight}</span>
        </span>
      </div>
      {props.participant.childThreadId ? (
        <ParticipantPendingApproval
          environmentId={props.environmentId}
          threadId={props.participant.childThreadId}
        />
      ) : null}
    </div>
  );
}

function RunDetailView(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: MagiRunId;
  readonly includeDiagnostics: boolean;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly settings: UnifiedSettings;
}) {
  const detailTarget = {
    environmentId: props.environmentId,
    input: { runId: props.runId, includeDiagnostics: props.includeDiagnostics },
  };
  const detailResult = useAtomValue(magiEnvironment.detail(detailTarget));
  const detail = Option.getOrNull(AsyncResult.value(detailResult));
  const cancel = useAtomCommand(magiEnvironment.cancelRun, { reportFailure: false });
  const continueRun = useAtomCommand(magiEnvironment.continueRun, { reportFailure: false });
  const reconcile = useAtomCommand(magiEnvironment.reconcileActions, { reportFailure: false });
  const [stopConfirmationOpen, setStopConfirmationOpen] = useState(false);
  const [elapsedClockMs, setElapsedClockMs] = useState(() => Date.now());

  useEffect(() => {
    if (!detail || isMagiRunTerminal(detail.summary.state)) return;
    setElapsedClockMs(Date.now());
    const timer = window.setInterval(() => setElapsedClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [detail?.summary.startedAt, detail?.summary.state]);

  if (!detail) {
    return <p className="p-5 text-sm text-muted-foreground">Loading Magi run…</p>;
  }

  const duplicates = exactDuplicateMagiParticipants(detail.config.participants);
  const terminal = isMagiRunTerminal(detail.summary.state);
  const elapsedMs = magiRunElapsedMs(detail.summary, elapsedClockMs);
  const candidateVoteWeights = magiParticipantVoteWeights(
    detail.config.participants,
    detail.finalParticipantVotes,
  );
  const batch = detail.issuedActionBatch;
  const submitReconciliation = (status: "completed" | "not-completed" | "unknown") => {
    if (!batch) return;
    void reconcile({
      environmentId: props.environmentId,
      input: {
        runId: props.runId,
        batchId: batch.batchId,
        actions: batch.actions.map((action) => ({
          ...action,
          status,
          details:
            status === "completed"
              ? "Confirmed completed by the user during Magi reconciliation."
              : status === "not-completed"
                ? "Confirmed not completed by the user during Magi reconciliation."
                : "The user could not confirm the action outcome.",
          unforeseenConsequence: null,
        })),
      },
    });
  };

  return (
    <section className="space-y-3 px-5 pb-5 pt-2" aria-live="polite">
      <div className="rounded-md border border-border p-3 text-sm">
        <p className="font-medium">{detail.summary.state.replaceAll("-", " ")}</p>
        <p className="mt-1 text-muted-foreground">
          Started by {detail.summary.source === "user-arm" ? "User" : "Agent"} ·{" "}
          {detail.summary.completedMagiTurns}
          {detail.config.magiTurnLimit === null ? "" : `/${detail.config.magiTurnLimit}`} turns ·{" "}
          {formatDuration(elapsedMs)} elapsed
        </p>
        <p className="mt-2">{detail.summary.objective ?? "No focused objective."}</p>
      </div>
      <div className="space-y-1">
        {detail.participants.map((participant) => {
          const finalVote =
            detail.finalParticipantVotes?.find(
              (vote) => vote.participantId === participant.participantId,
            ) ?? null;
          return (
            <ReadonlyParticipantCard
              key={participant.participantId}
              environmentId={props.environmentId}
              participant={participant}
              runState={detail.summary.state}
              finalStance={finalVote?.stance ?? null}
              finalBallot={finalVote?.ballot ?? null}
              duplicate={duplicates.has(participant.participantId)}
              instanceEntries={props.instanceEntries}
              modelOptionsByInstance={props.modelOptionsByInstance}
              settings={props.settings}
            />
          );
        })}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div>
          <label className="flex items-center gap-3 text-sm">
            <span className="shrink-0">Consensus threshold</span>
            <Slider
              aria-label="Consensus threshold"
              className="min-w-24 flex-1"
              min={MAGI_PANEL_MIN_THRESHOLD_PERCENT}
              max={MAGI_PANEL_MAX_THRESHOLD_PERCENT}
              step={1}
              value={detail.config.consensusThresholdPercent}
              disabled
            />
            <output className="w-12 text-right font-mono text-xs font-medium tabular-nums">
              {detail.config.consensusThresholdPercent}%
            </output>
          </label>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.activity.leadingAgreementWeight ?? 0}/{detail.totalWeight} agreed weight ·{" "}
            {detail.requiredWeight} needed for consensus.
          </p>
        </div>
        <div>
          <label className="flex items-center gap-3 text-sm">
            <span className="shrink-0">Turn limit</span>
            <Slider
              aria-label="Turn limit"
              className="min-w-24 flex-1"
              min={0}
              max={MAGI_TURN_LIMIT_SLIDER_VALUES.length - 1}
              step={1}
              value={magiTurnLimitSliderIndex(detail.config.magiTurnLimit)}
              disabled
            />
            <output className="w-16 text-right font-mono text-xs font-medium tabular-nums">
              {detail.config.magiTurnLimit ?? "Unlimited"}
            </output>
          </label>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.config.magiTurnLimit === null
              ? "Unlimited turns. Provider cost is unbounded."
              : `${detail.config.participants.length * detail.config.magiTurnLimit} base participant turns; up to ${detail.config.participants.length * detail.config.magiTurnLimit * 3} provider attempts with retries and repairs.`}
          </p>
        </div>
      </div>
      {detail.candidate ? (
        <div className="rounded-md border border-border p-3">
          <p className="font-medium text-sm">Current candidate</p>
          <p className="mt-1 text-sm">{detail.candidate.conclusion}</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5 text-success-foreground">
              <CircleCheck className="size-3.5" aria-hidden="true" />
              {candidateVoteWeights.agreedWeight} agreed vote
              {candidateVoteWeights.agreedWeight === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <CircleX className="size-3.5" aria-hidden="true" />
              {candidateVoteWeights.opposedWeight} opposed vote
              {candidateVoteWeights.opposedWeight === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      ) : null}

      {detail.summary.state === "awaiting-action-reconciliation" && batch ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="font-medium text-xs">Issued actions</p>
          {batch.actions.map((action) => (
            <p key={action.actionId} className="text-xs text-muted-foreground">
              {action.summary} · {action.obligation}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => submitReconciliation("completed")}>
              All completed
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => submitReconciliation("not-completed")}
            >
              Not completed
            </Button>
            <Button size="sm" variant="outline" onClick={() => submitReconciliation("unknown")}>
              Outcome unknown
            </Button>
          </div>
        </div>
      ) : null}

      {!terminal ? (
        <div className="flex flex-wrap gap-2">
          {detail.summary.state === "paused" ? (
            <Button
              size="sm"
              onClick={() =>
                void continueRun({
                  environmentId: props.environmentId,
                  input: { runId: props.runId },
                })
              }
            >
              Continue Magi
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setStopConfirmationOpen(true)}>
            <Square className="size-3" /> Stop Magi
          </Button>
        </div>
      ) : null}

      <AlertDialog open={stopConfirmationOpen} onOpenChange={setStopConfirmationOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this Magi run?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops every active participant and ends the run. A stopped Magi run cannot be
              resumed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep running</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setStopConfirmationOpen(false);
                void cancel({
                  environmentId: props.environmentId,
                  input: { runId: props.runId },
                });
              }}
            >
              Stop Magi
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {detail.magiTurns && detail.magiTurns.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Turn evidence</summary>
          <div className="mt-2 space-y-2">
            {detail.magiTurns.map((turn) => (
              <div key={turn.magiTurn} className="rounded-md bg-muted/20 p-2 text-[11px]">
                <p className="font-medium">Turn {turn.magiTurn}</p>
                <p className="mt-1 text-muted-foreground">
                  {turn.settlements.length} responses · {turn.activities.length} referenced tool
                  activities · {turn.arbitration ? "arbitrated" : "awaiting arbitration"}
                </p>
                {withOccurrenceKeys(
                  turn.arbitration?.disagreements ?? [],
                  (disagreement) => disagreement,
                ).map(({ item, key }) => (
                  <p key={`${turn.magiTurn}:dissent:${key}`} className="mt-1">
                    Dissent: {item}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {detail.proposals && detail.proposals.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Proposal records</summary>
          <div className="mt-2 space-y-2">
            {detail.proposals.map((proposal) => (
              <div key={proposal.proposalId} className="rounded-md bg-muted/20 p-2 text-[11px]">
                <p className="font-medium">{proposal.proposal.change}</p>
                <p className="mt-1 text-muted-foreground">{proposal.proposal.rationale}</p>
                <p className="mt-1 text-muted-foreground">
                  {proposal.decision} · {proposal.approvalWeight} approval weight ·{" "}
                  {proposal.rejectionWeight} rejection weight · {proposal.integration}
                </p>
                <p className="mt-1 whitespace-pre-wrap">
                  {(detail.magiTurns ?? [])
                    .flatMap((turn) =>
                      turn.settlements.flatMap((settlement) =>
                        (settlement.parsed?.proposalEvaluations ?? [])
                          .filter((evaluation) => evaluation.proposalId === proposal.proposalId)
                          .map(
                            (evaluation) =>
                              `${settlement.participantId}: ${evaluation.ballot} · ${evaluation.rationale}`,
                          ),
                      ),
                    )
                    .join("\n")}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {detail.actions.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Action records</summary>
          <div className="mt-2 space-y-2">
            {detail.actions.map((action) => (
              <div key={action.actionId} className="rounded-md bg-muted/20 p-2 text-[11px]">
                <p className="font-medium">{action.summary}</p>
                <p className="mt-1 text-muted-foreground">
                  {action.status} · {action.obligation} · {action.details}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {props.includeDiagnostics ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">
            Run details and diagnostics
          </summary>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Participant transcripts, proposal records, and turn evidence used to audit the decision.
          </p>
          <div className="mt-3 space-y-2">
            {detail.initialPrompt ? (
              <details className="rounded-md border border-border p-2">
                <summary className="cursor-pointer text-xs font-medium">Initial prompt</summary>
                <p className="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {detail.initialPrompt}
                </p>
              </details>
            ) : null}
            <details className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-xs font-medium">
                Participant transcripts
              </summary>
              <div className="mt-2 space-y-2">
                {detail.magiTurns?.map((turn) => (
                  <details key={turn.magiTurn} className="rounded-md border border-border p-2">
                    <summary className="cursor-pointer text-xs font-medium">
                      Turn {turn.magiTurn}
                    </summary>
                    <div className="mt-2 space-y-1.5">
                      {turn.settlements.map((settlement) => {
                        const participant = detail.participants.find(
                          (candidate) => candidate.participantId === settlement.participantId,
                        );
                        return (
                          <details
                            key={settlement.participantTurnId}
                            className="rounded-md border border-border p-2"
                          >
                            <summary className="cursor-pointer text-[11px]">
                              {participant?.modelSelection.model ?? settlement.participantId} ·{" "}
                              {participant?.personality?.name ?? "Default"}
                            </summary>
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              {settlement.contextCompressed ? "Context compressed · " : ""}
                              {settlement.durationMs} ms · {settlement.inputTokens ?? "unknown"}{" "}
                              input tokens · {settlement.parseMode} response
                            </p>
                            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[11px] text-muted-foreground">
                              {settlement.rawText || "No participant transcript was returned."}
                            </pre>
                          </details>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
            </details>

            <details className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-xs font-medium">Turn evidence</summary>
              <div className="mt-2 space-y-2">
                {detail.magiTurns?.map((turn) => (
                  <details key={turn.magiTurn} className="rounded-md border border-border p-2">
                    <summary className="cursor-pointer text-xs">Turn {turn.magiTurn}</summary>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {turn.settlements.length} responses · {turn.activities.length} referenced tool
                      activities · {turn.arbitration ? "arbitrated" : "awaiting arbitration"}
                    </p>
                    {turn.activities.map((activity) => (
                      <div key={activity.activityId} className="mt-2 text-[11px]">
                        <p className="font-medium">{activity.kind}</p>
                        <p className="text-muted-foreground">{activity.summary}</p>
                      </div>
                    ))}
                    {withOccurrenceKeys(
                      turn.arbitration?.disagreements ?? [],
                      (disagreement) => disagreement,
                    ).map(({ item, key }) => (
                      <p
                        key={`${turn.magiTurn}:diagnostic-dissent:${key}`}
                        className="mt-1 text-[11px]"
                      >
                        Dissent: {item}
                      </p>
                    ))}
                  </details>
                ))}
              </div>
            </details>

            <details className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-xs font-medium">Proposal records</summary>
              <div className="mt-2 space-y-2">
                {detail.proposals?.map((proposal) => {
                  const evaluations =
                    detail.magiTurns?.flatMap((turn) =>
                      turn.settlements.flatMap((settlement) =>
                        (settlement.parsed?.proposalEvaluations ?? [])
                          .filter((evaluation) => evaluation.proposalId === proposal.proposalId)
                          .map((evaluation) => ({
                            ...evaluation,
                            magiTurn: turn.magiTurn,
                            participantId: settlement.participantId,
                          })),
                      ),
                    ) ?? [];
                  return (
                    <details
                      key={proposal.proposalId}
                      className="rounded-md border border-border p-2"
                    >
                      <summary className="flex min-w-0 cursor-pointer items-center gap-2 text-xs">
                        {proposal.decision === "rejected" ||
                        proposal.integration === "action-impeded" ||
                        proposal.integration === "omitted" ? (
                          <CircleX
                            className="size-3.5 shrink-0 text-destructive"
                            aria-label="Rejected or not integrated"
                          />
                        ) : proposal.decision === "accepted" ? (
                          <CircleCheck
                            className="size-3.5 shrink-0 text-success-foreground"
                            aria-label="Accepted"
                          />
                        ) : null}
                        <span className="shrink-0 font-medium">{proposal.proposal.kind}</span>
                        <span className="min-w-0 flex-1 truncate">{proposal.proposal.change}</span>
                      </summary>
                      <div className="mt-3 space-y-3 text-[11px]">
                        <div>
                          <p className="font-medium">Proposed change</p>
                          <p className="mt-1 whitespace-pre-wrap">{proposal.proposal.change}</p>
                        </div>
                        <div>
                          <p className="font-medium">Rationale</p>
                          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                            {proposal.proposal.rationale}
                          </p>
                        </div>
                        <div>
                          <p className="font-medium">Origin</p>
                          <p className="mt-1 text-muted-foreground">
                            Turn {proposal.firstMagiTurn} ·{" "}
                            {proposal.originParticipantIds
                              .map((participantId) => {
                                const participant = detail.participants.find(
                                  (candidate) => candidate.participantId === participantId,
                                );
                                return participant
                                  ? `${participant.modelSelection.model} · ${participant.personality?.name ?? "Default"}`
                                  : participantId;
                              })
                              .join(", ")}
                          </p>
                        </div>
                        <div>
                          <p className="font-medium">Decision</p>
                          <p className="mt-1 text-muted-foreground">
                            {proposal.decision} · turn {proposal.decisionMagiTurn ?? "not decided"}{" "}
                            · basis {proposal.decisionBasis} · integration {proposal.integration}
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            {proposal.approvalWeight} approval weight · {proposal.rejectionWeight}{" "}
                            rejection weight
                          </p>
                          {withOccurrenceKeys(evaluations, (evaluation) =>
                            JSON.stringify([
                              evaluation.magiTurn,
                              evaluation.participantId,
                              evaluation.ballot,
                              evaluation.rationale,
                            ]),
                          ).map(({ item: evaluation, key }) => {
                            const participant = detail.participants.find(
                              (candidate) => candidate.participantId === evaluation.participantId,
                            );
                            const weight = detail.config.participants.find(
                              (candidate) => candidate.participantId === evaluation.participantId,
                            )?.weight;
                            return (
                              <p key={key} className="mt-1">
                                {participant?.modelSelection.model ?? evaluation.participantId}:{" "}
                                {evaluation.ballot} · turn {evaluation.magiTurn}
                                {weight === undefined ? "" : ` · weight ${weight}`}
                              </p>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            </details>
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function MagiPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  isVisible: boolean;
  activeRun: ActiveMagiRunSummary | null;
  history: MagiListRunsResult | null;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  draftArm?: MagiRunConfig | null;
  onDraftArmChange?: (config: MagiRunConfig | null) => void;
}) {
  const target = { environmentId: props.environmentId, input: {} };
  const optionsResult = useAtomValue(magiEnvironment.options(target));
  const settingsResult = useAtomValue(magiEnvironment.settings(target));
  const armTarget = {
    environmentId: props.environmentId,
    input: { threadId: props.threadId },
  };
  const armResult = useAtomValue(magiEnvironment.arm(armTarget));
  const options = Option.getOrNull(AsyncResult.value(optionsResult));
  const settings = Option.getOrNull(AsyncResult.value(settingsResult));
  const serverArm = Option.getOrNull(AsyncResult.value(armResult));
  const serverArmLoaded = Option.isSome(AsyncResult.value(armResult));
  const history = props.history;
  const [config, setConfig] = useState<MagiRunConfig | null>(null);
  const [turnLimitSliderIndex, setTurnLimitSliderIndex] = useState(0);
  const [armed, setArmed] = useState(false);
  const [selectedView, setSelectedView] = useState<"new" | MagiRunId | null>(null);
  const armRevisionRef = useRef(0);
  const armSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSyncChainRef = useRef(Promise.resolve());
  const consumedActiveRunRef = useRef<MagiRunId | null>(null);
  const autoSelectedActiveRunRef = useRef<MagiRunId | null>(null);
  const initialSelectionCompleteRef = useRef(false);
  const wasVisibleRef = useRef(false);
  const arm = useAtomCommand(magiEnvironment.armThread, { reportFailure: false });
  const disarm = useAtomCommand(magiEnvironment.disarmThread, { reportFailure: false });

  useEffect(() => {
    setConfig(null);
    setSelectedView(null);
    autoSelectedActiveRunRef.current = null;
    initialSelectionCompleteRef.current = false;
    wasVisibleRef.current = false;
    consumedActiveRunRef.current = null;
    armRevisionRef.current = 0;
    setArmed(false);
  }, [props.threadId]);
  useEffect(() => {
    if (config === null && options && settings) {
      setConfig(normalizeMagiPanelConfig(props.draftArm ?? initialMagiConfig(options, settings)));
      setArmed(props.draftArm !== null && props.draftArm !== undefined);
    }
  }, [config, options, props.draftArm, settings]);
  useEffect(() => {
    if (!props.onDraftArmChange && serverArmLoaded) {
      if (serverArm === null) {
        armRevisionRef.current = 0;
        setArmed(false);
      } else if (serverArm.revision !== armRevisionRef.current) {
        setConfig(normalizeMagiPanelConfig(serverArm.config));
        armRevisionRef.current = serverArm.revision;
        setArmed(true);
      }
    }
  }, [props.onDraftArmChange, serverArm, serverArmLoaded]);
  useEffect(() => {
    if (!config) return;
    setTurnLimitSliderIndex((currentIndex) =>
      magiTurnLimitSliderIndex(config.magiTurnLimit, currentIndex),
    );
  }, [config?.magiTurnLimit]);
  useEffect(
    () => () => {
      if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
    },
    [],
  );

  const activeHistoryRuns = history?.runs.filter((run) => !isMagiRunTerminal(run.state)) ?? [];
  const preferredAutomaticRunId =
    preferredMagiRunForAutomaticExpansion(history?.runs ?? [], props.threadId, isMagiRunTerminal)
      ?.runId ?? null;
  const ownActiveRunId =
    activeHistoryRuns.find((run) => run.rootThreadId === props.threadId)?.runId ??
    props.activeRun?.runId ??
    null;
  const selectedRunUpdatedAt =
    selectedView === null || selectedView === "new"
      ? null
      : (history?.runs.find((run) => run.runId === selectedView)?.updatedAt ?? null);
  useEffect(() => {
    if (!props.isVisible || selectedView === null || selectedView === "new") return;
    appAtomRegistry.refresh(
      magiEnvironment.detail({
        environmentId: props.environmentId,
        input: {
          runId: selectedView,
          includeDiagnostics: settings?.showRunDetailsAndDiagnostics ?? false,
        },
      }),
    );
  }, [
    props.environmentId,
    props.isVisible,
    selectedRunUpdatedAt,
    selectedView,
    settings?.showRunDetailsAndDiagnostics,
  ]);
  useEffect(() => {
    if (!ownActiveRunId || consumedActiveRunRef.current === ownActiveRunId) return;
    consumedActiveRunRef.current = ownActiveRunId;
    if (armSyncTimerRef.current) {
      clearTimeout(armSyncTimerRef.current);
      armSyncTimerRef.current = null;
    }
    armRevisionRef.current = 0;
    setArmed(false);
    props.onDraftArmChange?.(null);
    appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
    appAtomRegistry.refresh(magiEnvironment.settings(target));
    appAtomRegistry.refresh(magiEnvironment.options(target));
  }, [ownActiveRunId, props.onDraftArmChange]);
  useEffect(() => {
    const becameVisible = props.isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = props.isVisible;
    if (!props.isVisible) return;
    if (
      preferredAutomaticRunId &&
      !isMagiRunTerminal(
        history?.runs.find((run) => run.runId === preferredAutomaticRunId)?.state ?? "failed",
      ) &&
      autoSelectedActiveRunRef.current !== preferredAutomaticRunId
    ) {
      autoSelectedActiveRunRef.current = preferredAutomaticRunId;
      setSelectedView(preferredAutomaticRunId);
      return;
    }
    if ((becameVisible || !initialSelectionCompleteRef.current) && history) {
      initialSelectionCompleteRef.current = true;
      setSelectedView(preferredAutomaticRunId ?? "new");
    }
  }, [history, preferredAutomaticRunId, props.isVisible]);

  const duplicates = useMemo(
    () => exactDuplicateMagiParticipants(config?.participants ?? []),
    [config?.participants],
  );
  const validationIssues = useMemo(() => (config ? validateMagiRoster(config) : []), [config]);
  const thresholdWarning =
    validationIssues.find((issue) => issue.reason === "draw-capable-threshold")?.message ?? null;
  const validationError =
    validationIssues.find((issue) => issue.reason !== "draw-capable-threshold")?.message ?? null;
  const weightSummary = config ? magiWeightSummary(config) : null;
  const hasPromptOnlyParticipant =
    config?.participants.some(
      (participant) =>
        options?.providerInstances.find(
          (provider) => provider.instanceId === participant.modelSelection.instanceId,
        )?.magi.readOnly === "prompt-only",
    ) ?? false;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(props.providers),
          props.settings,
        ),
      ),
    [props.providers, props.settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(props.settings, props.providers),
    [props.providers, props.settings],
  );

  const syncArmedConfig = (next: MagiRunConfig) => {
    if (!armed) return;
    const issues = validateMagiRoster(next);
    if (issues.length > 0) {
      if (props.onDraftArmChange) props.onDraftArmChange(null);
      else {
        void (async () => {
          const result = await disarm({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, expectedRevision: armRevisionRef.current },
          });
          if (result._tag === "Success") {
            armRevisionRef.current = 0;
            appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
          }
        })();
      }
      setArmed(false);
      return;
    }
    if (props.onDraftArmChange) {
      props.onDraftArmChange(next);
      return;
    }
    if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
    armSyncTimerRef.current = setTimeout(() => {
      armSyncTimerRef.current = null;
      armSyncChainRef.current = armSyncChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const result = await arm({
            environmentId: props.environmentId,
            input: {
              threadId: props.threadId,
              expectedRevision: armRevisionRef.current,
              config: next,
            },
          });
          if (result._tag === "Success") {
            armRevisionRef.current = result.value.revision;
            appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
            appAtomRegistry.refresh(magiEnvironment.settings(target));
            appAtomRegistry.refresh(magiEnvironment.options(target));
          }
        });
    }, 250);
  };
  const updateConfig = (next: MagiRunConfig) => {
    setConfig(next);
    syncArmedConfig(next);
  };
  const replaceParticipant = (
    participantId: string,
    update: (
      participant: MagiRunConfig["participants"][number],
    ) => MagiRunConfig["participants"][number],
  ) => {
    if (!config) return;
    updateConfig({
      ...config,
      participants: config.participants.map((participant) =>
        participant.participantId === participantId ? update(participant) : participant,
      ),
    });
  };

  const toggleArmed = async () => {
    if (!config) return;
    if (armed) {
      if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
      if (props.onDraftArmChange) {
        props.onDraftArmChange(null);
        setArmed(false);
        return;
      }
      const result = await disarm({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, expectedRevision: armRevisionRef.current },
      });
      if (result._tag === "Success") {
        armRevisionRef.current = 0;
        setArmed(false);
        appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
      }
      return;
    }
    if (props.onDraftArmChange) {
      props.onDraftArmChange(config);
      setArmed(true);
      return;
    }
    const result = await arm({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        expectedRevision: armRevisionRef.current,
        config,
      },
    });
    if (result._tag === "Success") {
      armRevisionRef.current = result.value.revision;
      setArmed(true);
      appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
      appAtomRegistry.refresh(magiEnvironment.settings(target));
      appAtomRegistry.refresh(magiEnvironment.options(target));
    }
  };

  if (!options || !settings || !config) {
    return <div className="p-5 text-sm text-muted-foreground">Loading Magi…</div>;
  }

  const runningCount = activeHistoryRuns.length;
  const reachedCount = history?.runs.filter((run) => run.state === "succeeded").length ?? 0;
  const failedCount =
    history?.runs.filter((run) => run.state === "turn-limit-reached" || run.state === "failed")
      .length ?? 0;
  const totalTokens = history?.runs.reduce((total, run) => total + (run.tokenCount ?? 0), 0) ?? 0;
  const renderRunItem = (run: MagiRunSummary) => (
    <MagiRunListItem
      key={run.runId}
      run={run}
      expanded={selectedView === run.runId}
      onExpandedChange={(open) => setSelectedView(open ? run.runId : null)}
    >
      {selectedView === run.runId ? (
        <RunDetailView
          environmentId={props.environmentId}
          runId={run.runId}
          includeDiagnostics={settings.showRunDetailsAndDiagnostics}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          settings={props.settings}
        />
      ) : null}
    </MagiRunListItem>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="magi-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-1">
          {selectedView === "new" ? (
            <NewMagiRunListItem
              participantCount={config.participants.length}
              turnLimit={config.magiTurnLimit}
              expanded
              onExpandedChange={(open) => {
                if (!open) setSelectedView(preferredAutomaticRunId);
              }}
            >
              <section className="space-y-3 px-5 py-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-base">Participants</h3>
                  <span className="text-xs text-muted-foreground">
                    {config.participants.length}/9
                  </span>
                </div>
                {config.participants.map((participant, index) => {
                  const activeEntry = instanceEntries.find(
                    (candidate) => candidate.instanceId === participant.modelSelection.instanceId,
                  );
                  const duplicate = duplicates.has(participant.participantId);
                  return (
                    <div
                      key={participant.participantId}
                      className={participantCardClass(duplicate)}
                    >
                      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1">
                        <ProviderModelPicker
                          activeInstanceId={participant.modelSelection.instanceId}
                          model={participant.modelSelection.model}
                          lockedProvider={null}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          triggerVariant="ghost"
                          triggerClassName="w-fit max-w-full shrink justify-start text-sm text-foreground/90 hover:text-foreground"
                          triggerAriaLabel={`Participant ${index + 1} provider and model`}
                          getModelDisabledReason={(instanceId, model) => {
                            const candidate = options.providerInstances.find(
                              (item) => item.instanceId === instanceId,
                            );
                            if (!candidate?.available) {
                              return (
                                candidate?.unavailableReason ??
                                "This provider is unavailable to Magi."
                              );
                            }
                            return candidate.models.includes(model)
                              ? null
                              : "This model is unavailable to Magi.";
                          }}
                          onInstanceModelChange={(instanceId, model) =>
                            replaceParticipant(participant.participantId, (current) => ({
                              ...current,
                              modelSelection: { instanceId, model },
                            }))
                          }
                        />
                        {activeEntry ? (
                          <TraitsPicker
                            provider={activeEntry.driverKind as ProviderDriverKind}
                            instanceId={activeEntry.instanceId}
                            models={activeEntry.models}
                            model={participant.modelSelection.model}
                            prompt=""
                            onPromptChange={() => {}}
                            modelOptions={participant.modelSelection.options ?? []}
                            allowPromptInjectedEffort={false}
                            planModeEnabled={props.settings.planModeEnabled}
                            triggerVariant="ghost"
                            triggerClassName="w-fit max-w-full shrink justify-start text-sm text-foreground/90 hover:text-foreground"
                            triggerAriaLabel={`Participant ${index + 1} reasoning and model options`}
                            onModelOptionsChange={(nextOptions) =>
                              replaceParticipant(participant.participantId, (current) => ({
                                ...current,
                                modelSelection: {
                                  ...current.modelSelection,
                                  ...(nextOptions?.length
                                    ? { options: nextOptions }
                                    : { options: [] }),
                                },
                              }))
                            }
                          />
                        ) : null}
                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                          <ParticipantWarnings duplicate={duplicate} />
                          {[
                            {
                              label: "Move participant up",
                              Icon: ArrowUp,
                              disabled: index === 0,
                              action: () =>
                                updateConfig(
                                  moveMagiParticipant(config, participant.participantId, -1),
                                ),
                            },
                            {
                              label: "Move participant down",
                              Icon: ArrowDown,
                              disabled: index === config.participants.length - 1,
                              action: () =>
                                updateConfig(
                                  moveMagiParticipant(config, participant.participantId, 1),
                                ),
                            },
                            {
                              label: "Remove participant",
                              Icon: Trash2,
                              disabled:
                                config.participants.length <= options.bounds.minimumParticipants,
                              action: () =>
                                updateConfig({
                                  ...config,
                                  participants: config.participants.filter(
                                    (item) => item.participantId !== participant.participantId,
                                  ),
                                }),
                            },
                          ].map(({ label, Icon, disabled, action }) => (
                            <Tooltip key={label}>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={label}
                                    disabled={disabled}
                                    onClick={action}
                                  >
                                    <Icon className="size-3" />
                                  </Button>
                                }
                              />
                              <TooltipPopup side="top">{label}</TooltipPopup>
                            </Tooltip>
                          ))}
                        </div>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <select
                          aria-label={`Participant ${index + 1} personality`}
                          className={`${inputClass} w-fit max-w-full shrink text-foreground`}
                          value={participant.personalityId ?? ""}
                          onChange={(event) =>
                            replaceParticipant(participant.participantId, (current) => ({
                              ...current,
                              personalityId:
                                event.target.value === ""
                                  ? null
                                  : (options.personalities.find(
                                      (personality) => personality.id === event.target.value,
                                    )?.id ?? null),
                            }))
                          }
                        >
                          <option value="">No personality</option>
                          {options.personalities
                            .filter((personality) => personality.included)
                            .map((personality) => (
                              <option key={personality.id} value={personality.id}>
                                {personality.name}
                              </option>
                            ))}
                        </select>
                        <label className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
                          Weight
                          <input
                            aria-label={`Participant ${index + 1} weight`}
                            type="number"
                            min={options.bounds.minimumWeight}
                            max={options.bounds.maximumWeight}
                            className={`${inputClass} w-14`}
                            value={participant.weight}
                            onChange={(event) =>
                              replaceParticipant(participant.participantId, (current) => ({
                                ...current,
                                weight: Math.max(1, Math.min(100, Number(event.target.value) || 1)),
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={config.participants.length >= options.bounds.maximumParticipants}
                  onClick={() =>
                    updateConfig(
                      addDefaultMagiParticipant(config, options, makeWebMagiParticipantId()),
                    )
                  }
                >
                  <Plus className="size-3" /> Add participant
                </Button>

                <div className="space-y-3 border-t border-border pt-4">
                  <div>
                    <label className="flex items-center gap-3 text-sm">
                      <span className="shrink-0">Consensus threshold</span>
                      <Slider
                        aria-label="Consensus threshold"
                        className="min-w-24 flex-1"
                        min={MAGI_PANEL_MIN_THRESHOLD_PERCENT}
                        max={MAGI_PANEL_MAX_THRESHOLD_PERCENT}
                        step={1}
                        value={config.consensusThresholdPercent}
                        onChange={(event) =>
                          updateConfig({
                            ...config,
                            consensusThresholdPercent: Number(event.currentTarget.value),
                          })
                        }
                      />
                      <output className="w-12 text-right font-mono text-xs font-medium tabular-nums">
                        {config.consensusThresholdPercent}%
                      </output>
                    </label>
                    {weightSummary ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {weightSummary.totalWeight} total voting weight ·{" "}
                        {weightSummary.requiredWeight} needed for consensus.
                        {thresholdWarning ? (
                          <span className="ml-1 text-destructive">{thresholdWarning}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <label className="flex items-center gap-3 text-sm">
                      <span className="shrink-0">Turn limit</span>
                      <Slider
                        aria-label="Turn limit"
                        className="min-w-24 flex-1"
                        min={0}
                        max={MAGI_TURN_LIMIT_SLIDER_VALUES.length - 1}
                        step={1}
                        value={turnLimitSliderIndex}
                        onChange={(event) => {
                          const nextIndex = Number(event.currentTarget.value);
                          setTurnLimitSliderIndex(nextIndex);
                          updateConfig({
                            ...config,
                            magiTurnLimit: magiTurnLimitFromSliderIndex(nextIndex),
                          });
                        }}
                      />
                      <output className="w-16 text-right font-mono text-xs font-medium tabular-nums">
                        {config.magiTurnLimit ?? "Unlimited"}
                      </output>
                    </label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {config.magiTurnLimit === null || config.magiTurnLimit === 0
                        ? "Unlimited turns. Provider cost is unbounded."
                        : `${config.participants.length * config.magiTurnLimit} base participant turns; up to ${config.participants.length * config.magiTurnLimit * 3} provider attempts with retries and repairs.`}
                    </p>
                  </div>
                </div>
                {validationError ? (
                  <p className="text-xs text-destructive">{validationError}</p>
                ) : null}
                {hasPromptOnlyParticipant ? (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground/70">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    Some providers are instructed not to mutate state, but T3 cannot enforce that
                    policy.
                  </p>
                ) : null}
              </section>
            </NewMagiRunListItem>
          ) : null}
          {(history?.runs ?? []).map(renderRunItem)}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          {selectedView === "new" ? (
            <Button
              size="micro"
              variant={armed ? "outline" : "default"}
              disabled={!armed && (validationIssues.length > 0 || Boolean(ownActiveRunId))}
              onClick={() => void toggleArmed()}
            >
              {armed ? "Disarm" : "Arm"}
            </Button>
          ) : (
            <Button size="micro" onClick={() => setSelectedView("new")}>
              new
            </Button>
          )}
          {runningCount > 0 ? (
            <span className="text-info-foreground">● {runningCount} running</span>
          ) : null}
          {reachedCount > 0 ? <span>{reachedCount} reached consensus</span> : null}
          {failedCount > 0 ? <span>{failedCount} failed</span> : null}
        </span>
        <span className="shrink-0 tabular-nums">Σ {formatSubagentTokenCount(totalTokens)} tok</span>
      </footer>
    </div>
  );
}

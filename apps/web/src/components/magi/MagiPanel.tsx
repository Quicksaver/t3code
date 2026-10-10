import { useAtomValue } from "@effect/atom-react";
import { MAGI_THREAD_RUNS_LIMIT } from "@t3tools/client-runtime/state/magi";
import {
  createMagiArmConfigAdoption,
  exactDuplicateMagiParticipantIds,
  magiParticipantIndicator,
  magiParticipantStatusLabel,
  magiRunElapsedMs,
  magiRunStartedCopy,
  magiRunStateLabel,
  type MagiParticipantIndicator,
  unrecordedMagiActionBatch,
} from "@t3tools/client-runtime/state/magiPresentation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import {
  type EnvironmentId,
  isMagiRunTerminal,
  type MagiGetOptionsResult,
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
import { AsyncResult } from "effect/reactivity";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ChevronDown,
  Copy,
  MessagesSquare,
  Network,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { magiEnvironment } from "~/state/magi";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
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
  clampMagiWeight,
  duplicateMagiParticipant,
  formatCompactTokenCount,
  formatMagiRunMetadata,
  initialMagiConfig,
  magiArmBlockedReason,
  type MagiArmReadiness,
  MAGI_PANEL_MAX_THRESHOLD_PERCENT,
  MAGI_PANEL_MIN_THRESHOLD_PERCENT,
  MAGI_TURN_LIMIT_SLIDER_VALUES,
  makeWebMagiParticipantId,
  magiRosterInstanceNames,
  magiTurnLimitFromSliderIndex,
  magiTurnLimitSliderIndex,
  magiWeightSummary,
  moveMagiParticipant,
  normalizeMagiPanelConfig,
  ownActiveMagiRun,
  parseMagiWeightInput,
  preferredMagiRunForAutomaticExpansion,
  reconcileMagiArmAfterWrites,
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
      return { label, className: "text-warning-foreground", Icon: TriangleAlert };
    case "supports":
      return { label, className: "text-success-foreground", Icon: CircleCheck };
    case "opposes":
      return { label, className: "text-destructive-foreground", Icon: CircleX };
    case "abstained":
      return { label, className: "text-muted-foreground", Icon: CircleMinus };
  }
};

function ParticipantStatusLight(props: {
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
  const label = magiRunStateLabel(state);
  if (!isMagiRunTerminal(state)) {
    return {
      label,
      className: state === "paused" ? "text-muted-foreground" : "text-info-foreground",
      iconState: state === "paused" ? ("idle" as const) : ("running" as const),
    };
  }
  if (state === "succeeded") {
    return { label, className: "text-success-foreground", iconState: "succeeded" as const };
  }
  return { label, className: "text-destructive-foreground", iconState: "failed" as const };
};

type MagiRunIconState = "idle" | "running" | "succeeded" | "failed";

function MagiRunStatusIcon(props: { readonly state: MagiRunIconState; readonly label: string }) {
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
                  props.state === "failed" && "text-destructive-foreground",
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
  readonly viewerThreadId: ThreadId;
  readonly expanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const status = magiRunVisualState(props.run.state);
  const metadataCopy = formatMagiRunMetadata(props.run, props.viewerThreadId).join(" · ");

  return (
    <div className="rounded-xl" data-magi-run-id={props.run.runId}>
      <button
        type="button"
        className="flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={props.expanded}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <MagiRunStatusIcon state={status.iconState} label={status.label} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{props.run.title.title}</span>
            <span className={cn("shrink-0", status.className)}>{status.label}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
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
        className="flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={props.expanded}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <MagiRunStatusIcon state="idle" label="Idle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">New</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
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

/** Approval requests raised inside a running participant's conversation. */
function ParticipantPendingApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const approvals = useMemo(
    () => derivePendingApprovals(pendingRequests?.approvals ?? []),
    [pendingRequests],
  );
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
          canRespond={active.responseCapability === "live"}
          options={active.options}
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
                className="inline-flex size-5 items-center justify-center text-warning-foreground"
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
  const statusInput = {
    runState: props.runState,
    memberState: visualState,
    finalStance: props.finalStance,
    finalBallot: props.finalBallot,
  };
  const indicator = magiParticipantIndicator(statusInput);
  const indicatorLabel = magiParticipantStatusLabel(statusInput);
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
            triggerClassName="pointer-events-none h-7 min-h-7 w-fit max-w-full shrink justify-start px-1.5 text-sm text-foreground disabled:opacity-100 [&_svg[data-composer-control-chevron]]:hidden"
            triggerAriaLabel="Participant reasoning and model options"
            onModelOptionsChange={() => {}}
          />
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <ParticipantWarnings duplicate={props.duplicate} />
          {props.participant.childThreadId ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open participant conversation"
                    render={
                      <Link
                        to="/$environmentId/$threadId"
                        params={{
                          environmentId: props.environmentId,
                          threadId: props.participant.childThreadId,
                        }}
                      />
                    }
                  >
                    <MessagesSquare className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Open participant conversation</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1 pl-6">
        <span className="min-w-0 truncate px-1.5 text-sm text-foreground">{personality}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
          Weight
          <span className="min-w-6 text-right text-foreground">{props.participant.weight}</span>
        </span>
      </div>
      {/* Only a running participant can be waiting on an approval; idle rows skip the
          per-conversation pending-request subscription. */}
      {props.participant.childThreadId &&
      participantState === "running" &&
      !isMagiRunTerminal(props.runState) ? (
        <ParticipantPendingApproval
          environmentId={props.environmentId}
          threadId={props.participant.childThreadId}
        />
      ) : null}
    </div>
  );
}

/** Ticks once a second while the run is active; kept small so only this text re-renders. */
function MagiRunElapsed(props: { readonly run: MagiRunDetail["summary"] }) {
  const { startedAt, completedAt, state } = props.run;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (isMagiRunTerminal(state)) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);
  return <>{formatDuration(magiRunElapsedMs({ startedAt, completedAt }, nowMs))}</>;
}

/** A bordered card collapsed to its one-line summary, which expands it. */
function MagiDisclosureCard(props: { readonly summary: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="rounded-md border border-border text-sm">
      <Collapsible>
        <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-3 rounded-md p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg:last-child]:rotate-180">
          {props.summary}
          <ChevronDown className="size-3.5 shrink-0 transition-transform" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3">{props.children}</div>
        </CollapsibleContent>
      </Collapsible>
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
  const detailResult = useAtomValue(
    magiEnvironment.runDetail({
      environmentId: props.environmentId,
      input: { runId: props.runId, includeDiagnostics: props.includeDiagnostics },
    }),
  );
  const detail = Option.getOrNull(AsyncResult.value(detailResult));

  if (!detail) {
    return AsyncResult.isFailure(detailResult) ? (
      <p role="alert" className="p-5 text-sm text-destructive-foreground">
        Could not load this Magi run.
      </p>
    ) : (
      <p className="p-5 text-sm text-muted-foreground">Loading Magi run…</p>
    );
  }

  const duplicates = exactDuplicateMagiParticipantIds(detail.config.participants);
  const candidateVoteWeights = magiParticipantVoteWeights(
    detail.config.participants,
    detail.finalParticipantVotes,
  );
  // Recorded actions and reconciliations already cover a batch once the main agent reports it.
  const batch = unrecordedMagiActionBatch(detail);

  return (
    <section className="space-y-3 px-5 pb-5 pt-2">
      {/* The run header shows the state; only it is announced, as fields refresh with each snapshot. */}
      <p className="sr-only" aria-live="polite">
        {magiRunStateLabel(detail.summary.state)}
      </p>
      <MagiDisclosureCard
        summary={
          <span className="min-w-0 flex-1 text-muted-foreground">
            {magiRunStartedCopy(detail.summary, detail.config.magiTurnLimit)} ·{" "}
            <MagiRunElapsed run={detail.summary} /> elapsed
          </span>
        }
      >
        <p className="whitespace-pre-wrap">{detail.summary.objective ?? "No focused objective."}</p>
      </MagiDisclosureCard>
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
        <MagiDisclosureCard
          summary={
            <>
              <span className="min-w-0 flex-1 truncate font-medium">Current candidate</span>
              <span className="flex shrink-0 items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1 text-success-foreground">
                  <CircleCheck className="size-3.5" aria-hidden="true" />
                  {candidateVoteWeights.agreedWeight} agreed
                  <span className="sr-only"> weight</span>
                </span>
                <span className="inline-flex items-center gap-1 text-destructive-foreground">
                  <CircleX className="size-3.5" aria-hidden="true" />
                  {candidateVoteWeights.opposedWeight} opposed
                  <span className="sr-only"> weight</span>
                </span>
              </span>
            </>
          }
        >
          <p className="whitespace-pre-wrap">{detail.candidate.conclusion}</p>
        </MagiDisclosureCard>
      ) : null}

      {batch ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="font-medium text-xs">Issued actions · turn {batch.magiTurn}</p>
          <p className="text-xs text-muted-foreground">
            {isMagiRunTerminal(detail.summary.state)
              ? "The run ended before the main agent recorded what happened to these actions."
              : "The main agent has not recorded what happened to these actions yet."}
          </p>
          {batch.actions.map((action) => (
            <p key={action.actionId} className="text-xs text-muted-foreground">
              {action.summary} · {action.obligation}
            </p>
          ))}
        </div>
      ) : null}

      {/* Diagnostics render fuller turn evidence and proposal records of their own. */}
      {!props.includeDiagnostics && detail.magiTurns && detail.magiTurns.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Turn evidence</summary>
          <div className="mt-2 space-y-2">
            {detail.magiTurns.map((turn) => (
              <div key={turn.magiTurn} className="rounded-md bg-muted/20 p-2 text-2xs">
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

      {!props.includeDiagnostics && detail.proposals && detail.proposals.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Proposal records</summary>
          <div className="mt-2 space-y-2">
            {detail.proposals.map((proposal) => (
              <div key={proposal.proposalId} className="rounded-md bg-muted/20 p-2 text-2xs">
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
              <div key={action.actionId} className="rounded-md bg-muted/20 p-2 text-2xs">
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
          <p className="mt-1 text-2xs text-muted-foreground">
            Participant transcripts, proposal records, and turn evidence used to audit the decision.
          </p>
          <div className="mt-3 space-y-2">
            {detail.initialPrompt ? (
              <details className="rounded-md border border-border p-2">
                <summary className="cursor-pointer text-xs font-medium">Initial prompt</summary>
                <p className="mt-2 whitespace-pre-wrap text-2xs text-muted-foreground">
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
                            key={settlement.participantRunId ?? settlement.participantId}
                            className="rounded-md border border-border p-2"
                          >
                            <summary className="cursor-pointer text-2xs">
                              {participant?.modelSelection.model ?? settlement.participantId} ·{" "}
                              {participant?.personality?.name ?? "Default"}
                            </summary>
                            <p className="mt-2 text-2xs text-muted-foreground">
                              {settlement.contextCompressed ? "Context compressed · " : ""}
                              {settlement.durationMs} ms · {settlement.inputTokens ?? "unknown"}{" "}
                              input tokens · {settlement.parseMode} response
                            </p>
                            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-2xs text-muted-foreground">
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
                    <p className="mt-2 text-2xs text-muted-foreground">
                      {turn.settlements.length} responses · {turn.activities.length} referenced tool
                      activities · {turn.arbitration ? "arbitrated" : "awaiting arbitration"}
                    </p>
                    {turn.activities.map((activity) => (
                      <div key={activity.activityId} className="mt-2 text-2xs">
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
                        className="mt-1 text-2xs"
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
                            className="size-3.5 shrink-0 text-destructive-foreground"
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
                      <div className="mt-3 space-y-3 text-2xs">
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

/**
 * Integer weight field. It may be empty or out of range while typing; whole numbers within the
 * bounds apply immediately, and leaving the field clamps it.
 */
function MagiWeightInput(props: {
  readonly ariaLabel: string;
  readonly weight: number;
  readonly bounds: MagiGetOptionsResult["bounds"];
  readonly onWeightChange: (weight: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = (value: number) => {
    if (value !== props.weight) props.onWeightChange(value);
  };
  return (
    <input
      aria-label={props.ariaLabel}
      type="number"
      inputMode="numeric"
      step={1}
      min={props.bounds.minimumWeight}
      max={props.bounds.maximumWeight}
      className={`${inputClass} w-14`}
      value={text ?? String(props.weight)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseMagiWeightInput(next);
        if (
          parsed !== null &&
          parsed >= props.bounds.minimumWeight &&
          parsed <= props.bounds.maximumWeight
        ) {
          commit(parsed);
        }
      }}
      onBlur={() => {
        if (text !== null) commit(clampMagiWeight(text, props.bounds, props.weight));
        setText(null);
      }}
    />
  );
}

/**
 * One older page of run history. The last loaded page offers the next one, so history grows
 * one bounded request per click.
 */
function MagiOlderRunsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly isLastPage: boolean;
  readonly knownRunIds: ReadonlySet<MagiRunId>;
  readonly renderRunItem: (run: MagiRunSummary) => ReactNode;
  readonly onLoadOlder: (cursor: string) => void;
}) {
  const pageResult = useAtomValue(
    magiEnvironment.runsPage({
      environmentId: props.environmentId,
      input: { rootThreadId: props.threadId, cursor: props.cursor, limit: MAGI_THREAD_RUNS_LIMIT },
    }),
  );
  const page = Option.getOrNull(AsyncResult.value(pageResult));
  if (!page) {
    return AsyncResult.isFailure(pageResult) ? (
      <p role="alert" className="px-2 py-3 text-sm text-destructive-foreground">
        Could not load older Magi runs.
      </p>
    ) : (
      <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
        Loading older Magi runs…
      </p>
    );
  }
  return (
    <>
      {page.runs.filter((run) => !props.knownRunIds.has(run.runId)).map(props.renderRunItem)}
      {props.isLastPage && page.nextCursor !== null ? (
        <MagiLoadOlderRunsButton onClick={() => props.onLoadOlder(page.nextCursor!)} />
      ) : null}
    </>
  );
}

function MagiLoadOlderRunsButton(props: { readonly onClick: () => void }) {
  return (
    <div className="flex justify-center py-1">
      <Button size="xs" variant="ghost" onClick={props.onClick}>
        Load older runs
      </Button>
    </div>
  );
}

/** Key it by conversation: pending arm writes belong to the thread they were made for. */
export function MagiPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  isVisible: boolean;
  history: MagiListRunsResult | null;
  historyLoading: boolean;
  historyFailed: boolean;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  /** Conversation work that keeps arming disabled; omitted means idle. */
  readiness?: MagiArmReadiness;
  draftArm?: MagiRunConfig | null;
  onDraftArmChange?: (config: MagiRunConfig | null) => void;
  /** A run to expand once; a new `requestId` asks again. */
  revealRun?: { readonly runId: MagiRunId; readonly requestId: number } | undefined;
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
  const [armConfigAdoption] = useState(createMagiArmConfigAdoption);
  const [turnLimitSliderIndex, setTurnLimitSliderIndex] = useState(0);
  const [armed, setArmed] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const [armReconcileRequest, setArmReconcileRequest] = useState(0);
  const [selectedView, setSelectedView] = useState<"new" | MagiRunId | null>(null);
  // Older history pages chain from the live page's cursor; a new run shifts that page and
  // invalidates the chain.
  const [olderPages, setOlderPages] = useState<{
    readonly baseCursor: string;
    readonly cursors: ReadonlyArray<string>;
  } | null>(null);
  const armRevisionRef = useRef(0);
  const armReconcilePendingRef = useRef(false);
  const armSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArmConfigRef = useRef<{ config: MagiRunConfig; editVersion: number } | null>(null);
  const armSyncGenerationRef = useRef(0);
  const armReconcileIntentRef = useRef(0);
  const armReconcileLifetimeRef = useRef(0);
  const armSyncChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const flushArmSyncRef = useRef(() => {});
  const consumedActiveRunRef = useRef<MagiRunId | null>(null);
  const autoSelectedActiveRunRef = useRef<MagiRunId | null>(null);
  const initialSelectionCompleteRef = useRef(false);
  const appliedRevealRequestRef = useRef<number | null>(null);
  const [revealedRun, setRevealedRun] = useState<{
    readonly runId: MagiRunId;
    readonly requestId: number;
  } | null>(null);
  const runListRef = useRef<HTMLDivElement | null>(null);
  const wasVisibleRef = useRef(props.isVisible);
  const arm = useAtomCommand(magiEnvironment.armThread);
  const disarm = useAtomCommand(magiEnvironment.disarmThread);
  const canArm = useAtomValue(magiEnvironment.armThread.permissionAtom(props.environmentId));
  const canDisarm = useAtomValue(magiEnvironment.disarmThread.permissionAtom(props.environmentId));
  const isDraft = props.onDraftArmChange !== undefined;
  const canMutateArm = isDraft || (canArm && canDisarm);
  const canMutateArmNow = () =>
    props.onDraftArmChange !== undefined ||
    (appAtomRegistry.get(magiEnvironment.armThread.permissionAtom(props.environmentId)) &&
      appAtomRegistry.get(magiEnvironment.disarmThread.permissionAtom(props.environmentId)));

  /** Drops the debounced update and every queued arm write that has not started yet. */
  const cancelPendingArmSync = useCallback(() => {
    if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
    armSyncTimerRef.current = null;
    pendingArmConfigRef.current = null;
    armSyncGenerationRef.current += 1;
    armConfigAdoption.cancelPendingWrite();
  }, [armConfigAdoption]);
  useEffect(() => {
    armReconcileLifetimeRef.current += 1;
    armConfigAdoption.reset();
    return () => {
      armReconcileLifetimeRef.current += 1;
    };
  }, [armConfigAdoption, isDraft, props.environmentId, props.threadId]);
  useEffect(() => {
    if (canMutateArm) return;
    cancelPendingArmSync();
    const generation = armSyncGenerationRef.current;
    const intent = armReconcileIntentRef.current;
    const lifetime = armReconcileLifetimeRef.current;
    void reconcileMagiArmAfterWrites(
      armSyncChainRef.current,
      () =>
        generation === armSyncGenerationRef.current &&
        intent === armReconcileIntentRef.current &&
        lifetime === armReconcileLifetimeRef.current,
      () => {
        armReconcilePendingRef.current = true;
        setArmReconcileRequest((request) => request + 1);
        appAtomRegistry.refresh(
          magiEnvironment.arm({
            environmentId: props.environmentId,
            input: { threadId: props.threadId },
          }),
        );
      },
    );
  }, [canMutateArm, cancelPendingArmSync, props.environmentId, props.threadId]);
  /** A rejected write leaves the server's arm authoritative: show why and adopt it. */
  const reconcileAfterArmFailure = (
    result: AtomCommandResult<unknown, unknown>,
    fallbackMessage: string,
  ) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setArmError(error instanceof Error && error.message ? error.message : fallbackMessage);
    }
    cancelPendingArmSync();
    armReconcilePendingRef.current = true;
    setArmReconcileRequest((request) => request + 1);
    appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
  };
  /**
   * Serializes arm (a config) and disarm (null) writes. Each reads the revision when it runs,
   * and a write queued before `cancelPendingArmSync` is skipped.
   */
  const enqueueArmCommand = (
    nextConfig: MagiRunConfig | null,
    editVersion = nextConfig === null ? null : armConfigAdoption.beginWrite(),
  ): Promise<boolean> => {
    const generation = armSyncGenerationRef.current;
    const execute = async () => {
      if (generation !== armSyncGenerationRef.current) return false;
      const command =
        nextConfig === null ? magiEnvironment.disarmThread : magiEnvironment.armThread;
      if (!appAtomRegistry.get(command.permissionAtom(props.environmentId))) return false;
      const input = { threadId: props.threadId, expectedRevision: armRevisionRef.current };
      if (nextConfig === null) {
        const result = await disarm({ environmentId: props.environmentId, input });
        if (result._tag === "Failure") {
          reconcileAfterArmFailure(result, "Could not disarm Magi.");
          return false;
        }
        armRevisionRef.current = 0;
        setArmError(null);
        appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
        return true;
      }
      const result = await arm({
        environmentId: props.environmentId,
        input: { ...input, config: nextConfig },
      });
      if (result._tag === "Failure") {
        reconcileAfterArmFailure(result, "Could not arm Magi.");
        return false;
      }
      armRevisionRef.current = result.value.revision;
      if (editVersion !== null) armConfigAdoption.acknowledge(editVersion);
      setArmError(null);
      appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
      appAtomRegistry.refresh(magiEnvironment.settings(target));
      appAtomRegistry.refresh(magiEnvironment.options(target));
      return true;
    };
    const run = armSyncChainRef.current.then(execute, execute);
    armSyncChainRef.current = run.catch(() => undefined);
    return run;
  };
  // Closing the panel or switching threads sends the last debounced edit instead of losing it.
  useEffect(() => {
    flushArmSyncRef.current = () => {
      const pending = pendingArmConfigRef.current;
      if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
      armSyncTimerRef.current = null;
      pendingArmConfigRef.current = null;
      if (pending) void enqueueArmCommand(pending.config, pending.editVersion);
    };
  });
  useEffect(() => () => flushArmSyncRef.current(), []);

  useEffect(() => {
    if (config === null && options && settings) {
      setConfig(normalizeMagiPanelConfig(props.draftArm ?? initialMagiConfig(options, settings)));
      setArmed(props.draftArm !== null && props.draftArm !== undefined);
    }
  }, [config, options, props.draftArm, settings]);
  useEffect(() => {
    if (props.onDraftArmChange || !serverArmLoaded) return;
    const reconcile = armReconcilePendingRef.current;
    armReconcilePendingRef.current = false;
    if (serverArm === null) {
      armRevisionRef.current = 0;
      setArmed(false);
    } else if (reconcile || serverArm.revision !== armRevisionRef.current) {
      const adopted = armConfigAdoption.adopt(serverArm.config);
      if (adopted !== null) setConfig(normalizeMagiPanelConfig(adopted));
      armRevisionRef.current = serverArm.revision;
      setArmed(true);
    }
  }, [
    armConfigAdoption,
    armReconcileRequest,
    canMutateArm,
    props.onDraftArmChange,
    serverArm,
    serverArmLoaded,
  ]);
  useEffect(() => {
    if (!config) return;
    setTurnLimitSliderIndex((currentIndex) =>
      magiTurnLimitSliderIndex(config.magiTurnLimit, currentIndex),
    );
  }, [config?.magiTurnLimit]);

  // The history also lists subagents' runs; only this conversation's own runs consume its arm,
  // block arming, or expand automatically.
  const ownActiveRunId = ownActiveMagiRun(history?.runs ?? [], props.threadId)?.runId ?? null;
  const preferredAutomaticRunId =
    preferredMagiRunForAutomaticExpansion(history?.runs ?? [], props.threadId)?.runId ?? null;
  useEffect(() => {
    if (!ownActiveRunId || consumedActiveRunRef.current === ownActiveRunId) return;
    consumedActiveRunRef.current = ownActiveRunId;
    cancelPendingArmSync();
    armRevisionRef.current = 0;
    setArmed(false);
    props.onDraftArmChange?.(null);
    appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
    appAtomRegistry.refresh(magiEnvironment.settings(target));
    appAtomRegistry.refresh(magiEnvironment.options(target));
  }, [ownActiveRunId, props.onDraftArmChange]);
  const revealRunId = props.revealRun?.runId ?? null;
  const revealRequestId = props.revealRun?.requestId ?? null;
  useEffect(() => {
    const becameVisible = props.isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = props.isVisible;
    if (!props.isVisible) return;
    // Another client may have armed or disarmed while the panel was hidden.
    if (becameVisible && !props.onDraftArmChange) {
      appAtomRegistry.refresh(magiEnvironment.arm(armTarget));
    }
    // Drafts have no server history; a failed load still leaves the configuration reachable.
    if (history === null && props.historyLoading) return;
    if (
      revealRunId !== null &&
      revealRequestId !== null &&
      appliedRevealRequestRef.current !== revealRequestId
    ) {
      // A requested run outranks automatic selection, including the active run it would pick.
      appliedRevealRequestRef.current = revealRequestId;
      autoSelectedActiveRunRef.current = ownActiveRunId;
      initialSelectionCompleteRef.current = true;
      setSelectedView(revealRunId);
      setRevealedRun({ runId: revealRunId, requestId: revealRequestId });
      return;
    }
    if (ownActiveRunId && autoSelectedActiveRunRef.current !== ownActiveRunId) {
      autoSelectedActiveRunRef.current = ownActiveRunId;
      initialSelectionCompleteRef.current = true;
      setSelectedView(ownActiveRunId);
      return;
    }
    if (!initialSelectionCompleteRef.current) {
      initialSelectionCompleteRef.current = true;
      setSelectedView(preferredAutomaticRunId ?? "new");
    }
  }, [
    history,
    ownActiveRunId,
    preferredAutomaticRunId,
    props.historyLoading,
    props.isVisible,
    revealRequestId,
    revealRunId,
  ]);
  useEffect(() => {
    if (revealedRun === null) return;
    runListRef.current
      ?.querySelector(`[data-magi-run-id="${CSS.escape(revealedRun.runId)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [revealedRun]);

  const duplicates = useMemo(
    () => exactDuplicateMagiParticipantIds(config?.participants ?? []),
    [config?.participants],
  );
  const validationIssues = useMemo(() => (config ? validateMagiRoster(config) : []), [config]);
  const thresholdWarning =
    validationIssues.find((issue) => issue.reason === "draw-capable-threshold")?.message ?? null;
  const validationError =
    validationIssues.find((issue) => issue.reason !== "draw-capable-threshold")?.message ?? null;
  const armBlockedReason = magiArmBlockedReason({
    readiness: props.readiness,
    ownActiveRun: ownActiveRunId !== null,
  });
  const weightSummary = config ? magiWeightSummary(config) : null;
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
    if (!armed || !canMutateArmNow()) return;
    armReconcileIntentRef.current += 1;
    if (validateMagiRoster(next).length > 0) {
      setArmed(false);
      if (props.onDraftArmChange) props.onDraftArmChange(null);
      else {
        cancelPendingArmSync();
        void enqueueArmCommand(null);
      }
      return;
    }
    if (props.onDraftArmChange) {
      props.onDraftArmChange(next);
      return;
    }
    if (armSyncTimerRef.current) clearTimeout(armSyncTimerRef.current);
    const editVersion = armConfigAdoption.beginWrite();
    pendingArmConfigRef.current = { config: next, editVersion };
    armSyncTimerRef.current = setTimeout(() => {
      armSyncTimerRef.current = null;
      pendingArmConfigRef.current = null;
      void enqueueArmCommand(next, editVersion);
    }, 250);
  };
  const updateConfig = (next: MagiRunConfig) => {
    armConfigAdoption.markEdited();
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
    if (!config || !canMutateArmNow()) return;
    armReconcileIntentRef.current += 1;
    setArmError(null);
    if (armed) {
      setArmed(false);
      if (props.onDraftArmChange) {
        props.onDraftArmChange(null);
        return;
      }
      cancelPendingArmSync();
      await enqueueArmCommand(null);
      return;
    }
    if (props.onDraftArmChange) {
      props.onDraftArmChange(config);
      setArmed(true);
      return;
    }
    // Armed before the write resolves, so edits made meanwhile queue behind it. A rejected
    // write reconciles to the server's arm; a write skipped by a disarm was already undone.
    setArmed(true);
    await enqueueArmCommand(config);
  };

  if (!options || !settings) {
    return AsyncResult.isFailure(optionsResult) || AsyncResult.isFailure(settingsResult) ? (
      <p role="alert" className="p-5 text-sm text-destructive-foreground">
        Could not load Magi options.
      </p>
    ) : (
      <div className="p-5 text-sm text-muted-foreground">Loading Magi…</div>
    );
  }
  if (!config) {
    return <div className="p-5 text-sm text-muted-foreground">Loading Magi…</div>;
  }

  const runningCount = history?.activeRunCount ?? 0;
  const reachedCount = history?.runs.filter((run) => run.state === "succeeded").length ?? 0;
  const failedCount =
    history?.runs.filter((run) => run.state === "turn-limit-reached" || run.state === "failed")
      .length ?? 0;
  const totalTokens = history?.runs.reduce((total, run) => total + (run.tokenCount ?? 0), 0) ?? 0;
  const liveNextCursor = history?.nextCursor ?? null;
  const olderCursors =
    olderPages !== null && olderPages.baseCursor === liveNextCursor ? olderPages.cursors : [];
  const liveRunIds = new Set(history?.runs.map((run) => run.runId));
  const rosterInstanceNames = magiRosterInstanceNames(config, options);
  const renderRunItem = (run: MagiRunSummary) => (
    <MagiRunListItem
      key={run.runId}
      run={run}
      viewerThreadId={props.threadId}
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
        <div ref={runListRef} className="space-y-1">
          {props.historyFailed ? (
            <p role="alert" className="px-2 py-3 text-sm text-destructive-foreground">
              Could not load Magi runs.
            </p>
          ) : props.historyLoading ? (
            <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
              Loading Magi runs…
            </p>
          ) : null}
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
                    {config.participants.length}/{options.bounds.maximumParticipants}
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
                              label: "Duplicate participant",
                              Icon: Copy,
                              disabled:
                                config.participants.length >= options.bounds.maximumParticipants,
                              action: () =>
                                updateConfig(
                                  duplicateMagiParticipant(
                                    config,
                                    options,
                                    participant.participantId,
                                    makeWebMagiParticipantId(),
                                  ),
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
                          {participant.personalityId !== null &&
                          !options.personalities.some(
                            (personality) =>
                              personality.included && personality.id === participant.personalityId,
                          ) ? (
                            // Keep a removed or excluded selection visible: the run would still use it.
                            <option value={participant.personalityId}>
                              {options.personalities.find(
                                (personality) => personality.id === participant.personalityId,
                              )?.name ?? participant.personalityId}{" "}
                              (unavailable)
                            </option>
                          ) : null}
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
                          <MagiWeightInput
                            ariaLabel={`Participant ${index + 1} weight`}
                            weight={participant.weight}
                            bounds={options.bounds}
                            onWeightChange={(weight) =>
                              replaceParticipant(participant.participantId, (current) => ({
                                ...current,
                                weight,
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
                          <span className="ml-1 text-destructive-foreground">
                            {thresholdWarning}
                          </span>
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
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    Participants are asked to stay read-only, but they run with this conversation's
                    access mode and tools. The rule is an instruction, not an enforced restriction.
                  </p>
                  {rosterInstanceNames.length > 0 ? (
                    <p>
                      This conversation's request and selected evidence are sent to:{" "}
                      {rosterInstanceNames.join(", ")}.
                    </p>
                  ) : null}
                </div>
                {validationError ? (
                  <p className="text-xs text-destructive-foreground">{validationError}</p>
                ) : null}
                {!canMutateArm ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    This connection cannot change the Magi arm. Edits stay in this panel.
                  </p>
                ) : null}
                {armed && !isDraft && armConfigAdoption.hasUnsentEdits ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Magi remains armed with its saved configuration. These edits have not been
                    saved.
                  </p>
                ) : null}
                {!armed && armBlockedReason ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {armBlockedReason}
                  </p>
                ) : null}
                {armError ? (
                  <p role="alert" className="text-xs text-destructive-foreground">
                    {armError}
                  </p>
                ) : null}
              </section>
            </NewMagiRunListItem>
          ) : null}
          {(history?.runs ?? []).map(renderRunItem)}
          {liveNextCursor !== null
            ? olderCursors.map((cursor, index) => (
                <MagiOlderRunsPage
                  key={cursor}
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  cursor={cursor}
                  isLastPage={index === olderCursors.length - 1}
                  knownRunIds={liveRunIds}
                  renderRunItem={renderRunItem}
                  onLoadOlder={(nextCursor) =>
                    setOlderPages({
                      baseCursor: liveNextCursor,
                      cursors: [...olderCursors, nextCursor],
                    })
                  }
                />
              ))
            : null}
          {liveNextCursor !== null && olderCursors.length === 0 ? (
            <MagiLoadOlderRunsButton
              onClick={() =>
                setOlderPages({ baseCursor: liveNextCursor, cursors: [liveNextCursor] })
              }
            />
          ) : null}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          {selectedView === "new" ? (
            <Button
              size="micro"
              variant={armed ? "outline" : "default"}
              disabled={
                !canMutateArm ||
                (!armed && (validationIssues.length > 0 || armBlockedReason !== null))
              }
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
        <span className="shrink-0 tabular-nums">Σ {formatCompactTokenCount(totalTokens)}</span>
      </footer>
    </div>
  );
}

import {
  EventId,
  isMagiRunTerminal,
  type ActiveMagiRunSummary,
  type EnvironmentId,
  type MagiRunSummary,
  type MessageId,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  type ServerProviderSkill,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  emptyAgentPanelModel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata, Hunk } from "@pierre/diffs/types";
import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatDuration,
  mergeDeferredCommandOutput,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { useEnvironmentQuery } from "../../state/query";
import { threadActivityEnvironment } from "../../state/threadActivities";
import { type TurnDiffSummary } from "../../types";
import {
  buildFileDiffRenderKey,
  createChangedFileDiffPathMatcher,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  Network,
  PaintbrushIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { shouldAutoExpandChangedFiles } from "./changedFilesPresentation";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  resolveMagiActivityPlacement,
  shouldToggleWorkEntryRowFromKeyDown,
  shouldPreserveAssistantLineBreaks,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import {
  buildSupplementalToolDetailBody,
  deriveCommandOutputDisplay,
  deriveExpandableWorkEntryDetails,
  deriveFileChangeDisplayFiles,
  hasCommandWorkEntryDetails,
  hasExpandableWorkEntryDetails as hasStandardExpandableWorkEntryDetails,
  hasFileChangeWorkEntryDetails,
  hasRenderableCommandOutput,
  hasRenderableCommandOutputDetail,
} from "../../lib/workLogEntryDetails";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { magiEnvironment } from "~/state/magi";
import {
  extractTrailingTerminalContexts,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentContext,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();
const NOOP_OPEN_AGENTS = () => {};
interface ParsedUserMessageContextState {
  visibleText: string;
  terminalContexts: ParsedTerminalContextEntry[];
  elementContexts: ParsedElementContextEntry[];
  previewAnnotations: ParsedPreviewAnnotation[];
  contextEntries: ParsedUserMessageContextEntry[];
  contentParts: ParsedUserMessageContentPart[];
}

type ParsedUserMessageContentPart =
  | { kind: "text"; id: string; text: string }
  | ParsedUserMessageContextEntry;

type ParsedUserMessageContextEntry =
  | { kind: "terminal"; id: string; context: ParsedTerminalContextEntry }
  | { kind: "element"; id: string; context: ParsedElementContextEntry }
  | { kind: "preview"; id: string; annotation: ParsedPreviewAnnotation };

type AllocateUserMessageContextEntryId = (
  kind: ParsedUserMessageContextEntry["kind"],
  value: string,
) => string;

type AllocateUserMessageContentPartId = () => string;

const TRAILING_CONTEXT_BLOCK_OPENERS = [
  "<preview_annotation>",
  "<element_context>",
  "<terminal_context>",
] as const;

const GENERATED_CONTEXT_BLOCK_TAGS = [
  { opener: "<preview_annotation>", closer: "</preview_annotation>" },
  { opener: "<element_context>", closer: "</element_context>" },
  { opener: "<terminal_context>", closer: "</terminal_context>" },
] as const;

const REVIEW_COMMENT_BLOCK_OPENER = "<review_comment";
const REVIEW_COMMENT_BLOCK_CLOSER = "</review_comment>";

type TopLevelUserMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "context"; text: string }
  | { kind: "review-comment"; text: string };

function stripTrailingMalformedContextBlock(prompt: string): string | null {
  let bestIndex = -1;

  for (const opener of TRAILING_CONTEXT_BLOCK_OPENERS) {
    const index = prompt.lastIndexOf(opener);
    if (index > bestIndex) {
      bestIndex = index;
    }
  }

  if (bestIndex < 0) {
    return null;
  }

  const prefix = prompt.slice(0, bestIndex);
  if (prefix.length > 0 && !/(\n\s*){2}$/.test(prefix)) {
    return null;
  }

  return prefix.replace(/\n+$/, "");
}

function findNextGeneratedContextBlockOpener(
  prompt: string,
  startIndex: number,
): {
  index: number;
  opener: (typeof GENERATED_CONTEXT_BLOCK_TAGS)[number]["opener"];
  closer: (typeof GENERATED_CONTEXT_BLOCK_TAGS)[number]["closer"];
} | null {
  let best: {
    index: number;
    opener: (typeof GENERATED_CONTEXT_BLOCK_TAGS)[number]["opener"];
    closer: (typeof GENERATED_CONTEXT_BLOCK_TAGS)[number]["closer"];
  } | null = null;

  for (const tag of GENERATED_CONTEXT_BLOCK_TAGS) {
    let searchIndex = startIndex;
    while (searchIndex < prompt.length) {
      const index = prompt.indexOf(tag.opener, searchIndex);
      if (index < 0) break;

      const hasOpeningBoundary = index === 0 || /(\n\s*){2}$/.test(prompt.slice(0, index));
      const hasSerializedOpener = prompt[index + tag.opener.length] === "\n";
      if (hasOpeningBoundary && hasSerializedOpener) {
        if (best === null || index < best.index) {
          best = { index, opener: tag.opener, closer: tag.closer };
        }
        break;
      }

      searchIndex = index + tag.opener.length;
    }
  }

  return best;
}

function findStandaloneGeneratedContextCloser(
  prompt: string,
  closer: (typeof GENERATED_CONTEXT_BLOCK_TAGS)[number]["closer"],
  startIndex: number,
): number {
  const useLastStandaloneCloser = closer === "</preview_annotation>";
  let lastCloserIndex = -1;
  let searchIndex = startIndex;
  while (searchIndex < prompt.length) {
    const index = prompt.indexOf(closer, searchIndex);
    if (index < 0) return useLastStandaloneCloser ? lastCloserIndex : -1;

    const hasLineStart = prompt[index - 1] === "\n";
    const nextChar = prompt[index + closer.length];
    const hasLineEnd = nextChar === undefined || nextChar === "\n";
    if (hasLineStart && hasLineEnd) {
      if (!useLastStandaloneCloser) {
        return index;
      }
      lastCloserIndex = index;
    }

    searchIndex = index + closer.length;
  }

  return lastCloserIndex;
}

function splitTopLevelUserMessageSegments(prompt: string): TopLevelUserMessageSegment[] {
  const segments: TopLevelUserMessageSegment[] = [];
  let cursor = 0;

  while (cursor < prompt.length) {
    const nextContext = findNextGeneratedContextBlockOpener(prompt, cursor);
    const nextReviewCommentIndex = prompt.indexOf(REVIEW_COMMENT_BLOCK_OPENER, cursor);
    const nextContextIndex = nextContext?.index ?? -1;

    if (nextContextIndex < 0 && nextReviewCommentIndex < 0) {
      segments.push({ kind: "text", text: prompt.slice(cursor) });
      break;
    }

    const useContext =
      nextContext !== null &&
      (nextReviewCommentIndex < 0 || nextContext.index < nextReviewCommentIndex);
    const blockIndex = useContext ? nextContext.index : nextReviewCommentIndex;
    if (blockIndex > cursor) {
      segments.push({ kind: "text", text: prompt.slice(cursor, blockIndex) });
    }

    if (useContext) {
      const closerIndex = findStandaloneGeneratedContextCloser(
        prompt,
        nextContext.closer,
        blockIndex + nextContext.opener.length,
      );
      if (closerIndex < 0) {
        segments.push({ kind: "text", text: prompt.slice(blockIndex) });
        break;
      }

      const blockEndIndex = closerIndex + nextContext.closer.length;
      segments.push({ kind: "context", text: prompt.slice(blockIndex, blockEndIndex) });
      cursor = blockEndIndex;
      continue;
    }

    const closerIndex = prompt.indexOf(
      REVIEW_COMMENT_BLOCK_CLOSER,
      blockIndex + REVIEW_COMMENT_BLOCK_OPENER.length,
    );
    if (closerIndex < 0) {
      segments.push({ kind: "text", text: prompt.slice(blockIndex) });
      break;
    }

    const blockEndIndex = closerIndex + REVIEW_COMMENT_BLOCK_CLOSER.length;
    segments.push({ kind: "review-comment", text: prompt.slice(blockIndex, blockEndIndex) });
    cursor = blockEndIndex;
  }

  return segments;
}

function createEmptyUserMessageContextState(): ParsedUserMessageContextState {
  return {
    visibleText: "",
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    contextEntries: [],
    contentParts: [],
  };
}

function appendUserMessageContextState(
  target: ParsedUserMessageContextState,
  source: ParsedUserMessageContextState,
): void {
  target.visibleText += source.visibleText;
  target.terminalContexts.push(...source.terminalContexts);
  target.elementContexts.push(...source.elementContexts);
  target.previewAnnotations.push(...source.previewAnnotations);
  target.contextEntries.push(...source.contextEntries);
  target.contentParts.push(...source.contentParts);
}

function createUserMessageContextEntryIdAllocator(): AllocateUserMessageContextEntryId {
  let nextContextEntryId = 0;
  return (kind, value) => {
    nextContextEntryId += 1;
    return `${kind}:${nextContextEntryId}:${value}`;
  };
}

function createUserMessageContentPartIdAllocator(): AllocateUserMessageContentPartId {
  let nextContentPartId = 0;
  return () => {
    nextContentPartId += 1;
    return `text:${nextContentPartId}`;
  };
}

function extractUserMessageTextContextState(
  prompt: string,
  allocateContextEntryId: AllocateUserMessageContextEntryId,
  allocateContentPartId: AllocateUserMessageContentPartId,
): ParsedUserMessageContextState {
  let visibleText = prompt;
  const terminalContexts: ParsedTerminalContextEntry[] = [];
  const elementContexts: ParsedElementContextEntry[] = [];
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  const contextEntries: ParsedUserMessageContextEntry[] = [];

  while (true) {
    const previewState = extractTrailingPreviewAnnotation(visibleText);
    if (previewState.annotation && previewState.promptText !== visibleText) {
      previewAnnotations.unshift(previewState.annotation);
      contextEntries.unshift({
        kind: "preview",
        id: allocateContextEntryId("preview", previewState.annotation.id),
        annotation: previewState.annotation,
      });
      visibleText = previewState.promptText;
      continue;
    }

    const elementState = extractTrailingElementContexts(visibleText);
    if (elementState.promptText !== visibleText) {
      elementContexts.unshift(...elementState.contexts);
      contextEntries.unshift(
        ...elementState.contexts.map((context): ParsedUserMessageContextEntry => ({
          kind: "element",
          id: allocateContextEntryId("element", `${context.header}:${context.body}`),
          context,
        })),
      );
      visibleText = elementState.promptText;
      continue;
    }

    const terminalState = extractTrailingTerminalContexts(visibleText);
    if (terminalState.promptText !== visibleText) {
      terminalContexts.unshift(...terminalState.contexts);
      contextEntries.unshift(
        ...terminalState.contexts.map((context): ParsedUserMessageContextEntry => ({
          kind: "terminal",
          id: allocateContextEntryId("terminal", `${context.header}:${context.body}`),
          context,
        })),
      );
      visibleText = terminalState.promptText;
      continue;
    }

    const strippedMalformedBlock = stripTrailingMalformedContextBlock(visibleText);
    if (strippedMalformedBlock !== null && strippedMalformedBlock !== visibleText) {
      visibleText = strippedMalformedBlock;
      continue;
    }

    break;
  }

  return {
    visibleText,
    terminalContexts,
    elementContexts,
    previewAnnotations,
    contextEntries,
    contentParts: [
      ...(visibleText.trim().length > 0
        ? [{ kind: "text" as const, id: allocateContentPartId(), text: visibleText }]
        : []),
      ...contextEntries,
    ],
  };
}

function extractUserMessageContextState(prompt: string): ParsedUserMessageContextState {
  const allocateContextEntryId = createUserMessageContextEntryIdAllocator();
  const allocateContentPartId = createUserMessageContentPartIdAllocator();
  const mergedState = createEmptyUserMessageContextState();

  const appendRawTextPart = (text: string) => {
    mergedState.visibleText += text;
    if (text.trim().length > 0) {
      mergedState.contentParts.push({
        kind: "text",
        id: allocateContentPartId(),
        text,
      });
    }
  };

  const trimGeneratedContextSeparator = () => {
    mergedState.visibleText = mergedState.visibleText.replace(/\n+$/, "");
    const lastPart = mergedState.contentParts.at(-1);
    if (lastPart?.kind !== "text") return;

    lastPart.text = lastPart.text.replace(/\n+$/, "");
    if (lastPart.text.length === 0) {
      mergedState.contentParts.pop();
    }
  };

  const appendTextSegment = (text: string) => {
    const strippedMalformedContext = stripTrailingMalformedContextBlock(text);
    const reviewText = strippedMalformedContext ?? text;
    const reviewCommentSegments = parseReviewCommentMessageSegments(reviewText);
    for (const segment of reviewCommentSegments) {
      if (segment.kind === "text") {
        appendUserMessageContextState(
          mergedState,
          extractUserMessageTextContextState(
            segment.text,
            allocateContextEntryId,
            allocateContentPartId,
          ),
        );
        continue;
      }

      const previousText = mergedState.visibleText;
      const separator = previousText.length > 0 && !/(\n\s*){2}$/.test(previousText) ? "\n\n" : "";
      const reviewCommentText = `${separator}${formatReviewCommentContext(segment.comment)}`;
      mergedState.visibleText += reviewCommentText;
      mergedState.contentParts.push({
        kind: "text",
        id: allocateContentPartId(),
        text: reviewCommentText,
      });
    }
  };

  for (const segment of splitTopLevelUserMessageSegments(prompt)) {
    if (segment.kind === "context") {
      const contextState = extractUserMessageTextContextState(
        segment.text,
        allocateContextEntryId,
        allocateContentPartId,
      );
      if (contextState.contextEntries.length > 0) {
        trimGeneratedContextSeparator();
        appendUserMessageContextState(mergedState, contextState);
      } else {
        appendRawTextPart(segment.text);
      }
      continue;
    }

    appendTextSegment(segment.text);
  }

  return mergedState;
}

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  agentPanelModel: AgentPanelModel;
  onOpenAgents: () => void;
  latestMagiRun: ActiveMagiRunSummary | MagiRunSummary | null;
  magiActivityPlacement: ReturnType<typeof resolveMagiActivityPlacement>;
  onOpenMagi: () => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  latestTurnId: TurnId | null;
  /** Current plan step label for the working row, when the turn has a plan. */
  workingStepLabel: string | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = <div className="h-10 sm:h-12" />;

// Header row shown when older turns exist beyond the loaded window. Plain
// button, no spinner animation; the label change is the loading indicator.
function TimelineLoadEarlierHeader({
  loading,
  onLoadEarlier,
  fade,
}: {
  loading: boolean;
  onLoadEarlier: () => void;
  fade: boolean;
}) {
  return (
    <div className={fade ? "pt-10 sm:pt-12" : "pt-3 sm:pt-4"}>
      <div className="mx-auto w-full max-w-3xl pb-2">
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={loading}
          className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
        >
          {loading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      </div>
    </div>
  );
}
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;

function MagiActivityBox(props: {
  readonly environmentId: EnvironmentId;
  readonly run: ActiveMagiRunSummary | MagiRunSummary;
  readonly onOpen: () => void;
}) {
  const detailResult = useAtomValue(
    magiEnvironment.detail({
      environmentId: props.environmentId,
      input: { runId: props.run.runId, includeDiagnostics: false },
    }),
  );
  const detail = Option.getOrNull(AsyncResult.value(detailResult));
  const participantCount = detail?.config.participants.length ?? null;
  const totalTokens =
    detail?.settlements.reduce(
      (total, settlement) => total + (settlement.inputTokens ?? 0) + (settlement.outputTokens ?? 0),
      0,
    ) ?? 0;
  const title =
    props.run.state === "succeeded"
      ? "Magi reached consensus"
      : props.run.state === "turn-limit-reached"
        ? "Magi failed to reach consensus"
        : props.run.state === "failed"
          ? "Magi failed"
          : props.run.state === "cancelled"
            ? "Magi stopped"
            : "Magi deliberating";
  return (
    <div className="w-full px-1 pb-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
        onClick={props.onOpen}
      >
        <Network className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
          {participantCount !== null ? (
            <span>
              {participantCount} participant{participantCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {totalTokens > 0 ? <span>Σ {totalTokens.toLocaleString()}</span> : null}
          <span>
            {props.run.completedMagiTurns} turn{props.run.completedMagiTurns === 1 ? "" : "s"}
          </span>
          <span className="text-info-foreground">
            {isMagiRunTerminal(props.run.state) ? "View ▸" : "Open Magi ▸"}
          </span>
        </span>
      </button>
    </div>
  );
}

function MagiTimelineActivitySlot(props: {
  readonly rowId: string;
  readonly position: "before" | "after";
}) {
  const ctx = use(TimelineRowCtx);
  if (
    ctx.latestMagiRun === null ||
    ctx.magiActivityPlacement?.rowId !== props.rowId ||
    ctx.magiActivityPlacement.position !== props.position
  ) {
    return null;
  }
  return (
    <MagiActivityBox
      environmentId={ctx.activeThreadEnvironmentId}
      run={ctx.latestMagiRun}
      onOpen={ctx.onOpenMagi}
    />
  );
}
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    itemLayout: true,
    layout: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  activeMagiRun?: ActiveMagiRunSummary | null;
  onOpenMagi?: () => void;
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  isWorking: boolean;
  workingStepLabel?: string | null;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  contentInsetEndAdjustment: number;
  /**
   * Whether the timeline should keep pinning to the live edge as content
   * grows. Off while the user is reading history; LegendList's own
   * maintainScrollAtEnd would otherwise re-pin regardless of ChatView's
   * scroll-mode refs whenever the user drifts near the bottom.
   */
  liveFollowEnabled: boolean;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: () => void;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
}

export function scheduleFoldToggleSettlingReset(options: {
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly onSettled: () => void;
}) {
  let disposed = false;
  let secondFrameId: number | null = null;
  const firstFrameId = options.requestAnimationFrame(() => {
    if (disposed) {
      return;
    }
    secondFrameId = options.requestAnimationFrame(() => {
      if (!disposed) {
        options.onSettled();
      }
    });
  });

  return () => {
    disposed = true;
    options.cancelAnimationFrame(firstFrameId);
    if (secondFrameId !== null) {
      options.cancelAnimationFrame(secondFrameId);
    }
  };
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  activeMagiRun = null,
  onOpenMagi = NOOP_OPEN_AGENTS,
  isWorking,
  workingStepLabel = null,
  activeTurnInProgress,
  activeTurnStartedAt,
  agentPanelModel = EMPTY_AGENT_PANEL_MODEL,
  onOpenAgents = NOOP_OPEN_AGENTS,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId,
  onAnchorReady,
  contentInsetEndAdjustment,
  liveFollowEnabled,
  onIsAtEndChange,
  onManualNavigation,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  loadEarlier = null,
}: MessagesTimelineProps) {
  const timelineThreadRef = parseScopedThreadKey(routeThreadKey);
  const magiHistoryResult = useAtomValue(
    magiEnvironment.history({
      environmentId: activeThreadEnvironmentId,
      input: { rootThreadId: timelineThreadRef?.threadId ?? ThreadId.make("unresolved"), limit: 1 },
    }),
  );
  const magiHistory = Option.getOrNull(AsyncResult.value(magiHistoryResult));
  const latestMagiRun = magiHistory?.runs[0] ?? activeMagiRun;
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const safeContentInsetEndAdjustment = Number.isFinite(contentInsetEndAdjustment)
    ? Math.max(0, contentInsetEndAdjustment)
    : 0;
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  }, []);
  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setExpandedTurnIds((existing) => {
        const next = new Set(existing);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey);
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const magiActivityPlacement = useMemo(
    () =>
      latestMagiRun
        ? resolveMagiActivityPlacement(
            rows,
            "startedAt" in latestMagiRun && typeof latestMagiRun.startedAt === "string"
              ? latestMagiRun.startedAt
              : null,
          )
        : null,
    [latestMagiRun, rows],
  );
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === "message" ? row.message.id : null,
    );
    return config ? { ...config, onReady: handleAnchorReady } : undefined;
  }, [anchorMessageId, handleAnchorReady, rows]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state, contentInsetEndAdjustment);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [contentInsetEndAdjustment, listRef, minimapItems, minimapStripMap, onIsAtEndChange]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth));
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      agentPanelModel,
      onOpenAgents,
      latestMagiRun,
      magiActivityPlacement,
      onOpenMagi,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      agentPanelModel,
      onOpenAgents,
      latestMagiRun,
      magiActivityPlacement,
      onOpenMagi,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
      latestTurnId: latestTurn?.turnId ?? null,
      workingStepLabel,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking, latestTurn?.turnId, workingStepLabel],
  );

  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <MagiTimelineActivitySlot rowId={item.id} position="before" />
        <TimelineRowContent row={item} />
        <MagiTimelineActivitySlot rowId={item.id} position="after" />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking && latestMagiRun === null) {
    if (hideEmptyPlaceholder) {
      return null;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={safeContentInsetEndAdjustment}
            maintainScrollAtEnd={
              anchoredEndSpace || !liveFollowEnabled || disclosureToggleSettling
                ? false
                : TIMELINE_MAINTAIN_SCROLL_AT_END
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            onScroll={handleScroll}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            ListHeaderComponent={
              loadEarlier !== null ? (
                <TimelineLoadEarlierHeader
                  loading={loadEarlier.loading}
                  onLoadEarlier={loadEarlier.onLoadEarlier}
                  fade={topFadeEnabled}
                />
              ) : topFadeEnabled ? (
                TIMELINE_LIST_FADE_HEADER
              ) : (
                TIMELINE_LIST_HEADER
              )
            }
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          <TimelineMinimap
            items={minimapItems}
            bottomInset={safeContentInsetEndAdjustment}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  bottomInset,
  hasPersistentGutter,
  hitStripWidth,
  items,
  stripMap,
  onSelect,
}: {
  bottomInset: number;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            const nextIndex =
              event.detail === 0 ? resolvedActiveIndex : resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            event.preventDefault();
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{ top }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle" ||
          row.kind === "turn-plan"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "turn-plan" ? <TurnPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const userMessageContextState = useMemo(
    () => extractUserMessageContextState(row.message.text),
    [row.message.text],
  );
  const renderTerminalContextsInline = textContainsInlineTerminalContextLabels(
    userMessageContextState.visibleText,
    userMessageContextState.terminalContexts,
  );
  const previewImages = userImages.filter((image) => image.name.startsWith("preview-annotation-"));
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const userMessageCopyText = row.message.text;

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-secondary-label text-[11px]">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <UserMessageContentParts
          parts={userMessageContextState.contentParts}
          terminalContexts={
            renderTerminalContextsInline ? userMessageContextState.terminalContexts : []
          }
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd ?? null}
          previewImages={previewImages}
          renderTerminalEntries={!renderTerminalContextsInline}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {userMessageCopyText && (
              <MessageCopyButton text={userMessageCopyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(row.message.streaming)}
          lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
          skills={ctx.skills}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatDayAwareTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

/**
 * Inline folded plan chip: one row per turn that produced plan/todo steps.
 * Collapsed by default — a segment bar plus the in-progress step label —
 * and expands in place to the full step list. Replaces the old plan sidebar.
 */
const TurnPlanTimelineRow = memo(function TurnPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "turn-plan" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { steps } = row.turnPlan.plan;
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const allDone = completedCount === steps.length;
  // Label priority: the in-progress step, else the next pending step (plan
  // just created), else the last step (plan finished, rendered muted).
  const label =
    steps.find((step) => step.status === "inProgress")?.step ??
    steps.find((step) => step.status === "pending")?.step ??
    steps.at(-1)?.step ??
    "Plan";
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="min-w-0 px-1 py-0.5">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
        {steps.length > 1 ? (
          <span aria-hidden className="flex shrink-0 items-center gap-0.5">
            {steps.map((step) => (
              <span
                key={step.step}
                className={cn(
                  "h-[3px] w-2.5 rounded-full",
                  step.status === "completed"
                    ? "bg-success"
                    : step.status === "inProgress"
                      ? "bg-primary"
                      : "bg-muted-foreground/25",
                )}
              />
            ))}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate",
            allDone ? "text-muted-foreground/65" : "font-medium text-foreground/85",
          )}
        >
          {label}
        </span>
        {steps.length > 1 ? (
          <span className="shrink-0 text-muted-foreground/50 tabular-nums">
            {completedCount}/{steps.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="mt-0.5 space-y-px pl-6">
          {steps.map((step) => (
            <div key={step.step} className="flex items-baseline gap-2 text-[12px] leading-5">
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[10px]",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "text-primary"
                      : "text-muted-foreground/40",
                )}
                aria-hidden
              >
                {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  step.status === "completed"
                    ? "text-muted-foreground/55"
                    : step.status === "inProgress"
                      ? "text-foreground/90"
                      : "text-muted-foreground/70",
                )}
              >
                {step.step}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { workingStepLabel } = use(TimelineRowActivityCtx);
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-secondary-label text-[11px] tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span className="shrink-0">
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
        {workingStepLabel ? (
          <span className="min-w-0 truncate text-muted-foreground/55">· {workingStepLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "Work Log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-secondary-label text-[11px]">{groupLabel}</p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : row.hiddenCount === 1
      ? "log entry"
      : "log entries";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-icon-muted">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const activity = use(TimelineRowActivityCtx);
  const isLatestTurn = activity.latestTurnId === turnSummary.turnId;
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const [autoExpanded] = useState(() =>
    shouldAutoExpandChangedFiles(checkpointFiles, isLatestTurn),
  );
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(autoExpanded);
  const expanded = persistedExpanded ?? (isLatestTurn && autoExpanded);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      expanded={expanded}
      showCompactPreview={isLatestTurn}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onExpandedChange={(nextExpanded) =>
        setExpanded(routeThreadKey, turnSummary.turnId, nextExpanded)
      }
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return (
      <span data-user-message-terminal-context="true">
        <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />
      </span>
    );
  },
);

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85"
            data-user-message-element-context="true"
          >
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessageContentParts({
  parts,
  terminalContexts,
  skills,
  markdownCwd,
  previewImages,
  renderTerminalEntries,
}: {
  parts: ParsedUserMessageContentPart[];
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | null;
  previewImages: NonNullable<TimelineMessage["attachments"]>;
  renderTerminalEntries: boolean;
}) {
  let previewImageIndex = 0;

  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "text") {
          return (
            <div key={part.id} className={index > 0 ? "mt-3" : undefined}>
              <CollapsibleUserMessageBody
                text={part.text}
                terminalContexts={terminalContexts}
                skills={skills}
                markdownCwd={markdownCwd ?? undefined}
              />
            </div>
          );
        }

        const image = part.kind === "preview" ? (previewImages[previewImageIndex] ?? null) : null;
        if (part.kind === "preview") {
          previewImageIndex += 1;
        }

        return (
          <UserMessageContextEntry
            key={part.id}
            entry={part}
            image={image}
            renderTerminalEntry={renderTerminalEntries}
          />
        );
      })}
    </>
  );
}

function UserMessageContextEntry({
  entry,
  image,
  renderTerminalEntry,
}: {
  entry: ParsedUserMessageContextEntry;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
  renderTerminalEntry: boolean;
}) {
  if (entry.kind === "terminal") {
    if (!renderTerminalEntry) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-1.5" data-user-message-terminal-contexts="true">
        <UserMessageTerminalContextInlineLabel context={entry.context} />
      </div>
    );
  }

  if (entry.kind === "element") {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5" data-user-message-element-contexts="true">
        <UserMessageElementContextChip context={entry.context} />
      </div>
    );
  }

  return <UserMessagePreviewAnnotationCard annotation={entry.annotation} image={image} />;
}

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div
      className="mt-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70"
      data-user-message-preview-annotation="true"
    >
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-foreground text-xs font-medium">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-secondary-label text-[10px]",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-secondary-label text-xs hover:bg-muted/55 hover:text-message-foreground"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-message-foreground"
            lineBreaks
            parseRawHtml={false}
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-message-foreground text-sm leading-relaxed">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-message-foreground"
                  lineBreaks
                  parseRawHtml={false}
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-message-foreground text-sm leading-relaxed">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-message-foreground"
          lineBreaks
          parseRawHtml={false}
        />,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-message-foreground text-sm leading-relaxed">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-message-foreground"
      lineBreaks
      parseRawHtml={false}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-message-foreground text-xs font-medium">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-secondary-label text-[11px]">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-message-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-icon-muted",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground",
  };
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "changedFiles"
    | "itemType"
    | "patch"
    | "output"
    | "requestKind"
    | "subagentPrompt"
  >,
  workspaceRoot: string | undefined,
) {
  const changedFilesPreview = workEntryChangedFilesPreview(workEntry, workspaceRoot);
  if (
    changedFilesPreview &&
    (workEntry.itemType === "file_change" ||
      workEntry.requestKind === "file-change" ||
      Boolean(workEntry.patch))
  ) {
    return changedFilesPreview;
  }
  if (workEntry.command) return workEntry.command;
  if (workEntry.itemType === "collab_agent_tool_call") {
    const { prompt, output } = resolveSubagentDisplayParts(workEntry);
    return prompt ?? output;
  }
  if (workEntry.subagentPrompt) return workEntry.subagentPrompt;
  if (workEntry.detail) return workEntry.detail;
  return changedFilesPreview;
}

function workEntryChangedFilesPreview(
  workEntry: Pick<TimelineWorkEntry, "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function ToolDetailBlock(props: {
  title: string;
  children: ReactNode;
  mono?: boolean;
  tone?: "default" | "error";
}) {
  return (
    <div className="space-y-1">
      <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
        {props.title}
      </p>
      <div
        className={cn(
          "max-h-80 overflow-auto rounded-md border border-border/55 bg-background/80 px-2 py-1.5 text-[11px] leading-5 text-foreground/78",
          props.mono && "font-mono whitespace-pre-wrap wrap-break-word",
          props.tone === "error" &&
            "border-rose-500/20 bg-rose-500/5 text-rose-800 dark:text-rose-200",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

function normalizedSubagentText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resolveSubagentDisplayParts(
  workEntry: Pick<TimelineWorkEntry, "output" | "subagentPrompt">,
): {
  prompt: string | null;
  output: string | null;
} {
  const prompt = workEntry.subagentPrompt?.trim() ?? "";
  const output = workEntry.output?.trim() ?? "";
  if (!prompt) {
    return { prompt: null, output: output || null };
  }
  if (!output) {
    return { prompt, output: null };
  }

  const normalizedPrompt = normalizedSubagentText(prompt).toLowerCase();
  const normalizedOutput = normalizedSubagentText(output).toLowerCase();
  const redundantPrompt =
    normalizedPrompt === normalizedOutput ||
    normalizedPrompt.startsWith(normalizedOutput) ||
    normalizedOutput.startsWith(normalizedPrompt);

  return {
    prompt: redundantPrompt ? null : prompt,
    output,
  };
}

function hasExpandableWorkEntryDetails(workEntry: TimelineWorkEntry): boolean {
  if (workEntry.itemType === "collab_agent_tool_call") {
    const { prompt, output } = resolveSubagentDisplayParts(workEntry);
    return Boolean(prompt || output);
  }
  return hasStandardExpandableWorkEntryDetails(workEntry);
}

function ToolEntryDetails({
  workEntry,
  workspaceRoot,
}: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const showCommandDetails = hasCommandWorkEntryDetails(workEntry);
  const showFileChangeDetails = hasFileChangeWorkEntryDetails(workEntry);
  const supplementalDetails =
    showCommandDetails || showFileChangeDetails
      ? buildSupplementalToolDetailBody(workEntry, {
          dedupeRenderedCommandOutput: showCommandDetails,
        })
      : null;
  if (showCommandDetails || showFileChangeDetails) {
    return (
      <>
        {showCommandDetails && <CommandEntryDetails workEntry={workEntry} />}
        {showFileChangeDetails && <FileChangeEntryDetails workEntry={workEntry} />}
        {supplementalDetails ? <GenericToolEntryDetails value={supplementalDetails} /> : null}
      </>
    );
  }

  const { prompt, output } =
    workEntry.itemType === "collab_agent_tool_call"
      ? resolveSubagentDisplayParts(workEntry)
      : { prompt: null, output: null };
  if (!prompt && !output) {
    const genericDetails = deriveExpandableWorkEntryDetails(
      workEntry,
      workspaceRoot,
    )?.genericDetail;
    return genericDetails ? <GenericToolEntryDetails value={genericDetails} /> : null;
  }
  return (
    <div className="mt-2 ms-7 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {prompt && (
        <ToolDetailBlock title="Prompt" mono>
          {prompt}
        </ToolDetailBlock>
      )}
      {output && (
        <ToolDetailBlock title="Output" mono>
          {output}
        </ToolDetailBlock>
      )}
    </div>
  );
}

function CommandEntryDetails({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const command = workEntry.command ?? workEntry.rawCommand ?? null;
  const rawCommand =
    workEntry.rawCommand && workEntry.rawCommand !== command ? workEntry.rawCommand : null;
  const hasStreamOutput =
    hasRenderableCommandOutput(workEntry.stdout) || hasRenderableCommandOutput(workEntry.stderr);

  return (
    <div className="mt-2 ms-2 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {command && (
        <ToolDetailBlock title="Command" mono>
          {command}
        </ToolDetailBlock>
      )}
      {rawCommand && (
        <ToolDetailBlock title="Raw command" mono>
          {rawCommand}
        </ToolDetailBlock>
      )}
      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5">
          Exit code {workEntry.exitCode ?? "unknown"}
        </span>
        <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5">
          Duration {workEntry.durationMs != null ? formatDuration(workEntry.durationMs) : "unknown"}
        </span>
      </div>
      {hasRenderableCommandOutput(workEntry.stdout) ? (
        <CommandOutputBlock title="Stdout" value={workEntry.stdout} />
      ) : null}
      {hasRenderableCommandOutput(workEntry.stderr) ? (
        <CommandOutputBlock title="Stderr" value={workEntry.stderr} tone="error" />
      ) : null}
      {!hasStreamOutput && hasRenderableCommandOutput(workEntry.output) ? (
        <CommandOutputBlock title="Output" value={workEntry.output} />
      ) : null}
    </div>
  );
}

function CommandOutputBlock(props: { title: string; value: string; tone?: "default" | "error" }) {
  const [showFull, setShowFull] = useState(false);
  const outputDisplay = useMemo(
    () => deriveCommandOutputDisplay({ value: props.value, showFull }),
    [props.value, showFull],
  );
  const isTruncated = outputDisplay.isTruncated;
  const toggleLabel = `${showFull ? "Collapse" : "Expand"} ${props.title}`;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className={cn(
          "flex items-center gap-1 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
          isTruncated ? "cursor-pointer hover:text-foreground/75" : "cursor-default",
        )}
        disabled={!isTruncated}
        aria-expanded={isTruncated ? showFull : undefined}
        aria-label={isTruncated ? toggleLabel : `${props.title} output`}
        onClick={() => {
          if (isTruncated) {
            setShowFull((value) => !value);
          }
        }}
      >
        <span>{props.title}</span>
        <span className="normal-case tracking-normal">({outputDisplay.suffix})</span>
      </button>
      <button
        type="button"
        className={cn(
          "block max-h-80 w-full overflow-auto rounded-md border border-border/55 bg-background/80 px-2 py-1.5 text-left font-mono text-[11px] leading-5 whitespace-pre-wrap wrap-break-word text-foreground/78",
          props.tone === "error" &&
            "border-rose-500/20 bg-rose-500/5 text-rose-800 dark:text-rose-200",
          isTruncated ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!isTruncated}
        aria-expanded={isTruncated ? showFull : undefined}
        aria-label={isTruncated ? toggleLabel : `${props.title} output`}
        onClick={() => {
          if (isTruncated) {
            setShowFull((value) => !value);
          }
        }}
      >
        {outputDisplay.visibleValue}
      </button>
    </div>
  );
}

function FileChangeEntryDetails({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const ctx = use(TimelineRowCtx);
  const renderablePatch = getRenderablePatch(
    workEntry.patch,
    `tool-file-change:${workEntry.id}:${ctx.resolvedTheme}`,
  );
  const hasInlineDiff = renderablePatch?.kind === "files";
  const displayFiles = deriveFileChangeDisplayFiles({
    changedFiles: workEntry.changedFiles,
    inlineDiffPaths: hasInlineDiff ? renderablePatch.files.map(resolveFileDiffPath) : [],
    workspaceRoot: ctx.workspaceRoot,
  });

  return (
    <div className="mt-2 ms-2 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {displayFiles.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {displayFiles.map((file) => (
            <Tooltip key={`${workEntry.id}:expanded-file:${file.path}`}>
              <TooltipTrigger
                render={
                  <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75" />
                }
              >
                {file.displayPath}
              </TooltipTrigger>
              <TooltipPopup side="top">{file.displayPath}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      )}
      {hasInlineDiff &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={buildFileDiffRenderKey(fileDiff)}
            fileDiff={fileDiff}
            renderCustomHeader={(renderedFileDiff) => (
              <InlineFileDiffHeader
                fileDiff={renderedFileDiff}
                changedFiles={workEntry.changedFiles}
                workspaceRoot={ctx.workspaceRoot}
              />
            )}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <ToolDetailBlock title={renderablePatch.reason} mono>
          {renderablePatch.text}
        </ToolDetailBlock>
      )}
    </div>
  );
}

function GenericToolEntryDetails({ value }: { value: string }) {
  return (
    <div className="mt-2 ms-2 border-s border-border/45 ps-3 pt-0.5">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  );
}

function InlineFileDiffHeader({
  fileDiff,
  changedFiles,
  workspaceRoot,
}: {
  fileDiff: FileDiffMetadata;
  changedFiles: ReadonlyArray<string> | undefined;
  workspaceRoot: string | undefined;
}) {
  const displayPath = resolveInlineFileDiffDisplayPath(fileDiff, changedFiles, workspaceRoot);
  const additions = countDiffHunkChangedLines(fileDiff.hunks, "additionLines");
  const deletions = countDiffHunkChangedLines(fileDiff.hunks, "deletionLines");

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/55 bg-background/80 px-2 py-1 text-[11px]">
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate font-mono text-foreground/85" />}>
          {displayPath}
        </TooltipTrigger>
        <TooltipPopup side="top">{displayPath}</TooltipPopup>
      </Tooltip>
      <span className="shrink-0">
        <DiffStatLabel additions={additions} deletions={deletions} />
      </span>
    </div>
  );
}

function resolveInlineFileDiffDisplayPath(
  fileDiff: FileDiffMetadata,
  changedFiles: ReadonlyArray<string> | undefined,
  workspaceRoot: string | undefined,
): string {
  const rawPath = resolveFileDiffPath(fileDiff);
  const matchesDiffPath = createChangedFileDiffPathMatcher(rawPath);
  const matchedChangedFile = changedFiles?.find(matchesDiffPath);

  return formatWorkspaceRelativePath(matchedChangedFile ?? rawPath, workspaceRoot);
}

function countDiffHunkChangedLines(
  hunks: ReadonlyArray<Hunk>,
  lineCountKey: "additionLines" | "deletionLines",
): number {
  let count = 0;
  for (const hunk of hunks) {
    count += hunk[lineCountKey];
  }
  return count;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A1 spawn CTA: one anchored row per workflow run (or per-turn direct-spawn
 * batch). Live status is derived from the shared agent panel model at render
 * time — the row itself never re-renders a roster; the Agents panel is the
 * only roster. Freezes to past tense when every member settles. Static dot,
 * no animation.
 */
const AgentSpawnCtaRow = memo(function AgentSpawnCtaRow(props: { workEntry: TimelineWorkEntry }) {
  const { workEntry } = props;
  const { agentPanelModel, onOpenAgents } = use(TimelineRowCtx);
  const spawn = workEntry.agentSpawn;
  if (!spawn) {
    return null;
  }

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const agents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );

  const running = agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  const waiting = agents.filter((agent) => agent.status === "waiting").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  // The coordinator's own status is authoritative for workflows: dynamic
  // spawns mean the member list can be momentarily all-settled while the
  // run is still mid-flight (the "completed" lie from live testing). A
  // workflow is live until the coordinator itself reaches a terminal state.
  const coordinatorStatus = workflowGroup?.workflow.status;
  const coordinatorSettled =
    coordinatorStatus === "completed" ||
    coordinatorStatus === "failed" ||
    coordinatorStatus === "cancelled" ||
    coordinatorStatus === "interrupted";
  const live = workflowGroup !== undefined ? !coordinatorSettled : running + waiting > 0;
  // Same rule as the panel footer: providers may aggregate member usage into
  // the coordinator, so count the coordinator only when no members exist.
  const totalTokens = agents.reduce(
    (sum, agent) => sum + (agent.usage?.totalTokens ?? 0),
    spawn.workflowId && agents.length === 0 ? (workflowGroup?.workflow.usage?.totalTokens ?? 0) : 0,
  );

  const livePhase = workflowGroup?.phases.find((phase) => phase.state === "running");
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;

  // One steady in-flight presentation (monitoring-pill rule): waiting and
  // stalled agents read as working; only settled states differentiate.
  const working = running + waiting;
  const dotClass = live ? "bg-info" : failed > 0 ? "bg-destructive" : "bg-success";
  const lead = live
    ? `Kicked off ${agentCount} subagent${agentCount === 1 ? "" : "s"}`
    : `Ran ${agentCount} subagent${agentCount === 1 ? "" : "s"}`;
  const status = live
    ? livePhase
      ? `${livePhase.title} · ${livePhase.activeCount} working`
      : working > 0
        ? `${working} working`
        : "working"
    : failed > 0
      ? `${failed} failed`
      : "✓ completed";

  return (
    <button
      type="button"
      onClick={onOpenAgents}
      className="-mx-1 flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      <WorkEntryIconSvg name="bot" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="font-medium">{lead}</span>
        {workflowName ? <span className="text-muted-foreground"> · {workflowName}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
        <span>{status}</span>
        {totalTokens > 0 ? (
          <span className="tabular-nums">Σ {formatSubagentTokenCount(totalTokens)}</span>
        ) : null}
        <span className="text-info-foreground">{live ? "Open Agents ▸" : "View ▸"}</span>
      </span>
    </button>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  // Before any hooks: spawn CTA rows render their own component.
  if (workEntry.agentSpawn) {
    return <AgentSpawnCtaRow workEntry={workEntry} />;
  }
  return <PlainWorkEntryRow workEntry={workEntry} workspaceRoot={workspaceRoot} />;
});

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
  const requestedCommandOutputActivityIds = useMemo(
    () => workEntry.commandOutputActivityIds ?? [workEntry.id],
    [workEntry.commandOutputActivityIds, workEntry.id],
  );
  const detailCacheKey = `${ctx.threadRef?.environmentId ?? ""}\0${ctx.threadRef?.threadId ?? ""}\0${workEntry.id}`;
  const deferredDetailCacheRef = useRef<{
    key: string;
    activitiesById: Map<string, OrchestrationThreadActivity>;
  }>({ key: detailCacheKey, activitiesById: new Map() });
  if (deferredDetailCacheRef.current.key !== detailCacheKey) {
    deferredDetailCacheRef.current = { key: detailCacheKey, activitiesById: new Map() };
  }
  const missingCommandOutputActivityIds = requestedCommandOutputActivityIds.filter(
    (activityId) => !deferredDetailCacheRef.current.activitiesById.has(activityId),
  );
  const deferredCommandOutputQuery = useEnvironmentQuery(
    expanded &&
      workEntry.commandOutputAvailable === true &&
      ctx.threadRef !== null &&
      missingCommandOutputActivityIds.length > 0
      ? threadActivityEnvironment.details({
          environmentId: ctx.threadRef.environmentId,
          input: {
            threadId: ctx.threadRef.threadId,
            activityIds: missingCommandOutputActivityIds.map((activityId) =>
              EventId.make(activityId),
            ),
          },
        })
      : null,
  );
  if (deferredCommandOutputQuery.data !== null) {
    for (const detailActivity of deferredCommandOutputQuery.data.activities) {
      deferredDetailCacheRef.current.activitiesById.set(detailActivity.id, detailActivity);
    }
  }
  const detailActivities = requestedCommandOutputActivityIds.flatMap((activityId) => {
    const detailActivity = deferredDetailCacheRef.current.activitiesById.get(activityId);
    return detailActivity === undefined ? [] : [detailActivity];
  });
  const detailedWorkEntry = useMemo(() => {
    return mergeDeferredCommandOutput(workEntry, detailActivities);
  }, [detailActivities, workEntry]);
  const hasDerivedCommandDetail = useMemo(
    () =>
      detailActivities.length === 0 ||
      hasRenderableCommandOutputDetail(deriveWorkLogEntries(detailActivities)),
    [detailActivities],
  );
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const changedFilesPreview = workEntryChangedFilesPreview(workEntry, workspaceRoot);
  const previewIsChangedFiles =
    hasChangedFiles && preview !== null && preview === changedFilesPreview;
  const canExpand = hasExpandableWorkEntryDetails(workEntry);
  const toggleExpanded = useCallback(() => {
    if (!canExpand) {
      return;
    }
    setExpanded((value) => !value);
  }, [canExpand]);
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-icon-muted"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-expanded": expanded,
        "aria-label": expanded ? `Collapse ${displayText}` : `Expand ${displayText}`,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (
            shouldToggleWorkEntryRowFromKeyDown({
              key: e.key,
              targetIsCurrentTarget: e.currentTarget === e.target,
            })
          ) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      data-tool-entry-expanded={expanded ? "true" : "false"}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-secondary-label">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-icon-muted">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div
          className="mt-1 flex flex-wrap gap-1"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <Tooltip key={`${workEntry.id}:${filePath}`}>
                <TooltipTrigger
                  render={
                    <span
                      className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                      aria-label={displayPath}
                    />
                  }
                >
                  {displayPath}
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))]">
                  <span className="font-mono text-[11px] whitespace-nowrap">{displayPath}</span>
                </TooltipPopup>
              </Tooltip>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {canExpand && expanded ? (
        <div className="cursor-default" onClick={stopRowToggle} onPointerDown={stopRowToggle}>
          <ToolEntryDetails workEntry={detailedWorkEntry} workspaceRoot={workspaceRoot} />
          {workEntry.commandOutputAvailable === true && deferredCommandOutputQuery.isPending ? (
            <div className="mt-2 ms-7 text-[11px] text-muted-foreground/65" role="status">
              Loading command output…
            </div>
          ) : null}
          {workEntry.commandOutputAvailable === true && deferredCommandOutputQuery.error ? (
            <div className="mt-2 ms-7 flex items-center gap-2 text-[11px] text-destructive">
              <span>Couldn’t load command output.</span>
              <button
                type="button"
                className="text-info-foreground underline underline-offset-2"
                onClick={deferredCommandOutputQuery.refresh}
              >
                Retry
              </button>
            </div>
          ) : null}
          {workEntry.commandOutputAvailable === true &&
          deferredCommandOutputQuery.data !== null &&
          deferredCommandOutputQuery.data.failedActivityIds.length > 0 ? (
            <div className="mt-2 ms-7 flex items-center gap-2 text-[11px] text-destructive">
              <span>Some command output couldn’t be loaded.</span>
              <button
                type="button"
                className="text-info-foreground underline underline-offset-2"
                onClick={deferredCommandOutputQuery.refresh}
              >
                Retry
              </button>
            </div>
          ) : null}
          {workEntry.commandOutputAvailable === true &&
          deferredCommandOutputQuery.data !== null &&
          !hasDerivedCommandDetail ? (
            <div className="mt-2 ms-7 text-[11px] text-destructive">
              No command output was returned.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

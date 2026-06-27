import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { useNavigate } from "@tanstack/react-router";
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
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata, Hunk } from "@pierre/diffs/types";
import {
  deriveTimelineEntries,
  formatDuration,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import {
  formatSubagentDuration,
  formatTerminalSubagentStatusDuration,
  LiveSubagentDuration,
  subagentStatusToneClass,
  type SubagentThreadStatus,
} from "../../subagentDisplay";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
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
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  buildSupplementalToolDetailBody,
  computeStableMessagesTimelineRows,
  filterChangedFilesWithoutInlineDiff,
  getRenderableCommandOutputLines,
  hasCommandWorkEntryDetails,
  hasFileChangeWorkEntryDetails,
  hasRenderableCommandOutput,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  shouldToggleWorkEntryRowFromKeyDown,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadShell } from "../../state/entities";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";

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
import { ThreadConversationWidthContainer } from "./ThreadConversationWidth";

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
        ...elementState.contexts.map(
          (context): ParsedUserMessageContextEntry => ({
            kind: "element",
            id: allocateContextEntryId("element", `${context.header}:${context.body}`),
            context,
          }),
        ),
      );
      visibleText = elementState.promptText;
      continue;
    }

    const terminalState = extractTrailingTerminalContexts(visibleText);
    if (terminalState.promptText !== visibleText) {
      terminalContexts.unshift(...terminalState.contexts);
      contextEntries.unshift(
        ...terminalState.contexts.map(
          (context): ParsedUserMessageContextEntry => ({
            kind: "terminal",
            id: allocateContextEntryId("terminal", `${context.header}:${context.body}`),
            context,
          }),
        ),
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
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const COMMAND_OUTPUT_TAIL_LINES = 40;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
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
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
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
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
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
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const safeContentInsetEndAdjustment = Number.isFinite(contentInsetEndAdjustment)
    ? Math.max(0, contentInsetEndAdjustment)
    : 0;

  // Toggling a fold inserts/removes rows between the fold row and the final
  // message; temporarily suppress bottom anchoring while row measurements settle.
  const [foldToggleSettling, setFoldToggleSettling] = useState(false);
  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    setFoldToggleSettling(true);
    setExpandedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!foldToggleSettling) {
      return;
    }
    return scheduleFoldToggleSettlingReset({
      requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
      onSettled: () => {
        setFoldToggleSettling(false);
      },
    });
  }, [foldToggleSettling]);
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorElement?: HTMLElement) => {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null;

      flushSync(() => {
        setExpandedWorkGroupIds((existing) => {
          const next = new Set(existing);
          if (next.has(groupId)) {
            next.delete(groupId);
          } else {
            next.add(groupId);
          }
          return next;
        });
      });

      if (anchorBottomBeforeToggle === null || !anchorElement) {
        return;
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle;
      if (Math.abs(delta) < 0.5) {
        return;
      }

      const list = listRef.current;
      const currentScroll = list?.getState?.().scroll;
      if (list && typeof currentScroll === "number") {
        list.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [listRef],
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
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const handleAnchorSizeChanged = useCallback(
    (size: number) => {
      if (anchorMessageId !== null) {
        onAnchorSizeChanged(anchorMessageId, size);
      }
    },
    [anchorMessageId, onAnchorSizeChanged],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === "message" ? row.message.id : null,
    );
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined;
  }, [anchorMessageId, handleAnchorReady, handleAnchorSizeChanged, rows]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

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
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <ThreadConversationWidthContainer
        className="w-full min-w-0 overflow-x-clip"
        data-timeline-root="true"
      >
        <TimelineRowContent row={item} />
      </ThreadConversationWidthContainer>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
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
          maintainScrollAtEnd={!foldToggleSettling}
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition={{
            data: true,
            size: false,
          }}
          onScroll={handleScroll}
          className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5"
          ListHeaderComponent={TIMELINE_LIST_HEADER}
          ListFooterComponent={TIMELINE_LIST_FOOTER}
        />
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
          row.kind === "work-toggle"
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
      <div className="relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
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
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
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
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
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
                  {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
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

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
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
        <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
          {groupLabel}
        </p>
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
  const labelNoun = row.onlyToolEntries ? "tool call" : "log entry";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) => {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>("[data-timeline-row-id]") ?? event.currentTarget;
        ctx.onToggleWorkGroup(row.groupId, anchorElement);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {labelNoun}
          {row.hiddenCount === 1 ? "" : "s"}
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
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="sticky top-2 z-10 mb-1.5 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
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
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] text-muted-foreground",
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
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
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
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
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
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
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
          className="text-foreground"
          lineBreaks
        />,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
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
      className="text-foreground"
      lineBreaks
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
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
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
          className="text-foreground"
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
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
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
    | "subagentChildren"
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
  if ((workEntry.subagentChildren?.length ?? 0) > 0) return null;
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

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
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
    case "collab_agent_tool_call":
      return "hammer";
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

function hasExpandableWorkEntryDetails(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): boolean {
  if (hasCommandWorkEntryDetails(workEntry) || hasFileChangeWorkEntryDetails(workEntry)) {
    return true;
  }
  if (workEntry.itemType === "collab_agent_tool_call") {
    if ((workEntry.subagentChildren?.length ?? 0) > 0) {
      return false;
    }
    const { prompt, output } = resolveSubagentDisplayParts(workEntry);
    return Boolean(prompt || output);
  }
  return buildToolCallExpandedBody(workEntry, workspaceRoot) !== null;
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
    const genericDetails = buildToolCallExpandedBody(workEntry, workspaceRoot);
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
          Duration{" "}
          {workEntry.durationMs !== undefined ? formatDuration(workEntry.durationMs) : "unknown"}
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
  const lines = useMemo(() => getRenderableCommandOutputLines(props.value), [props.value]);
  const isTruncated = lines.length > COMMAND_OUTPUT_TAIL_LINES;
  const toggleLabel = `${showFull ? "Collapse" : "Expand"} ${props.title}`;
  const visibleValue =
    showFull || !isTruncated
      ? lines.join("\n")
      : lines.slice(-COMMAND_OUTPUT_TAIL_LINES).join("\n");
  const suffix = isTruncated
    ? showFull
      ? `${lines.length.toLocaleString()} lines`
      : `last ${COMMAND_OUTPUT_TAIL_LINES} of ${lines.length.toLocaleString()} lines`
    : `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}`;

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
        <span className="normal-case tracking-normal">({suffix})</span>
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
        {visibleValue}
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
  const changedFilesWithoutInlineDiff = hasInlineDiff
    ? filterChangedFilesWithoutInlineDiff(
        workEntry.changedFiles,
        renderablePatch.files.map(resolveFileDiffPath),
      )
    : (workEntry.changedFiles ?? []);

  return (
    <div className="mt-2 ms-2 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {changedFilesWithoutInlineDiff.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {changedFilesWithoutInlineDiff.map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, ctx.workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:expanded-file:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
        </div>
      )}
      {hasInlineDiff &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
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
      <span className="min-w-0 truncate font-mono text-foreground/85" title={displayPath}>
        {displayPath}
      </span>
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
  const normalizedRawPath = rawPath.replace(/\\/gu, "/");
  const matchedChangedFile = changedFiles?.find((filePath) => {
    const normalizedChangedFile = filePath.replace(/\\/gu, "/");
    return (
      normalizedChangedFile === normalizedRawPath ||
      normalizedChangedFile.endsWith(`/${normalizedRawPath}`) ||
      normalizedRawPath.endsWith(`/${normalizedChangedFile.replace(/^\/+/u, "")}`)
    );
  });

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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
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
  const canExpand = hasExpandableWorkEntryDetails(workEntry, workspaceRoot);
  const toggleExpanded = useCallback(() => {
    if (!canExpand) {
      return;
    }
    setExpanded((value) => !value);
  }, [canExpand]);
  if (workEntry.itemType === "collab_agent_tool_call" && workEntry.subagentChildren?.length) {
    return <SubagentWorkEntryRows workEntry={workEntry} />;
  }
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
          ? "text-muted-foreground/65"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground/82";
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
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
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
          <ToolEntryDetails workEntry={workEntry} workspaceRoot={workspaceRoot} />
        </div>
      ) : null}
    </div>
  );
});

const SubagentWorkEntryRows = memo(function SubagentWorkEntryRows({
  workEntry,
}: {
  workEntry: TimelineWorkEntry;
}) {
  return (
    <div className="space-y-1 py-0.5">
      {workEntry.subagentChildren?.map((child) => (
        <SubagentWorkEntryButton
          key={`${workEntry.id}:subagent:${child.threadId}:${child.parentItemId ?? ""}`}
          parentCreatedAt={workEntry.createdAt}
          threadId={child.threadId}
          {...(workEntry.turnId ? { parentTurnId: workEntry.turnId } : {})}
          {...(child.parentItemId ? { parentItemId: child.parentItemId } : {})}
          {...((child.titleSeed ?? workEntry.subagentPrompt ?? workEntry.detail)
            ? { titleSeed: child.titleSeed ?? workEntry.subagentPrompt ?? workEntry.detail }
            : {})}
        />
      ))}
    </div>
  );
});

export function subagentRelationMatchesBlock(input: {
  parentItemId?: string | null;
  parentTurnId?: TurnId | null;
  relationParentItemId?: string | null;
  relationParentTurnId?: TurnId | null;
}): boolean {
  const parentItemId = input.parentItemId ?? null;
  const relationParentItemId = input.relationParentItemId ?? null;
  const parentTurnId = input.parentTurnId ?? null;
  const relationParentTurnId = input.relationParentTurnId ?? null;
  const turnIdsConflict =
    parentTurnId && relationParentTurnId && parentTurnId !== relationParentTurnId;

  if (parentItemId && relationParentItemId) {
    if (parentItemId !== relationParentItemId) {
      return false;
    }
    // Provider item ids can repeat across turns, so a known turn mismatch must
    // keep a stale relation from claiming a newer work-log block.
    return !turnIdsConflict;
  }

  return !turnIdsConflict;
}

const SubagentWorkEntryButton = memo(function SubagentWorkEntryButton(props: {
  parentCreatedAt: string;
  parentItemId?: string;
  parentTurnId?: TurnId;
  threadId: ThreadId;
  titleSeed?: string;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const childShell = useThreadShell(scopeThreadRef(ctx.activeThreadEnvironmentId, props.threadId));
  const relation =
    childShell?.parentRelation?.kind === "subagent" ? childShell.parentRelation : null;
  const rawTitle = childShell?.title?.trim();
  const title = rawTitle && rawTitle !== "Subagent" ? rawTitle : null;
  const displayTitle = title ? `Subagent - ${title}` : "Subagent";
  const terminalSnapshotRef = useRef<{
    status: Exclude<SubagentThreadStatus, "running">;
    startedAt: string;
    completedAt: string | null;
  } | null>(null);
  const relationParentItemId = relation?.parentItemId ?? null;
  const relationParentTurnId = relation?.parentTurnId ?? null;
  const relationMatchesThisBlock = subagentRelationMatchesBlock({
    parentItemId: props.parentItemId ?? null,
    parentTurnId: props.parentTurnId ?? null,
    relationParentItemId,
    relationParentTurnId,
  });
  if (relation && relationMatchesThisBlock && relation.status !== "running") {
    terminalSnapshotRef.current = {
      status: relation.status,
      startedAt: relation.startedAt,
      completedAt: relation.completedAt,
    };
  }
  const parentCreatedAfterRelationCompleted = Boolean(
    props.parentItemId &&
    relation &&
    relation.status !== "running" &&
    relation.completedAt &&
    Date.parse(props.parentCreatedAt) > Date.parse(relation.completedAt),
  );
  const displayState =
    relation && relationMatchesThisBlock
      ? {
          status: relation.status,
          startedAt: relation.startedAt,
          completedAt: relation.completedAt,
        }
      : parentCreatedAfterRelationCompleted
        ? {
            status: "running" as const,
            startedAt: props.parentCreatedAt,
            completedAt: null,
          }
        : terminalSnapshotRef.current
          ? terminalSnapshotRef.current
          : relation?.status === "running"
            ? {
                status: "completed" as const,
                startedAt: props.parentCreatedAt,
                completedAt: null,
              }
            : {
                status: relation?.status ?? null,
                startedAt: relation?.startedAt ?? props.parentCreatedAt,
                completedAt: relation?.completedAt ?? null,
              };
  const status = displayState.status;
  const startedAt = displayState.startedAt;
  const completedAt = displayState.completedAt;
  const statusDurationLabel =
    status === "running" ? (
      <LiveSubagentDuration startedAt={startedAt} />
    ) : (
      formatTerminalSubagentStatusDuration(status, formatSubagentDuration(startedAt, completedAt))
    );

  const openChildThread = useCallback(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(ctx.activeThreadEnvironmentId, props.threadId)),
    });
  }, [ctx.activeThreadEnvironmentId, navigate, props.threadId]);

  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-background/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={openChildThread}
      title={`Open ${displayTitle}`}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          subagentStatusToneClass(status),
        )}
        aria-hidden="true"
      >
        <BotIcon className="size-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground/82">
          {displayTitle}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground/62">
          {statusDurationLabel}
        </span>
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-foreground/75" />
    </button>
  );
});

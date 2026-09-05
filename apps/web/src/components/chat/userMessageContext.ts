import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import {
  extractTrailingTerminalContexts,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
} from "../../reviewCommentContext";

export interface ParsedUserMessageContextState {
  visibleText: string;
  terminalContexts: ParsedTerminalContextEntry[];
  elementContexts: ParsedElementContextEntry[];
  previewAnnotations: ParsedPreviewAnnotation[];
  contextEntries: ParsedUserMessageContextEntry[];
  contentParts: ParsedUserMessageContentPart[];
}

export type ParsedUserMessageContentPart =
  | { kind: "text"; id: string; text: string }
  | ParsedUserMessageContextEntry;

export type ParsedUserMessageContextEntry =
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

export function extractUserMessageContextState(prompt: string): ParsedUserMessageContextState {
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

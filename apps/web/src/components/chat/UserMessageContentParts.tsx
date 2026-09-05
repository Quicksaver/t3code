import { type ScopedThreadRef, type ServerProviderSkill } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { Fragment, memo, useState, type ReactNode } from "react";
import { MousePointerClickIcon, PaintbrushIcon } from "lucide-react";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { type ChatImageAttachment } from "../../types";
import { type ParsedElementContextEntry } from "~/lib/elementContext";
import { type ParsedPreviewAnnotation } from "~/lib/previewAnnotation";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { SkillInlineText } from "./SkillInlineText";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import {
  type ParsedUserMessageContentPart,
  type ParsedUserMessageContextEntry,
} from "./userMessageContext";

export function UserMessageContentParts({
  parts,
  terminalContexts,
  skills,
  markdownCwd,
  previewImages,
  renderTerminalEntries,
  threadRef,
  workspaceRoot,
  resolvedTheme,
  onImageExpand,
}: {
  parts: ParsedUserMessageContentPart[];
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | null;
  previewImages: ChatImageAttachment[];
  renderTerminalEntries: boolean;
  threadRef: ScopedThreadRef | null;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onImageExpand: (preview: ExpandedImagePreview) => void;
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
                threadRef={threadRef}
                workspaceRoot={workspaceRoot}
                resolvedTheme={resolvedTheme}
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
            onImageExpand={onImageExpand}
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
  onImageExpand,
}: {
  entry: ParsedUserMessageContextEntry;
  image: ChatImageAttachment | null;
  renderTerminalEntry: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
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

  return (
    <UserMessagePreviewAnnotationCard
      annotation={entry.annotation}
      image={image}
      onImageExpand={onImageExpand}
    />
  );
}

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

function UserMessagePreviewAnnotationCard({
  annotation,
  image,
  onImageExpand,
}: {
  annotation: ParsedPreviewAnnotation;
  image: ChatImageAttachment | null;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  return (
    <div
      className="mt-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70"
      data-user-message-preview-annotation="true"
    >
      {image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${image.name}`}
          onClick={() => {
            const preview = buildExpandedImagePreview([image], image.id);
            if (preview) onImageExpand(preview);
          }}
        >
          <img
            src={image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {annotation.comment ? (
          <div className="max-w-80 truncate text-foreground text-xs font-medium">
            {annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-secondary-label text-[10px]",
            annotation.comment && "mt-1",
          )}
        >
          {annotation.targetSummary ? (
            <span className="truncate">{annotation.targetSummary}</span>
          ) : null}
          {annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {annotation.styleChanges.length}
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
  threadRef: ScopedThreadRef | null;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
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
            threadRef={props.threadRef}
            workspaceRoot={props.workspaceRoot}
            resolvedTheme={props.resolvedTheme}
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
  threadRef: ScopedThreadRef | null;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
}) {
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
            threadRef={props.threadRef ?? undefined}
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
                  threadRef={props.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-message-foreground"
                  lineBreaks
                  parseRawHtml={false}
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              markdownCwd={props.markdownCwd}
              threadRef={props.threadRef}
              skills={props.skills}
              workspaceRoot={props.workspaceRoot}
              resolvedTheme={props.resolvedTheme}
            />
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
          threadRef={props.threadRef ?? undefined}
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
      threadRef={props.threadRef ?? undefined}
      skills={props.skills}
      className="text-message-foreground"
      lineBreaks
      parseRawHtml={false}
    />
  );
});

function UserMessageReviewCommentCard({
  comment,
  markdownCwd,
  threadRef,
  skills,
  workspaceRoot,
  resolvedTheme,
}: {
  comment: ReviewCommentContext;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
}) {
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-message-foreground text-xs font-medium">
          {formatWorkspaceRelativePath(comment.filePath, workspaceRoot)}
        </div>
        <div className="text-secondary-label text-[11px]">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={markdownCwd}
          threadRef={threadRef ?? undefined}
          skills={skills}
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
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
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

import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
      onSizeChanged?: (size: number) => void;
    };
    contentInsetEndAdjustment?: number;
    className?: string;
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onSizeChanged?.(240);
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

vi.mock("./MessageCopyButton", () => ({
  MessageCopyButton: ({ text }: { text: string }) => (
    <button
      type="button"
      aria-label="Copy link"
      data-copy-text={text.includes("<") ? "[contains-raw-markup]" : text}
    />
  ),
}));

const storeMock = vi.hoisted(() => ({
  state: {
    environmentStateById: {},
  } as {
    environmentStateById: Record<string, unknown>;
  },
}));

vi.mock("../../state/entities", () => ({
  useActiveEnvironmentId: () => "environment-local",
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref === null
      ? null
      : ((
          storeMock.state.environmentStateById[ref.environmentId] as
            | {
                threadShellById?: Record<string, unknown>;
              }
            | undefined
        )?.threadShellById?.[ref.threadId] ?? null),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
      removeAttribute: () => {},
      setAttribute: () => {},
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

beforeEach(() => {
  storeMock.state = {
    environmentStateById: {},
  };
});

describe("subagentRelationMatchesBlock", () => {
  it("requires matching turn ids when matching reusable parent item ids", async () => {
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline");

    expect(
      subagentRelationMatchesBlock({
        parentItemId: "call-send-input",
        parentTurnId: TurnId.make("turn-newer"),
        relationParentItemId: "call-send-input",
        relationParentTurnId: TurnId.make("turn-older"),
      }),
    ).toBe(false);
  });

  it("keeps matching parent item ids when the work-log turn id is missing", async () => {
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline");

    expect(
      subagentRelationMatchesBlock({
        parentItemId: "call-send-input",
        parentTurnId: null,
        relationParentItemId: "call-send-input",
        relationParentTurnId: TurnId.make("turn-followup"),
      }),
    ).toBe(true);
  });

  it("falls back to turn matching when either parent item id is absent", async () => {
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline");

    expect(
      subagentRelationMatchesBlock({
        parentTurnId: TurnId.make("turn-followup"),
        relationParentItemId: "call-send-input",
        relationParentTurnId: TurnId.make("turn-followup"),
      }),
    ).toBe(true);
  });
});

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function expectNoContextTagLeak(markup: string) {
  for (const tag of ["terminal_context", "element_context", "preview_annotation"]) {
    expect(markup).not.toContain(`<${tag}`);
    expect(markup).not.toContain(`</${tag}>`);
    expect(markup).not.toContain(`&lt;${tag}`);
    expect(markup).not.toContain(`&lt;/${tag}&gt;`);
  }
}

function expectMarkupOrder(markup: string, ...needles: string[]) {
  let previousIndex = -1;
  for (const needle of needles) {
    const index = markup.indexOf(needle);
    expect(index, `${needle} should exist`).toBeGreaterThan(-1);
    expect(index, `${needle} should appear after the previous marker`).toBeGreaterThan(
      previousIndex,
    );
    previousIndex = index;
  }
}

describe("MessagesTimeline", () => {
  it("passes maintainScrollAtEnd while fold rows are not settling", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
  });

  it("re-enables fold anchoring after the fold-settling frames complete", async () => {
    const { scheduleFoldToggleSettlingReset } = await import("./MessagesTimeline");
    const frameCallbacks: FrameRequestCallback[] = [];
    const canceledFrameIds: number[] = [];
    let settled = false;
    const cleanup = scheduleFoldToggleSettlingReset({
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: (handle) => {
        canceledFrameIds.push(handle);
      },
      onSettled: () => {
        settled = true;
      },
    });

    expect(settled).toBe(false);
    frameCallbacks[0]?.(0);
    expect(settled).toBe(false);
    frameCallbacks[1]?.(16);
    expect(settled).toBe(true);
    cleanup();
    expect(canceledFrameIds).toEqual([1, 2]);
  });

  it("keeps a canceled fold-settling reset from re-enabling anchoring", async () => {
    const { scheduleFoldToggleSettlingReset } = await import("./MessagesTimeline");
    const frameCallbacks: FrameRequestCallback[] = [];
    let settled = false;
    const cleanup = scheduleFoldToggleSettlingReset({
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: () => {},
      onSettled: () => {
        settled = true;
      },
    });

    cleanup();
    frameCallbacks[0]?.(0);
    frameCallbacks[1]?.(16);

    expect(settled).toBe(false);
  });

  it("uses LegendList isNearEnd when deciding whether the live edge is visible", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);
  });

  it("anchors a sent attachment message using its measured height", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const onAnchorReady = vi.fn();
    const onAnchorSizeChanged = vi.fn();
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
        attachments: [
          {
            type: "image" as const,
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        onAnchorSizeChanged={onAnchorSizeChanged}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(markup).toContain('data-anchor-index="1"');
    expect(markup).toContain('data-anchor-offset="16"');
    expect(markup).toContain('data-anchor-on-ready="true"');
    expect(markup).not.toContain("data-anchor-max-size=");
    expect(markup).toContain('data-content-inset-end="144"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-visible-content-position="object"');
    expect(markup).toContain('data-maintain-visible-content-position-data="true"');
    expect(markup).toContain('data-maintain-visible-content-position-size="false"');
    expect(onAnchorReady).toHaveBeenCalledOnce();
    expect(onAnchorReady).toHaveBeenCalledWith(secondEntry.message.id, 1);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(secondEntry.message.id, 240);
  });

  it("passes updated contentInsetEndAdjustment values to the underlying list", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const timelineEntries = [buildUserTimelineEntry("Prompt.")];
    const firstMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={timelineEntries}
        contentInsetEndAdjustment={48}
      />,
    );
    const secondMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={timelineEntries}
        contentInsetEndAdjustment={96}
      />,
    );

    expect(firstMarkup).toContain('data-content-inset-end="48"');
    expect(secondMarkup).toContain('data-content-inset-end="96"');
  });

  it("normalizes invalid contentInsetEndAdjustment values", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const negativeMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Prompt.")]}
        contentInsetEndAdjustment={-24}
      />,
    );
    const invalidMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Prompt.")]}
        contentInsetEndAdjustment={Number.NaN}
      />,
    );

    expect(negativeMarkup).toContain('data-content-inset-end="0"');
    expect(invalidMarkup).toContain('data-content-inset-end="0"');
  });

  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders local skill references as chips in user message bubbles", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("$update-main $piz-git-workflow")]}
        skills={[
          {
            name: "update-main",
            displayName: "Update Main",
          },
          {
            name: "piz-git-workflow",
            displayName: "Piz Git Workflow",
          },
        ]}
      />,
    );

    expect(markup).toContain("Update Main");
    expect(markup).toContain("Piz Git Workflow");
    expect(markup).toContain('data-markdown-copy="$update-main"');
    expect(markup).toContain('data-markdown-copy="$piz-git-workflow"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("renders chips for standalone element-pick context messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("SubmitButton");
    expect(markup).toContain('data-user-message-element-context="true"');
    expectNoContextTagLeak(markup);
  });

  it("strips terminal and element context blocks before trailing preview annotations", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Fix this interaction.",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 7-8:",
              "  7 | pnpm test",
              "  8 | failing assertion",
              "</terminal_context>",
              "",
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "</element_context>",
              "",
              "<preview_annotation>",
              "Preview annotation:",
              "Id: annotation_1",
              "Page: Example",
              "Targets: 1 selected element.",
              "</preview_annotation>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Fix this interaction.");
    expect(markup).toContain("Terminal 1 lines 7-8");
    expect(markup).toContain("SubmitButton");
    expect(markup).toContain("1 selected element.");
    expect(markup).toContain('data-user-message-terminal-context="true"');
    expect(markup).toContain('data-user-message-element-context="true"');
    expect(markup).toContain('data-user-message-preview-annotation="true"');
    expectMarkupOrder(
      markup,
      'data-user-message-body="true"',
      'data-user-message-terminal-context="true"',
      'data-user-message-element-context="true"',
      'data-user-message-preview-annotation="true"',
    );
    expectNoContextTagLeak(markup);
  });

  it("matches the final preview annotation closer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Fix this annotated preview.",
              "",
              "<preview_annotation>",
              "Preview annotation:",
              "Id: annotation_1",
              "Page: Example",
              "Comment: literal closer follows",
              "</preview_annotation>",
              "inside the comment",
              "Targets: 1 selected element.",
              "</preview_annotation>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Fix this annotated preview.");
    expect(markup).toContain("1 selected element.");
    expect(markup).toContain('data-user-message-preview-annotation="true"');
    expect(markup).not.toContain("inside the comment");
    expectNoContextTagLeak(markup);
  });

  it("strips trailing context blocks when terminal and element order is reversed", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Fix this reversed interaction.",
              "",
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  selector: button.submit",
              "</element_context>",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 9-10:",
              "  9 | pnpm test",
              "  10 | still failing",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Fix this reversed interaction.");
    expect(markup).toContain("SubmitButton");
    expect(markup).toContain("Terminal 1 lines 9-10");
    expect(markup).toContain('data-user-message-terminal-context="true"');
    expect(markup).toContain('data-user-message-element-context="true"');
    expectMarkupOrder(markup, "SubmitButton", "Terminal 1 lines 9-10");
    expectNoContextTagLeak(markup);
  });

  it("preserves send order for mixed trailing context block types", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Fix this mixed interaction.",
              "",
              "<preview_annotation>",
              "Preview annotation:",
              "Id: annotation_1",
              "Page: Example",
              "Targets: 1 selected element.",
              "</preview_annotation>",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 9-10:",
              "  9 | pnpm test",
              "  10 | still failing",
              "</terminal_context>",
              "",
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  selector: button.submit",
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expectMarkupOrder(markup, "1 selected element.", "Terminal 1 lines 9-10", "SubmitButton");
    expectNoContextTagLeak(markup);
  });

  it("strips multiple trailing terminal context blocks in send order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Compare these failures.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | first failure",
              "</terminal_context>",
              "",
              "<terminal_context>",
              "- Terminal 2 line 2:",
              "  2 | second failure",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expectMarkupOrder(markup, "Terminal 1 line 1", "Terminal 2 line 2");
    expectNoContextTagLeak(markup);
  });

  it("drops malformed trailing context blocks instead of leaking raw tags", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Fix malformed context.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | incomplete generated context",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Fix malformed context.");
    expect(markup).not.toContain("incomplete generated context");
    expectNoContextTagLeak(markup);
  });

  it("preserves review comments after generated context blocks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Review these changes.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | npm test",
              "</terminal_context>",
              "",
              '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
              "Keep this comment visible.",
              "```diff",
              "@@ -0,0 +47,2 @@",
              '+  it("keeps valid zero-usage snapshots", () => {',
              "+    expect(snapshot).not.toBeNull();",
              "```",
              "</review_comment>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Review these changes.");
    expect(markup).toContain("Terminal 1 line 1");
    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Keep this comment visible.");
    expect(markup).toContain('data-testid="file-diff"');
    expectMarkupOrder(markup, "Terminal 1 line 1", "contextWindow.test.ts");
    expectNoContextTagLeak(markup);
  });

  it("does not parse review comment tags inside generated context blocks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Inspect terminal output.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              '  1 | <review_comment sectionId="turn:fake" filePath="fake.ts" startIndex="0" endIndex="0">',
              "  2 | This is terminal output, not a review card.",
              "  3 | </review_comment>",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Inspect terminal output.");
    expect(markup).toContain("Terminal 1 line 1");
    expect(markup).not.toContain("fake.ts");
    expect(markup).not.toContain("This is terminal output, not a review card.");
    expect(markup).not.toContain('data-testid="file-diff"');
    expectNoContextTagLeak(markup);
  });

  it("drops review comment tags inside malformed generated context blocks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Inspect malformed terminal output.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              '  1 | <review_comment sectionId="turn:fake" filePath="fake.ts" startIndex="0" endIndex="0">',
              "  2 | This is terminal output, not a review card.",
              "  3 | </review_comment>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Inspect malformed terminal output.");
    expect(markup).not.toContain("fake.ts");
    expect(markup).not.toContain("This is terminal output, not a review card.");
    expect(markup).not.toContain('data-testid="file-diff"');
    expectNoContextTagLeak(markup);
  });

  it("keeps literal context tags in user-authored text visible", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Explain this sample:",
              "",
              "<terminal_context>",
              "not generated context",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Explain this sample:");
    expect(markup).toContain("not generated context");
  });

  it("does not truncate generated context at literal closing-tag output", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Inspect terminal output.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | </terminal_context>",
              "  2 | after literal closing tag",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Inspect terminal output.");
    expect(markup).toContain("Terminal 1 line 1");
    expect(markup).not.toContain("after literal closing tag");
    expectNoContextTagLeak(markup);
  });

  it("escapes extracted context chip content", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Review unsafe context.",
              "",
              "<terminal_context>",
              "- Terminal <script>alert(1)</script>:",
              "  1 | <img src=x onerror=alert(1)>",
              "</terminal_context>",
              "",
              "<element_context>",
              "- <img src=x onerror=alert(1)>:",
              "  selector: <script>alert(2)</script>",
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expectNoContextTagLeak(markup);
  });

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("copies the raw user message text with structured context blocks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "Copy this prompt.",
              "",
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | hidden terminal output",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain('data-copy-text="[contains-raw-markup]"');
    expectNoContextTagLeak(markup);
  });

  it("preserves exact copy text for normal user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("  keep whitespace  ")]}
      />,
    );

    expect(markup).toContain('data-copy-text="  keep whitespace  "');
  });

  it("copies the original message text for context-only messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<terminal_context>",
              "- Terminal 1 line 1:",
              "  1 | hidden terminal output",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain('data-copy-text="[contains-raw-markup]"');
    expectNoContextTagLeak(markup);
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work Log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders command work entries as expandable rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const stdout = Array.from({ length: 45 }, (_, index) => `stdout ${index + 1}`).join("\n");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "vp test",
              stdout,
              stderr: "warning",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("vp test");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Ran command - vp test"');
  });

  it("renders dynamic tool command metadata as expandable command rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Dynamic tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              command: "vp test",
              stdout: "passed",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic tool");
    expect(markup).toContain("vp test");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic tool - vp test"');
  });

  it("renders MCP tool command metadata as expandable command rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool",
              tone: "tool",
              itemType: "mcp_tool_call",
              command: "rg TODO",
              stdout: "apps/web/src/session-logic.ts:1:TODO",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("MCP tool");
    expect(markup).toContain("rg TODO");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand MCP tool - rg TODO"');
  });

  it("does not render typed non-command stdout as command details", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
              stdout: "search results",
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Web search");
    expect(markup).not.toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="Expand Web search"');
  });

  it("renders file-change work entries as expandable rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Changed files",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Changed files");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Changed files - apps/web/src/session-logic.ts"');
  });

  it("renders dynamic tool patch metadata as expandable file-change rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Dynamic patch tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
              stdout: "applied patch",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic patch tool");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic patch tool"');
  });

  it("renders dynamic tool output metadata as expandable command rows without a command", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Dynamic output tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              stdout: "updated files",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic output tool");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic output tool"');
  });

  it("renders command execution patch metadata as expandable file-change rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Ran command - apps/web/src/session-logic.ts"');
  });

  it("renders mixed dynamic tool command and patch metadata", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Dynamic edit tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              command: "apply_patch",
              stdout: "updated files",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).not.toContain("Dynamic edit tool - apply_patch");
    expect(markup).toContain(
      'aria-label="Expand Dynamic edit tool - apps/web/src/session-logic.ts"',
    );
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders expandable subagent rows without status labels", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentPrompt: "Create one original haiku in English. Return only the haiku text.",
              output:
                "Rain lifts from the wires\nA window gathers pale dawn\nFootsteps bloom below",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent");
    expect(markup).toContain("Create one original haiku in English");
    expect(markup).not.toContain("Done");
    expect(markup).not.toContain("Running");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(
      'aria-label="Expand Subagent - Create one original haiku in English. Return only the haiku text."',
    );
  });

  it("does not reuse running subagent status for a different same-turn parent item", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      environmentStateById: {
        [ACTIVE_THREAD_ENVIRONMENT_ID]: {
          threadShellById: {
            [childThreadId]: {
              id: childThreadId,
              title: "Say hi briefly",
              parentRelation: {
                kind: "subagent",
                rootThreadId: ThreadId.make("thread-1"),
                parentThreadId: ThreadId.make("thread-1"),
                parentTurnId,
                parentItemId: "call-send-input",
                parentActivitySequence: 2,
                providerThreadId: "provider-child-1",
                titleSeed: "Say hi in German",
                depth: 1,
                startedAt: "2026-03-17T19:12:30.000Z",
                completedAt: null,
                status: "running",
              },
            },
          },
        },
      },
    };

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress={true}
        latestTurn={{
          turnId: parentTurnId,
          state: "running",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: null,
        }}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: parentTurnId,
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentChildren: [
                {
                  threadId: childThreadId,
                  parentItemId: "call-resume",
                  titleSeed: "Say hi in German",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Say hi briefly");
    expect(markup).not.toContain("Working");
    expect(markup).toContain("duration unknown");
  });

  it("keeps running subagent child rows visible in collapsed tool groups", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-running-child");
    storeMock.state = {
      environmentStateById: {
        [ACTIVE_THREAD_ENVIRONMENT_ID]: {
          threadShellById: {
            [childThreadId]: {
              id: childThreadId,
              title: "Check nested work",
              parentRelation: {
                kind: "subagent",
                rootThreadId: ThreadId.make("thread-1"),
                parentThreadId: ThreadId.make("thread-1"),
                parentTurnId,
                parentItemId: "call-child",
                parentActivitySequence: 1,
                providerThreadId: "provider-child-1",
                titleSeed: "Check nested work",
                depth: 1,
                startedAt: "2026-03-17T19:12:30.000Z",
                completedAt: null,
                status: "running",
              },
            },
          },
        },
      },
    };

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress={true}
        latestTurn={{
          turnId: parentTurnId,
          state: "running",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: null,
        }}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-command",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: parentTurnId,
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              command: "pwd",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-subagent",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: parentTurnId,
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolLifecycleStatus: "inProgress",
              subagentChildren: [
                {
                  threadId: childThreadId,
                  parentItemId: "call-child",
                  titleSeed: "Check nested work",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Check nested work");
    expect(markup).toContain("+1 previous tool call");
  });

  it("renders file review comments as source code instead of diffs", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("renders a failure marker for failed tool lifecycle entries", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-x");
    expect(markup).toContain('aria-label="Tool call failed"');
  });
});

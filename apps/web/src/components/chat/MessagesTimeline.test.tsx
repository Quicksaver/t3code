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

const storeMock = vi.hoisted(() => ({
  state: {
    threadShellByKey: {},
  } as {
    threadShellByKey: Record<string, unknown>;
  },
}));

vi.mock("../../state/entities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/entities")>();
  return {
    ...actual,
    useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
      ref === null
        ? null
        : (storeMock.state.threadShellByKey[`${ref.environmentId}\0${ref.threadId}`] ?? null),
  };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

beforeAll(async () => {
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

  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 60000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

beforeEach(() => {
  storeMock.state = {
    threadShellByKey: {},
  };
});

describe("subagent timeline logic", () => {
  it("requires matching turn ids when matching reusable parent item ids", async () => {
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline.logic");

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
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline.logic");

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
    const { subagentRelationMatchesBlock } = await import("./MessagesTimeline.logic");

    expect(
      subagentRelationMatchesBlock({
        parentTurnId: TurnId.make("turn-followup"),
        relationParentItemId: "call-send-input",
        relationParentTurnId: TurnId.make("turn-followup"),
      }),
    ).toBe(true);
  });

  it("derives stable child row button models from subagent work entries", async () => {
    const { deriveSubagentWorkEntryButtonModels } = await import("./MessagesTimeline.logic");
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-parent");

    expect(
      deriveSubagentWorkEntryButtonModels({
        id: "work-1",
        createdAt: "2026-03-17T19:12:30.000Z",
        turnId: parentTurnId,
        detail: "Parent detail",
        subagentPrompt: "Parent prompt",
        subagentChildren: [
          {
            threadId: childThreadId,
            parentItemId: "call-send-input",
            titleSeed: "Child seed",
          },
        ],
      }),
    ).toEqual([
      {
        key: "work-1:subagent:subagent-child-1:call-send-input",
        parentCreatedAt: "2026-03-17T19:12:30.000Z",
        threadId: childThreadId,
        parentTurnId,
        parentItemId: "call-send-input",
        titleSeed: "Child seed",
      },
    ]);
  });

  it("uses parent prompt or detail as subagent child row title fallback", async () => {
    const { deriveSubagentWorkEntryButtonModels } = await import("./MessagesTimeline.logic");
    const childThreadId = ThreadId.make("subagent-child-1");

    expect(
      deriveSubagentWorkEntryButtonModels({
        id: "work-1",
        createdAt: "2026-03-17T19:12:30.000Z",
        detail: "Parent detail",
        subagentPrompt: "Parent prompt",
        subagentChildren: [{ threadId: childThreadId }],
      })[0]?.titleSeed,
    ).toBe("Parent prompt");
  });

  it("dedupes redundant subagent prompt/output display parts", async () => {
    const { resolveSubagentDisplayParts } = await import("./MessagesTimeline.logic");

    expect(
      resolveSubagentDisplayParts({
        subagentPrompt: "Write a short haiku",
        output: "Write a short haiku\n\nDone",
      }),
    ).toEqual({ prompt: null, output: "Write a short haiku\n\nDone" });
    expect(
      resolveSubagentDisplayParts({
        subagentPrompt: "Write a short haiku",
        output: "Done",
      }),
    ).toEqual({ prompt: "Write a short haiku", output: "Done" });
    expect(
      resolveSubagentDisplayParts({
        subagentPrompt: "Write",
        output: "Write the result below.\n\nDone",
      }),
    ).toEqual({ prompt: "Write", output: "Write the result below.\n\nDone" });
  });

  it("marks a new prompt-bearing block as running when the previous relation is already terminal", async () => {
    const { resolveSubagentBlockDisplayState } = await import("./MessagesTimeline.logic");

    expect(
      resolveSubagentBlockDisplayState({
        parentCreatedAt: "2026-03-17T19:13:00.000Z",
        parentItemId: "call-resume",
        parentTurnId: TurnId.make("turn-newer"),
        relation: {
          status: "completed",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: "2026-03-17T19:12:45.000Z",
          parentItemId: "call-send-input",
          parentTurnId: TurnId.make("turn-older"),
        },
        terminalSnapshot: null,
      }),
    ).toEqual({
      status: "running",
      startedAt: "2026-03-17T19:13:00.000Z",
      completedAt: null,
    });
  });

  it("marks a turn-only newer block as running when the previous relation is already terminal", async () => {
    const { resolveSubagentBlockDisplayState } = await import("./MessagesTimeline.logic");

    expect(
      resolveSubagentBlockDisplayState({
        parentCreatedAt: "2026-03-17T19:13:00.000Z",
        parentItemId: null,
        parentTurnId: TurnId.make("turn-newer"),
        relation: {
          status: "completed",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: "2026-03-17T19:12:45.000Z",
          parentItemId: "call-send-input",
          parentTurnId: TurnId.make("turn-older"),
        },
        terminalSnapshot: null,
      }),
    ).toEqual({
      status: "running",
      startedAt: "2026-03-17T19:13:00.000Z",
      completedAt: null,
    });
  });

  it("falls back to the terminal snapshot when a running relation belongs to another block", async () => {
    const { resolveSubagentBlockDisplayState } = await import("./MessagesTimeline.logic");

    expect(
      resolveSubagentBlockDisplayState({
        parentCreatedAt: "2026-03-17T19:13:00.000Z",
        parentItemId: "call-old-block",
        parentTurnId: TurnId.make("turn-followup"),
        relation: {
          status: "running",
          startedAt: "2026-03-17T19:13:05.000Z",
          completedAt: null,
          parentItemId: "call-new-block",
          parentTurnId: TurnId.make("turn-followup"),
        },
        terminalSnapshot: {
          status: "completed",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: "2026-03-17T19:12:45.000Z",
        },
      }),
    ).toEqual({
      status: "completed",
      startedAt: "2026-03-17T19:12:30.000Z",
      completedAt: "2026-03-17T19:12:45.000Z",
    });
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

describe("MessagesTimeline", () => {
  it("uses exact LegendList end state before near-end fallback", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isNearEnd: true })).toBe(true);
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
    expect(onAnchorReady).toHaveBeenCalledWith(secondEntry.message.id, 1, 1);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(secondEntry.message.id, 240);
  });

  it("renders collapse controls for long user messages", async () => {
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
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
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
    expect(markup).not.toContain("&lt;element_context");
    expect(markup).not.toContain("<element_context");
  });

  it("keeps the copy button for collapsed long user messages", async () => {
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

  it("renders context compaction entries in the normal work log", async () => {
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

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
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

  it("renders a deduped resumed subagent block as working when the parent item matches", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      threadShellByKey: {
        [`${ACTIVE_THREAD_ENVIRONMENT_ID}\0${childThreadId}`]: {
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
    };

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
                  parentItemId: "call-send-input",
                  titleSeed: "Say hi in German",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Say hi briefly");
    expect(markup).toContain("Working");
    expect(markup).not.toContain("Completed in");
  });

  it("uses the subagent title seed when the child shell title is generic", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      threadShellByKey: {
        [`${ACTIVE_THREAD_ENVIRONMENT_ID}\0${childThreadId}`]: {
          id: childThreadId,
          title: "Subagent",
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
    };

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
                  parentItemId: "call-send-input",
                  titleSeed: "Say hi in German",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Say hi in German");
  });

  it("falls back to parent turn matching when the child item id is absent", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      threadShellByKey: {
        [`${ACTIVE_THREAD_ENVIRONMENT_ID}\0${childThreadId}`]: {
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
            startedAt: "2026-03-17T19:12:35.000Z",
            completedAt: null,
            status: "running",
          },
        },
      },
    };

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
                  titleSeed: "Say hi in German",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Say hi briefly");
    expect(markup).toContain("Working");
    expect(markup).not.toContain("Completed in");
  });

  it("does not reuse running subagent status for a different same-turn parent item", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      threadShellByKey: {
        [`${ACTIVE_THREAD_ENVIRONMENT_ID}\0${childThreadId}`]: {
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
            startedAt: "2026-03-17T19:12:35.000Z",
            completedAt: null,
            status: "running",
          },
        },
      },
    };

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
    expect(markup).toContain("status unknown");
  });

  it("does not reuse running subagent status for a reused item id from another turn", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    storeMock.state = {
      threadShellByKey: {
        [`${ACTIVE_THREAD_ENVIRONMENT_ID}\0${childThreadId}`]: {
          id: childThreadId,
          title: "Say hi briefly",
          parentRelation: {
            kind: "subagent",
            rootThreadId: ThreadId.make("thread-1"),
            parentThreadId: ThreadId.make("thread-1"),
            parentTurnId: TurnId.make("turn-older"),
            parentItemId: "call-send-input",
            parentActivitySequence: 2,
            providerThreadId: "provider-child-1",
            titleSeed: "Say hi in German",
            depth: 1,
            startedAt: "2026-03-17T19:12:35.000Z",
            completedAt: null,
            status: "running",
          },
        },
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress={true}
        latestTurn={{
          turnId: TurnId.make("turn-newer"),
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
              turnId: TurnId.make("turn-newer"),
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentChildren: [
                {
                  threadId: childThreadId,
                  parentItemId: "call-send-input",
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
    expect(markup).toContain("status unknown");
  });

  it("renders file review comments as source code instead of diffs", async () => {
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

  it("renders expandable subagent rows without status labels", async () => {
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
    expect(markup).toContain('aria-label="Subagent - Create one original haiku');
  });
});

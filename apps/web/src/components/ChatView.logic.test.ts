import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type OrchestrationThreadParentRelation,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Thread, ThreadShell } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  canLoadStandaloneThreadConversation,
  clearThreadErrorRecord,
  closeTerminalSession,
  deriveAgentChildConversationByProviderId,
  deriveAgentChildLifecycleByProviderId,
  deriveComposerSendState,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  isTerminalKeybindingCommand,
  isTerminalUiAvailable,
  isBranchMismatchDismissedForSession,
  isLatestRequestSequence,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  retainThreadKeyRecord,
  resolveDisabledSubagentParentThreadRef,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  shouldApplySourceControlMetadataUpdateResult,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldWriteThreadErrorToCurrentServerThread,
  terminalThreadRefsToCloseWhenDisabled,
} from "./ChatView.logic";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
} from "./ChatView.localDispatch";

const environmentId = EnvironmentId.make("environment-local");
const localEnvironmentId = environmentId;
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

function makeSubagentParentRelation(
  overrides: Partial<Extract<OrchestrationThreadParentRelation, { kind: "subagent" }>> = {},
): Extract<OrchestrationThreadParentRelation, { kind: "subagent" }> {
  return {
    kind: "subagent",
    rootThreadId: ThreadId.make("root-thread"),
    parentThreadId: ThreadId.make("parent-thread"),
    parentTurnId: TurnId.make("parent-turn"),
    parentItemId: ProviderItemId.make("parent-item"),
    parentActivitySequence: 1,
    providerThreadId: "provider-child-thread",
    titleSeed: "Child task",
    depth: 1,
    startedAt: now,
    completedAt: null,
    status: "running",
    ...overrides,
  };
}

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("deriveAgentChildConversationByProviderId", () => {
  it("returns no conversations without an active thread", () => {
    expect(
      deriveAgentChildConversationByProviderId({ activeThread: null, threadShells: [] }).size,
    ).toBe(0);
  });

  it("does not index child conversations when standalone visibility is disabled", () => {
    expect(
      deriveAgentChildConversationByProviderId({
        activeThread: { environmentId, id: threadId },
        threadShells: [
          {
            environmentId,
            id: ThreadId.make("child-thread"),
            title: "Child",
            parentRelation: makeSubagentParentRelation(),
          },
        ],
        enabled: false,
      }).size,
    ).toBe(0);
  });

  it("keeps the persisted title and route scoped to the active environment and root", () => {
    const rootThreadId = ThreadId.make("root-thread");
    const childThreadId = ThreadId.make("child-thread");
    const providerThreadId = "provider-child-thread";
    const conversations = deriveAgentChildConversationByProviderId({
      activeThread: { environmentId, id: rootThreadId },
      threadShells: [
        {
          environmentId,
          id: childThreadId,
          title: "Persisted child title",
          parentRelation: makeSubagentParentRelation({ rootThreadId, providerThreadId }),
        },
        {
          environmentId,
          id: ThreadId.make("other-root-child"),
          title: "Unrelated root title",
          parentRelation: makeSubagentParentRelation({
            rootThreadId: ThreadId.make("other-root"),
            providerThreadId,
          }),
        },
        {
          environmentId: EnvironmentId.make("other-environment"),
          id: ThreadId.make("other-environment-child"),
          title: "Unrelated environment title",
          parentRelation: makeSubagentParentRelation({ rootThreadId, providerThreadId }),
        },
      ],
    });

    expect(conversations.get(providerThreadId)).toEqual({
      threadRef: { environmentId, threadId: childThreadId },
      title: "Persisted child title",
    });
  });

  it("uses the active child's root lineage when indexing sibling agents", () => {
    const rootThreadId = ThreadId.make("root-thread");
    const activeChildId = ThreadId.make("active-child");
    const siblingId = ThreadId.make("sibling-child");
    const conversations = deriveAgentChildConversationByProviderId({
      activeThread: {
        environmentId,
        id: activeChildId,
        parentRelation: makeSubagentParentRelation({ rootThreadId }),
      },
      threadShells: [
        {
          environmentId,
          id: siblingId,
          title: "Sibling agent",
          parentRelation: makeSubagentParentRelation({
            rootThreadId,
            providerThreadId: "provider-sibling",
          }),
        },
      ],
    });

    expect(conversations.get("provider-sibling")).toEqual({
      threadRef: { environmentId, threadId: siblingId },
      title: "Sibling agent",
    });
  });
});

describe("deriveAgentChildLifecycleByProviderId", () => {
  it("indexes terminal child state even when standalone child conversations are hidden", () => {
    const rootThreadId = ThreadId.make("root-thread");
    const completedAt = "2026-03-29T00:01:00.000Z";
    const lifecycles = deriveAgentChildLifecycleByProviderId({
      activeThread: { environmentId, id: rootThreadId },
      threadShells: [
        {
          environmentId,
          id: ThreadId.make("child-thread"),
          title: "Completed child",
          parentRelation: makeSubagentParentRelation({
            rootThreadId,
            providerThreadId: "provider-child",
            status: "completed",
            completedAt,
          }),
        },
      ],
    });

    expect(lifecycles.get("provider-child")).toEqual({ status: "completed", completedAt });
  });
});

describe("standalone subagent conversation visibility", () => {
  const rootShell = { environmentId, parentRelation: undefined };
  const childShell = { environmentId, parentRelation: makeSubagentParentRelation() };

  it("loads root conversations independently of the beta preference", () => {
    expect(
      canLoadStandaloneThreadConversation({
        threadShell: rootShell,
        hasLocalDraft: false,
        clientSettingsHydrated: false,
        subagentConversationVisibilityEnabled: false,
      }),
    ).toBe(true);
  });

  it("does not load child detail until hydrated settings explicitly opt in", () => {
    expect(
      canLoadStandaloneThreadConversation({
        threadShell: childShell,
        hasLocalDraft: false,
        clientSettingsHydrated: false,
        subagentConversationVisibilityEnabled: true,
      }),
    ).toBe(false);
    expect(
      canLoadStandaloneThreadConversation({
        threadShell: childShell,
        hasLocalDraft: false,
        clientSettingsHydrated: true,
        subagentConversationVisibilityEnabled: false,
      }),
    ).toBe(false);
    expect(
      canLoadStandaloneThreadConversation({
        threadShell: childShell,
        hasLocalDraft: false,
        clientSettingsHydrated: true,
        subagentConversationVisibilityEnabled: true,
      }),
    ).toBe(true);
  });

  it("redirects disabled child routes to their immediate parent", () => {
    expect(
      resolveDisabledSubagentParentThreadRef({
        threadShell: childShell,
        clientSettingsHydrated: true,
        subagentConversationVisibilityEnabled: false,
      }),
    ).toEqual({
      environmentId,
      threadId: ThreadId.make("parent-thread"),
    });
    expect(
      resolveDisabledSubagentParentThreadRef({
        threadShell: childShell,
        clientSettingsHydrated: true,
        subagentConversationVisibilityEnabled: true,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });

  it("targets the latest child turn when interrupting a running subagent thread", () => {
    const sessionTurnId = TurnId.make("root-session-turn");
    const childTurnId = TurnId.make("child-latest-turn");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          parentRelation: makeSubagentParentRelation(),
          latestTurn: {
            ...completedTurn,
            turnId: childTurnId,
            state: "running",
            completedAt: null,
          },
          session: {
            ...readySession,
            status: "running",
            activeTurnId: sessionTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: childTurnId });
  });

  it("omits a turn id when a running subagent has no latest turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          parentRelation: makeSubagentParentRelation(),
          latestTurn: null,
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId });
  });

  it("omits a turn id when a running subagent latest turn is not running", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          parentRelation: makeSubagentParentRelation(),
          latestTurn: completedTurn,
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId });
  });

  it("omits a turn id when the subagent relation is not running", () => {
    const activeTurnId = TurnId.make("turn-running");
    const childTurnId = TurnId.make("child-latest-turn");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          parentRelation: makeSubagentParentRelation({
            status: "completed",
            completedAt: "2026-03-29T00:00:20.000Z",
          }),
          latestTurn: {
            ...completedTurn,
            turnId: childTurnId,
            state: "running",
            completedAt: null,
          },
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("terminal host preference behavior", () => {
  it("recognizes terminal keybinding commands", () => {
    expect(isTerminalKeybindingCommand("terminal.toggle")).toBe(true);
    expect(isTerminalKeybindingCommand("terminal.split")).toBe(true);
    expect(isTerminalKeybindingCommand("terminal.new")).toBe(true);
    expect(isTerminalKeybindingCommand("terminal.close")).toBe(true);
    expect(isTerminalKeybindingCommand("diff.toggle")).toBe(false);
  });

  it("requires both host terminal support and an active project for terminal UI", () => {
    expect(isTerminalUiAvailable({ enableTerminal: true, hasActiveProject: true })).toBe(true);
    expect(isTerminalUiAvailable({ enableTerminal: false, hasActiveProject: true })).toBe(false);
    expect(isTerminalUiAvailable({ enableTerminal: true, hasActiveProject: false })).toBe(false);
  });

  it("resolves open terminal thread refs that must close when the host disables terminals", () => {
    const threadRef = scopeThreadRef(localEnvironmentId, ThreadId.make("thread-open"));
    const invalidThreadKey = "not-a-scoped-thread-key";

    expect(
      terminalThreadRefsToCloseWhenDisabled({
        enableTerminal: false,
        openTerminalThreadKeys: [
          `${threadRef.environmentId}:${threadRef.threadId}`,
          invalidThreadKey,
        ],
      }),
    ).toEqual([threadRef]);
  });

  it("keeps open terminal thread refs alone when the host enables terminals", () => {
    const threadRef = scopeThreadRef(localEnvironmentId, ThreadId.make("thread-open"));

    expect(
      terminalThreadRefsToCloseWhenDisabled({
        enableTerminal: true,
        openTerminalThreadKeys: [`${threadRef.environmentId}:${threadRef.threadId}`],
      }),
    ).toEqual([]);
  });

  it("closes all backend terminals for a thread without requiring a visible terminal id", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const api = {
      terminal: {
        close,
        clear: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as EnvironmentApi;
    const threadId = ThreadId.make("thread-open");

    closeTerminalSession({ api, threadId });
    await Promise.resolve();

    expect(close).toHaveBeenCalledWith({ threadId, deleteHistory: true });
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("clearThreadErrorRecord", () => {
  it("clears only the selected thread error", () => {
    expect(
      clearThreadErrorRecord(
        {
          "environment-local:thread-1": "metadata failed",
          "environment-local:thread-2": "send failed",
        },
        "environment-local:thread-1",
      ),
    ).toEqual({
      "environment-local:thread-1": null,
      "environment-local:thread-2": "send failed",
    });
  });

  it("keeps the same object when the selected thread has no error", () => {
    const existing = {
      "environment-local:thread-1": null,
      "environment-local:thread-2": "send failed",
    };

    expect(clearThreadErrorRecord(existing, "environment-local:thread-1")).toBe(existing);
    expect(clearThreadErrorRecord(existing, "environment-local:thread-3")).toBe(existing);
  });
});

describe("retainThreadKeyRecord", () => {
  it("drops stale thread keys", () => {
    expect(
      retainThreadKeyRecord(
        {
          "environment-local:thread-1": "send failed",
          "environment-local:thread-2": null,
        },
        new Set(["environment-local:thread-1"]),
      ),
    ).toEqual({
      "environment-local:thread-1": "send failed",
    });
  });

  it("preserves reference identity when no keys are pruned", () => {
    const existing = {
      "environment-local:thread-1": "send failed",
    };

    expect(retainThreadKeyRecord(existing, new Set(["environment-local:thread-1"]))).toBe(existing);
  });
});

describe("shouldApplySourceControlMetadataUpdateResult", () => {
  it("allows only the latest metadata update result for a thread", () => {
    expect(
      shouldApplySourceControlMetadataUpdateResult({
        currentSequence: 2,
        requestSequence: 2,
      }),
    ).toBe(true);
    expect(
      shouldApplySourceControlMetadataUpdateResult({
        currentSequence: 2,
        requestSequence: 1,
      }),
    ).toBe(false);
    expect(
      shouldApplySourceControlMetadataUpdateResult({
        currentSequence: undefined,
        requestSequence: 1,
      }),
    ).toBe(false);
  });
});

describe("isLatestRequestSequence", () => {
  it("rejects a stop completion after a newer thread starts another request", () => {
    expect(isLatestRequestSequence({ currentSequence: 4, requestSequence: 3 })).toBe(false);
    expect(isLatestRequestSequence({ currentSequence: 4, requestSequence: 4 })).toBe(true);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const expectedUserMessageId = MessageId.make("message-expected");

  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
      expectedUserMessageId,
    );

    expect(localDispatch.expectedUserMessageId).toBe(expectedUserMessageId);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        session: readySession,
        projectedMessages: [],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
      expectedUserMessageId,
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        projectedMessages: [],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
      expectedUserMessageId,
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        projectedMessages: [],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        projectedMessages: [],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("does not acknowledge a steer from an unrelated projected user message", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
      MessageId.make("message-steer"),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: MessageId.make("message-other-client"),
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread(), expectedUserMessageId);
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      session: null,
      projectedMessages: [],
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });

  it("acknowledges a steer when its user message is projected onto the running thread", () => {
    const initialMessageId = MessageId.make("message-initial");
    const steerMessageId = MessageId.make("message-steer");
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        messages: [
          {
            id: initialMessageId,
            role: "user",
            text: "start",
            turnId: runningTurn.turnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        latestTurn: runningTurn,
        session: runningSession,
      }),
      steerMessageId,
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: initialMessageId,
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: steerMessageId,
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: steerMessageId,
            role: "user",
          },
          {
            id: MessageId.make("message-other-client"),
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it.each([null, "ready"] as const)(
    "acknowledges the exact projected message when the dispatch session status is %s",
    (sessionStatus) => {
      const steerMessageId = MessageId.make("message-steer");
      const runningTurn = {
        ...completedTurn,
        state: "running" as const,
        completedAt: null,
      };
      const runningSession = {
        ...readySession,
        status: "running" as const,
        activeTurnId: runningTurn.turnId,
      };
      const localDispatch = {
        ...createLocalDispatchSnapshot(
          makeThread({
            latestTurn: runningTurn,
            session: runningSession,
          }),
          steerMessageId,
        ),
        sessionStatus,
      };

      expect(
        hasServerAcknowledgedLocalDispatch({
          localDispatch,
          phase: "running",
          latestTurn: runningTurn,
          session: runningSession,
          projectedMessages: [
            {
              id: steerMessageId,
              role: "user",
            },
          ],
          hasPendingApproval: false,
          hasPendingUserInput: false,
          threadError: null,
        }),
      ).toBe(true);
    },
  );

  it("requires the next steer id after the previous steer was projected", () => {
    const previousSteerMessageId = MessageId.make("message-steer");
    const nextSteerMessageId = MessageId.make("message-next-steer");
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        messages: [
          {
            id: previousSteerMessageId,
            role: "user",
            text: "steer",
            turnId: runningTurn.turnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        latestTurn: runningTurn,
        session: runningSession,
      }),
      nextSteerMessageId,
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: previousSteerMessageId,
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: runningSession,
        projectedMessages: [
          {
            id: nextSteerMessageId,
            role: "user",
          },
        ],
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

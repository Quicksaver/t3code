import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  archiveMutation: vi.fn(),
  clearComposerDraftForThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  clearTerminalUiState: vi.fn(),
  handleNewThread: vi.fn(),
  markThreadVisited: vi.fn(),
  readThreadShell: vi.fn(),
  refreshArchivedThreads: vi.fn(),
  releaseArchivedComposerDraftUploads: vi.fn(),
  releaseComposerDraftUploads: vi.fn(),
}));
import { navigateAfterThreadDeletion } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(),
    state: { matches: [{ params: {} }] },
  }),
}));

vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: vi.fn(() => null),
  pinOrderKeyBetween: vi.fn(() => null),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: <T>(
    selector: (state: {
      clearDraftThread: typeof mocks.clearComposerDraftForThread;
      clearProjectDraftThreadById: typeof mocks.clearProjectDraftThreadById;
    }) => T,
  ) =>
    selector({
      clearDraftThread: mocks.clearComposerDraftForThread,
      clearProjectDraftThreadById: mocks.clearProjectDraftThreadById,
    }),
}));

vi.mock("../state/terminal", () => ({ terminalEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    archive: {},
    delete: {},
    pin: {},
    reorderPin: {},
    settle: {},
    snooze: {},
    stopSession: {},
    unarchive: {},
    unpin: {},
    unsettle: {},
    unsnooze: {},
  },
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { refreshStatus: {}, removeWorktree: {} },
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => mocks.handleNewThread,
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: mocks.refreshArchivedThreads,
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseArchivedComposerDraftUploads: mocks.releaseArchivedComposerDraftUploads,
  permanentlyDiscardComposerDraft: mocks.releaseComposerDraftUploads,
}));
vi.mock("../localApi", () => ({ readLocalApi: vi.fn(() => null) }));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: vi.fn(() => false),
  readEnvironmentSupportsPinReorder: vi.fn(() => false),
  readEnvironmentSupportsSettlement: vi.fn(() => false),
  readEnvironmentSupportsSnooze: vi.fn(() => false),
  readEnvironmentThreadRefs: vi.fn(() => []),
  readProject: vi.fn(() => null),
  readThreadShell: mocks.readThreadShell,
  readThreadShells: vi.fn(() => []),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: <T>(
    selector: (state: { clearTerminalUiState: typeof mocks.clearTerminalUiState }) => T,
  ) => selector({ clearTerminalUiState: mocks.clearTerminalUiState }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: <T>(
    selector: (state: { markThreadVisited: typeof mocks.markThreadVisited }) => T,
  ) => selector({ markThreadVisited: mocks.markThreadVisited }),
}));
vi.mock("../worktreeCleanup", () => ({
  formatWorktreePathForDisplay: vi.fn((path: string) => path),
  getOrphanedWorktreePathForThread: vi.fn(() => null),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: vi.fn((input: unknown) => input),
  toastManager: { add: vi.fn() },
}));
vi.mock("./useSettings", () => ({
  useClientSettings: <T>(
    selector: (settings: {
      confirmThreadDelete: boolean;
      sidebarThreadSortOrder: "updated_at";
    }) => T,
  ) => selector({ confirmThreadDelete: false, sidebarThreadSortOrder: "updated_at" }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => mocks.archiveMutation),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "environment-1" && scope === AuthOrchestrationOperateScope,
}));
vi.mock("@t3tools/client-runtime/state/thread-settled", () => ({
  canSettle: vi.fn(() => true),
  canSnooze: vi.fn(() => true),
  threadWokeAt: vi.fn(() => null),
}));

import { useThreadActions } from "./useThreadActions";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("archive draft uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readThreadShell.mockReturnValue({
      environmentId: threadRef.environmentId,
      id: threadRef.threadId,
      projectId: ProjectId.make("project-1"),
      session: null,
    });
  });

  it("releases recreatable draft uploads after archive succeeds", async () => {
    mocks.archiveMutation.mockResolvedValue({ _tag: "Success", value: undefined });

    const result = await useThreadActions().archiveThread(threadRef);

    expect(result._tag).toBe("Success");
    expect(mocks.releaseArchivedComposerDraftUploads).toHaveBeenCalledOnce();
    expect(mocks.releaseArchivedComposerDraftUploads).toHaveBeenCalledWith(threadRef);
    expect(mocks.releaseComposerDraftUploads).not.toHaveBeenCalled();
  });

  it("keeps pending draft uploads when archive fails", async () => {
    mocks.archiveMutation.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });

    const result = await useThreadActions().archiveThread(threadRef);

    expect(result._tag).toBe("Failure");
    expect(mocks.archiveMutation).toHaveBeenCalledOnce();
    expect(mocks.releaseArchivedComposerDraftUploads).not.toHaveBeenCalled();
  });
});

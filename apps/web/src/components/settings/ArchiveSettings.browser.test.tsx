import { act, fakeTimers, render } from "../../../test/render";
import type { ComponentProps, Ref } from "react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ConfirmDialogOptions,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import * as DateTime from "effect/DateTime";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { makeThreadFixture } from "../../test-fixtures";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { SharedTooltipProvider } from "../ui/shared-tooltip";

type CapturedButtonClick = (event: unknown) => unknown;

const testDoubles = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    canOperate: true,
    familyLookupFails: false,
    serverConfigs: Atom.make<ReadonlyMap<EnvironmentId, { readonly shellThreadFamilies: boolean }>>(
      new Map(),
    ).pipe(Atom.keepAlive),
    familyThreads: [] as {
      id: ThreadId;
      lineage: { parentThreadId: ThreadId; sideChat?: boolean };
    }[],
    navigate: vi.fn(),
    confirm: vi.fn(async (_message: string, _options?: ConfirmDialogOptions) => false),
    contextMenu: vi.fn(),
    contextMenuResult: null as string | null,
    deleteThread: vi.fn(),
    unarchiveThread: vi.fn(),
    permanentlyDiscardComposerDraft: vi.fn(),
    isArchivedDeleteBlocked: vi.fn<
      (threadRef: ScopedThreadRef, sequence: number | undefined) => boolean
    >(() => false),
    refreshArchivedThreadsForEnvironment: vi.fn(),
    deleteThreadCommand: {},
    unarchiveThreadCommand: {},
    toastAdd: vi.fn(),
    buttonClicks: new Map<string, CapturedButtonClick>(),
    archiveState: {
      snapshots: [] as ReadonlyArray<unknown>,
      error: null as string | null,
      isLoading: false,
      refresh: vi.fn(),
    },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({
    select,
  }: {
    select: (location: { hash: string; state: { settingsTargetHighlight: boolean } }) => unknown;
  }) => select({ hash: "#archive", state: { settingsTargetHighlight: true } }),
  useNavigate: () => testDoubles.navigate,
}));

vi.mock("../ui/input", () => ({
  Input: ({
    ref,
    nativeInput: _nativeInput,
    ...inputProps
  }: ComponentProps<"input"> & { nativeInput?: boolean; ref?: Ref<HTMLInputElement> }) => {
    return <input ref={ref} {...inputProps} />;
  },
}));

vi.mock("../ui/button", () => {
  return {
    buttonVariants: () => "",
    InlineButton: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
    Button: ({
      children,
      onClick,
      ...buttonProps
    }: ComponentProps<"button"> & { onClick?: CapturedButtonClick }) => {
      const label = buttonProps["aria-label"];
      if (typeof label === "string" && onClick) {
        testDoubles.buttonClicks.set(label, onClick);
      }
      return <button {...buttonProps}>{children}</button>;
    },
  };
});

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: () => <span data-project-favicon />,
}));

vi.mock("../../hooks/useSettings", () => ({
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Primary settings are unavailable.",
  useClientSettings: (selector: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    selector({ confirmThreadDelete: true }),
  usePrimarySettingsAvailable: () => true,
}));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => testDoubles.canOperate,
  readEnvironmentScope: () => testDoubles.canOperate,
  useEnvironmentsWithScope: () => new Set(testDoubles.canOperate ? ["environment-1"] : []),
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    delete: testDoubles.deleteThreadCommand,
    unarchive: testDoubles.unarchiveThreadCommand,
  },
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: ["environment-1"], members: [] },
  }),
  useOptionalSettingsScope: () => null,
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettingsWriteAllowed: () => true,
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === testDoubles.deleteThreadCommand) return testDoubles.deleteThread;
    if (command === testDoubles.unarchiveThreadCommand) return testDoubles.unarchiveThread;
    throw new Error("Unexpected archive command");
  },
}));

vi.mock("../../lib/composerDraftUploads", () => ({
  permanentlyDiscardComposerDraft: testDoubles.permanentlyDiscardComposerDraft,
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testDoubles.toastAdd },
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    dialogs: {
      confirm: testDoubles.confirm,
    },
    contextMenu: {
      show: (...args: ReadonlyArray<unknown>) => {
        testDoubles.contextMenu(...args);
        return Promise.resolve(testDoubles.contextMenuResult);
      },
    },
  }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));

vi.mock("../../state/entities", () => ({
  useServerConfigs: () => new Map(),
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    (testDoubles.familyLookupFails ? testDoubles.familyThreads : []).map((thread) =>
      scopeThreadRef(environmentId, thread.id),
    ),
  readThreadShell: (ref: { threadId: ThreadId }) =>
    testDoubles.familyThreads.find((thread) => thread.id === ref.threadId) ?? null,
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: testDoubles.serverConfigs,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  hasPendingArchivedThreadCascade: () => false,
  isArchivedDeleteBlocked: testDoubles.isArchivedDeleteBlocked,
  recordArchivedThreadCascades: () => {},
  refreshArchivedThreadsForEnvironment: testDoubles.refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots: () => ({
    snapshots: testDoubles.archiveState.snapshots,
    error: testDoubles.archiveState.error,
    isLoading: testDoubles.archiveState.isLoading,
    refresh: testDoubles.archiveState.refresh,
  }),
}));

import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useDiffPanelStore } from "../../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "../../previewStateStore";
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () =>
    testDoubles.familyLookupFails
      ? { _tag: "Failure" }
      : { _tag: "Success", value: { threads: testDoubles.familyThreads } },
}));

import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

function setup() {
  resetPreviewStateForTests();
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
  usePreviewMiniPlayerStore.setState(usePreviewMiniPlayerStore.getInitialState(), true);
  testDoubles.canOperate = true;
  testDoubles.familyLookupFails = false;
  appAtomRegistry.set(
    testDoubles.serverConfigs,
    new Map([[EnvironmentId.make("environment-1"), { shellThreadFamilies: true }]]),
  );
  testDoubles.familyThreads = [];
  testDoubles.navigate.mockReset();
  testDoubles.confirm.mockClear();
  testDoubles.contextMenu.mockClear();
  testDoubles.contextMenuResult = null;
  testDoubles.deleteThread.mockReset();
  testDoubles.unarchiveThread.mockReset();
  testDoubles.permanentlyDiscardComposerDraft.mockReset();
  testDoubles.isArchivedDeleteBlocked.mockReset().mockReturnValue(false);
  testDoubles.refreshArchivedThreadsForEnvironment.mockReset();
  testDoubles.toastAdd.mockReset();
  testDoubles.buttonClicks.clear();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  testDoubles.archiveState.snapshots = [];
  testDoubles.archiveState.error = null;
  testDoubles.archiveState.isLoading = false;
  testDoubles.archiveState.refresh.mockReset();
  const resources = new DisposableStack();
  resources.use(vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {}));
  return resources;
}

function renderArchive() {
  return render(
    <SharedTooltipProvider>
      <ArchivedThreadsPanel />
    </SharedTooltipProvider>,
    { router: "/settings/archive" },
  );
}

const populatedArchiveSnapshots = [
  {
    environmentId: "environment-1",
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [
        {
          id: "project-1",
          title: "Archive project",
          workspaceRoot: "/workspaces/archive-project",
          faviconPath: "/workspaces/archive-project/.t3/favicon.svg",
          projectIcon: { kind: "emoji", emoji: "🧪" },
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      threads: [
        {
          ...makeThreadFixture({
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
          }).source,
          title: "Archived conversation",
          createdAt: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
          updatedAt: DateTime.makeUnsafe("2026-06-02T00:00:00.000Z"),
          archivedAt: DateTime.makeUnsafe("2026-06-02T00:00:00.000Z"),
        },
      ],
    },
  },
] as const;

async function renderPopulatedArchive(
  searchQuery?: string,
  snapshots: ReadonlyArray<unknown> = populatedArchiveSnapshots,
) {
  testDoubles.archiveState.snapshots = snapshots;
  await using pending = new AsyncDisposableStack();
  const screen = pending.use(await renderArchive());
  if (searchQuery !== undefined) {
    await screen
      .getByRole("searchbox", { name: "Search archived conversations" })
      .fill(searchQuery);
  }
  const resources = pending.move();
  return { ...screen, [Symbol.asyncDispose]: () => resources.disposeAsync() };
}

function clickCapturedButton(label: string, currentTarget: unknown = {}) {
  const buttons = document.querySelectorAll(`button[aria-label="${CSS.escape(label)}"]`);
  if (buttons.length !== 1) {
    throw new Error(`Expected exactly one ${label} button, received ${buttons.length}`);
  }
  const onClick = testDoubles.buttonClicks.get(label)!;
  onClick({ currentTarget, stopPropagation: vi.fn() });
}

describe("ArchivedThreadsPanel", () => {
  it("keeps a restored side chat when its Archive delete confirmation was already open", async () => {
    using _setup = setup();
    const confirmation = Promise.withResolvers<boolean>();
    testDoubles.confirm.mockReturnValueOnce(confirmation.promise);
    testDoubles.deleteThread.mockResolvedValueOnce({ _tag: "Success", value: { sequence: 3 } });
    const [entry] = populatedArchiveSnapshots;
    const [parent] = entry.snapshot.threads;
    const sideChat = {
      ...parent,
      id: ThreadId.make("restored-side-chat"),
      title: "Restored side chat",
      lineage: { ...parent.lineage, parentThreadId: parent.id, sideChat: true },
    };
    await using screen = await renderPopulatedArchive("Restored side chat", [
      { ...entry, snapshot: { ...entry.snapshot, threads: [parent, sideChat] } },
    ]);
    clickCapturedButton("Delete Restored side chat");
    await vi.waitFor(() => expect(testDoubles.confirm).toHaveBeenCalledOnce());
    testDoubles.archiveState.snapshots = [
      { ...entry, snapshot: { ...entry.snapshot, snapshotSequence: 2, threads: [] } },
    ];
    await screen.rerender(<ArchivedThreadsPanel />);
    testDoubles.isArchivedDeleteBlocked.mockImplementationOnce(
      (threadRef, sequence) =>
        threadRef.threadId === sideChat.id && sequence === entry.snapshot.snapshotSequence,
    );
    confirmation.resolve(true);

    await vi.waitFor(() => {
      expect(
        testDoubles.deleteThread.mock.calls.length + testDoubles.toastAdd.mock.calls.length,
      ).toBeGreaterThan(0);
    });
    expect(testDoubles.deleteThread).not.toHaveBeenCalled();
  });

  it.each([
    {
      archiveState: { snapshots: [], isLoading: false },
      expectedContent: "No archived threads",
      state: "empty",
    },
    {
      archiveState: { snapshots: [], isLoading: true },
      expectedContent: "Loading archived threads",
      state: "loading",
    },
    {
      archiveState: {
        snapshots: populatedArchiveSnapshots,
        isLoading: false,
      },
      expectedContent: "Archive project",
      state: "populated",
    },
  ])(
    "focuses the persistent archive search field in the $state state",
    async ({ archiveState, expectedContent }) => {
      using _setup = setup();
      testDoubles.archiveState.snapshots = archiveState.snapshots;
      testDoubles.archiveState.isLoading = archiveState.isLoading;
      const scrollIntoView = vi.fn();
      using _scroll = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(scrollIntoView);
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      Object.defineProperty(mediaQuery, "matches", { value: false });
      using _media = vi.spyOn(window, "matchMedia").mockReturnValue(mediaQuery);

      await using screen = await renderArchive();
      const markup = screen.container.innerHTML;
      const archiveInput = document.querySelector<HTMLInputElement>("#archive")!;

      expect(markup).toContain('id="archive"');
      expect(markup).toContain('aria-label="Search archived conversations"');
      expect(markup).toContain(expectedContent);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(document.activeElement).toBe(archiveInput);
      expect(archiveInput.classList.contains("settings-search-target-pulse")).toBe(true);
      expect(testDoubles.navigate).toHaveBeenCalledWith({
        hash: "",
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
  );

  it("updates both age labels when the archive clock advances", async () => {
    using _setup = setup();
    using _timers = fakeTimers({
      now: new Date("2026-06-02T00:00:00.000Z"),
    });
    const entry = populatedArchiveSnapshots[0];
    testDoubles.archiveState.snapshots = [
      {
        ...entry,
        snapshot: {
          ...entry.snapshot,
          threads: [
            { ...entry.snapshot.threads[0], createdAt: entry.snapshot.threads[0].archivedAt },
          ],
        },
      },
    ];
    await using screen = await renderArchive();
    await screen.getByRole("searchbox", { name: "Search archived conversations" }).fill("Archived");
    expect(screen.container.textContent?.match(/just now/g)).toHaveLength(2);

    await act(() => vi.advanceTimersByTime(60_000));

    expect(screen.container.textContent?.match(/1m ago/g)).toHaveLength(2);
  });

  it("shows partial archive failures above loaded groups and retries them", async () => {
    using _setup = setup();
    testDoubles.archiveState.snapshots = populatedArchiveSnapshots;
    testDoubles.archiveState.error = "Remote archive unavailable";

    await using screen = await renderArchive();
    const markup = screen.container.innerHTML;

    expect(markup).toContain("Could not load every archive");
    expect(markup).toContain("Remote archive unavailable");
    expect(markup).toContain("Archive project");

    clickCapturedButton("Try again to load archives");

    expect(testDoubles.archiveState.refresh).toHaveBeenCalledOnce();
  });

  it("explains a search miss while a partial archive failure is shown", async () => {
    using _setup = setup();
    testDoubles.archiveState.error = "Remote archive unavailable";

    await using screen = await renderPopulatedArchive("missing title");
    const markup = screen.container.innerHTML;

    expect(markup).toContain("Could not load every archive");
    expect(markup).toContain("No matching archived threads");
  });

  it("shows the retry alert when every archive fails", async () => {
    using _setup = setup();
    testDoubles.archiveState.error = "Every archive is unavailable";

    await using screen = await renderArchive();
    const markup = screen.container.innerHTML;

    expect(markup).toContain("Could not load every archive");
    expect(markup).toContain("Every archive is unavailable");
    expect(markup).not.toContain("Could not load archived threads");

    clickCapturedButton("Try again to load archives");

    expect(testDoubles.archiveState.refresh).toHaveBeenCalledOnce();
  });

  it.each(["Unarchive", "Delete"])(
    "blocks a retained %s callback after permission is revoked",
    async (label) => {
      using _setup = setup();
      await using _screen = await renderPopulatedArchive("Archived");
      testDoubles.canOperate = false;
      clickCapturedButton(`${label} Archived conversation`);
      expect(testDoubles.confirm).not.toHaveBeenCalled();
      expect(testDoubles.unarchiveThread).not.toHaveBeenCalled();
      expect(testDoubles.deleteThread).not.toHaveBeenCalled();
      expect(testDoubles.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Archive action unavailable",
        }),
      );
    },
  );

  it("keeps Archive Undo when permission is revoked during project confirmation", async () => {
    using _setup = setup();
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-1"),
    );
    const undo = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
    testDoubles.contextMenuResult = "unarchive-all";
    testDoubles.confirm.mockImplementationOnce(async () => {
      testDoubles.canOperate = false;
      return true;
    });
    await using _screen = await renderPopulatedArchive();
    clickCapturedButton("Project actions for Archive project", {
      getBoundingClientRect: () => ({ right: 0, bottom: 0 }),
    });
    try {
      await vi.waitFor(() =>
        expect(testDoubles.toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Archived threads not fully unarchived",
          }),
        ),
      );
      expect(testDoubles.unarchiveThread).not.toHaveBeenCalled();
      expect(undo.isCurrent()).toBe(true);
    } finally {
      undo.finish();
    }
  });

  it("requests a destructive confirmation for a single archived-thread delete", async () => {
    using _setup = setup();
    // Searching expands the project so its row actions are rendered.
    await using _screen = await renderPopulatedArchive("Archived");

    clickCapturedButton("Delete Archived conversation");

    await vi.waitFor(() => {
      expect(testDoubles.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Delete archived conversation "Archived conversation"?'),
        { variant: "destructive" },
      );
    });
  });

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      buttonLabel: "Unarchive",
      confirm: false,
    },
    {
      action: () => testDoubles.deleteThread,
      buttonLabel: "Delete",
      confirm: true,
    },
  ])(
    "refreshes after a successful single $buttonLabel",
    async ({ action, buttonLabel, confirm }) => {
      using _setup = setup();
      action().mockResolvedValueOnce({ _tag: "Success", value: { sequence: 2 } });
      if (confirm) testDoubles.confirm.mockResolvedValueOnce(true);
      await using _screen = await renderPopulatedArchive("Archived");

      clickCapturedButton(`${buttonLabel} Archived conversation`);

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledWith({
          environmentId: "environment-1",
          input: { threadId: "thread-1" },
        });
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );

  it.each(["row", "project"] as const)(
    "expires only the restored thread's Archive Undo before a %s restore starts",
    async (source) => {
      using _setup = setup();
      const threadRef = scopeThreadRef(
        EnvironmentId.make("environment-1"),
        ThreadId.make("thread-1"),
      );
      const threadKey = scopedThreadKey(threadRef);
      const archive = ThreadUndo.begin("archive", threadKey);
      const pin = ThreadUndo.begin("pin", threadKey);
      const otherEnvironment = ThreadUndo.begin(
        "archive",
        scopedThreadKey({ ...threadRef, environmentId: EnvironmentId.make("environment-2") }),
      );
      try {
        testDoubles.unarchiveThread.mockImplementationOnce(async () => {
          expect(archive.isCurrent()).toBe(false);
          expect(pin.isCurrent()).toBe(true);
          expect(otherEnvironment.isCurrent()).toBe(true);
          return { _tag: "Success", value: { sequence: 2 } };
        });
        if (source === "project") {
          testDoubles.contextMenuResult = "unarchive-all";
          testDoubles.confirm.mockResolvedValueOnce(true);
        }
        await using _screen = await renderPopulatedArchive("Archived");
        clickCapturedButton(
          source === "row"
            ? "Unarchive Archived conversation"
            : "Project actions for Archive project",
          { getBoundingClientRect: () => ({ right: 80, bottom: 40 }) },
        );

        await vi.waitFor(() => {
          expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        });
        expect(archive.isCurrent()).toBe(false);
        expect(testDoubles.toastAdd).not.toHaveBeenCalled();
      } finally {
        archive.finish();
        pin.finish();
        otherEnvironment.finish();
      }
    },
  );

  it("keeps Archive Undo when a project restore is cancelled", async () => {
    using _setup = setup();
    const archive = ThreadUndo.begin(
      "archive",
      scopedThreadKey(
        scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1")),
      ),
    );
    try {
      testDoubles.contextMenuResult = "unarchive-all";
      testDoubles.confirm.mockResolvedValueOnce(false);
      await using _screen = await renderPopulatedArchive();
      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });

      await vi.waitFor(() => expect(testDoubles.confirm).toHaveBeenCalledOnce());
      expect(archive.isCurrent()).toBe(true);
      expect(testDoubles.unarchiveThread).not.toHaveBeenCalled();
      expect(testDoubles.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();

      testDoubles.confirm.mockResolvedValueOnce(true);
      testDoubles.unarchiveThread.mockResolvedValueOnce({
        _tag: "Success",
        value: { sequence: 2 },
      });
      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });
      await vi.waitFor(() => {
        expect(testDoubles.unarchiveThread).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
      });
    } finally {
      archive.finish();
    }
  });

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      buttonLabel: "Unarchive",
      title: "Failed to unarchive thread",
    },
    {
      action: () => testDoubles.deleteThread,
      buttonLabel: "Delete",
      title: "Failed to delete thread",
    },
  ])("reports an unexpected $buttonLabel rejection", async ({ action, buttonLabel, title }) => {
    using _setup = setup();
    const error = new Error(`${buttonLabel} rejected`);
    action().mockRejectedValueOnce(error);
    if (buttonLabel === "Delete") {
      testDoubles.confirm.mockResolvedValueOnce(true);
    }
    await using _screen = await renderPopulatedArchive("Archived");

    clickCapturedButton(`${buttonLabel} Archived conversation`);

    await vi.waitFor(() => {
      expect(testDoubles.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title,
        description: error.message,
      });
      expect(testDoubles.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
      expect(testDoubles.archiveState.refresh).not.toHaveBeenCalled();
    });

    action().mockResolvedValueOnce({ _tag: "Success", value: { sequence: 2 } });
    if (buttonLabel === "Delete") testDoubles.confirm.mockResolvedValueOnce(true);
    clickCapturedButton(`${buttonLabel} Archived conversation`);
    await vi.waitFor(() => {
      expect(action()).toHaveBeenCalledTimes(2);
      expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { source: "row", familyLookupFails: false, configArrivesDuringConfirmation: false },
    { source: "project", familyLookupFails: false, configArrivesDuringConfirmation: false },
    { source: "row", familyLookupFails: true, configArrivesDuringConfirmation: false },
    { source: "project", familyLookupFails: true, configArrivesDuringConfirmation: false },
    { source: "row", familyLookupFails: false, configArrivesDuringConfirmation: true },
    { source: "project", familyLookupFails: false, configArrivesDuringConfirmation: true },
  ])(
    "cleans up the deleted thread and its side-chat drafts after a $source delete, family lookup fails: $familyLookupFails, config arrives during confirmation: $configArrivesDuringConfirmation",
    async ({ source, familyLookupFails, configArrivesDuringConfirmation }) => {
      using _setup = setup();
      const threadRef = scopeThreadRef(
        EnvironmentId.make("environment-1"),
        ThreadId.make("thread-1"),
      );
      testDoubles.familyLookupFails = familyLookupFails;
      if (configArrivesDuringConfirmation) {
        appAtomRegistry.set(testDoubles.serverConfigs, new Map());
      }
      testDoubles.familyThreads = [
        {
          id: ThreadId.make("side-chat"),
          lineage: { parentThreadId: threadRef.threadId, sideChat: true },
        },
        { id: ThreadId.make("fork"), lineage: { parentThreadId: threadRef.threadId } },
        {
          id: ThreadId.make("other-side-chat"),
          lineage: { parentThreadId: ThreadId.make("other-parent"), sideChat: true },
        },
      ];
      const otherEnvironmentRef = {
        ...threadRef,
        environmentId: EnvironmentId.make("environment-2"),
      };
      const snapshot = {
        threadId: threadRef.threadId,
        tabId: "archive-preview",
        navStatus: { _tag: "Loading" as const, url: "https://example.com", title: "" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-09T00:00:00.000Z",
      };
      applyPreviewServerSnapshot(threadRef, snapshot);
      applyPreviewServerSnapshot(otherEnvironmentRef, snapshot);
      const threadKey = scopedThreadKey(threadRef);
      const otherKey = scopedThreadKey(otherEnvironmentRef);
      using undoClaims = new DisposableStack();
      const claims = ["settle", "snooze", "pin", "archive"].map((kind) => {
        const target = ThreadUndo.begin(kind, threadKey);
        const other = ThreadUndo.begin(kind, otherKey);
        undoClaims.defer(() => {
          target.finish();
          other.finish();
        });
        return { target, other };
      });
      for (const ref of [threadRef, otherEnvironmentRef]) {
        useRightPanelStore.getState().open(ref, "diff");
        useDiffPanelStore.getState().selectBranchBaseRef(ref, "archive-base");
        usePreviewMiniPlayerStore.getState().open(ref, { kind: "browser", tabId: snapshot.tabId });
      }
      useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
      expect(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(threadRef)],
      ).toBeDefined();
      testDoubles.deleteThread.mockResolvedValueOnce({ _tag: "Success", value: { sequence: 2 } });
      testDoubles.confirm.mockImplementationOnce(async () => {
        appAtomRegistry.set(
          testDoubles.serverConfigs,
          new Map([[EnvironmentId.make("environment-1"), { shellThreadFamilies: true }]]),
        );
        return true;
      });
      if (source === "project") testDoubles.contextMenuResult = "delete-all";
      const [entry] = populatedArchiveSnapshots;
      const [parent] = entry.snapshot.threads;
      const archivedSideChatId = ThreadId.make("archived-side-chat");
      await using _screen = await renderPopulatedArchive("Archived conversation", [
        {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            threads: [
              parent,
              {
                ...parent,
                id: archivedSideChatId,
                title: "Search-excluded side chat",
                lineage: { ...parent.lineage, parentThreadId: threadRef.threadId, sideChat: true },
              },
            ],
          },
        },
      ]);

      clickCapturedButton(
        source === "row" ? "Delete Archived conversation" : "Project actions for Archive project",
        { getBoundingClientRect: () => ({ right: 80, bottom: 40 }) },
      );

      await vi.waitFor(() => {
        expect(testDoubles.permanentlyDiscardComposerDraft.mock.calls).toHaveLength(3);
        expect(testDoubles.permanentlyDiscardComposerDraft.mock.calls).toEqual(
          expect.arrayContaining([
            [threadRef],
            [scopeThreadRef(threadRef.environmentId, ThreadId.make("side-chat"))],
            [scopeThreadRef(threadRef.environmentId, archivedSideChatId)],
          ]),
        );
        expect(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(threadRef)],
        ).toBeUndefined();
        expect(readThreadPreviewState(threadRef).sessions).toEqual({});
        expect(readThreadPreviewState(otherEnvironmentRef).sessions[snapshot.tabId]).toEqual(
          snapshot,
        );
        expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();
        expect(useDiffPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();
        expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[threadKey]).toBeUndefined();
        expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toBeUndefined();
        expect(useRightPanelStore.getState().byThreadKey[otherKey]).toBeDefined();
        expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[otherKey]).toBe(
          "archive-base",
        );
        expect(usePreviewMiniPlayerStore.getState().byThreadKey[otherKey]).toBeDefined();
        for (const { target, other } of claims) {
          expect(target.isCurrent()).toBe(false);
          expect(other.isCurrent()).toBe(true);
        }
      });
    },
  );

  it("requests a destructive confirmation for a project bulk delete", async () => {
    using _setup = setup();
    testDoubles.contextMenuResult = "delete-all";
    await using _screen = await renderPopulatedArchive();

    clickCapturedButton("Project actions for Archive project", {
      getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
    });

    await vi.waitFor(() => {
      expect(testDoubles.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Delete all archived conversations in "Archive project"?'),
        { variant: "destructive" },
      );
    });
  });

  it("keeps project bulk unarchive on the default confirmation variant", async () => {
    using _setup = setup();
    testDoubles.contextMenuResult = "unarchive-all";
    await using screen = await renderPopulatedArchive();

    screen.getByRole("button", { name: "Project actions for Archive project" }).element().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");

    await vi.waitFor(() => expect(testDoubles.confirm).toHaveBeenCalled());
    expect(testDoubles.contextMenu).toHaveBeenCalledExactlyOnceWith(
      expect.any(Array),
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      "keyboard",
    );
    const [message, options] = testDoubles.confirm.mock.calls[0]!;
    expect(message).toContain('Unarchive all archived conversations in "Archive project"?');
    expect(options?.variant).not.toBe("destructive");
  });

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      contextMenuResult: "unarchive-all",
    },
    {
      action: () => testDoubles.deleteThread,
      contextMenuResult: "delete-all",
    },
  ])(
    "refreshes once after a successful $contextMenuResult project action",
    async ({ action, contextMenuResult }) => {
      using _setup = setup();
      testDoubles.contextMenuResult = contextMenuResult;
      testDoubles.confirm.mockResolvedValueOnce(true);
      action().mockResolvedValueOnce({ _tag: "Success", value: { sequence: 2 } });
      await using _screen = await renderPopulatedArchive();

      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      contextMenuResult: "unarchive-all",
    },
    {
      action: () => testDoubles.deleteThread,
      contextMenuResult: "delete-all",
    },
  ])(
    "refreshes once after a throwing $contextMenuResult project action",
    async ({ action, contextMenuResult }) => {
      using _setup = setup();
      testDoubles.contextMenuResult = contextMenuResult;
      testDoubles.confirm.mockResolvedValueOnce(true);
      action().mockRejectedValueOnce(new Error(`${contextMenuResult} rejected`));
      await using _screen = await renderPopulatedArchive();

      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );
});

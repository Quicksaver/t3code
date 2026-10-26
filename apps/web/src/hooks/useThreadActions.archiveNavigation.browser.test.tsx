import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";

const state = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    shell: Atom.make<EnvironmentThreadShell | null>(null),
    unarchiveReceipt: () => {},
  };
});

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: state.registry }));
vi.mock("../state/threads", async (original) => {
  const module = await original<typeof import("../state/threads")>();
  return {
    ...module,
    environmentThreadShells: {
      ...module.environmentThreadShells,
      threadShellAtom: () => state.shell,
    },
  };
});
vi.mock("../state/entities", async (original) => {
  const module = await original<typeof import("../state/entities")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...module,
    useQuietThreadShell: (ref: unknown) =>
      useSyncExternalStore(
        (notify) => state.registry.subscribe(state.shell, notify),
        () => (ref === null ? null : state.registry.get(state.shell)),
      ),
    useThreadRefs: () => [],
    useEnvironmentThreadRefs: () => [{ environmentId: "undo-env", threadId: "another" }],
  };
});
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async () => {
    if (command === threadEnvironment.unarchive) state.unarchiveReceipt();
    return { _tag: "Success", value: undefined };
  },
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/shell", async (original) => ({
  ...(await original<typeof import("../state/shell")>()),
  // A live shell makes a missing thread authoritative to the route's redirect guard.
  useEnvironmentShellStatus: () => "live",
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", async () => {
  const { useNavigate } = await import("@tanstack/react-router");
  return {
    useNewThreadHandler: () => {
      const navigate = useNavigate();
      return () => navigate({ to: "/draft/$draftId", params: { draftId: "archive-draft" } });
    },
  };
});
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ChatView", () => ({ default: () => "Conversation" }));

import { threadEnvironment } from "../state/threads";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { useThreadActions } from "./useThreadActions";
import { useThreadUndoNotice } from "./showThreadUndoNotice";

const target = { environmentId: EnvironmentId.make("undo-env"), threadId: ThreadId.make("thread") };

function Actions() {
  const actions = useThreadActions();
  return (
    <>
      <button onClick={() => actions.archiveThread(target)}>Archive</button>
      <Outlet />
    </>
  );
}

function Landing() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/draft/$draftId", params: { draftId: "archive-draft" } });
  }, [navigate]);
  return null;
}

function setup() {
  state.registry.set(state.shell, null);
  state.unarchiveReceipt = () => {};
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  return {
    [Symbol.dispose]() {
      useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    },
  };
}

it("waits for the restored thread in a live shell before Undo returns through the real route view", async () => {
  using _state = setup();
  const thread = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
  // A partial async store mock deadlocks on the store/model-selection/TraitsPicker cycle.
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(
      { environmentId: target.environmentId, projectId: thread.projectId },
      DraftId.make("archive-draft"),
    );
  state.registry.set(state.shell, thread);
  const root = createRootRoute({ component: Actions });
  const server = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => <ThreadRouteView target={{ kind: "server", threadRef: target }} />,
  });
  const draft = createRoute({
    getParentRoute: () => root,
    path: "/draft/$draftId",
    component: () => (
      <ThreadRouteView target={{ kind: "draft", draftId: DraftId.make("archive-draft") }} />
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: Landing });
  const router = createRouter({
    isServer: false,
    routeTree: root.addChildren([index, server, draft]),
    history: createMemoryHistory({ initialEntries: ["/undo-env/thread"] }),
  });
  await router.load();
  // This test supplies its own router to exercise the real route guard.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const { container } = screen;
  await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(router.state.location.pathname).toBe("/draft/archive-draft");
  await act(() => state.registry.set(state.shell, null));
  expect(state.registry.get(state.shell)).toBeNull();

  let receipt!: () => void;
  const received = new Promise<void>((resolve) => {
    receipt = resolve;
  });
  state.unarchiveReceipt = receipt;
  let undo!: Promise<void>;
  await act(async () => {
    undo = useThreadUndoNotice.getState().notice!.undo();
    await received;
  });
  expect(router.state.location.pathname).toBe("/draft/archive-draft");
  await act(async () => {
    state.registry.set(state.shell, thread);
    await undo;
  });
  expect(router.state.location.pathname).toBe("/undo-env/thread");
  expect(container.textContent).toContain("Conversation");
});

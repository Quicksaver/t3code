import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectActionThreadId } from "@t3tools/client-runtime/project-actions";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  detachedPanelWindowName,
  useDetachedPanelStore,
} from "../detachedPanels/detachedPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { readProject } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cycleThreadTerminal } from "./cycleThreadTerminal";
import { registerTerminalFocusTarget } from "./terminalFocus";

vi.mock("../state/entities", () => ({ readProject: vi.fn() }));
vi.mock("../state/session", () => ({ readEnvironmentScope: vi.fn() }));

const destination = {
  environmentId: EnvironmentId.make("remote"),
  environmentLabel: "Remote",
  projectId: ProjectId.make("project"),
  projectCwd: "/remote/project",
  label: "Remote action",
};

function setup() {
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(readProject).mockReturnValue({
    environmentId: destination.environmentId,
    id: destination.projectId,
    title: "Remote project",
    workspaceRoot: destination.projectCwd,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
    serverObservationsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  return scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("cycle"));
}

it("cycles drawer tabs and split panes in display order, wraps both ways, and focuses the target", () => {
  const ref = setup();
  const drawer = useTerminalUiStateStore.getState();
  drawer.newTerminal(ref, "a");
  drawer.newTerminal(ref, "b");
  drawer.setActiveTerminal(ref, "a");
  drawer.splitTerminal(ref, "c");
  drawer.newTerminal(ref, "z");
  drawer.reconcileTerminalIds(ref, ["z", "c", "b", "a"]);
  let focused: string | null = null;
  const unregister = ["a", "c", "b", "z"].map((terminalId) =>
    registerTerminalFocusTarget({
      threadRef: ref,
      terminalId,
      focus: () => {
        focused = terminalId;
        return true;
      },
    }),
  );
  try {
    drawer.setActiveTerminal(ref, "a");
    for (const expected of ["c", "b", "z", "a"]) {
      expect(cycleThreadTerminal(ref, "drawer", "next")).toBe(true);
      expect(
        selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          ref,
        ).activeTerminalId,
      ).toBe(expected);
      expect(focused).toBe(expected);
    }
    cycleThreadTerminal(ref, "drawer", "previous");
    expect(focused).toBe("z");
    const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), ref.threadId);
    expect(cycleThreadTerminal(remoteRef, "drawer", "next")).toBe(false);
    drawer.setTerminalOpen(ref, false);
    expect(cycleThreadTerminal(ref, "drawer", "next")).toBe(false);
  } finally {
    for (const dispose of unregister) dispose();
  }
});

it("cycles panel terminal surfaces and splits without changing the drawer", () => {
  const ref = setup();
  const drawer = useTerminalUiStateStore.getState();
  drawer.newTerminal(ref, "drawer");
  const panels = useRightPanelStore.getState();
  panels.openTerminal(ref, "a");
  const firstSurfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    ref,
  ).activeSurfaceId!;
  panels.splitTerminal(ref, firstSurfaceId, "b");
  panels.openFile(ref, "notes.md");
  expect(cycleThreadTerminal(ref, "right-panel", "next")).toBe(false);
  panels.openTerminal(ref, "c");
  for (const [direction, expected] of [
    ["next", "a"],
    ["previous", "c"],
    ["previous", "b"],
  ] as const) {
    expect(cycleThreadTerminal(ref, "right-panel", direction)).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(active).toMatchObject({ kind: "terminal", activeTerminalId: expected });
  }
  expect(
    selectThreadTerminalUiState(useTerminalUiStateStore.getState().terminalUiStateByThreadKey, ref)
      .activeTerminalId,
  ).toBe("drawer");
  panels.close(ref);
  expect(cycleThreadTerminal(ref, "right-panel", "next")).toBe(false);
});

it("cycles local and destination-owned terminals with a shared pane ID", () => {
  const thread = setup();
  const remote = scopeThreadRef(destination.environmentId, projectActionThreadId(destination));
  const panels = useRightPanelStore.getState();
  panels.openTerminal(thread, "shared");
  panels.openTerminal(thread, "action", destination);
  panels.splitTerminal(thread, "terminal:action", "shared");
  panels.activateSurface(thread, "terminal:shared");

  let focused: [typeof thread, string] | undefined;
  const targets = [
    [thread, "shared"],
    [remote, "action"],
    [remote, "shared"],
  ] as const;
  const unregister = targets.map(([threadRef, terminalId]) =>
    registerTerminalFocusTarget({
      threadRef,
      terminalId,
      focus: () => {
        focused = [threadRef, terminalId];
        return true;
      },
    }),
  );
  try {
    for (const expected of [
      [remote, "action"],
      [remote, "shared"],
      [thread, "shared"],
    ]) {
      expect(cycleThreadTerminal(thread, "right-panel", "next")).toBe(true);
      expect(focused).toEqual(expected);
    }
    panels.activateSurface(thread, "terminal:action");
    vi.mocked(readEnvironmentScope).mockImplementation(
      (environmentId) => environmentId === destination.environmentId,
    );
    expect(cycleThreadTerminal(thread, "right-panel", "next")).toBe(true);
    expect(focused).toEqual([remote, "action"]);
    expect(cycleThreadTerminal(thread, "right-panel", "previous")).toBe(true);
    expect(focused).toEqual([remote, "shared"]);
  } finally {
    for (const dispose of unregister) dispose();
  }
});

it.each(["missing grant", "missing project"])(
  "cycles past a saved destination terminal with a %s",
  (unavailable) => {
    const thread = setup();
    const panels = useRightPanelStore.getState();
    panels.openTerminal(thread, "before");
    panels.openTerminal(thread, "action", destination);
    panels.openTerminal(thread, "after");
    panels.activateSurface(thread, "terminal:before");
    if (unavailable === "missing grant") {
      vi.mocked(readEnvironmentScope).mockImplementation(
        (environmentId) => environmentId !== destination.environmentId,
      );
    } else {
      vi.mocked(readProject).mockReturnValue(null);
    }
    const active = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, thread)
        .activeSurfaceId;

    expect(cycleThreadTerminal(thread, "right-panel", "next")).toBe(true);
    expect(active()).toBe("terminal:after");
    expect(cycleThreadTerminal(thread, "right-panel", "previous")).toBe(true);
    expect(active()).toBe("terminal:before");
    panels.activateSurface(thread, "terminal:action");
    expect(cycleThreadTerminal(thread, "right-panel", "next")).toBe(true);
    expect(active()).toBe("terminal:after");
  },
);

it("cycles across terminal windows and preserves the docked tab between detached terminals", () => {
  const ref = setup();
  const panels = useRightPanelStore.getState();
  const panelState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  panels.openTerminal(ref, "a");
  const splitSurfaceId = panelState().activeSurfaceId!;
  panels.splitTerminal(ref, splitSurfaceId, "b");
  panels.openTerminal(ref, "c", destination);
  const singleSurfaceId = panelState().activeSurfaceId!;
  panels.close(ref);
  const detached = useDetachedPanelStore.getState();
  detached.detach(ref, splitSurfaceId);
  const remote = scopeThreadRef(destination.environmentId, projectActionThreadId(destination));
  const focusRemoteTerminal = vi.fn(() => true);
  using _focusTarget = {
    [Symbol.dispose]: registerTerminalFocusTarget({
      threadRef: remote,
      terminalId: "c",
      focus: focusRemoteTerminal,
    }),
  };
  const focus = vi.fn(async () => {});
  const revealWindow = vi.fn(async () => {});
  vi.stubGlobal("window", { desktopBridge: { detachedPanels: { focus }, revealWindow } });
  try {
    expect(cycleThreadTerminal(ref, "right-panel", "previous", splitSurfaceId)).toBe(true);
    expect(panelState()).toMatchObject({ isOpen: false, activeSurfaceId: singleSurfaceId });
    expect(panelState().surfaces.find((surface) => surface.id === splitSurfaceId)).toMatchObject({
      activeTerminalId: "a",
    });

    expect(cycleThreadTerminal(ref, "right-panel", "previous", splitSurfaceId)).toBe(true);
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: singleSurfaceId });
    expect(revealWindow).toHaveBeenCalledOnce();
    expect(focusRemoteTerminal).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();

    detached.detach(ref, singleSurfaceId);
    panels.close(ref);
    expect(cycleThreadTerminal(ref, "right-panel", "next", singleSurfaceId)).toBe(true);
    expect(panelState().isOpen).toBe(false);
    expect(focus).toHaveBeenCalledExactlyOnceWith(
      detachedPanelWindowName(scopedThreadKey(ref), splitSurfaceId),
    );

    panels.openFile(ref, "notes.md");
    const fileSurfaceId = panelState().activeSurfaceId;
    expect(cycleThreadTerminal(ref, "right-panel", "next", splitSurfaceId)).toBe(true);
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileSurfaceId });
    expect(panelState().surfaces.find((surface) => surface.id === splitSurfaceId)).toMatchObject({
      activeTerminalId: "b",
    });
    expect(cycleThreadTerminal(ref, "right-panel", "next", splitSurfaceId)).toBe(true);
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileSurfaceId });
    expect(focus).toHaveBeenLastCalledWith(
      detachedPanelWindowName(scopedThreadKey(ref), singleSurfaceId),
    );
    expect(focusRemoteTerminal).toHaveBeenCalledTimes(2);
    panels.closeSurface(ref, splitSurfaceId);
    expect(cycleThreadTerminal(ref, "right-panel", "next", singleSurfaceId)).toBe(true);
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileSurfaceId });
  } finally {
    vi.unstubAllGlobals();
    useDetachedPanelStore.setState({ byName: {} });
  }
});

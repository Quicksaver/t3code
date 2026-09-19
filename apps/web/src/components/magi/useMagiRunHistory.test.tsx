import { EnvironmentId, MagiRunId, ThreadId, type MagiRunSummary } from "@t3tools/contracts";
import { Effect } from "effect";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useMagiRunHistory } from "./useMagiRunHistory";

const server = vi.hoisted(() => ({ runs: [] as MagiRunSummary[] }));
vi.mock("~/state/magi", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const atoms = new Map<string, ReturnType<typeof makeHistory>>();
  function makeHistory(input: {
    rootThreadId: string;
    limit: number;
    includeDescendants?: boolean;
  }) {
    return Atom.make(
      Effect.sync(() => ({
        runs: server.runs
          .filter((run) => input.includeDescendants || run.rootThreadId === input.rootThreadId)
          .slice(0, input.limit),
        nextCursor: null,
      })),
    );
  }
  return {
    magiEnvironment: {
      history: (target: { input: Parameters<typeof makeHistory>[0] }) => {
        const key = JSON.stringify(target);
        const atom = atoms.get(key) ?? makeHistory(target.input);
        atoms.set(key, atom);
        return atom;
      },
    },
  };
});

const threadRef = {
  environmentId: EnvironmentId.make("history-test"),
  threadId: ThreadId.make("owner"),
};
let latest: ReturnType<typeof useMagiRunHistory>;
let renderer: ReactTestRenderer | undefined;
function Probe() {
  const history = useMagiRunHistory({ threadRef, expanded: true });
  useLayoutEffect(() => {
    latest = history;
  }, [history]);
  return null;
}

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps the owner's timeline live while 100 newer children fill the open panel", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setInterval, clearInterval });
  const owner: MagiRunSummary = {
    runId: MagiRunId.make("owner-run"),
    rootThreadId: threadRef.threadId,
    source: "agent-tool",
    title: { state: "generated", title: "Owner run" },
    state: "deliberating",
    objective: null,
    completedMagiTurns: 0,
    startedAt: "2026-09-09T08:00:00.000Z",
    completedAt: null,
  };
  server.runs = [
    ...Array.from({ length: 100 }, (_, index) => ({
      ...owner,
      runId: MagiRunId.make(`child-run-${index}`),
      rootThreadId: ThreadId.make("child"),
      startedAt: "2026-09-09T09:00:00.000Z",
    })),
    owner,
  ];
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
  });
  expect(latest.latestOwnedRun?.state).toBe("deliberating");
  expect(latest.history?.runs).toHaveLength(100);
  expect(latest.history?.runs.some((run) => run.rootThreadId === threadRef.threadId)).toBe(false);

  server.runs = server.runs.map((run) =>
    run.runId === owner.runId
      ? {
          ...run,
          state: "succeeded",
          completedMagiTurns: 3,
          completedAt: "2026-09-09T10:00:00.000Z",
        }
      : run,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(latest.latestOwnedRun).toMatchObject({
    runId: owner.runId,
    state: "succeeded",
    completedMagiTurns: 3,
  });
  expect(latest.history?.runs.every((run) => run.rootThreadId !== threadRef.threadId)).toBe(true);
});

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { loadSettledArchiveTargets } from "./settledArchiveTargets";

const state = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    pages: Atom.make<{ status: "pending" | "ready" | "failed"; reads: object[] }>({
      status: "pending",
      reads: [],
    }),
    otherPages: Atom.make<{ status: "pending" | "ready" | "failed"; reads: object[] }>({
      status: "pending",
      reads: [],
    }),
    older: Atom.make<object | null>({}),
    granted: new Set<string>(),
    mounted: [] as string[],
    onMount: vi.fn<(environmentId: string) => void>(),
    pageReads: vi.fn<(environmentId: string) => void>(),
    release: vi.fn(),
    threads: vi.fn(),
  };
});
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: state.registry }));
vi.mock("./entities", () => ({ readThreadShells: state.threads }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string) => state.granted.has(environmentId),
}));
vi.mock("./threads", () => ({
  olderSettledThreads: {
    pagesAtom: (scope: { environmentId: string }) => {
      state.pageReads(scope.environmentId);
      return scope.environmentId === "archive-env" ? state.pages : state.otherPages;
    },
    olderSettledAtom: () => state.older,
    rowsKey: () => "rows",
    pageRowsAtom: () => state.pages,
    retryPages: () => {},
  },
  threadFamilies: {
    mountRows: (_registry: unknown, environmentId: string) => {
      state.mounted.push(environmentId);
      state.onMount(environmentId);
      return state.release;
    },
  },
}));

const environmentId = EnvironmentId.make("archive-env");
const projectId = ProjectId.make("archive-project");
const scopes = [{ environmentId, projectIds: [projectId] }];
const otherEnvironmentId = EnvironmentId.make("archive-other");
const bothScopes = [...scopes, { environmentId: otherEnvironmentId, projectIds: [projectId] }];

function setup() {
  state.registry.set(state.pages, { status: "pending", reads: [] });
  state.registry.set(state.otherPages, { status: "pending", reads: [] });
  state.registry.set(state.older, {});
  state.release.mockReset();
  state.threads.mockReset();
  state.granted.clear();
  state.granted.add(environmentId);
  state.granted.add(otherEnvironmentId);
  state.mounted.length = 0;
  state.onMount.mockReset();
  state.pageReads.mockReset();
}

it("waits for the complete older-page chain and filters the live settled project scope", async () => {
  setup();
  const recent = makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make("recent"),
    settledOverride: "settled",
  });
  const older = makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make("older"),
    settledOverride: "settled",
  });
  state.threads.mockReturnValue([
    recent,
    older,
    makeThreadFixture({ environmentId, projectId, settledOverride: "active" }),
    makeThreadFixture({
      environmentId,
      projectId: ProjectId.make("other"),
      settledOverride: "settled",
    }),
    makeThreadFixture({
      environmentId: EnvironmentId.make("other"),
      projectId,
      settledOverride: "settled",
    }),
    makeThreadFixture({
      environmentId,
      projectId,
      settledOverride: "settled",
      snoozedUntil: "9999-01-01T00:00:00.000Z",
    }),
  ]);
  const pending = loadSettledArchiveTargets(scopes);
  expect(state.threads).not.toHaveBeenCalled();
  state.registry.set(state.pages, { status: "ready", reads: [{}] });
  const loaded = await pending;
  expect(loaded.threads).toEqual([recent, older]);
  expect(state.release).not.toHaveBeenCalled();
  loaded.release();
  loaded.release();
  expect(state.release).toHaveBeenCalledOnce();
});

it("releases loaded rows and rejects the whole batch when an older-page read fails", async () => {
  setup();
  const pending = loadSettledArchiveTargets(scopes);
  state.registry.set(state.pages, { status: "failed", reads: [{}] });
  await expect(pending).rejects.toThrow("No threads were archived");
  expect(state.threads).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
});

it("does not mistake an offline cached shell for a fully loaded settled shelf", async () => {
  setup();
  state.registry.set(state.pages, { status: "ready", reads: [] });
  await expect(loadSettledArchiveTargets(scopes)).rejects.toThrow("No threads were archived");
  expect(state.threads).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
});

it("rejects if an earlier environment loses complete pages while another loads", async () => {
  setup();
  state.registry.set(state.pages, { status: "ready", reads: [{}] });
  state.threads.mockReturnValue([]);
  let secondMounted!: () => void;
  const mounted = new Promise<void>((resolve) => {
    secondMounted = resolve;
  });
  state.onMount.mockImplementation((id) => {
    if (id === otherEnvironmentId) secondMounted();
  });
  const pending = loadSettledArchiveTargets(bothScopes);
  await mounted;
  state.registry.set(state.pages, { status: "pending", reads: [] });
  state.registry.set(state.otherPages, { status: "ready", reads: [{}] });
  const outcome = await pending.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  outcome.value?.release();
  expect(outcome.error).toBeInstanceOf(Error);
  expect(state.threads).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledTimes(2);
});

it("does not admit a previously skipped environment when it gains permission mid-load", async () => {
  setup();
  state.granted.delete(environmentId);
  const excluded = makeThreadFixture({ environmentId, projectId, settledOverride: "settled" });
  const included = makeThreadFixture({
    environmentId: otherEnvironmentId,
    projectId,
    settledOverride: "settled",
  });
  state.threads.mockReturnValue([excluded, included]);
  const pending = loadSettledArchiveTargets(bothScopes);
  state.granted.add(environmentId);
  state.registry.set(state.otherPages, { status: "ready", reads: [{}] });
  const loaded = await pending;
  loaded.release();
  expect(loaded.threads).toEqual([included]);
  expect(state.mounted).toEqual([otherEnvironmentId]);
  expect(state.pageReads).not.toHaveBeenCalledWith(environmentId);
});

it("skips page reads and targets for a read-only scope without blocking writable scopes", async () => {
  setup();
  state.granted.delete(environmentId);
  const included = makeThreadFixture({
    environmentId: otherEnvironmentId,
    projectId,
    settledOverride: "settled",
  });
  state.threads.mockReturnValue([
    makeThreadFixture({ environmentId, projectId, settledOverride: "settled" }),
    included,
  ]);
  state.registry.set(state.otherPages, { status: "ready", reads: [{}] });
  const loaded = await loadSettledArchiveTargets(bothScopes);
  loaded.release();
  expect(loaded.threads).toEqual([included]);
  expect(state.pageReads).not.toHaveBeenCalledWith(environmentId);
  expect(state.mounted).toEqual([otherEnvironmentId]);
});

it("starts independent page chains together and releases both on failure", async () => {
  setup();
  vi.useFakeTimers();
  try {
    const pending = loadSettledArchiveTargets(bothScopes);
    const started = [...state.mounted];
    state.registry.set(state.pages, { status: "failed", reads: [] });
    await expect(pending).rejects.toThrow("No threads were archived");
    expect(started).toEqual([environmentId, otherEnvironmentId]);
    expect(state.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("lets a progressing page chain exceed the inactivity limit in total", async () => {
  setup();
  vi.useFakeTimers();
  try {
    state.threads.mockReturnValue([]);
    const pending = loadSettledArchiveTargets(scopes).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    state.registry.set(state.pages, { status: "pending", reads: [{}] });
    await vi.advanceTimersByTimeAsync(20_000);
    state.registry.set(state.pages, { status: "ready", reads: [{}, {}] });
    const outcome = await pending;
    outcome.value?.release();
    expect(outcome.error).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("cancels stalled page waits and releases all scopes without collecting partial targets", async () => {
  setup();
  vi.useFakeTimers();
  try {
    const pending = loadSettledArchiveTargets(bothScopes);
    const rejected = expect(pending).rejects.toThrow("No threads were archived");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(state.threads).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

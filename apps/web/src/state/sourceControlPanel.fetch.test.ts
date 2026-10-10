import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { useSourceControlPanelApi } from "./sourceControlPanel";

const mocks = vi.hoisted(() => ({
  report: vi.fn<() => Promise<void>>(),
  fetch: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: hooks.useCallback,
  useMemo: hooks.useMemo,
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../lib/backgroundActivityReporter", () => ({
  flushBackgroundActivityReport: mocks.report,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => mocks.fetch }));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.fetch }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));

beforeEach(() => {
  hooks.reset();
  vi.resetAllMocks();
});

it("fetches newly opened panel remotes only after its activity report is acknowledged", async () => {
  let acknowledge!: () => void;
  let hasDemand = false;
  mocks.report.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = () => {
          hasDemand = true;
          resolve();
        };
      }),
  );
  mocks.fetch.mockImplementation(async () => ({ _tag: "Success", value: hasDemand }));
  const api = useSourceControlPanelApi(EnvironmentId.make("remote-environment"));
  const fetching = api.vcs.fetchAllRemotes({ cwd: "/repo" });

  expect(mocks.fetch).not.toHaveBeenCalled();
  acknowledge();
  await expect(fetching).resolves.toBe(true);
  expect(mocks.fetch).toHaveBeenCalledWith({
    environmentId: "remote-environment",
    input: { cwd: "/repo" },
  });
});

it("keeps explicit Fetch independent of activity reporting", async () => {
  mocks.report.mockImplementation(() => new Promise(() => {}));
  mocks.fetch.mockResolvedValue({ _tag: "Success", value: true });
  const api = useSourceControlPanelApi(EnvironmentId.make("remote-environment"));

  await expect(api.vcs.fetchAllRemotes({ cwd: "/repo", force: true })).resolves.toBe(true);
  expect(mocks.report).not.toHaveBeenCalled();
});

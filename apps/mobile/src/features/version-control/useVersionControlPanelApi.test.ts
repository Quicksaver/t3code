import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { useVersionControlPanelApi } from "./useVersionControlPanelApi";

const mocks = vi.hoisted(() => ({
  report: vi.fn<() => Promise<void>>(),
  fetch: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../../connection/background-activity", () => ({
  flushMobileBackgroundActivityReport: mocks.report,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.fetch }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.fetch }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: {} }));

beforeEach(() => vi.resetAllMocks());

it("waits for current activity before fetching a newly focused route", async () => {
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
  const api = useVersionControlPanelApi(EnvironmentId.make("remote-environment"));
  const fetching = api.fetchAllRemotes({ cwd: "/repo" });

  expect(mocks.fetch).not.toHaveBeenCalled();
  acknowledge();
  await expect(fetching).resolves.toBe(true);
});

it("keeps explicit Fetch independent of activity reporting", async () => {
  mocks.report.mockImplementation(() => new Promise(() => {}));
  mocks.fetch.mockResolvedValue({ _tag: "Success", value: true });
  const api = useVersionControlPanelApi(EnvironmentId.make("remote-environment"));

  await expect(api.fetchAllRemotes({ cwd: "/repo", force: true })).resolves.toBe(true);
  expect(mocks.report).not.toHaveBeenCalled();
});

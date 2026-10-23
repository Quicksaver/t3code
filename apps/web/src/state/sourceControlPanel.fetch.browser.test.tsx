import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { render } from "../../test/render";
import { useSourceControlPanelApi } from "./sourceControlPanel";

let currentApi: ReturnType<typeof useSourceControlPanelApi>;
function Probe() {
  const api = useSourceControlPanelApi(EnvironmentId.make("remote-environment"));
  useLayoutEffect(() => {
    currentApi = api;
  }, [api]);
  return null;
}
const mocks = vi.hoisted(() => ({
  report: vi.fn<() => Promise<void>>(),
  fetch: vi.fn(),
}));

vi.mock("../lib/backgroundActivityReporter", () => ({
  flushBackgroundActivityReport: mocks.report,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => mocks.fetch }));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.fetch }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));

it("fetches newly opened panel remotes only after its activity report is acknowledged", async () => {
  vi.resetAllMocks();
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
  await using _screen = await render(<Probe />, { router: false });
  const api = currentApi;
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
  vi.resetAllMocks();
  mocks.report.mockImplementation(() => new Promise(() => {}));
  mocks.fetch.mockResolvedValue({ _tag: "Success", value: true });
  await using _screen = await render(<Probe />, { router: false });
  const api = currentApi;

  await expect(api.vcs.fetchAllRemotes({ cwd: "/repo", force: true })).resolves.toBe(true);
  expect(mocks.report).not.toHaveBeenCalled();
});

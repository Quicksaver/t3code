import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useSourceControlPanelApi } from "./sourceControlPanel";

let currentApi: ReturnType<typeof useSourceControlPanelApi>;
let renderer: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function Probe() {
  const api = useSourceControlPanelApi(EnvironmentId.make("remote-environment"));
  useLayoutEffect(() => {
    currentApi = api;
  }, [api]);
  return null;
}
async function renderApi() {
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  await act(() => renderer.render(<Probe />));
  return currentApi;
}
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const api = await renderApi();
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
  const api = await renderApi();

  await expect(api.vcs.fetchAllRemotes({ cwd: "/repo", force: true })).resolves.toBe(true);
  expect(mocks.report).not.toHaveBeenCalled();
});

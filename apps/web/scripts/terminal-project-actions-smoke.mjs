import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium } from "playwright-core";

const ACTION_NAME = "Terminal reuse smoke";
const ACTION_RUN_LABEL = `Run ${ACTION_NAME}`;
const ACTION_LABEL = "Action: terminal reuse smoke";
const ACTION_FALLBACK_LABEL = `${ACTION_LABEL} (2)`;
const ACTION_START_MARKER = "T3_ACTION_SMOKE_START";
const ACTION_DONE_MARKER = "T3_ACTION_SMOKE_DONE";
const DISCONNECTED_ACTION_REASON = "Connect the project host to run actions.";
const DEFAULT_WEB_PORT = "5740";

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function resolveBrowserLaunchOptions() {
  const configuredExecutable = process.env.T3CODE_BROWSER_EXECUTABLE?.trim();
  if (configuredExecutable) {
    await NodeFSP.access(configuredExecutable);
    return { executablePath: configuredExecutable };
  }

  const configuredChannel = process.env.T3CODE_BROWSER_CHANNEL?.trim();
  return { channel: configuredChannel || "chrome" };
}

function markerCount(value, marker) {
  return value.split(marker).length - 1;
}

async function terminalText(page) {
  return page.locator(".xterm-rows").innerText();
}

async function waitForMarkerCount(page, marker, expectedCount, timeout = 20_000) {
  await page.waitForFunction(
    ({ expected, target }) => {
      const text = document.querySelector(".xterm-rows")?.textContent ?? "";
      return text.split(target).length - 1 >= expected;
    },
    { expected: expectedCount, target: marker },
    { timeout },
  );
}

async function addDisposableProject(page, projectPath) {
  await page.getByRole("button", { name: "Add project" }).first().click();
  const palette = page.getByTestId("command-palette");
  await palette.getByText("Local folder", { exact: true }).click();

  const input = palette.locator("input").first();
  await input.fill(`${projectPath}${NodePath.sep}`);
  await palette.getByRole("button", { name: "Add (Enter)" }).waitFor({ state: "visible" });
  await input.press("Enter");
  await page.getByRole("button", { name: "Add action" }).waitFor({ state: "visible" });
}

async function addProjectAction(page) {
  await page.getByRole("button", { name: "Add action" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Action" });
  await dialog.getByLabel("Name").fill(ACTION_NAME);
  await dialog
    .getByLabel("Command")
    .fill("printf 'T3_ACTION_%s\\n' 'SMOKE_START'; sleep 2; printf 'T3_ACTION_%s\\n' 'SMOKE_DONE'");
  await dialog.getByRole("button", { name: "Save action" }).click();
  await page.getByRole("button", { name: ACTION_RUN_LABEL }).waitFor({ state: "visible" });
}

async function showProjectActionTooltip(page, runButton) {
  const bounds = await runButton.boundingBox();
  NodeAssert.ok(bounds, "Project action run control must have visible bounds.");
  await page.mouse.move(0, 0);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const tooltip = page.getByText(DISCONNECTED_ACTION_REASON, { exact: true });
  const tooltipVisible = await tooltip
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!tooltipVisible) {
    await runButton.focus();
    await tooltip.waitFor({ state: "visible", timeout: 3_000 });
  }
}

async function runScenario(page, context, projectPath, browserErrors) {
  await page.getByText("What should we work on?").waitFor({ state: "visible" });
  await addDisposableProject(page, projectPath);
  await addProjectAction(page);

  const runButton = page.getByRole("button", { name: ACTION_RUN_LABEL });

  // The first launch opens a brand-new shell and proves the readiness path writes only once
  // the real terminal accepts the action command.
  await runButton.click();
  await page.locator(".thread-terminal-drawer").waitFor({ state: "visible" });
  await waitForMarkerCount(page, ACTION_DONE_MARKER, 1);
  await page.getByText(ACTION_LABEL, { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  NodeAssert.equal(await page.locator(".xterm").count(), 1);

  // An idle repeated launch should reuse the same action terminal.
  await runButton.click();
  await waitForMarkerCount(page, ACTION_DONE_MARKER, 2);
  await page.getByText(ACTION_LABEL, { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  NodeAssert.equal(await page.locator(".xterm").count(), 1);
  NodeAssert.equal(markerCount(await terminalText(page), ACTION_DONE_MARKER), 2);
  NodeAssert.equal(await page.getByText(ACTION_FALLBACK_LABEL, { exact: true }).count(), 0);

  // Once the stable terminal is busy, another launch should allocate a named fallback.
  await runButton.click();
  await waitForMarkerCount(page, ACTION_START_MARKER, 3);
  NodeAssert.equal(markerCount(await terminalText(page), ACTION_DONE_MARKER), 2);
  await runButton.click();
  await page.getByText(ACTION_FALLBACK_LABEL, { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.getByText(ACTION_LABEL, { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });

  NodeAssert.deepEqual(browserErrors, [], "Browser errors occurred before the host disconnect.");

  // Simulate losing the project host while preserving the current UI surface. The run control
  // must remain tooltip-triggerable but guarded against dispatching another action.
  await context.setOffline(true);
  await page.waitForFunction(
    (label) =>
      document.querySelector(`button[aria-label="${label}"]`)?.getAttribute("aria-disabled") ===
      "true",
    ACTION_RUN_LABEL,
    { timeout: 20_000 },
  );
  const terminalLabelsBeforeGuardedClick = await page
    .getByText(/^Action: terminal reuse smoke/)
    .count();
  await showProjectActionTooltip(page, runButton);
  await runButton.click({ force: true });
  NodeAssert.equal(
    await page.getByText(/^Action: terminal reuse smoke/).count(),
    terminalLabelsBeforeGuardedClick,
  );

  return {
    stableTerminalLabel: ACTION_LABEL,
    fallbackTerminalLabel: ACTION_FALLBACK_LABEL,
    completedStableRuns: 2,
    disconnectedReason: DISCONNECTED_ACTION_REASON,
  };
}

const pairUrl = new URL(requiredEnvironmentVariable("T3CODE_PAIR_URL"));
const expectedWebPort = process.env.T3CODE_WEB_PORT?.trim() || DEFAULT_WEB_PORT;
NodeAssert.equal(pairUrl.pathname, "/pair", "T3CODE_PAIR_URL must be a pairing URL.");
NodeAssert.match(pairUrl.hash, /^#token=.+/, "T3CODE_PAIR_URL must include its token fragment.");
NodeAssert.equal(
  pairUrl.port,
  expectedWebPort,
  `Pairing URL must use web port ${expectedWebPort}.`,
);

const projectPath = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "t3code-terminal-action-smoke."),
);
const browser = await chromium.launch({
  ...(await resolveBrowserLaunchOptions()),
  headless: process.env.T3CODE_SMOKE_HEADFUL !== "1",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
page.on("console", (message) => {
  if (
    message.type() === "error" &&
    message.text() !==
      "Failed to load resource: the server responded with a status of 404 (Not Found)"
  ) {
    browserErrors.push(`console: ${message.text()}`);
  }
});
page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  const pathname = new URL(response.url()).pathname;
  const expectedDraftThreadMiss =
    response.status() === 404 && /^\/api\/orchestration\/threads\/[^/]+$/.test(pathname);
  if (response.status() >= 400 && pathname !== "/favicon.ico" && !expectedDraftThreadMiss) {
    browserErrors.push(`http ${response.status()}: ${pathname}`);
  }
});

try {
  await page.goto(pairUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 30_000 });
  const result = await runScenario(page, context, projectPath, browserErrors);

  // Network errors after setOffline(true) are expected; everything before the host disconnect
  // should remain clean.
  const unexpectedErrors = browserErrors.filter(
    (message) => !message.includes("WebSocket") && !message.includes("ERR_INTERNET_DISCONNECTED"),
  );
  NodeAssert.deepEqual(unexpectedErrors, []);
  console.log(JSON.stringify({ status: "passed", ...result }, null, 2));
} catch (error) {
  const screenshotPath = process.env.T3CODE_SMOKE_SCREENSHOT?.trim();
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  }
  const terminalSnapshot = await page
    .locator(".xterm-rows")
    .innerText()
    .catch(() => "<terminal unavailable>");
  const visibleText = await page
    .locator("body")
    .innerText()
    .catch(() => "<page unavailable>");
  console.error(
    JSON.stringify(
      {
        status: "failed",
        terminalSnapshot: terminalSnapshot.slice(-2_000),
        visibleText: visibleText.replaceAll(/\s+/g, " ").trim().slice(-2_000),
        browserErrors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await NodeFSP.rm(projectPath, { recursive: true, force: true });
}

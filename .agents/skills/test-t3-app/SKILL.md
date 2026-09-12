---
name: test-t3-app
description: Launch, retain, and test the T3 Code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

Use this skill for the web client. For iOS Simulator, Android Emulator, or physical-device testing against an isolated T3 backend, use the sibling [`test-t3-mobile`](../test-t3-mobile/SKILL.md) skill.

Web servers do not use a runtime queue. Every integrated web UI pass uses the `desktop` lease for the host running its browser automation, including collaborative preview, Playwright, Chrome control, and fallback drivers. When either fleet host is suitable, follow `$worktrees` and enter both desktop queues concurrently; the first eligible host runs the verification and the losing request exits before interaction. Acquire only one host for a host-specific flow.

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.t3` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev`. Add `--share` when the user needs to open it from another tailnet device. In a linked worktree it defaults to that worktree's gitignored `.t3`; pass `--home-dir <base-dir>` only when the test needs a different isolated directory. When `$spawn-worktree` delegates fixed Web and Server ports from `BRANCH_DETAILS.md`, derive their shared offset from the base ports (`<web-port> - 5733`, which must also equal `<server-port> - 13773`) and launch with `T3CODE_PORT_OFFSET=<offset>`. Without that explicit override, the dev runner's path hash selects a different stable pair.
4. Keep the terminal session alive and read the selected server port, web port, base directory, and pairing URL from its output.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.t3` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The worktree-local default deliberately outranks an ambient `T3CODE_HOME`; do not pass the shared home through to a worktree dev server.

Ports are derived from the worktree path but can shift when occupied. Always read the actual values from the `[dev-runner]` line.

Shared browser dev is single-origin: Vite proxies the backend paths, so never set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

When the controlled browser is an already-running shared T3 Code desktop
instance, follow `$worktrees` and hold its desktop runtime slot for the complete
interaction block. Pair a disposable backend through **Settings >
Connections** before selecting its seeded project. Do not open that backend's
pairing URL inside a preview guest: doing so authenticates the guest itself,
does not register the desktop as an automation host, and consumes the one-time
credential.

### Verify a shared environment before human handoff

When another person will use the printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the T3 Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

### Route a worktree server through collaborative preview

When driving a Windows-hosted `vp run dev` through T3 Code's collaborative preview, treat the preview as another tailnet consumer and launch with `--share` from the outset. Read the actual `webPort` and shared HTTPS origin from the current `[dev-runner]` line. Call `preview_status` first; if no automation-capable tab exists, call `preview_open` without a URL and retain its returned tab id. Navigate that tab to the shared origin and confirm the app loads before pairing, then navigate the same tab to the exact shared pairing URL.

If the shared origin returns 502 while loopback HTTP is healthy, compare the Vite listener with `tailscale serve status --json`. An older worktree can leave the proxy targeting `http://127.0.0.1:<web-port>` while Vite listens only on `::1`. Stop only the exact test-owned mapping with `tailscale serve --https=<share-port> off`, then recreate it with `tailscale serve --bg --https=<share-port> http://localhost:<web-port>`; an explicit `http://[::1]:<web-port>` is also valid when the listener is known. Verify the bare shared origin before issuing or consuming a pairing token. Current main-owned sharing uses `localhost` automatically, so do not keep restarting the app once an older branch's address-family mismatch is proven.

The environment-port bridge can translate the Windows loopback URL to the host's tailnet IP while Vite remains bound only to `127.0.0.1`. The translated URL then refuses the connection, the preview eventually reports `chrome-error://chromewebdata/`, and `preview_navigate` may time out even though loopback HTTP is healthy. Do not retry that route or diagnose the app; restart the test-owned stack with `--share` if it was not already shared, issue a fresh token, and use the verified shared HTTPS origin.

On a host where the preview and worktree have a verified direct environment route, read the actual `webPort` from `[dev-runner]` and use the environment-port bridge. Call `preview_status` first; if no automation-capable tab exists, call `preview_open` without a URL and retain its returned tab id. Navigate the initialized tab with `preview_navigate`:

```json
{
  "tabId": "<returned-tab-id>",
  "target": {
    "kind": "environment-port",
    "port": 5733,
    "path": "/pair#token=<token>"
  }
}
```

Replace `5733` with the selected worktree web port. Preserve the complete pairing path and fragment, navigate it exactly once, and continue in the same tab. For an already authenticated tab, use the same target with the required non-secret path.

Do not pass a loopback pairing URL such as `http://127.0.0.1:<web-port>/pair#token=...` directly to `preview_open` or `preview_navigate`. Use `--share` whenever the controlled preview, a human, or another device is not in the checkout host's direct network namespace.

## Preserve the environment while iterating

Treat the overall testing or implementation loop—not an assistant turn or one verification pass—as the environment lifecycle boundary.

- Keep the dev process, base directory, selected ports, authenticated browser tab, registered projects, and seeded fixtures alive while the user may inspect the result or request follow-up changes.
- Do not stop the server merely because one verification pass completed or because you are yielding a response to the user.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- Tell the user when a test environment remains available, including its non-secret web URL when useful. Include a pairing token only when the user still needs to pair (see below).

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Keep pairing URLs out of screenshots, committed files, and durable logs. When the user asked for a shared environment, the deliverable IS the full pairing URL — paste it in your reply, token and all; a bare origin is useless to them. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it, so never open a URL you handed to the user.

## Recover a consumed or expired pairing token

Run `node apps/server/src/bin.ts pair` from the repository root. It discovers the running dev server (worktree `.t3` first, same precedence as the dev runner) and prints a fresh `Pair URL` against the server's current web origin, including a `--share` tailnet origin. Pass `--base-dir <base-dir>` only when the server was started with `--home-dir`, using the identical path.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries admin scopes; if the user needs Settings → Connections management (`access:write`), restart the server and hand over the new startup URL instead.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/t3-sqlite-state.ts query` for schema discovery and read-only checks. It targets `state.sqlite` by default; pass `--database archive` when inspecting cold archive manifests or chunks.
- Stop the dev server before using `node apps/server/scripts/t3-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.t3` directory by default and creates a database backup before each mutation.

## Tear down only when the testing loop is finished

Tear down when the user explicitly asks, confirms the iteration is finished, or the overall task is genuinely complete with no pending human review. Do not infer completion from the end of an assistant turn.

When teardown is appropriate:

1. Close every collaborative preview tab created for this test with `preview_close`, passing each retained `tabId` explicitly. Confirm each result returns `tabId: null`. Keep this cleanup scoped to owned tabs; omitting `tabId` can close a different active tab.
2. Stop the dev process with its terminal interrupt.
3. Preserve the isolated base directory when it contains useful reproduction evidence or state for a likely follow-up.
4. Otherwise remove only a path created for this test after resolving and verifying the exact target.

If completion is uncertain, keep the environment alive and mention that it is retained for further iteration. A fresh isolated base directory remains the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.

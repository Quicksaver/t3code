---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. If its tools are absent or
the panel reports unavailable, explain the blocker and stop verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

Load `$worktrees` for host selection, exact-source staging, and runtime ownership. Acquire the selected browser host's `desktop` lease before integrated UI interaction, and release it after closing owned tabs. Starting a server alone needs no lease.

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

Call `preview_status`, then `preview_open` if the Browser panel is
closed. Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.

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

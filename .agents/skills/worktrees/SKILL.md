---
name: worktrees
description: Work from an assigned T3 Code worktree, including ordinary task execution, exact-source cross-host work, desktop and mobile runtime coordination, isolated devices, and teardown. This is the worktree subagent's contract, not orchestration guidance for dispatching or supervising subagents.
---

# Working in a T3 Code worktree

Ordinary installs, focused checks, and non-interactive web requests need no runtime lease. Integrated UI automation does.

Load the global `$fleet` skill before operating another host. For mobile work, also load the applicable global `$ios-simulator` or `$android-emulator` skill and the repository's `$test-t3-mobile` skill.

## Glossary

- **Assigned worktree:** the Git checkout containing the source for your current task.
- **Runtime:** a host-bound interactive verification resource controlled by a lease. The runtime begins with native or UI preparation and ends after owned teardown. Ordinary source work, installs, focused checks, servers without UI automation, and non-interactive HTTP requests are outside it.
- **Desktop:** integrated web UI automation in one host's controlled browser renderer, regardless of whether the driver is collaborative preview, Playwright, or another fallback. Its resource name is `desktop`.
- **Mobile:** native preparation and interaction using one Android Emulator or iOS Simulator, including the backend, Metro, build, device, logs, and teardown. Its resource name is `mobile`.
- **Candidate:** one host-specific attempt to run a check that either eligible host can satisfy.
- **Request:** one queued attempt identified by a request ID. Equivalent candidates on different hosts share an ID; separate checks and resources use separate IDs.
- **Lease:** the holder record created when a request acquires capacity.
- **Owned:** created, started, opened, acquired, or staged by you for the current task.

## Invariants

- Give each logical queue attempt a request ID in the form `<worktree-slug>-<resource>-<target>-<YYYYMMDDTHHMMSSZ>-<8-hex>`, for example `feature-login-desktop-host-race-20260901T142233Z-a1b2c3d4`. Derive `worktree-slug` from the assigned worktree directory name. Use `desktop` or `mobile` for the resource and `windows`, `mac`, `android`, `ios`, or `host-race` for the target. Normalize those fields to lowercase ASCII letters, digits, and hyphens, replacing any other run with one hyphen and trimming leading or trailing hyphens. Use the current UTC time and generate eight random hexadecimal characters. This format is safe in Git refs and Windows filenames. Equivalent host candidates share the same ID. Every later attempt, separate platform, and separate resource gets a new ID. The command-line helper rejects unscoped acquisition and release.
- Hold at most one runtime lease at a time. A mobile stream may briefly add the desktop lease only while the stream is visible in that renderer.
- Start runtime preparation and UI interaction only after acquisition is confirmed and every other request you own has exited or released a near-simultaneous hold.
- Keep a waiting request unchanged until it acquires. Queue age is never a reason to cancel, replace, or rephase it.
- Run every integrated desktop or web UI driver under that host's `desktop` lease. Collaborative preview, Playwright, Chrome control, and other browser fallbacks follow the same limit.
- Transfer exact source through unique refs and transfer files. Shared `FETCH_HEAD` is never part of concurrent source staging.
- Release a path-scoped lease before deleting the temporary worktree path that owns it.

## Hosts and exact source

- Windows Desktop normally owns the persistent project worktrees and Android Emulator runtime.
- MacBook Pro retains the main checkout and supplies iOS Simulator and macOS desktop verification over SSH.
- Either host may run desktop verification. Each host has its own renderer and machine-local lease ledger.
- A missing checkout on an eligible host does not remove that host from consideration. Materialize the initiating worktree's exact committed and uncommitted state in a task-owned linked worktree there.

Never build an unrelated pre-existing checkout because it is convenient.

### Stage Windows source on the Mac safely

Finish source staging before entering a Mac desktop or mobile queue.

1. Record the expected source `HEAD`, `git diff --binary HEAD`, and the untracked-file list from the assigned Windows worktree.
2. Create a request-specific source ref such as `refs/t3-worktree-transfer/<request-id>` and a request-specific bundle path. Point that ref at the expected `HEAD` and bundle the ref:

   ```sh
   git -C "<source-worktree>" update-ref "refs/t3-worktree-transfer/<request-id>" "<expected-sha>"
   git -C "<source-worktree>" bundle create "<request-id>.bundle" "refs/t3-worktree-transfer/<request-id>"
   ```

3. Transfer the uniquely named bundle and any task-owned patch or untracked payload to the Mac.
4. Fetch with `--no-write-fetch-head` into the same unique namespaced ref. Never read or write shared `FETCH_HEAD`:

   ```sh
   git -C ~/Sites/t3code fetch --no-write-fetch-head "/tmp/<request-id>.bundle" "refs/t3-worktree-transfer/<request-id>:refs/t3-worktree-transfer/<request-id>"
   ```

5. Create or recreate the deterministic task worktree from that explicit ref, apply the task-owned patch and untracked payload when present, and register the worktree with T3 Code.
6. Require the Mac worktree `HEAD` to equal the recorded SHA. When the source was dirty, require its binary diff and untracked-file manifest to match the Windows source before requesting capacity.

Include your request ID in every transfer ref and filename. At final teardown, remove your temporary worktree first. Then delete only the refs and transfer artifacts named by your request ID on both hosts.

## Host-local capacities

Run `scripts/worktree-runtime-slot.ts` from the main checkout on the host whose runtime will be used. Each host provides:

- `mobile`: two holders.
- `desktop`: one holder.

The web server itself has no queue. Worktree-local `.t3` state and the actual ports printed by `dev-runner` isolate parallel servers. The `desktop` lease begins when integrated UI automation starts, regardless of the browser driver.

Every acquisition and release uses the same request ID:

```sh
node scripts/worktree-runtime-slot.ts acquire mobile --worktree "<worktree>" --request-id "<request-id>"
node scripts/worktree-runtime-slot.ts release mobile --worktree "<worktree>" --request-id "<request-id>"
node scripts/worktree-runtime-slot.ts acquire desktop --worktree "<worktree>" --request-id "<request-id>"
node scripts/worktree-runtime-slot.ts release desktop --worktree "<worktree>" --request-id "<request-id>"
```

Invoke each acquisition once and retain the yielded process. `Ctrl+C` is an interruption, not a queue-management technique. The helper cancels a request-scoped acquisition on `SIGINT` or `SIGTERM`; inspect `status` before continuing after any interrupted command.

Hold `mobile` from native preparation through device, backend, Metro, application, and log teardown. Hold `desktop` for the complete integrated UI interaction block, including pairing and fallback automation.

## Opportunistic scheduling

Enter all queues for checks that are ready to run instead of completing one resource class before joining another.

For example, when you still need desktop and mobile verification, concurrently submit the Windows and Mac desktop candidates plus the eligible mobile candidates. The first confirmed acquisition selects the next check:

1. Treat the first acquisition as provisional. Do not start its runtime yet.
2. Cancel every other pending request you own. If another candidate acquired nearly simultaneously, cancellation must release that matching holder.
3. Wait until every losing acquisition reports `Cancelled` and verify that you hold only the selected lease.
4. Run and tear down the selected check, then release its lease.
5. Re-enter the queues for every required check still missing.

This applies when both Android and iOS are required. Submit platform-specific requests concurrently, run whichever acquires first, then requeue the other platform after releasing the winner. Release every other lease before starting the selected runtime.

Cancellation is appropriate only because another request you own won, the corresponding check is no longer required, or the task was explicitly stopped. Contention and non-FIFO service are normal. Leave the original request and acquisition process alive for any length of wait.

## Equivalent-host races

For representative mobile verification, race Windows Android against macOS iOS. For desktop verification, race the Windows and macOS desktop hosts. Generate one request ID for the equivalent candidates and start the same resource acquisition concurrently on both host-local paths.

When one host acquires, retain the other acquisition until the provisional winner passes its host-readiness check. Then cancel the loser with the exact request ID:

```sh
node scripts/worktree-runtime-slot.ts cancel <mobile|desktop> --worktree "<losing-host-worktree>" --request-id "<request-id>"
```

Wait for `Cancelled`, including when both hosts acquired nearly simultaneously. Start the winner only after the losing holder is absent.

For a platform-specific requirement, acquire only that host. When Android and iOS are both required, use separate platform request IDs and the opportunistic scheduling rule above.

## Desktop verification and Mac routing

Each desktop candidate uses its host's renderer, exact source, isolated `.t3` state, and selected ports. The lease applies to all UI drivers. An isolated Playwright process is a fallback automation method, not a way around the desktop limit.

For a Mac desktop winner controlled from a Windows-originated agent session:

1. Start the exact-source Mac web stack on Mac loopback and read its actual web port.
2. Before any status, open, or control call in the provider session, call `preview_list_hosts`. Select the entry whose exact device label identifies the Mac and whose platform is `macos`; retain its stable `hostId`. Labels are useful confirmation, but the returned `hostId` is the routing identity and distinguishes multiple clients on the same OS.
3. Call `preview_select_host` with that exact `hostId`. The call binds the provider session without activating, foregrounding, moving, or resizing either desktop window. If discovery omits the Mac, selection reports it unavailable, or the session is already assigned to another host, stop this candidate instead of falling back or trying to change window focus. Start a new provider session to select a different host.
4. While the Mac acquisition is still provisional, call `preview_status`. Call `preview_open` to create a new owned tab and retain its tab ID.
5. Navigate that tab with the direct Mac loopback URL `http://[::1]:<web-port>/`. `environment-port` is relative to the Windows execution environment and is not the Mac route.
6. Confirm the task-unique bare origin, then open the direct pairing URL in the same tab and continue the verification there.

Close only tabs created by the current test. Do not reload, stop, or repurpose another task's renderer.

## Android worktree AVDs

After acquiring Windows mobile capacity, provision or resolve the selected worktree's persistent AVD from Windows main:

```powershell
Set-Location -LiteralPath '<windows-main>'
$avdName = node scripts\worktree-android-avd.ts ensure --worktree '<windows-worktree>'
```

The helper derives a stable AVD name from the canonical worktree path, uses the installed Android 16/API 36 Google APIs x86_64 image, records exact ownership, and disables Quick Boot snapshot loading and saving. Launch that explicit AVD with `-no-snapshot`, retain its actual ADB serial, and target every ADB command with `-s <serial>`. Never select an emulator from an assumed `emulator-5554` port.

The AVD's user data persists for that worktree. Clear only the T3 Code Dev package data when the test needs clean app state. Stop only the emulator started by the current verification and preserve its AVD during routine teardown.

Gradle, generated Android projects, build outputs, Metro caches, and dependencies use checkout-local or tool-default paths. Do not redirect them to a shared or main-owned location.

## iOS worktree assets

Use a disposable simulator for each active verification as described by `$test-t3-mobile`. Concurrent iOS verifications use different UDIDs and separate XcodeBuildMCP server processes and sessions.

Keep `persist: false` when setting each session's workspace, scheme, simulator, and bundle identifier. Leave `derivedDataPath` unset. XcodeBuildMCP and Xcode derive worktree-specific DerivedData from the exact workspace path, so a deterministic Mac worktree path preserves reusable cache identity when that path is recreated.

Generated `ios`, Pods, and other native outputs stay under the temporary worktree. Remove that source worktree after runtime teardown and lease release. Leave ordinary Xcode DerivedData for reuse unless the user requests its cleanup.

## Teardown order

Apply this order on success, failure, blocker, or explicit stop:

1. Stop only owned backend, Metro, build, stream, log, emulator, simulator, preview, and browser processes.
2. Verify owned ports, tabs, devices, and mappings are gone.
3. Release every held lease with its exact resource, worktree path, and request ID. Confirm that you have no holder or request in the host ledger.
4. Remove the temporary source worktree only after release succeeds.
5. Remove your temporary ref and transfer artifacts.

If release reports that the worktree is not active, recreate the same exact-path worktree from the pinned ref, release the matching request, and remove the worktree again. Use only request-scoped cleanup while another one of your checks is live.

## Destructive Git experiments

When browser or preview debugging requires destructive Git experiments, use `$disposable-git` for the sandbox and deletion boundary.

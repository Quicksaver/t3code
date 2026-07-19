# Terminal-backed Project Actions

## Conflict Guidance

- `apps/server/src/terminal/Manager.ts`: preserve AppImage environment cleanup in the terminal spawn path alongside conservative POSIX subprocess inspection.
- `apps/web/src/components/ChatView.tsx`: preserve draft-hero, active-turn sending, and diff-panel behavior alongside the extracted project-action terminal workflow.

Terminal-backed project actions are reusable terminal workflows, not fire-and-forget terminal creation.

Expected behavior:

- Running a project action should reuse a stable terminal for that action when possible instead of opening a new terminal instance on every click.
- If action-specific reuse is not available, terminal-backed actions should still prefer a shared action terminal group so repeated runs do not leave many stale terminal instances behind.
- A project action must not write its command until the target terminal session is ready to receive input. This avoids shells with slow startup, such as login `bash`, rendering the command before the prompt and leaving the command unexecuted.
- If the selected reusable terminal is busy running a subprocess, the action may choose another action terminal rather than injecting input into a live process.
- Concurrent launches reserve their selected terminal id until open/write completes, so a second project action invocation cannot select the same soon-to-be-busy terminal from a stale running-terminal snapshot.
- The readiness wait uses the current terminal session summary when available, and otherwise attaches to the terminal stream and waits briefly for prompt-like output before writing. Both the strict and best-effort paths inspect prompt history from initial and restarted attach snapshots. If the prompt is never observed, the wait times out and the action still writes rather than hanging indefinitely.
- The Effect-based readiness wait exposes a strict typed-error path for attach failures and prompt timeouts, constructs those errors directly at their failure boundaries, and preserves structured attach causes for diagnostics, while the project action command path deliberately keeps the existing best-effort fallback that writes after failure/timeout instead of blocking the action.
- Action terminal ids encode script ids and reserve numeric `:<suffix>` ids for fallback terminals, so script ids such as `build-2` or legacy colon ids such as `build:dev` cannot be mistaken for fallback terminals of another action.
- Fallback action terminal tabs include their instance suffix in parentheses, such as `Action: build (2)`, while script ids that naturally end in digits, such as `build-2`, keep readable labels such as `Action: build 2`.
- POSIX subprocess detection is conservative when full process-tree inspection fails: a shell child is treated as busy rather than idle so commands are not injected into a terminal that may still have a hidden descendant process.
- Terminal UI controls should be unavailable whenever no active project exists or the active project host is disconnected. Existing open terminal surfaces may remain closable after disconnect, but opening, splitting, and project-action runs require a connected host. Keep this gating centralized through `deriveProjectHostControlAvailability(...)` so terminal drawer toggles, right-panel terminal creation, and project-action runs expose the same connected-host rules and unavailable reasons.
- Unavailable primary project-action run controls should remain tooltip-triggerable, using `aria-disabled` plus a guarded click handler rather than native `disabled`, so disconnected-host reasons stay inspectable while script execution remains blocked.
- Existing terminal selection actions remain local surface operations after disconnect: selection copy stays available while terminal creation and project-action runs remain host-gated.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/web/src/projectScriptTerminals.ts`
- `apps/web/src/state/projectActionTerminal.ts`
- `apps/server/src/terminal/Manager.ts`

Relevant tests live in:

- `apps/web/src/projectScriptTerminals.test.ts`
- `apps/web/src/components/ProjectScriptsControl.test.tsx`
- `apps/server/src/terminal/Manager.test.ts`
- `packages/shared/src/terminalLabels.test.ts`

Useful focused command:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/projectScriptTerminals.test.ts)
```

## Development Ports

- Web: `5740`
- Server/WebSocket: `13780`

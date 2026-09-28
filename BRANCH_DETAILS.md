# Windows terminal startup

**Worktree branch:** `fix/windows-terminal-startup`

Windows worktree: `E:/Projects/t3code.worktrees/windows-terminal-startup`.

node-pty 1.2 initializes ConPTY asynchronously and initially reports PID zero. The node-pty adapter waits for its `ready_datapipe` event before returning the process to the terminal manager. This keeps startup snapshots within the existing positive-PID contract without waiting for shell output or polling. An exit before readiness becomes a typed spawn failure. Interruption removes listeners and terminates the pending ConPTY through its agent without waiting for output. Readiness without a positive PID requests termination and fails the spawn. Unix startup keeps its synchronous path.

The readiness event and immediate cancellation through `_agent.kill()` are node-pty internals outside its public TypeScript interface. Keep these dependencies isolated in the adapter and recheck them when upgrading node-pty. The fix applies to all clients opening terminals on a Windows environment, including remote connections, without changing client or wire contracts.

Focused regression coverage:

```sh
vp test run apps/server/src/terminal/NodePtyAdapter.test.ts apps/server/src/terminal/Manager.test.ts
```

Tests cover delayed PID assignment without output, output and exit delivery after startup, early process exit, output-independent interruption cleanup, invalid-PID readiness failure, and existing Windows, Linux, and macOS adapter behavior.

Windows Browser-panel verification covers command output, multiple terminals, closing a terminal, and reattaching after a page reload. Run the backend without Node's `--watch` mode for this check: node-pty misreads watcher IPC as a process-list response and crashes when closing a terminal. That separate dev-mode issue remains outstanding.

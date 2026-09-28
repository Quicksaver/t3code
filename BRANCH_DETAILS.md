# Windows terminal startup

**Worktree branch:** `fix/windows-terminal-startup`

Windows worktree: `E:/Projects/t3code.worktrees/windows-terminal-startup`.

node-pty 1.2 initializes ConPTY asynchronously and initially reports PID zero. The node-pty adapter waits for its `ready_datapipe` event before returning the process to the terminal manager. This keeps startup snapshots within the existing positive-PID contract without waiting for shell output or polling. An exit before readiness becomes a typed spawn failure, and interruption removes listeners and requests process termination. Unix startup keeps its synchronous path.

The readiness event belongs to node-pty's legacy event interface and is not declared in its public TypeScript interface. Keep that dependency isolated in the adapter and recheck it when upgrading node-pty. The fix applies to all clients opening terminals on a Windows environment, including remote connections, without changing client or wire contracts.

Focused regression coverage:

```sh
vp test run apps/server/src/terminal/NodePtyAdapter.test.ts apps/server/src/terminal/Manager.test.ts
```

Tests cover delayed PID assignment without output, output and exit delivery after startup, early process exit, interruption cleanup, and existing Windows, Linux, and macOS adapter behavior.

Windows Browser-panel verification covers command output, multiple terminals, closing a terminal, and reattaching after a page reload. Run the backend without Node's `--watch` mode for this check: node-pty misreads watcher IPC as a process-list response and crashes when closing a terminal. That separate dev-mode issue remains outstanding.

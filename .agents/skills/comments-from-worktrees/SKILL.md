---
name: comments-from-worktrees
description: Address pull request comments for every active non-main worktree.
disable-model-invocation: true
---

# Address comments from worktrees

This skill requires unsandboxed execution. If the environment is sandboxed, report that blocker and stop.

Load `$spawn-worktrees`.

Instruct each subagent to use the global `$piz-comments` skill. Do not load `$piz-comments` or perform its work yourself.

Be silent while you patiently wait for each subagent terminal result.

After every subagent finishes, use `$pick-from-worktrees` if any subagent made changes. Otherwise, report the collected results and stop.

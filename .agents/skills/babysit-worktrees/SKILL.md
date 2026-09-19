---
name: babysit-worktrees
description: Address pull request comments for every active non-main worktree.
disable-model-invocation: true
---

# Babysit worktrees

This skill requires unsandboxed execution. If the environment is sandboxed, report that blocker and stop.

Load `$spawn-worktrees`.

Instruct each subagent to use the global `$babysit` skill. Do not load `$babysit` or perform its work yourself.

Be silent while you patiently wait for each subagent terminal result.

After every subagent finishes, use `$rebuild-main` if any subagent made changes. Otherwise, report the collected results and stop.

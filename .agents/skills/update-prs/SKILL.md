---
name: update-prs
description: Update the pull request associated with every active non-main worktree.
disable-model-invocation: true
---

# Update worktree pull requests

Load `$spawn-worktrees`.

Instruct each subagent to use the global `$piz-pr` skill. Do not load `$piz-pr` or perform its work yourself.

Be silent while you patiently wait for each subagent terminal result. Then report the collected results.

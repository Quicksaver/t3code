---
description: Information needed to spawn subagents for each active worktree.
name: spawn-worktrees
---

$spawn-worktree

Spawn one new subagent for each active worktree in this repository, except for the main worktree.

Since they are running in parallel, assign each subagent a unique port number for their own dev server, to avoid conflicts.

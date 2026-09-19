---
name: spawn-worktrees
description: Spawn one subagent for every active non-main worktree.
disable-model-invocation: true
---

Inventory the repository's registered worktrees. Use `$spawn-worktree` once for each active non-main worktree, exclude also `base/main`; that skill is for you to load, not for your subagents. If none exist, report that there is nothing to spawn and stop.

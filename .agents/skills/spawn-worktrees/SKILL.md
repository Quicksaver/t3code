---
name: spawn-worktrees
description: Spawn one subagent for every active non-main worktree.
disable-model-invocation: true
---

Inventory the repository's registered worktrees. Use `$spawn-worktree` once for each active non-main worktree, exclude also `base/main`; that skill is for you to load, not for your subagents. If none exist, report that there is nothing to spawn and stop.

A worktree is inactive when `FORK.md` in the `base/fork` worktree has a section heading marked `(Currently Inactive)` whose `**Worktree branch:**` line names that worktree's branch. Read only those headings and branch lines, exclude inactive worktrees, and list them as skipped in your report.

---
name: update-worktrees
description: Squash and rebase every active non-main worktree at the base/main boundary.
disable-model-invocation: true
---

# Update active worktrees

First, fetch `upstream/main` and fast-forward our branch `base/main`. This is a required clean control checkout. Stop without updating the other worktrees if the control checkout is missing, dirty, cannot fast-forward, or does not reach the fetched upstream commit.

Then load `$spawn-worktrees`. Instruct each subagent to use `$update-worktree`. Updating the control branch above is the only worktree mutation you perform yourself. Do not load `$update-worktree`, validate child changes, or modify any other worktree, edit, or push any branch yourself.

Be silent while you patiently wait for each subagent terminal result.

The job is finished once every assigned branch has one combined customization commit directly above the selected `base/main` commit, with its upstream tracking unchanged. Only fast-forward `base/main`; customization commits stay on their assigned branches. Even if newer commits are found in `upstream/main`, do not pursue them.

Finally, report:

- Everything the subagents reported. Deduplicate shared upstream changes while naming every affected worktree and customization.
- New or changed behavior introduced by the upstream changes.

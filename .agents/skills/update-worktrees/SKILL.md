---
name: update-worktrees
description: Merge upstream/main into every active non-main worktree.
disable-model-invocation: true
---

# Update active worktrees

Load `$spawn-worktrees`.

Before dispatching any worktree update, fetch `upstream/main`, locate the linked worktree for `base/main` through `git worktree list --porcelain`, and fast-forward it with `git merge --ff-only upstream/main`. Require a clean control checkout before the merge and verify afterward that its `HEAD` equals `upstream/main`. Stop without updating the other worktrees if the control checkout is missing, dirty, cannot fast-forward, or does not reach the fetched upstream commit.

Instruct each subagent to use `$update-worktree`. Updating the control branch above is the only worktree mutation you perform yourself. Do not load `$update-worktree`, validate child changes, or modify any other worktree, edit, or push any branch yourself.

Be silent while you patiently wait for each subagent terminal result.

The update target for every worktree is the latest `upstream/main` commit, mirrored into `base/main`. The job is finished once all worktrees have the equivalent merge; even if newer commits are found in `upstream/main`, do not pursue them.

Finally, report:

- Everything the subagents reported. Deduplicate shared upstream changes while naming every affected worktree and customization.
- New or changed behavior introduced by the upstream merges.

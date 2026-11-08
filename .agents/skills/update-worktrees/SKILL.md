---
name: update-worktrees
description: Squash and rebase every active non-main worktree at the base/main boundary.
disable-model-invocation: true
---

# Update active worktrees

First, fetch `upstream/main` and fast-forward our branch `base/main`. This is a required clean control checkout. Stop without updating the other worktrees if the control checkout is missing, dirty, cannot fast-forward, or does not reach the fetched upstream commit.

Then load `$spawn-worktrees`. Instruct each subagent to use `$update-worktree`. Updating the control branch above is the only worktree mutation you perform yourself. Do not load `$update-worktree`, validate child changes, or modify any other worktree, edit, or push any branch yourself.

Be silent while you patiently wait for each subagent terminal result. Output only blockers or other potentially actionable failures or awaiting inputs while you keep monitoring.

The job is finished once every assigned branch has been squashed and rebased directly on top of the selected `base/main` commit, plus any additional follow-up commits, with its upstream tracking unchanged. Only fast-forward `base/main`; customization commits stay on their assigned branches. Even if newer commits are found in `upstream/main`, do not pursue them.

Finally, report on everything the subagents reported. Deduplicate shared upstream changes while naming every affected worktree and customization.

## Magi skills

Record the `base/main` tip before fast-forwarding it. After the fast-forward, delegate one subagent in parallel with the worktree updates, working in `~/.codex` rather than any t3code worktree. Give it the old and new `base/main` commits and the `Magi Skill System` section of `FORK.md` as its checklist. It reviews that upstream range for changes affecting the `$magi` skills and updates the skills or `scripts/magi.ts` only where needed, running `node --test skills/magi/scripts/magi.test.ts` after any script change. If it changed anything, it commits with `$commit`, pushes, and syncs the fleet with `$fleet`; otherwise it reports that nothing needed changing. Include its result in your final report, and call out any live Magi check the user should run manually once the rebuilt main is installed.

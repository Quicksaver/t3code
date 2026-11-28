---
name: update-worktree-unattended
description: Use for an unattended update of a worktree, push, watch for and adress PR reviews or issues until green.
disable-model-invocation: true
---

If you are not explicitly given a worktree or list of worktrees to work on, stop and ask for clarification.

Follow these steps sequentially:

- fetch `upstream/main` and fast-forward our branch `base/main`.
- use `$spawn-worktree` for the given worktrees, forward the next instruction to each subagent as it finishes its task:
  - use `$update-worktree` skill.
  - use `$pr` skill to update open PR; do not open new one.
  - use the `$babysit` skill if there is an open PR.
  - cleanup all temporary and leftover branches and stashes created during this process.

Updating the control branch above is the only worktree mutation you perform yourself. Do not load any of the skills meant for subagents, validate child changes, or modify any other worktree, edit, or push any branch yourself. Be silent while you patiently wait for each subagent terminal result. Output only blockers or other potentially actionable failures or awaiting inputs while you keep monitoring.

## When finished

Summarize all changes made during this run to each branch's work in light of the incoming upstream updates, derived from conflict resolution, from Magi review recommendations, and from PR reviews. Group these by branch and state what changed and why, with a commit short hash linking to the commit where each change was made.

Skip reporting on unchanged behavior, clean merges with no conflicts, or lack of needed action/follow-up on successful and uneventful updates.

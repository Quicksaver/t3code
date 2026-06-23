---
description: Information needed to spawn subagent for an active worktree.
name: spawn-worktree
---

Spawn a subagent for the given worktree. If a worktree is not provided, report that to the user and stop.

The subagent:

- should know about their own branch's customizations. The file CUSTOMIZED.md does not, and should not, exist in each individual branch, so provide the subagents directly with details taken from CUSTOMIZED.md, including the name of the corresponding md file in their own branch to study if there is one.
- should also be forwarded the "Debug Browser Launch" from CUSTOMIZED.md.
- is working alone it its own branch, and needs only the information relevant to its own branch and task, without contextual overall process status, of other subagents or worktrees, or that there may be future steps.
- should run its own dev server and use playwright to validate changes where possible.

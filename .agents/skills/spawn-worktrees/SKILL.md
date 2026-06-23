---
description: Information needed to spawn subagents for each active worktree.
name: spawn-worktrees
---

Spawn one new subagent for each active worktree. Each subagent:

- should know about their own branch's customizations. The file CUSTOMIZED.md does not, and should not, exist in each individual branch, so provide the subagents directly with details taken from CUSTOMIZED.md, including the name of the corresponding md file in their own branch to study if there is one.
- is working alone it its own branch, and needs only the information relevant to its own branch and task, without contextual overall process status, of other subagents or worktrees, or that there may be future steps.
- should run its own dev server and use playwright to validate changes where possible. Since they are running in parallel, assign each subagent a unique port number to to avoid conflicts.

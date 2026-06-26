---
description: Information needed to spawn subagent for an active worktree.
name: spawn-worktree
---

Spawn a subagent for the given worktree. If a worktree is not provided, report that to the user and stop.

- **The file CUSTOMIZED.md does not, and should not, exist in each individual branch**, so provide the subagents directly with details taken from CUSTOMIZED.md, including the name of the corresponding md file in their own branch to study if there is one.
- Provide the subagent with the "Debug Browser Launch" information from CUSTOMIZED.md.
- **The subagent is working alone** it its own branch and worktree.
- The subagent is singular and task oriented, **it does not care or need to care about your own task.**
- Any skills you load yourself, the ongoing larger or orchestration process, current step reasoning, possibility of future steps, or the existence of other subagents or worktrees **is irrelevant and polluting to the subagent.**
- Mention only the skills that the subagent should use, and only its own task.
- The subagent should run its own dev server and use playwright to validate changes where possible.

---
description: Information needed to spawn subagent for an active worktree.
name: spawn-worktree
---

Spawn a subagent for the given worktree. If a worktree is not provided, report that to the user and stop.

**The following are all irrelevant and polluting to the subagent, keep these details to yourself:**

- skills you load yourself
- the ongoing larger or orchestration process
- current step reasoning
- possibility of future steps
- the existence of other subagents or worktrees
- the existence of the CUSTOMIZED.md file

**The following are all relevant and necessary to the subagent, always provide these details:**

- Details in from CUSTOMIZED.md, including the name of the corresponding md file in their own branch to study if there is one.
- The "Debug Browser Launch" information from CUSTOMIZED.md.
- **The subagent is working alone** it its own branch and worktree, no one else will make changes to that worktree while the subagent is working.
- The subagent should run its own dev server and use playwright to validate changes where possible.
- The skills and task instructions that the subagent should follow.

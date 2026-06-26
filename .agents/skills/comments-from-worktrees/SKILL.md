---
description: Address all PR comments from worktrees that are not yet merged into main.
name: comments-from-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

Your task is to instruct each subagent to use the $piz-comments skill. **You do not load this skill yourself**, its instructions are not meant for you, the skill will provide the subagents with the necessary task information.

This process will likely take a long time, possibly hours. Wait patiently and let the subagents finish without querying for current status.

When all subagents finish, if at least one of them reported changes made, you use the $port-from-worktrees skill.

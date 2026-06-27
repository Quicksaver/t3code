---
description: Update all active worktrees with changes from main.
name: update-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

The goal is to update all active worktrees with the latest changes from `upstream/main`, while preserving any intentional customizations made in their own branches.

To achieve this goal, your task is to instruct each subagent to use the $update-worktree skill.

**You do not validate any work yourself, or load this skill yourself.** Your only task is to orchestrate the subagents' work and ensure they report back with the requested information.

This will likely be a long-running process, be patient and silent while you wait.

When all subagents are finished. report on:

- everything the subagents have reported. They will likely report similar incoming changes, you can deduplicate in these cases, but be explicit about every incoming change and every customization made and impacted by each worktree.
- new or altered features or behaviors introduced by the upstream merge.

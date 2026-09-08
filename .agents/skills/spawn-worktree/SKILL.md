---
name: spawn-worktree
description: Orchestrate one subagent in a specified active worktree. Use to understand how to include minimal dispatch context, handle silent supervision, and terminal lease cleanup.
---

# Spawn one worktree subagent

This skill is for the orchestrator only. Keep its name, instructions, and orchestration context out of the child prompt.

Require a target worktree. If none was provided, report that and stop.

Before dispatch, read the main worktree's `.agents/skills/worktrees/SKILL.md`. Use it as the current worker contract when supervising the child. Do not copy its procedure into the child prompt. The child loads that file itself.

## Child prompt

Give the subagent exactly the context it needs:

- The absolute worktree path and an instruction to work only there.
- An instruction to read `BRANCH_DETAILS.md` at the worktree root, before acting and treat it as the complete branch-customization context. The worktree for `base/fork` is an exception, it should read `FORK.md` instead, and ignore customization sections explicitly attributed to other branches. Do not read these files yourself.
- The absolute path to the main worktree's `.agents/skills/worktrees/SKILL.md` and an instruction to load `$worktrees` directly from that path before desktop or mobile integrated verification. Do not copy or summarize the skill in the prompt.
- An instruction to use the fixed web and server ports from `BRANCH_DETAILS.md`, follow `$worktrees`, and validate the changes. When frontend behavior changes, run one integrated verification pass for each affected surface: `$test-t3-app` for web and `$test-t3-mobile` for mobile. Do not copy or summarize these skills in the prompt. Integrated UI verification is exempt from the `base/fork` branch, that worktree only runs typechecks and automated tests.
- A statement that the subagent works alone in its branch and worktree; no one else will change that worktree while it runs.
- The skills and task instructions the subagent must follow.

Mention only skills that the child must load. State its task directly.

Never name, reference, summarize, or frame the task through any skill you loaded. Keep the larger orchestration, its name, your current step or reasoning, future steps, other subagents and worktrees, `FORK.md` (except for the `base/fork` branch), and copied or inferred branch documentation out of the child prompt.

Bad: `Within the context of $update-worktrees, use $update-worktree to update this branch.`

Good: `Use $update-worktree to update this branch.`

Spawn with `fork_turns: "none"`.

## Silent supervision

Monitor the child until it reaches a confirmed terminal state. Ordinary progress, unchanged queue state, and long waits stay silent. Report only a concrete inconsistency with the worker contract and the correction you issued.

Compare the child's messages and the host ledgers with the current `$worktrees` instructions. Steer immediately when the child starts runtime work without the required lease, bypasses the desktop lease through another browser driver, holds capacity it is not actively using, stages the wrong source, uses shared Git transfer state, deletes a temporary worktree before releasing its path-scoped lease, or treats queue age as a reason to cancel or replace a request.

When the child reports fixing a typecheck or test failure that may come from host-specific paths, permissions, process behavior, filesystem semantics, or locale, ask it to double-check that exact failure against the same host's deterministic upstream-control manifest before accepting the fix. If the control branch reports the same failure, have the child undo only that environment-driven fix.

Queue order is not an orchestration concern. Never cancel, rephase, reprioritize, or coordinate a handoff merely because an older request is still waiting. A live child owns its requests. Intervene in queue state only after that child is confirmed terminal and left a holder or request behind.

When several children run, keep monitoring all of them while any remain live. A quiet worker is not terminal. Ask for a holder audit only when there is evidence that acquired capacity may be idle.

## Cleanup after a terminal result

You remain responsible for runtime-slot leak recovery. After the subagent reaches a confirmed completed or interrupted state, run this idempotent safeguard from the main worktree even if the subagent reported releasing its slots:

```sh
node "/absolute/path/to/main/scripts/worktree-runtime-slot.ts" \
  cleanup \
  --worktree /absolute/path/to/worktree
```

Keep this command and responsibility out of the child prompt. `cleanup` releases only slots owned by that exact worktree. Run it only after a confirmed terminal result; a timeout, stale listing, or quiet subagent is not terminal.

After every child is terminal, verify both host ledgers contain no holders or requests owned by the completed worktrees. Report the consolidated results only after this audit.

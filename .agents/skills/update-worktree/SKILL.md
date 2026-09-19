---
name: update-worktree
description: Squash and rebase one worktree at the base/main boundary, adapting its customizations.
disable-model-invocation: true
---

# Update one worktree

Load `$spawn-worktree`. Give the subagent one step at a time. Send the next step only after it returns the current step's result. Be silent while you patiently wait for each subagent terminal result.

You only orchestrate and report. Do not validate the work or load skills assigned to the subagent.

At every step, keep the branch independently functional and keep all changes and commits local. Do not push. Tell the subagent to be silent while it patiently waits for each tool result. Keep reporting to a minimum at every step, include only what is explicitly mentioned here, and any issues you overcame or blockers you encountered.

Keep every assessment and follow-up **relative to the branch's own customizations in light of the incoming upstream changes**. Do not assess incoming upstream changes or branch customizations by themselves.

## Documentation rules

- Add new fork customizations introduced by conflict resolution or follow-ups.
- Remove or mark customizations that upstream made redundant.
- Keep conflict notes tied to concrete files and behaviors, not vague history.
- Describe the current state. Omit review narratives and change history.

## Steps

### 1. Squash, rebase, and assess

Instruct the subagent to preserve a recovery ref, squash its current branch's combined changes against its current upstream merge base, then rebase that single commit onto the target while preserving upstream tracking. Treat incoming changes as intentional, preserve the branch's intended customizations around them, and run focused validation for touched areas. Record the rebased commit as the baseline for later adaptation review.

The exact target is the `base/main` tip at the start of the update. Do not pursue newer commits in `upstream/main`.

- If the branch started with exactly one commit directly above the target, skip validation, report that result, and stop. A branch already based there but carrying multiple commits still needs squashing.
- If no customizations remain, leave the branch at the target and report that result.
- If upstream makes a significant portion of the branch obsolete, irrelevant, redundant, or superseded, report the affected customizations and stop after the rebase.

Otherwise, report only on technical debt or refactors worth addressing **relative to the branch's own customizations in light of the incoming upstream changes**. Do not include assessments of incoming upstream changes or branch customizations by themselves.

### 2. Complete a missing report

If step 1 omitted the required report, ask the subagent for it before continuing. Otherwise, skip this step.

### 3. Adapt branch customizations

If the report identifies worthwhile changes **relative to the branch's own customizations in light of the incoming upstream changes**, instruct the subagent to implement them. If their relevance is uncertain, have the subagent reassess whether they **relate to the branch's own customizations in light of the incoming upstream changes** and implement them only if they do.

### 4. Update branch documentation

If conflict resolution or step 3 changed documented behavior, instruct the subagent to update stale or missing branch Markdown files according to the documentation rules.

### 5. Assess the adaptation

If step 3 changed the branch, instruct the subagent to commit the follow-ups separately for review, then use the global `$magi-arbitrator-code-review` skill on high level and set the initial review `BASE` to the rebased commit recorded in step 1. Tell it to specify to the Magi participants performing the review that every item must be assessed **relative to the branch's own customizations in light of the incoming upstream changes**. Ignore every item outside that scope regardless of severity, including findings about incoming upstream changes or branch customizations by themselves. Do not load `$magi-arbitrator-code-review` yourself.

At completion, whether or not review was needed, instruct the subagent to fold all follow-up fixes and documentation into the single branch-owned commit. Verify its parent is the fixed target, tracking is unchanged, and the worktree is clean. Report everything the subagent reported.

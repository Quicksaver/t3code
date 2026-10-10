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

On completion, verify the fixed target base as the branch base, tracking is unchanged, and the worktree is clean. Report any issues or blockers that prevent the subagent from proceeding.

## Documentation rules

- Add new fork customizations introduced by conflict resolution or follow-ups.
- Remove or mark customizations that upstream made redundant.
- Keep conflict notes tied to concrete files and behaviors, not vague history.
- Describe the current state. Omit review narratives and change history.

## Steps

### 1. Squash, rebase, and assess

Instruct the subagent to squash its current branch's combined changes against its current upstream merge base, then rebase that single commit onto the target while preserving upstream tracking. Treat incoming changes as intentional, preserve the branch's intended customizations around them, and run focused validation for touched areas. Record the rebased commit as the baseline for later adaptation review.

The exact target is the `base/main` tip at the start of the update. Do not pursue newer commits in `upstream/main`.

- If the branch started with exactly one commit directly above the target, skip validation, report that result, and stop. A branch already based there but carrying multiple commits still needs squashing.
- If upstream makes a significant portion of the branch obsolete, irrelevant, redundant, or superseded, report this and what customizations would remain if any, and stop after the rebase.

Otherwise, the subagent is to report any conflicts, resolutions, and follow-up changes made to preserve the branch's intended customizations. You include these in your final report.

The subagent is to report also on any technical debt or refactors worth addressing **relative to the branch's own customizations in light of the incoming upstream changes**; do not assess the incoming upstream changes or branch customizations by themselves.

For later steps, the subagent is to commit any follow-ups separately on top of the rebased commit.

### 2. Complete a missing report

If step 1 omitted the required report, ask the subagent for it before continuing. Otherwise, skip this step.

### 3. Adapt branch customizations

If the report identifies worthwhile changes **relative to the branch's own customizations in light of the incoming upstream changes**, instruct the subagent to implement them. If their relevance is uncertain, have the subagent reassess whether they **relate to the branch's own customizations in light of the incoming upstream changes** and implement them only if they do. You include these applied changes in your final report.

### 4. Update branch documentation

If conflict resolution or step 3 changed documented behavior, instruct the subagent to update stale or missing branch Markdown files, including the git-ignored ones, according to the documentation rules.

### 5. Assess the adaptation

Before starting review, have the worker call `magi_get_options` and map one small completed evidence activity through `magi_list_context_activities` in the same turn. If native caller registration fails, return that infrastructure blocker with the worker's provider thread ID; repeating review operations does not repair registration. If evidence mapping is ambiguous, re-emit that evidence alone and list activities immediately. Preserve any existing run ID for recovery in its owning conversation.

A participant reporting missing `context_read` has an evidence-access failure. Preserve its response and provider diagnostics for the orchestrator; do not count repository reconstruction as consumption of the supplied artifacts, remove the participant, or claim the review passed. Resume through the review skill only after the required evidence access is restored.

If step 3 changed the branch, instruct the subagent to commit the follow-ups separately for review, then use the global `$magi-arbitrator-code-review` skill on high level and set the initial review `BASE` to the rebased commit recorded in step 1. Tell it to specify to the Magi participants performing the review that every item must be assessed **relative to the branch's own customizations in light of the incoming upstream changes**. Ignore every item outside that scope regardless of severity, including findings about incoming upstream changes or branch customizations by themselves. Do not load `$magi-arbitrator-code-review` yourself.

Include any changes made derived from Magi review recommendations in your final report.

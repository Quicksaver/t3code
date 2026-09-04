---
name: update-worktree
description: Merge upstream/main into one worktree and adapt its customizations.
disable-model-invocation: true
---

# Update one worktree

Load `$spawn-worktree`.

Give the subagent one step at a time. Send the next step only after it returns the current step's result. Be silent while you patiently wait for each subagent terminal result.

You only orchestrate and report. Do not validate the work or load skills assigned to the subagent.

At every step, keep the branch independently functional and keep all changes and commits local. Do not push. Tell the subagent to be silent while it patiently waits for each tool result.

Keep every assessment and follow-up **relative to the branch's own customizations in light of the incoming upstream changes**. Do not assess incoming upstream changes or branch customizations by themselves.

## Documentation rules

- Add new fork customizations introduced by conflict resolution or follow-ups.
- Remove or mark customizations that upstream made redundant.
- Keep conflict notes tied to concrete files and behaviors, not vague history.
- Describe the current state. Omit review narratives and change history.

## Steps

### 1. Merge and assess

Instruct the subagent to fetch and merge `upstream/main` into its current branch. Treat the incoming changes as intentional, preserve the branch's intended customizations around them, and run focused validation for touched areas.

The exact target commit from `upstream/main` is same as the latest head of `base/main`; even if `upstream/main` itself has newer commits, do not pursue them.

- If the branch is already current with `upstream/main` at the target commit specified above, skip validation, report that result, and stop.
- If upstream makes a significant portion of the branch obsolete, irrelevant, redundant, or superseded, report the affected customizations and stop after the merge.

Otherwise, require a report covering:

- New or changed upstream behavior.
- Upstream behavior that affects branch customizations or needs specific attention.
- Technical debt or refactors worth addressing **relative to the branch's own customizations in light of the incoming upstream changes**. Do not include assessments of incoming upstream changes or branch customizations by themselves.

### 2. Complete a missing report

If step 1 omitted the required report, ask the subagent for it before continuing. Otherwise, skip this step.

### 3. Adapt branch customizations

If the report identifies worthwhile changes **relative to the branch's own customizations in light of the incoming upstream changes**, instruct the subagent to implement them. If their relevance is uncertain, have the subagent reassess whether they **relate to the branch's own customizations in light of the incoming upstream changes** and implement them only if they do.

### 4. Update branch documentation

If step 3 changed the branch, instruct the subagent to update stale or missing branch Markdown files according to the documentation rules.

### 5. Assess the adaptation

If step 3 changed the branch, instruct the subagent to ensure everything is properly committed, then use the global `$magi-arbitrator-code-review` skill on high level and set the initial review `BASE` to the merge commit. Tell it to specify to the Magi participants performing the review that every item must be assessed **relative to the branch's own customizations in light of the incoming upstream changes**. Ignore every item outside that scope regardless of severity, including findings about incoming upstream changes or branch customizations by themselves. Do not load `$magi-arbitrator-code-review` yourself.

After the sequence finishes, report everything the subagent reported.

---
description: Update worktree with changes from main.
name: update-worktree
---

$spawn-worktree

Your task is to instruct the subagent in several steps, provide it instructions one step at a time, and wait for the subagent to report back before providing the next step's instructions. **You do not validate any work yourself, your only task is to orchestrate the subagent's work and ensure they report back with the requested information.**

**Step 1**: instruct subagent to fetch and merge `main` branch from `upstream` remote onto its current branch, preserving that branch's intentional customizations without blocking new upstream behavior.

Instruct it to remember incoming changes have been purposefully merged, the ongoing branch work is accessory and any conflicts should be resolved by working our changes around the incoming ones as necessary. Also the subagent must run the relevant validation for touched areas.

- If their branch is already up to date with `upstream/main`, they can skip the verification, reporting only that their branch is already up to date, and exit early.
- If the incoming `upstream/main` changes make obsolete a significant portion of the branch's customizations, for example by re-implementing a similar set of features or behaviors, the subagent should report on what is now considered irrelevant and exit early.

Each worktree branch work should be individual and fully working standalone. If there is a specific md file in their own branch, the subagent must:

- Update the generated-from refs, ahead/behind counts, and diff size.
- Add new fork customizations introduced by the merge or conflict resolution.
- Remove or mark retired customizations that upstream made redundant.
- Keep conflict notes tied to concrete files and behaviors, not vague history.

Finally, the subagent must report on

- new features or behaviors introduced by the upstream merge.
- highlight those features or behaviors that can impact the customized behavior or functionality, or that should be otherwise specifically addressed.
- analyse what from our customizations implementation could now be considered tech debt when compared to the changes that merge brought, and should be refactored for consistency with the new code.

**Step 2**: If the subagent finishes its work but forgets to provide the above asked report, ask the subagent again for it, with the details mentioned above. Skip this step if the subagent already provided a detailed report.

**Step 3**: If there is anything worth updating or refactoring, instruct the subagent to implement those refactors and changes in their branch.

**Step 4**: If there were changes made in step 3, instruct the subagent to update any stale or missing information in the related md file if any.

**Step 5**: If there were changes made in step 3, instruct the subagent to use the $assess-work skill.

When all steps are finished, report back on everything the subagent has reported.

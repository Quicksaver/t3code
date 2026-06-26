---
description: Update the current branch by picking commits from worktrees.
name: pick-from-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

The goal is to update the local `main` branch by applying the relevant worktree history directly, so that `main` is up-to-date with all worktree changes and reflects the full set of customizations and fixes from those worktrees.

To achieve this goal, your task is to instruct each subagent to list all merges, customizations, and fixes from its branch that are absent from the current main branch; include:

- SHAs for merge commits from `upstream/main` into the worktree branch.
- SHAs for commits outside `upstream/main` merges.

When all subagents finish:

- make the necessary equivalent merges from `upstream/main` up to the point where it is also merged into the worktree branches, keeping the upstream merge range bounded to the commits already present in those worktree branches.
- compare each listed non-upstream commit against current `main`; skip commits whose behavior is already present, and record the main commit or concrete evidence that covers the behavior.
- cherry-pick each remaining listed non-upstream commit from the worktree branches as its own commit whenever the patch applies or can be resolved as that commit's direct adaptation.
- preserve the original commit boundary and message by default, so future audits can trace each picked commit back to the worktree SHA.
- when a cherry-picked commit needs conflict resolutions that are part of that same change, resolve them inside that cherry-pick and continue it as the same commit.
- when the update requires root-only integration glue, `CUSTOMIZED.md` updates, test-harness adjustments, or documentation that belongs to the combined `main` branch rather than to one worktree commit, make those changes after the direct cherry-picks and commit them separately.
- update any stale or missing information in CUSTOMIZED.md as part of that separate root integration commit when the combined `main` branch owns the update rather than a single cherrypicked worktree commit.
- finally, use $commit.

Summarize everything that has been merged and cherry-picked, including:

- new or altered features or behaviors introduced by upstream merges if any.
- highlight those features or behaviors that can impact the customized behavior or functionality, or that should be otherwise specifically addressed.
- any potential behavior conflicts between worktree branches that were resolved or may still need to be resolved.

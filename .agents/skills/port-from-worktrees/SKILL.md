---
description: Port everything from worktrees into the current branch.
name: port-from-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

The goal is to port all changes from worktrees into the local `main` branch, so that it is up-to-date with all worktree changes and reflects the full set of customizations and fixes from those worktrees.

To achieve this goal, your task is to instruct each subagent to report all merges, customizations, and fixes from its branch that do not yet exist in the current main branch; include:

- SHAs for merge commits from `upstream/main` into the worktree branch.
- SHAs for commits not related to any `upstream/main` merges.

When all subagents finish:

- make the necessary equivalent merges from `upstream/main` up to the point where it is also merged into the worktree branches, i.e. do not include any commits from `upstream/main` that are not yet in the worktree branches.
- cherrypick each reported non-upstream commit from the worktree branches as its own commit whenever the patch applies or can be resolved as that commit's direct adaptation. Preserve the original commit boundary and message by default, so future audits can trace each port back to the worktree SHA.
- when a cherrypicked commit needs conflict resolutions that are part of that same change, resolve them inside that cherrypick and continue it as the same commit.
- when the port requires root-only integration glue, `CUSTOMIZED.md` updates, test-harness adjustments, or documentation that belongs to the combined `main` branch rather than to one worktree commit, make those changes after the direct cherry-picks and commit them separately.
- update any stale or missing information in CUSTOMIZED.md as part of that separate root integration commit when the update is not owned by a single cherrypicked worktree commit.
- finally, use $commit.

Report on everything that has been merged and cherrypicked, including:

- new or altered features or behaviors introduced by upstream merges if any.
- highlight those features or behaviors that can impact the customized behavior or functionality, or that should be otherwise specifically addressed.
- any potential behavior conflicts between worktree branches that were resolved or may still need to be resolved.

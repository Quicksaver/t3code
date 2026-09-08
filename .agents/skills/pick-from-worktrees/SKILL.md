---
name: pick-from-worktrees
description: Rebuild local main from base/fork and the active worktree commits.
disable-model-invocation: true
---

# Pick from worktrees

The goal is to rebuild `main` from `base/fork` and the active worktree commits, preserving their customizations and tracking. The rebuilt `main` should be a clean fast-forward of `base/main`, with all worktree customizations applied in order.

## Steps

1. Inventory all active non-main worktree branches.
2. Study the existing `FORK.md` and preserve `main`'s old tip for recovery and reference. Require a clean `main` worktree before rewriting it.
3. Fix the target at the current `base/main` commit. Require all worktree branches to share that base, with one customization commit per branch. Report branches needing preparation and stop before rebuilding.
4. Rewind `main` to its latest upstream base without revert commits, then fast-forward it to the target.
5. `base/fork` goes first. Apply all `base/fork` commits above the target to `main` in order, or fast-forward `main` to `base/fork` when equivalent.
6. Cherry-pick each remaining worktree branch's single commit onto `main`, one branch at a time, preserving its message. Before proceeding to the next branch, complete and validate the integration work needed as noted in "Integration Work" below, for it to coexist with the branches already applied.

## Integration work

- Preserve existing `main` tracking configuration.
- Reflect relevant `BRANCH_DETAILS.md` content in `FORK.md` without retaining branch-specific `BRANCH_DETAILS.md` files on `main`.
- For each branch, reassess existing `FORK.md` guidance against its current implementation and branch documentation; the old integration notes may be stale. Update the affected `FORK.md` sections during that branch's step. Include conflict-resolution glue and its documentation in the cherry-pick commit itself. Put any subsequent integration glue and its documentation together in a follow-up commit before picking the next branch. It is ok, and expected, to also update `FORK.md` in `base/fork` at every step with new commits there, so it remains mirror-synced with `main` after the rebuild.

## Report

- The base and branch commits used to rebuild `main`.
- Integration changes and the corresponding `FORK.md` updates for each branch.
- Behavior conflicts between worktree branches, including how they were resolved or what remains unresolved.

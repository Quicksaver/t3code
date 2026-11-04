---
name: rebuild-main
description: Rebuild local main from base/fork and the active worktree commits.
disable-model-invocation: true
---

# Rebuild main

The goal is to rebuild `main` from `base/fork` and the active worktree commits, preserving their customizations and tracking. The rebuilt `main` should be a clean fast-forward of `base/main`, with all worktree customizations applied in order.

## Steps

1. Inventory all active non-main worktree branches, plus maintainer-owned branches even when marked `(Currently Inactive)`. Exclude `base/main`.
2. Study the existing `FORK.md` and preserve `main`'s old tip for recovery and reference. Require a clean `main` worktree before rewriting it.
3. Fix the target at the current `base/main` commit. Require all locally maintained worktree branches to share that base, with commits for its customizations on top.
4. Rewind `main` to its latest upstream base without revert commits, then fast-forward it to the target.
5. `base/fork` goes first. Apply all `base/fork` commits above the target to `main` in order, or fast-forward `main` to `base/fork` when equivalent.
6. Cherry-pick each remaining worktree branch's commits onto `main`, one branch at a time, preserving its messages. Before proceeding to the next branch, complete and validate the integration work needed as noted in "Integration Work" below, for it to coexist with the branches already applied.

## Integration work

- Preserve existing `main` tracking configuration.
- Each worktree's `BRANCH_DETAILS.md` and accessory documentation are purposefully git-ignored through the repository's `.git/info/exclude`. BRANCH_DETAILS.md mirror that branch's specific customizations info that already exists in `FORK.md`, excluding only any conflict-resolution and integration glue-like documentation only meant for our `main` branch.
- For each branch, reassess existing `FORK.md` guidance against its current implementation and branch documentation; the old integration notes may be stale. Update the affected `FORK.md` sections during that branch's step. Include conflict-resolution glue and its documentation in the cherry-picked commits themselves. Put any subsequent integration glue and its documentation together in a follow-up commit before picking the next branch. It is ok, and expected, to also update `FORK.md` in `base/fork` at every step with new commits there, so it remains mirror-synced with `main` after the rebuild.

## Taken-over by upstream maintainer

An exception to steps 3. and 6. above are worktree branches that have been taken over by the upstream maintainer. We still want to cherry-pick the work in those branches, but their base will likely be different, so we may run into additional merge conflicts with our own target base.

Before rewriting `main`, require clean maintainer-owned worktrees, fetch their published PR heads and synchronize the local branches to them. Allow force-resetting after a maintainer rebase; preserve tracking and the old tips for recovery. Pin each source head and its own upstream base. Integrate the complete published PR changes, including all maintainer edits and merge resolutions. Avoid replaying `upstream/main` history already present in rebuilt `main`, and preserve any newer upstream changes the branch requires. When commit selection is ambiguous, apply the final customization diff to `main` instead of cherry-picking `base/main..branch`.

Treat incoming changes in our new base as intentional, preserve the branch's intended customizations around them, and run focused validation for touched areas on `main`. If our new base makes a significant portion of the branch obsolete, irrelevant, redundant, or superseded, report this and what customizations would remain if any, and skip cherry-picking that branch.

`FORK.md` and corresponding `BRANCH_DETAILS.md` updates are allowed for these taken-over worktrees, as those actions do not imply commits to these maintainer-owned branches; committing and pushing on the maintainer-owned branches is forbidden.

## Report

- The base and branch commits used to rebuild `main`.
- Integration changes and the corresponding `FORK.md` updates for each branch.
- Behavior conflicts between worktree branches, including how they were resolved or what remains unresolved.

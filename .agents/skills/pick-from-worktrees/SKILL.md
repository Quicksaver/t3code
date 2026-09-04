---
name: pick-from-worktrees
description: Integrate relevant active-worktree commits into local main.
disable-model-invocation: true
---

# Pick from worktrees

Load `$spawn-worktrees`.

Ask each subagent to inventory branch history that is absent from local `main`. Each report must include:

- The SHAs of merges from `upstream/main` into the worktree branch.
- The SHAs of commits outside those upstream merges.
- Every worktree commit after the completed synchronization checkpoint through the current worktree tip. The checkpoint is the latest `upstream/main` version already merged into both the worktree branch and local `main`.

Be silent while you patiently wait for each subagent terminal result.

After every subagent finishes:

1. Study `FORK.md`.
2. Merge the equivalent range from `upstream/main`, bounded by the upstream commits already present in the worktree branches.
3. Compare each reported non-upstream commit with local `main`. Skip behavior that is already present, and record the covering main commit or other concrete evidence.
4. Cherry-pick each remaining non-upstream commit as its own commit when its patch applies directly or can be resolved as a direct adaptation. Preserve its commit boundary and message. Resolve conflicts belonging to that change inside the same cherry-pick.
5. After the direct cherry-picks, make any main-owned integration glue, test-harness adjustment, documentation, or `FORK.md` correction, keeping those changes in their own commits separate from the cherry-picks. Reflect relevant `BRANCH_DETAILS.md` changes in `FORK.md` when the combined main branch owns that information.

Report:

- Every merge and cherry-pick.
- New or changed behavior introduced by upstream merges, especially behavior that affects fork customizations.
- Behavior conflicts between worktree branches, including how they were resolved or what remains unresolved.

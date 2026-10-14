---
name: update-unattended
description: Use for an unattended update of all worktrees, pick into main, and build all dists to get ready to update whole fleet.
disable-model-invocation: true
---

Follow these steps sequentially:

- use `$update-worktrees`. On blockers, report and do not proceed;
- use `$update-prs` to update open PRs; do not open new ones;
- use `$babysit-worktrees`. Contrarily to that skill's final instructions, do not cherrypick any new commits onto `main` yet as we will be entirely rebuilding in the next step;
- use `$rebuild-main`. If unsuccessful, report and do not proceed;
- push all tracked branches to origin;
- cleanup all temporary and leftover branches and stashes created during this process
- use `$build-fleet`.

## When finished

Provide an upstream changelog report: since we're outside the usual app update process, I need a sort of "Release notes" or "Changelog" summary of the changes that affect me and my usage of T3 Code, even if they don't affect my customizations. Based on all new upstream commits integrated in this run (base yourself on titles and bodies only, do not deep dive into diffs), group them by type and list them in your report.

Summarize also all changes made during this run to each branch's work in light of the incoming upstream updates, derived from conflict resolution, from Magi review recommendations, and from PR reviews. Group these by branch and state what changed and why, with a commit short hash linking to the commit where each change was made.

Skip reporting on unchanged behavior, clean merges with no conflicts, lack of needed action/follow-up on successful and uneventful updates, or any obvious or already documented main integration changes; i.e. "Combined X with Y in `main`" is obvious, I don't care.

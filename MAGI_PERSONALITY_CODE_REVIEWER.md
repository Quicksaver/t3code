# Magi participant instructions for code review

Review the evidence diff as a whole, and offer insightful, actionable comments. Use read-only native tools when code, documentation, or external facts need inspection. The changed code and its direct effects define scope.

**Focus:**

- logic and implementation defects;
- overlooked edge cases;
- wrong or unclear assumptions;
- security, reliability, performance, and maintenance issues;
- concrete, scoped consistency fixes, refactors, or cleanup opportunities, that improve readability or maintainability without changing intended behavior or established visuals, or regressing performance;
- unclear code;
- typos;
- stale, missing, or erroneous documentation;
- redundant, tautological, or irrelevant tests;
- missing important test coverage;
- other specific improvements with a real benefit.

For every review comment, name the file, affected line when applicable, severity, concrete impact, and smallest exemplifying fix when possible.

**Considerations:**

- valid issues and beneficial optimizations are actionable despite how minimal or low-impact;
- there are no "optional" comments, every valid finding is actionable;
- formatting preferences and praise are not findings;
- reverting intended behavior requires a concrete correctness, safety, or scope reason;
- a comment is in scope only when it concerns code changed by the diff, or unchanged code that directly affects or is affected by that change. Unchanged context lines are not in scope merely because they appear in the patch;
- preserve the stated change goal;
- when documentation and implementation disagree, investigate which one is wrong.

Express every actionable review comment as its own `vote-changing` proposal. Group only semantically identical duplicates. Different issues on the same line remain separate. A participant that accepts a CodeRabbit or other external finding must re-raise it as a participant proposal. An external finding that no participant re-raises has no `proposalId`, receives no vote, and is reported as unadopted external evidence.

On every follow-up turn, return an explicit ballot for the candidate fingerprint and evaluate every active proposal, including your own:

- `approve` a proposal when the issue still exists, is in scope, and is actionable, regardless of existence or validity of a proposed fix. Describe a still-unresolved valid issue in this rationale.
- `reject` a proposal when it is invalid, not actionable, outside the change goal, stale, superseded, or already addressed. Name the reason in the rationale.
- `abstain` only when reasonable investigation cannot establish a position. This completes your evaluation with zero approval weight and does not keep the proposal pending.

Approve the candidate only when no vote-changing condition remains in the reviewed change, and reject it when a required fix remains. Abstain when you cannot assess the selected candidate after reasonable investigation. Justify every ballot.

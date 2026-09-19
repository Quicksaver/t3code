# Magi code-review example prompt

## Goal

Perform a code review-and-fix of a given range of work, to achieve the highest possible quality of code that matches the desired behavior or feature.

> The reviewed change, including every threshold-approved fix applied so far, is correct and complete as it stands for the stated change goal.

Use the selected candidate for every arbitration. Success requires a `consensus-reached` result for that candidate. Unaddressed and unevaluated reviews, leading proposals, or edits without a confirming panel turn do not close the run.

## Preflight before Magi starts

Resolve the available Magi participants roster with `magi_get_options`. Use the following configuration, and stop with the exact incompatibility when an instance, model, option, or personality is unavailable:

- unlimited turns (`magiTurnLimit: null`; `0` is a panel input alias, not the canonical tool value)
- consensus threshold 50%
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, weight 4
- participant: Claude Fable 5, extra high reasoning, 1M context window, weight 4
- participant: Cursor Grok 4.6, extra high reasoning, fast mode off, weight 3
- participant: Cursor Composer 2.5, fast mode off, weight 2
- participant: OpenCode GLM 5.3 Flash, high variant, weight 2

Use this exact configuration, do not silently alter it for any reason.

All participants are to use the Code Reviewer personality. Configure that personality with the complete current contents of `MAGI_PERSONALITY_CODE_REVIEWER.md`; a pointer to an explicit-only provider skill does not prove every provider loaded the review rubric.

Resolve exactly one review target from my request:

- staged changes;
- unstaged changes;
- the working tree against an explicit base ref;
- one or several commits against their first parent, or the empty tree for a root commit;
- an explicit topic ref against an explicit base ref.

Ask for specificity when unresolved.

## For every Magi turn

Read project local `AGENTS.md`. Supply as evidence its file path and the file paths of all files referenced in it as relevant context for code review.

Generate and supply as evidence one complete, non-colorized git diff with argument-safe commands. Represent binary files with metadata only.

### Optional CodeRabbit evidence

Check whether the CodeRabbit CLI already exists and is authenticated:

```bash
coderabbit --version
coderabbit auth status --agent
```

A missing or unauthenticated CLI is unavailable. Skip CodeRabbit entirely.

When it is ready, use the narrowest command that exactly represents the resolved range:

```bash
coderabbit review --agent -t committed
coderabbit review --agent -t uncommitted
coderabbit review --agent --base <base>
coderabbit review --agent --base-commit <sha>
```

Use only the matching command. If CodeRabbit cannot represent the exact range, skip it and record why. Pass applicable `AGENTS.md`, `.coderabbit.yaml`, and the other referenced relevant code review context files when the CLI supports it. CodeRabbit can take a long time, be silent while you patiently wait for its results. Parse NDJSON one line at a time, retain finding events, and omit status events from the evidence. On an error, rate limit, or timeout, record the exact failure and skip it.

If CodeRabbit produces code reviews, supply them as evidence.

## Arbitrate and follow the requested workflow

After each Magi result, call `magi_record_arbitration` with the candidate, one evidence-based assessment per participant, every proposal disposition, and the next-turn brief. Derive first-turn support from each independent recommendation. On later turns, use the ballot tied to the current candidate fingerprint and interpret its rationale against that candidate. Send material ambiguity through the full-panel clarification flow. The server computes weighted totals and identifies threshold-approved proposals.

Treat only proposals that the Magi result marks threshold-approved as adopted. Pending, rejected, and below-threshold proposals are evidence only. Use the Magi exclusive-decision-set protocol when approved proposals conflict.

For every threshold-approved actionable proposal:

1. Make the smallest complete fix.
2. Update any documentation made stale or incomplete by the fix.
3. Run focused verification for the changed behavior.
4. Record the exact action and related proposal ids through `magi_record_actions`.

If an approved action cannot be completed or exposes an unforeseen consequence, record the actual outcome and return the impediment to the participants. Follow the owning conversation's authorization and normal repository policy for any rollback or commit. Do not substitute a materially different fix without another vote.

## Continue with exact new evidence

If changes were made in the last turn, follow the "For every Magi turn" instructions for the generated commit only; include all file paths dictated in those instructions even if duplicated from previous turns.

If no files changed but a new or revised proposal still awaits full-panel evaluation, call `magi_deliberate` without an empty diff and ask participants to assess the active proposals.

If an action succeeded but incremental evidence generation failed, record the action as completed and attach the evidence failure as an unforeseen consequence through `magi_record_actions`. If the action itself failed, record it as not completed. Send either impediment through the next arbitration cycle. Keep ordinary conversation and steering available while Magi is active; use the Magi-scoped main-agent input or approval flow only when the run genuinely cannot continue without the user.

Continue until the server returns a terminal state. Only `consensus-reached` closes the review successfully. Report `turn-limit-reached`, cancellation, and failure as failure to reach review closure.

## Report

State whether the candidate reached consensus. Account for every participant review comment with one outline item:

```md
- **<comment summary>** (<severity>, <file/line when applicable>): **<assessment>**, <fix or reason no change was made>, <alternative when useful>, <supporting and dissenting Model (Personality) participants>.
```

List the exact ranges reviewed, CodeRabbit failures or skips, unadopted external findings, remaining dissent, abstentions, minority objections, rejected proposals, and terminal state.

List incremental ranges, actions, focused verification, and required commits. The report is complete when every participant finding, external finding, vote, action, verification result, and cleanup outcome is accounted for.

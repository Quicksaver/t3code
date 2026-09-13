# Magi plan-refinement example prompt

## Glossary

- **document**: the target file or files object of the refinement, includes accessory files created throughout the process.

## Goal

Refine a plan, implementation specification, design document, or comparable breakdown file(s) into a durable, ready-to-implement account of its intended objective; the **document**.

The candidate is the current complete revision of the document, including every threshold-approved refinement applied so far. Use this candidate for every arbitration:

> The current revision of `<target path>` is an accurate, coherent, and ready-to-implement specification of `<objective>`.

Success requires a `consensus-reached` result for that candidate. A useful review, a leading proposal, or edits without a confirming panel turn do not close the run.

This workflow refines the document. It does not implement the work described by it. Treat the initiating request as edit authorization only when it explicitly authorizes changes to the document, or creation of accessory files towards that same goal.

## Preflight before Magi starts

Resolve the available Magi participants roster with `magi_get_options`. Use the following configuration, and stop with the exact incompatibility when an instance, model, option, or personality is unavailable:

- unlimited turns (`magiTurnLimit: null`; `0` is a panel-input alias)
- consensus threshold 50%
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, Product and UX Advocate, weight 2
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, Reliability and Operations Engineer, weight 2
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, Maintainability Steward, weight 1
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, Skeptical Reviewer, weight 1
- participant: Codex GPT 5.6 Sol, extra high reasoning, standard tier, Financials Advisor, weight 2
- participant: Claude Fable 5, extra high reasoning, 1M context window, no personality, weight 3
- participant: Cursor Grok 4.6, extra high reasoning, fast mode off, Security specialist, weight 2
- participant: Cursor Grok 4.6, extra high reasoning, fast mode off, no personality, weight 1
- participant: OpenCode GLM 5.3 Flash, high variant, no personality, weight 1

Use this exact configuration, do not silently alter it for any reason.

Resolve the document and intended objective from the initiating request and the document itself. Ask the user when either remains materially ambiguous. Preserve the user's objective, constraints, exclusions, and deliberate tradeoffs. A participant may challenge them, but the panel cannot silently replace them with a different project.

Read the complete document, every applicable project instruction file, and the repository sources needed to check the document's factual claims. Follow direct references from the target when they define its objective, constraints, existing behavior, or proposed interfaces. Distinguish current implementation facts from proposed changes.

Capture the complete target and shared source material as completed root-turn tool activities, and provide them as evidence.

Use this focused objective for `magi_start`, with the placeholders resolved:

> Assess the complete current revision of `<target path>` against its intended objective, `<objective>`. Decide whether an implementer can complete it without discovering an unstated product, architecture, behavior, migration, recovery, problem, constraint, or validation decision. Check every factual claim against the supplied repository evidence or your own read-only investigation. Propose each necessary document change as one atomic vote-changing proposal. Preserve deliberate scope. Do not implement.

## Readiness standard

Apply each concern only when it bears on the objective. The document is ready when it:

- states the intended outcome, scope, constraints, and meaningful exclusions without contradiction;
- agrees with the current repository or clearly labels proposed behavior;
- assigns ownership and defines the relevant interfaces, data, state transitions, invariants, and lifecycle;
- resolves material choices and defaults, with the reason for choices that would otherwise be reopened during implementation;
- covers applicable failure, interruption, retry, cancellation, concurrency, compatibility, migration, security, privacy, accessibility, and cleanup behavior;
- breaks the work into an order that respects dependencies and gives each part a checkable completion condition;
- names focused validation for the promised behavior and leaves no stale notes, duplicated sources of truth, placeholders, or unexplained contradictions.

Prefer the smallest document that carries the complete design. Keep useful existing structure and terminology. Add a section only when it gives the implementer information that has no clear home.

## Arbitrate every panel result

After each `magi_start` or `magi_deliberate` result, call `magi_record_arbitration` for that exact run and Magi turn. Use the candidate above, updated only when the intended objective itself changes with explicit user authority.

Bind the candidate to the exact document revision under review by naming the newest complete target-file T3 activity id in the candidate rationale. Replace that reference after every edit.

A participant supports the candidate only when it says the document meets the readiness standard without another material change. Send material ambiguity through the full-panel clarification flow.

## Apply approved refinements

For every threshold-approved actionable proposal:

1. Re-read the document immediately before editing and preserve changes made since the evidence snapshot.
2. Make the smallest coherent document edit that fully applies the proposal.
3. Check every changed factual reference, path, symbol, command, contract, and claimed test against the repository.
4. Run focused document validation that exists in the project, such as formatting, link, or Markdown checks.
5. Record the exact completed or failed edit and its proposal ids through `magi_record_actions`.

Edit only the document. When an approved refinement depends on a user-only product choice, conflicts with a newer edit, or cannot be supported by repository evidence, record the impediment rather than inventing an answer. Use the Magi-scoped input flow when the user can resolve it. Return the answer and the resulting document revision to the whole panel.

Finally commit all changes made this turn.

## Continue with the complete revised document

After any edit, read the complete revised document into a new root-turn activity and supply it as evidence, along with new evidence for disputed or changed claims.

Ask the panel to reassess the full document, not merely the latest patch. An edit can fix one finding while making another section stale or contradictory.

If no edit occurred but proposals or an exclusive decision set still need votes, continue with the active ids and a precise next-turn brief. If an edit succeeded but evidence collection or validation failed, record the edit as completed and the failure as an unforeseen consequence. Return that consequence to the panel.

Continue until the server returns a terminal state. Only `consensus-reached` means the target is ready to implement. Cancellation, failure, and `turn-limit-reached` mean the refinement did not reach closure.

## Report

State the target path, intended objective, terminal state, and whether the ready-to-implement candidate reached consensus. Summarize the material refinements made and the focused checks run.

List any unresolved user decisions, remaining dissent, abstentions, failed actions, factual claims that could not be verified, and threshold-approved work that remains incomplete. Attribute outcomes and dissent with the exact Model and Personality labels supplied by Magi. Omit internal participant ids and routine Magi workflow steps.

The report is complete when every accepted proposal and action is accounted for and the stated terminal result matches the server transition.

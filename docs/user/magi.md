# Magi consensus

Magi asks models to deliberate on a question and reports whether they reached weighted agreement. Your conversation's agent acts as the arbitrator. It prepares the run, interprets the answers, and reports the outcome. Each participant has a model, a voting weight.

## Starting a run

Ask the agent to use Magi and explicitly supply the roster, consensus threshold, and turn limit. For example, request two named models, a 100% threshold, and at most three Magi turns. Specify unlimited turns if that is what you want. Voting weights are 1 unless you override them.

The agent asks you to clarify missing or ambiguous configuration before starting. A request such as "Run Magi on the question 'is X really Y?'" needs a roster, threshold, and turn limit before it can run. There is no Magi-specific maximum roster size.

Participants appear as ordinary subagents in Lineage under the conversation that owns the run. A run started by a subagent belongs to that subagent's conversation.

## Things to know

- Every Magi turn runs every participant. Later turns carry earlier evidence, and participants can also use their own subagents. Cost grows with roster size and turn count.
- Participants keep working while the arbitrator is idle. The conversation's agent resumes automatically when the complete result is ready. Ask the agent to pause, resume, or stop the run. Stopping does not roll back completed actions.
- Participants are instructed to investigate and propose without changing files. Only the arbitrator acts on an authorized outcome. Participants retain the conversation's access mode, so read-only behavior relies on them following that instruction. Participants and their subagents cannot start Magi runs, create top-level threads, or message conversations outside their own subagents.
- Models can agree on the same mistake. Read the dissent the agent reports.

## Settings

Settings > **Magi** holds the arbitrator instructions. Edits apply to future runs; earlier runs keep their starting configuration.

# Magi consensus

Magi asks a panel of models to deliberate on a question and reports whether they reached weighted agreement. Your conversation's agent acts as the arbitrator: it starts each round, interprets the answers, and reports the outcome. Each participant is a model with an optional personality and a voting weight, and any configured provider can take part.

## Starting a run

- **From the Magi panel.** Open the **Magi** tab in the right panel, configure the participants, consensus threshold, and turn limit, then choose **Arm** while the conversation is idle. Your next message starts the run; **Disarm** cancels it before then. You can arm a new thread before its first message too. On mobile, use **Open magi** in the conversation's menu.
- **By asking the agent.** Ask the agent to use Magi, optionally naming the participants. Agents start Magi only when you ask for it.

Each run appears in the Magi panel's history, and the conversation's own newest run also appears as a summary in the conversation. Runs started by the conversation's subagents or delegated tasks also appear in its history and count toward the Magi tab's active-run badge, labelled with the subagent that started them. Participants run as child conversations of the thread that started Magi, so you can follow their transcripts from the thread's lineage and answer their approval requests there or, on web, in the Magi panel.

## Things to know

- **Cost grows quickly.** Every Magi turn runs every participant, and later turns resend the panel's latest answers. Participants can also use their own subagents. Keep the turn limit low unless you need more rounds.
- **Participants are told to stay read-only.** They investigate and propose; only your conversation's agent acts on the outcome. They still run with your conversation's access mode and the same tools as any conversation, so this relies on the models following the instruction. Participants and their subagents cannot start Magi runs, create new threads, or message conversations outside their own subagents.
- **Consensus is not proof.** Models that share training data or context can agree on the same mistake. Read the dissent the agent reports.
- **Stopping.** Ask the agent to stop the run. Completed actions are not rolled back.

## Settings

Settings → **Magi** holds the arbitrator instructions and the personality catalogue. Edits apply to future runs; earlier runs keep the configuration they started with.

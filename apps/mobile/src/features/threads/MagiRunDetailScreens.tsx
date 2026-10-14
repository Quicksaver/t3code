import {
  isMagiRunTerminal,
  type MagiParticipantId,
  type MagiParticipantSettlement,
  type MagiRunDetail,
  type ThreadId,
} from "@t3tools/contracts";
import { unrecordedMagiActionBatch } from "@t3tools/client-runtime/state/magiPresentation";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobileMagiProposalEvaluations } from "./MagiPanelSheet.logic";

/** Read-only nested Magi run screens. They render the run detail the sheet already subscribes to. */

type ParticipantLabel = (participantId: MagiParticipantId) => string;

/** Stable keys for text lists that may repeat an entry. */
function withOccurrenceKeys<T>(items: ReadonlyArray<T>, identify: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const identity = identify(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { item, key: `${identity}:${occurrence}` };
  });
}

const cardClass = "gap-2 rounded-2xl border border-border bg-card p-4";

function Card(props: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <View className={cardClass}>
      {props.title ? (
        <Text accessibilityRole="header" className="font-t3-bold">
          {props.title}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

function Muted(props: { readonly children: ReactNode }) {
  return <Text className="text-sm text-foreground-muted">{props.children}</Text>;
}

function Bullets(props: { readonly label: string; readonly items: ReadonlyArray<string> }) {
  if (props.items.length === 0) return null;
  return (
    <View className="gap-1">
      <Text className="text-sm font-t3-medium">{props.label}</Text>
      {withOccurrenceKeys(props.items, (item) => item).map(({ item, key }) => (
        <Text key={key} selectable className="text-sm">
          • {item}
        </Text>
      ))}
    </View>
  );
}

function Empty(props: { readonly children: ReactNode }) {
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      <Muted>{props.children}</Muted>
    </ScrollView>
  );
}

function SettlementBody(props: {
  readonly settlement: MagiParticipantSettlement;
  readonly showTranscript: boolean;
}) {
  const { settlement } = props;
  const parsed = settlement.parsed;
  return (
    <View className="gap-2">
      <Muted>
        {settlement.state.replaceAll("-", " ")} · {settlement.parseMode} response
        {parsed ? ` · ballot ${parsed.ballot} · ${parsed.confidence}% confidence` : ""}
        {settlement.failureClass ? ` · ${settlement.failureClass}` : ""}
      </Muted>
      {parsed ? (
        <>
          <Text selectable className="text-sm">
            {parsed.recommendation}
          </Text>
          <Bullets label="Rationale" items={parsed.rationale} />
          <Bullets label="Risks" items={parsed.risks} />
          <Bullets label="Assumptions" items={parsed.assumptions} />
        </>
      ) : null}
      {props.showTranscript ? (
        <View className="gap-1 border-t border-border-subtle pt-2">
          <Text className="text-sm font-t3-medium">Transcript</Text>
          <Muted>
            {settlement.contextCompressed ? "Context compressed · " : ""}
            {settlement.durationMs} ms · {settlement.inputTokens ?? "unknown"} input tokens ·{" "}
            {settlement.outputTokens ?? "unknown"} output tokens
          </Muted>
          <Text selectable className="text-sm text-foreground-muted">
            {settlement.rawText || "No participant transcript was returned."}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function MagiRunTurnScreen(props: {
  readonly detail: MagiRunDetail;
  readonly magiTurn: number;
  readonly showDiagnostics: boolean;
  readonly labelParticipant: ParticipantLabel;
}) {
  const turn = props.detail.magiTurns?.find((item) => item.magiTurn === props.magiTurn);
  if (!turn) return <Empty>This Magi turn is not recorded yet.</Empty>;
  const arbitration = turn.arbitration;
  const candidate = arbitration?.candidate ?? turn.candidate;
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      <Muted>
        {turn.settlements.length} responses · {turn.activities.length} referenced tool activities ·{" "}
        {arbitration ? "arbitrated" : "awaiting arbitration"}
      </Muted>
      {candidate ? (
        <Card title="Candidate">
          <Text selectable>{candidate.conclusion}</Text>
          <Bullets label="Rationale" items={candidate.rationale} />
          <Bullets label="Caveats" items={candidate.caveats} />
        </Card>
      ) : null}
      {arbitration && arbitration.disagreements.length > 0 ? (
        <Card title="Dissent">
          {withOccurrenceKeys(arbitration.disagreements, (item) => item).map(({ item, key }) => (
            <Text key={key} selectable className="text-sm">
              {item}
            </Text>
          ))}
        </Card>
      ) : null}
      {arbitration && arbitration.assessments.length > 0 ? (
        <Card title="Arbitrator assessments">
          {arbitration.assessments.map((assessment) => (
            <View key={assessment.participantId} className="gap-1">
              <Text className="text-sm font-t3-medium">
                {props.labelParticipant(assessment.participantId)} · {assessment.stance}
              </Text>
              <Text selectable className="text-sm text-foreground-muted">
                {assessment.evidence}
              </Text>
              {assessment.clarificationQuestion ? (
                <Text selectable className="text-sm">
                  Clarification: {assessment.clarificationQuestion}
                </Text>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
      {arbitration && arbitration.proposalDispositions.length > 0 ? (
        <Card title="Proposal dispositions">
          {arbitration.proposalDispositions.map((disposition) => (
            <View key={disposition.proposalId} className="gap-1">
              <Text selectable className="text-sm font-t3-medium">
                {props.detail.proposals?.find((item) => item.proposalId === disposition.proposalId)
                  ?.proposal.change ?? disposition.proposalId}
              </Text>
              <Muted>
                {disposition.disposition.replaceAll("-", " ")} · {disposition.rationale}
              </Muted>
            </View>
          ))}
        </Card>
      ) : null}
      {arbitration?.nextTurnBrief ? (
        <Card title="Next turn brief">
          <Text selectable className="text-sm">
            {arbitration.nextTurnBrief}
          </Text>
        </Card>
      ) : null}
      {turn.activities.length > 0 ? (
        <Card title="Tool evidence">
          {turn.activities.map((activity) => (
            <View key={activity.activityId} className="gap-0.5">
              <Text className="text-sm font-t3-medium">{activity.kind}</Text>
              <Muted>{activity.summary}</Muted>
            </View>
          ))}
        </Card>
      ) : null}
      {turn.settlements.map((settlement) => (
        <Card
          key={settlement.participantRunId ?? settlement.participantId}
          title={props.labelParticipant(settlement.participantId)}
        >
          <SettlementBody settlement={settlement} showTranscript={props.showDiagnostics} />
        </Card>
      ))}
    </ScrollView>
  );
}

export function MagiRunParticipantScreen(props: {
  readonly detail: MagiRunDetail;
  readonly participantId: MagiParticipantId;
  readonly showDiagnostics: boolean;
  readonly onOpenConversation: (threadId: ThreadId) => void;
}) {
  const childThreadId =
    props.detail.participants.find((item) => item.participantId === props.participantId)
      ?.childThreadId ?? null;
  const turns = (props.detail.magiTurns ?? []).flatMap((turn) => {
    const settlement = turn.settlements.find((item) => item.participantId === props.participantId);
    const assessment = turn.arbitration?.assessments.find(
      (item) => item.participantId === props.participantId,
    );
    return settlement || assessment ? [{ magiTurn: turn.magiTurn, settlement, assessment }] : [];
  });
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      {childThreadId ? (
        <Pressable
          className="min-h-11 items-center justify-center rounded-xl border border-border bg-card px-4 active:bg-subtle"
          accessibilityRole="link"
          accessibilityHint="Closes Magi and opens this participant's conversation"
          onPress={() => props.onOpenConversation(childThreadId)}
        >
          <Text className="font-t3-medium">Open participant conversation</Text>
        </Pressable>
      ) : null}
      {turns.length === 0 ? <Muted>This participant has not responded yet.</Muted> : null}
      {turns.map(({ magiTurn, settlement, assessment }) => (
        <Card key={magiTurn} title={`Turn ${magiTurn}`}>
          {settlement ? (
            <SettlementBody settlement={settlement} showTranscript={props.showDiagnostics} />
          ) : (
            <Muted>No response recorded.</Muted>
          )}
          {assessment ? (
            <View className="gap-1 border-t border-border-subtle pt-2">
              <Text className="text-sm font-t3-medium">Arbitrator: {assessment.stance}</Text>
              <Text selectable className="text-sm text-foreground-muted">
                {assessment.evidence}
              </Text>
            </View>
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}

/** The instruction that started the run; the detail carries it only when fetched with diagnostics. */
export function MagiRunInitialPromptScreen(props: { readonly detail: MagiRunDetail }) {
  if (!props.detail.initialPrompt) return <Empty>No initial prompt is available.</Empty>;
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      <Card>
        <Text selectable className="text-sm">
          {props.detail.initialPrompt}
        </Text>
      </Card>
    </ScrollView>
  );
}

export function MagiRunProposalsScreen(props: {
  readonly detail: MagiRunDetail;
  readonly labelParticipant: ParticipantLabel;
}) {
  const proposals = props.detail.proposals ?? [];
  if (proposals.length === 0) return <Empty>No proposals were made in this run.</Empty>;
  const turns = props.detail.magiTurns ?? [];
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      {proposals.map((proposal) => {
        const evaluations = mobileMagiProposalEvaluations(turns, proposal.proposalId);
        const dispositions = turns.flatMap((turn) =>
          (turn.arbitration?.proposalDispositions ?? [])
            .filter((item) => item.proposalId === proposal.proposalId)
            .map((item) => ({ ...item, magiTurn: turn.magiTurn })),
        );
        return (
          <Card key={proposal.proposalId}>
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {proposal.decision} · {proposal.proposal.kind.replaceAll("-", " ")}
            </Text>
            <Text selectable className="font-t3-medium">
              {proposal.proposal.change}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {proposal.proposal.rationale}
            </Text>
            <Muted>
              {proposal.approvalWeight} approval weight · {proposal.rejectionWeight} rejection
              weight · integration {proposal.integration.replaceAll("-", " ")}
            </Muted>
            <Muted>
              Proposed in turn {proposal.firstMagiTurn} by{" "}
              {proposal.originParticipantIds.map(props.labelParticipant).join(", ")} · decided{" "}
              {proposal.decisionMagiTurn === null
                ? "not yet"
                : `in turn ${proposal.decisionMagiTurn}`}{" "}
              · basis {proposal.decisionBasis.replaceAll("-", " ")}
            </Muted>
            {evaluations.length > 0 ? (
              <View className="gap-1 border-t border-border-subtle pt-2">
                <Text className="text-sm font-t3-medium">Evaluations</Text>
                {withOccurrenceKeys(evaluations, (evaluation) =>
                  JSON.stringify([
                    evaluation.magiTurn,
                    evaluation.participantId,
                    evaluation.ballot,
                  ]),
                ).map(({ item: evaluation, key }) => (
                  <Text key={key} selectable className="text-sm">
                    {props.labelParticipant(evaluation.participantId)}: {evaluation.ballot} · turn{" "}
                    {evaluation.magiTurn} · {evaluation.rationale}
                  </Text>
                ))}
              </View>
            ) : null}
            {dispositions.length > 0 ? (
              <View className="gap-1 border-t border-border-subtle pt-2">
                <Text className="text-sm font-t3-medium">Arbitrator dispositions</Text>
                {dispositions.map((item) => (
                  <Text key={item.magiTurn} selectable className="text-sm">
                    Turn {item.magiTurn}: {item.disposition.replaceAll("-", " ")} · {item.rationale}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}

export function MagiRunActionsScreen(props: { readonly detail: MagiRunDetail }) {
  const { detail } = props;
  // Recorded actions and reconciliations already cover a batch once the main agent reports it.
  const batch = unrecordedMagiActionBatch(detail);
  const reconciliations = detail.actionReconciliations ?? [];
  if (!batch && detail.actions.length === 0 && reconciliations.length === 0) {
    return <Empty>No actions were issued or recorded in this run.</Empty>;
  }
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-10">
      {batch ? (
        <Card title={`Issued actions · turn ${batch.magiTurn}`}>
          <Muted>
            {isMagiRunTerminal(detail.summary.state)
              ? "The run ended before the main agent recorded what happened to these actions."
              : "The main agent has not recorded what happened to these actions yet."}
          </Muted>
          {batch.actions.map((action) => (
            <Text key={action.actionId} selectable className="text-sm">
              {action.summary} · {action.obligation}
            </Text>
          ))}
        </Card>
      ) : null}
      {detail.actions.map((action) => (
        <Card key={action.actionId}>
          <Text className="text-sm font-t3-medium text-foreground-muted">
            {action.status.replaceAll("-", " ")} · {action.obligation}
          </Text>
          <Text selectable className="font-t3-medium">
            {action.summary}
          </Text>
          <Text selectable className="text-sm text-foreground-muted">
            {action.details}
          </Text>
          {action.unforeseenConsequence ? (
            <Text selectable className="text-sm text-danger-foreground">
              Unforeseen consequence: {action.unforeseenConsequence}
            </Text>
          ) : null}
        </Card>
      ))}
      {reconciliations.map((reconciliation) => (
        <Card key={reconciliation.reconciliationId} title="Action reconciliation">
          <Muted>Recorded {new Date(reconciliation.recordedAt).toLocaleString()}</Muted>
          {reconciliation.actions.map((action) => (
            <View key={action.actionId} className="gap-0.5">
              <Text selectable className="text-sm font-t3-medium">
                {action.summary}
              </Text>
              <Muted>
                {action.status.replaceAll("-", " ")} · {action.details}
              </Muted>
            </View>
          ))}
        </Card>
      ))}
    </ScrollView>
  );
}

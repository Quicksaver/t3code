import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MagiParticipantId,
  MagiRunId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
  ProviderItemId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

function archiveThread(readModel: OrchestrationReadModel, threadId: ThreadId, index: number) {
  const archivedAt = `2026-01-01T00:0${index}:00.000Z`;
  return projectEvent(readModel, {
    sequence: readModel.snapshotSequence + 1,
    eventId: asEventId(`evt-thread-archive-${index}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.archived",
    occurredAt: archivedAt,
    commandId: asCommandId(`cmd-thread-archive-${index}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-thread-archive-${index}`),
    metadata: {},
    payload: {
      threadId,
      archivedAt,
      updatedAt: archivedAt,
    },
  });
}

const seedReadModelWithSubagents = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const withRoots = yield* seedReadModel;
  const childThreadId = asThreadId("thread-delete-1-child");
  const grandchildThreadId = asThreadId("thread-delete-1-grandchild");
  const withChild = yield* projectEvent(withRoots, {
    sequence: 4,
    eventId: asEventId("evt-thread-create-1-child"),
    aggregateKind: "thread",
    aggregateId: childThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1-child"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1-child"),
    metadata: {},
    payload: {
      threadId: childThreadId,
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1 Child",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      parentRelation: {
        kind: "subagent",
        rootThreadId: asThreadId("thread-delete-1"),
        parentThreadId: asThreadId("thread-delete-1"),
        parentTurnId: asTurnId("turn-delete-1"),
        parentItemId: asProviderItemId("item-delete-1"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-delete-1-child",
        titleSeed: "Child",
        depth: 1,
        startedAt: now,
        completedAt: null,
        status: "running",
      },
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withChild, {
    sequence: 5,
    eventId: asEventId("evt-thread-create-1-grandchild"),
    aggregateKind: "thread",
    aggregateId: grandchildThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1-grandchild"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1-grandchild"),
    metadata: {},
    payload: {
      threadId: grandchildThreadId,
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1 Grandchild",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      parentRelation: {
        kind: "subagent",
        rootThreadId: asThreadId("thread-delete-1"),
        parentThreadId: childThreadId,
        parentTurnId: asTurnId("turn-delete-1-child"),
        parentItemId: asProviderItemId("item-delete-1-child"),
        parentActivitySequence: 2,
        providerThreadId: "provider-thread-delete-1-grandchild",
        titleSeed: "Grandchild",
        depth: 2,
        startedAt: now,
        completedAt: null,
        status: "running",
      },
      createdAt: now,
      updatedAt: now,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

function normalizeThreadLifecycleEvents(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          threadId: entry.payload.threadId,
        };
      case "thread.archived":
      case "thread.unarchived":
        return {
          type: entry.type,
          threadId: entry.payload.threadId,
        };
      case "project.deleted":
        return {
          type: entry.type,
          projectId: entry.payload.projectId,
        };
      default:
        return { type: entry.type };
    }
  });
}

it.layer(NodeServices.layer)("decider thread lifecycle flows", (it) => {
  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("rejects deleteArchivedThreads when the project still has a live thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const withArchivedThread = yield* archiveThread(readModel, asThreadId("thread-delete-1"), 1);
      expect(
        withArchivedThread.threads.find((thread) => thread.id === "thread-delete-2")?.archivedAt,
      ).toBeNull();

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-archived-only-mixed"),
            projectId: asProjectId("project-delete"),
            deleteArchivedThreads: true,
          },
          readModel: withArchivedThread,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("rejects deleting archived threads without explicit opt-in", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      for (const [index, threadId] of ["thread-delete-1", "thread-delete-2"].entries()) {
        readModel = yield* archiveThread(readModel, asThreadId(threadId), index + 1);
      }

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-archived-no-opt-in"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("deletes a project containing only archived threads without force", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      for (const [index, threadId] of ["thread-delete-1", "thread-delete-2"].entries()) {
        readModel = yield* archiveThread(readModel, asThreadId(threadId), index + 1);
      }

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: asCommandId("cmd-project-delete-archived-only"),
          projectId: asProjectId("project-delete"),
          deleteArchivedThreads: true,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );

  it.effect("deletes subagent descendants before deleting their parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-delete-cascade"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("archives subagent descendants before archiving their parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-thread-archive-cascade"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.archived", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("unarchives every archived subagent descendant with its root thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;
      const archiveResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-thread-archive-before-unarchive"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel,
      });
      const archiveEvents = Array.isArray(archiveResult) ? archiveResult : [archiveResult];
      let archivedReadModel = readModel;
      for (const [index, event] of archiveEvents.entries()) {
        archivedReadModel = yield* projectEvent(archivedReadModel, {
          ...event,
          sequence: readModel.snapshotSequence + index + 1,
        });
      }

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-thread-unarchive-cascade"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: archivedReadModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.unarchived", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.unarchived", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.unarchived", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("rejects reparenting a subagent beneath its own descendant", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;
      const child = readModel.threads.find(
        (thread) => thread.id === asThreadId("thread-delete-1-child"),
      );
      if (child?.parentRelation?.kind !== "subagent") {
        throw new Error("Expected seeded child subagent relation");
      }

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: asCommandId("cmd-thread-cycle-reparent"),
            threadId: child.id,
            parentRelation: {
              ...child.parentRelation,
              parentThreadId: asThreadId("thread-delete-1-grandchild"),
              depth: 3,
            },
          },
          readModel,
        }),
      );

      expect(error.message).toContain("parent relation would create a cycle");
    }),
  );

  it.effect("rejects creating a subagent with a missing parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;
      const child = readModel.threads.find(
        (thread) => thread.id === asThreadId("thread-delete-1-child"),
      );
      if (child?.parentRelation?.kind !== "subagent") {
        throw new Error("Expected seeded child subagent relation");
      }

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: asCommandId("cmd-thread-create-missing-parent"),
            threadId: asThreadId("thread-missing-parent-child"),
            projectId: child.projectId,
            title: "Missing parent child",
            modelSelection: child.modelSelection,
            interactionMode: child.interactionMode,
            runtimeMode: child.runtimeMode,
            branch: child.branch,
            worktreePath: child.worktreePath,
            parentRelation: {
              ...child.parentRelation,
              parentThreadId: asThreadId("thread-missing-parent"),
              providerThreadId: "provider-thread-missing-parent-child",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          readModel,
        }),
      );

      expect(error.message).toContain(
        "Thread 'thread-missing-parent' does not exist for command 'thread.create'",
      );
    }),
  );

  it.effect("rejects reparenting a subagent to a missing parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;
      const child = readModel.threads.find(
        (thread) => thread.id === asThreadId("thread-delete-1-child"),
      );
      if (child?.parentRelation?.kind !== "subagent") {
        throw new Error("Expected seeded child subagent relation");
      }

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: asCommandId("cmd-thread-reparent-missing-parent"),
            threadId: child.id,
            parentRelation: {
              ...child.parentRelation,
              parentThreadId: asThreadId("thread-missing-parent"),
            },
          },
          readModel,
        }),
      );

      expect(error.message).toContain(
        "Thread 'thread-missing-parent' does not exist for command 'thread.meta.update'",
      );
    }),
  );

  it.effect("force-deletes subagent descendants once when deleting a project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: asCommandId("cmd-project-delete-subagents"),
          projectId: asProjectId("project-delete"),
          force: true,
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-2") },
        { type: "project.deleted", projectId: asProjectId("project-delete") },
      ]);
    }),
  );

  it.effect("applies lifecycle changes to a native subagent's Magi tree in lineage order", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;
      const ownerThreadId = asThreadId("thread-delete-1-child");
      const participantThreadId = asThreadId("zz-thread-delete-1-child-magi-participant");
      const now = "2026-01-01T00:00:00.000Z";
      const withParticipant = yield* projectEvent(readModel, {
        sequence: readModel.snapshotSequence + 1,
        eventId: asEventId("evt-create-subagent-magi-participant"),
        aggregateKind: "thread",
        aggregateId: participantThreadId,
        type: "thread.created",
        occurredAt: now,
        commandId: asCommandId("cmd-create-subagent-magi-participant"),
        causationEventId: null,
        correlationId: asCommandId("cmd-create-subagent-magi-participant"),
        metadata: {},
        payload: {
          threadId: participantThreadId,
          projectId: asProjectId("project-delete"),
          title: "Nested Magi participant",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          parentRelation: {
            kind: "magi",
            rootThreadId: ownerThreadId,
            parentThreadId: ownerThreadId,
            runId: MagiRunId.make("run-delete-subagent-owner"),
            participantId: MagiParticipantId.make("participant-delete-subagent-owner"),
            providerThreadId: "provider-subagent-magi-participant",
            depth: 1,
            startedAt: now,
            completedAt: null,
            status: "completed",
          },
          createdAt: now,
          updatedAt: now,
        },
      });

      const archived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-root-with-subagent-magi"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: withParticipant,
      });
      expect(normalizeThreadLifecycleEvents(archived)).toEqual([
        { type: "thread.archived", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.archived", threadId: participantThreadId },
        { type: "thread.archived", threadId: ownerThreadId },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1") },
      ]);

      let archivedReadModel = withParticipant;
      for (const [index, event] of (Array.isArray(archived) ? archived : [archived]).entries()) {
        archivedReadModel = yield* projectEvent(archivedReadModel, {
          ...event,
          sequence: withParticipant.snapshotSequence + index + 1,
        });
      }
      const unarchived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-unarchive-root-with-subagent-magi"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: archivedReadModel,
      });
      expect(normalizeThreadLifecycleEvents(unarchived)).toEqual([
        { type: "thread.unarchived", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.unarchived", threadId: participantThreadId },
        { type: "thread.unarchived", threadId: ownerThreadId },
        { type: "thread.unarchived", threadId: asThreadId("thread-delete-1") },
      ]);

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-delete-root-with-subagent-magi"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: withParticipant,
      });

      expect(normalizeThreadLifecycleEvents(deleted)).toEqual([
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.deleted", threadId: participantThreadId },
        { type: "thread.deleted", threadId: ownerThreadId },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("archives and deletes Magi participant descendants with their root", () =>
    Effect.gen(function* () {
      const roots = yield* seedReadModel;
      const now = "2026-01-01T00:00:00.000Z";
      const childId = asThreadId("thread-delete-1-magi-participant");
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-create-magi-participant"),
          threadId: childId,
          projectId: asProjectId("project-delete"),
          title: "Magi participant",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          parentRelation: {
            kind: "magi",
            rootThreadId: asThreadId("thread-delete-1"),
            parentThreadId: asThreadId("thread-delete-1"),
            runId: MagiRunId.make("run-delete-1"),
            participantId: MagiParticipantId.make("participant-delete-1"),
            providerThreadId: "provider-magi-participant",
            depth: 1,
            startedAt: now,
            completedAt: null,
            status: "running",
          },
          createdAt: now,
        },
        readModel: roots,
      });
      const withMagi = yield* projectEvent(roots, {
        ...(Array.isArray(created) ? created[0]! : created),
        sequence: roots.snapshotSequence + 1,
      });

      const archived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-root-with-magi"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: withMagi,
      });
      expect(normalizeThreadLifecycleEvents(archived)).toEqual([
        { type: "thread.archived", threadId: childId },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1") },
      ]);

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-delete-root-with-magi"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: withMagi,
      });
      expect(normalizeThreadLifecycleEvents(deleted)).toEqual([
        { type: "thread.deleted", threadId: childId },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );
});

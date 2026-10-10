import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AiError } from "effect/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as AttachmentHandlers from "../mcp/toolkits/attachment/handlers.ts";
import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadHandlers from "../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { ProjectionMagiRepository } from "../persistence/ProjectionMagi.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlRepository from "../sourceControl/SourceControlRepositoryService.ts";
import * as MagiParticipantPolicy from "./MagiParticipantPolicy.ts";

const projectId = ProjectId.make("project:policy");
const otherProjectId = ProjectId.make("project:other");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };

// owner ─┬─ participant ── participantChild ── participantGrandchild
//        ├─ otherParticipant
//        └─ ordinarySubagent ── ordinaryGrandchild
const id = ThreadId.make;
const owner = id("owner");
const participant = id("participant");
const participantChild = id("participant-child");
const participantGrandchild = id("participant-grandchild");
const otherParticipant = id("other-participant");
const ordinarySubagent = id("ordinary-subagent");
const ordinaryGrandchild = id("ordinary-grandchild");
const otherProjectThread = id("other-project-thread");
const parents = new Map<ThreadId, ThreadId>([
  [participant, owner],
  [participantChild, participant],
  [participantGrandchild, participantChild],
  [otherParticipant, owner],
  [ordinarySubagent, owner],
  [ordinaryGrandchild, ordinarySubagent],
]);
const participants = new Set([participant, otherParticipant]);

const appThread = (threadId: ThreadId) =>
  ({
    id: threadId,
    lineage: {
      parentThreadId: parents.get(threadId) ?? null,
      relationshipToParent: parents.has(threadId) ? "subagent" : null,
      rootThreadId: owner,
    },
  }) as OrchestrationV2AppThread;

// Each thread has a scheduled task bound to it, plus one that launches a fresh thread per run.
const boundTaskId = (threadId: ThreadId) => ScheduledTaskId.make(`task:${threadId}`);
const unboundTaskId = ScheduledTaskId.make("task:unbound");
const otherProjectTaskIds = [
  ScheduledTaskId.make("task:other-project:bound"),
  ScheduledTaskId.make("task:other-project:unbound"),
];
const scheduledTasks = [
  ...[owner, ...parents.keys()].map((threadId) => ({
    id: boundTaskId(threadId),
    threadId,
    projectId,
  })),
  { id: unboundTaskId, threadId: null, projectId },
  { id: otherProjectTaskIds[0], threadId: otherProjectThread, projectId: otherProjectId },
  { id: otherProjectTaskIds[1], threadId: null, projectId: otherProjectId },
].map(
  (task) =>
    ({
      ...task,
      lastRunStatus: "never",
      runCount: 0,
      nextRunAt: null,
    }) as unknown as ScheduledTask,
);

const ownedAttachment = {
  type: "image" as const,
  id: "owned-image",
  name: "owned.png",
  mimeType: "image/png",
  sizeBytes: 12,
};
const pendingRequestId = "request";
const notRunHere = () =>
  Effect.fail(
    new OrchestratorMcpFailure({ code: "orchestration_error", message: "Not run here." }),
  );

const dependenciesFor = (caller: ThreadId, calls: Array<string>) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: { threadId: caller, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      createThreads: () => {
        calls.push("create_threads");
        return Effect.succeed({ threads: [] });
      },
      sendToThread: (_scope, input) => {
        calls.push(`t3_thread_send:${input.threadId}`);
        return Effect.succeed({
          threadId: input.threadId,
          messageId: MessageId.make("message"),
          runId: RunId.make("run"),
          status: "running" as const,
          delivery: "started" as const,
        });
      },
      interruptThread: (_scope, input) => {
        calls.push(`t3_thread_interrupt:${input.threadId}`);
        return Effect.succeed({
          threadId: input.threadId,
          runId: null,
          status: "no_active_run" as const,
        });
      },
      delegateTask: () => {
        calls.push("delegate_task");
        return notRunHere();
      },
      scheduleTask: (_scope, input) => {
        calls.push(`schedule_task:${input.bindToCurrentThread ?? true}`);
        return notRunHere();
      },
      listScheduledTasks: (_scope, input) =>
        Effect.succeed({
          tasks: scheduledTasks
            .filter((task) => task.projectId === (input.projectId ?? projectId))
            .map((task) => ({
              scheduledTaskId: task.id,
              boundThreadId: task.threadId,
            })),
        } as never),
      updateScheduledTask: (_scope, input) => {
        calls.push(`update_scheduled_task:${input.scheduledTaskId}`);
        return notRunHere();
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        calls.push("t3_thread_launch");
        return Effect.succeed({
          threadId: input.threadId,
          projection: {
            thread: { id: input.threadId, title: "Launched thread", projectId, modelSelection },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: scheduledTasks }),
      runNow: ({ id }) => {
        calls.push(`run_scheduled_task_now:${id}`);
        return Effect.succeed({ task: scheduledTasks.find((task) => task.id === id)! });
      },
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
    Layer.mock(Project.ProjectService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(SourceControlRepository.SourceControlRepositoryService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-participant-policy-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    MagiParticipantPolicy.layerFromServices.pipe(
      Layer.provide(
        Layer.mock(ProjectionMagiRepository)({
          findParticipantThreads: (threadIds) =>
            Effect.succeed(threadIds.filter((threadId) => participants.has(threadId))),
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: caller,
            projectId,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            activeRunId: "active-run",
            archivedAt: null,
            deletedAt: null,
          } as OrchestrationV2ThreadShell),
        getThreadRecords: (threadId) => Effect.succeed({ thread: appThread(threadId) }) as never,
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({
            thread: {
              ...appThread(threadId),
              projectId,
              runtimeMode: "full-access",
              interactionMode: "default",
              archivedAt: null,
            },
            messages: [{ attachments: [ownedAttachment] }],
            runtimeRequests: [{ id: pendingRequestId, kind: "user_input", status: "pending" }],
            turnItems: [{ type: "user_input_request", requestId: pendingRequestId, questions: [] }],
          }) as never,
        dispatch: (command) => {
          calls.push(`${command.type}:${"threadId" in command ? command.threadId : ""}`);
          return Effect.succeed({ sequence: 1 }) as never;
        },
        sendToThread: (input) => {
          calls.push(`t3_thread_send_attachments:${input.threadId}`);
          return Effect.succeed({
            message: { attachments: input.attachments },
            run: { id: RunId.make("run"), status: "running" },
          }) as never;
        },
      }),
    ),
  );

const buildToolkits = (dependencies: ReturnType<typeof dependenciesFor>) =>
  Effect.all({
    orchestrator: OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    ),
    project: ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    ),
    thread: ThreadToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    ),
    attachment: AttachmentToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AttachmentHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    ),
  });
type Toolkits = Effect.Success<ReturnType<typeof buildToolkits>>;
type ToolServices = Layer.Success<ReturnType<typeof dependenciesFor>>;
type ToolInvocation = (
  toolkits: Toolkits,
) => Effect.Effect<
  Stream.Stream<
    { readonly isFailure: boolean; readonly result: unknown },
    AiError.AiError,
    ToolServices
  >,
  AiError.AiError,
  ToolServices
>;

/** The failure code of a tool's final result, or null when it succeeded. */
const failureCode = (
  results: Iterable<{ readonly isFailure: boolean; readonly result: unknown }>,
) => {
  const last = [...results].at(-1);
  return last?.isFailure ? (last.result as { readonly code: string }).code : null;
};

/** Calls one tool as `caller`; returns its failure code and the side effects it made. */
const callTool = (caller: ThreadId, invoke: ToolInvocation) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const dependencies = dependenciesFor(caller, calls);
    const toolkits = yield* buildToolkits(dependencies);
    const results = yield* invoke(toolkits).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provide(dependencies),
    );
    return { code: failureCode(results), calls };
  });

const queuedRunId = RunId.make("queued-run");
const sourcePoint = { type: "latest_stable" as const };
const everyHour = { type: "interval" as const, everyMs: 3_600_000 };

/** Tools that write to or control a target thread, with the side effect each makes there. */
const targetedTools: ReadonlyArray<
  readonly [
    name: string,
    invoke: (target: ThreadId) => ToolInvocation,
    call: (target: ThreadId) => string,
  ]
> = [
  [
    "t3_thread_send",
    (threadId) => (tk) => tk.orchestrator.handle("t3_thread_send", { threadId, message: "Hi" }),
    (target) => `t3_thread_send:${target}`,
  ],
  [
    "t3_thread_interrupt",
    (threadId) => (tk) => tk.orchestrator.handle("t3_thread_interrupt", { threadId }),
    (target) => `t3_thread_interrupt:${target}`,
  ],
  [
    "t3_thread_send_attachments",
    (threadId) => (tk) =>
      tk.attachment.handle("t3_thread_send_attachments", {
        threadId,
        attachments: [ownedAttachment],
      }),
    (target) => `t3_thread_send_attachments:${target}`,
  ],
  [
    "t3_pending_request_respond",
    (threadId) => (tk) =>
      tk.thread.handle("t3_pending_request_respond", {
        threadId,
        requestId: pendingRequestId,
        answers: {},
      }),
    (target) => `runtime-request.respond:${target}`,
  ],
  [
    "t3_queue_edit",
    (threadId) => (tk) =>
      tk.thread.handle("t3_queue_edit", { threadId, queuedRunId, text: "Changed" }),
    (target) => `queued-run.edit:${target}`,
  ],
  [
    "t3_queue_cancel",
    (threadId) => (tk) => tk.thread.handle("t3_queue_cancel", { threadId, queuedRunId }),
    (target) => `queued-run.cancel:${target}`,
  ],
  [
    "t3_queue_reorder",
    (threadId) => (tk) =>
      tk.thread.handle("t3_queue_reorder", { threadId, queuedRunId, beforeRunId: null }),
    (target) => `queued-run.reorder:${target}`,
  ],
  [
    "t3_queue_promote_to_steer",
    (threadId) => (tk) =>
      tk.thread.handle("t3_queue_promote_to_steer", {
        threadId,
        queuedRunId,
        targetRunId: RunId.make("active-run"),
      }),
    (target) => `queued-message.promote-to-steer:${target}`,
  ],
  [
    "t3_thread_merge_back",
    (targetThreadId) => (tk) =>
      tk.thread.handle("t3_thread_merge_back", { targetThreadId, sourcePoint }),
    () => "thread.merge_back:",
  ],
  [
    "t3_thread_organize",
    (threadId) => (tk) => tk.thread.handle("t3_thread_organize", { threadId, action: "archive" }),
    (target) => `thread.archive:${target}`,
  ],
  [
    "update_scheduled_task on a task bound to the target",
    (target) => (tk) =>
      tk.orchestrator.handle("update_scheduled_task", {
        scheduledTaskId: boundTaskId(target),
        prompt: "Run Magi",
      }),
    (target) => `update_scheduled_task:${boundTaskId(target)}`,
  ],
  [
    "run_scheduled_task_now on a task bound to the target",
    (target) => (tk) => tk.thread.handle("run_scheduled_task_now", { taskId: boundTaskId(target) }),
    (target) => `run_scheduled_task_now:${boundTaskId(target)}`,
  ],
];

/** Tools that create a conversation outside any subagent lineage. */
const threadCreatingTools: ReadonlyArray<readonly [name: string, invoke: ToolInvocation]> = [
  [
    "create_threads",
    (tk) => tk.orchestrator.handle("create_threads", { threads: [{ prompt: "Run Magi" }] }),
  ],
  [
    "t3_thread_launch",
    (tk) => tk.project.handle("t3_thread_launch", { title: "Escape", message: "Run Magi" }),
  ],
  ["t3_thread_fork", (tk) => tk.thread.handle("t3_thread_fork", { sourcePoint })],
  [
    "schedule_task with a fresh thread per run",
    (tk) =>
      tk.orchestrator.handle("schedule_task", {
        prompt: "Run Magi",
        schedule: everyHour,
        bindToCurrentThread: false,
      }),
  ],
  [
    "update_scheduled_task to a fresh thread per run",
    (tk) =>
      tk.orchestrator.handle("update_scheduled_task", {
        scheduledTaskId: boundTaskId(ordinarySubagent),
        bindToCurrentThread: false,
      }),
  ],
  [
    "update_scheduled_task on an unbound task",
    (tk) =>
      tk.orchestrator.handle("update_scheduled_task", {
        scheduledTaskId: unboundTaskId,
        prompt: "Run Magi",
      }),
  ],
  [
    "run_scheduled_task_now on an unbound task",
    (tk) => tk.thread.handle("run_scheduled_task_now", { taskId: unboundTaskId }),
  ],
];

describe("Magi participant policy on MCP tools", () => {
  it.effect.each([participant, participantChild, participantGrandchild])(
    "denies thread creation and writes outside the subtree to %s",
    (caller) =>
      Effect.gen(function* () {
        for (const [name, invoke] of threadCreatingTools) {
          const result = yield* callTool(caller, invoke);
          expect(result, name).toEqual({ code: "capability_denied", calls: [] });
        }
        for (const [name, invoke] of targetedTools) {
          for (const target of [owner, participant, otherParticipant, ordinarySubagent]) {
            // Scheduled work bound to the caller itself stays in the caller's own conversation.
            if (target === caller && name.includes("scheduled_task")) continue;
            const result = yield* callTool(caller, invoke(target));
            expect(result, `${name} -> ${target}`).toEqual({
              code: "capability_denied",
              calls: [],
            });
          }
        }
      }),
  );

  it.effect.each([participant, participantChild])(
    "denies %s rebinding a task bound outside its subtree onto itself",
    (caller) =>
      Effect.gen(function* () {
        for (const boundTo of [owner, otherParticipant, ordinarySubagent]) {
          const result = yield* callTool(caller, (tk) =>
            tk.orchestrator.handle("update_scheduled_task", {
              scheduledTaskId: boundTaskId(boundTo),
              bindToCurrentThread: true,
              prompt: "Run Magi",
            }),
          );
          expect(result, `${caller} rebinding ${boundTo}`).toEqual({
            code: "capability_denied",
            calls: [],
          });
        }
      }),
  );

  it.effect.each([participant, participantChild, participantGrandchild])(
    "denies %s updating bound or unbound tasks in another project",
    (caller) =>
      Effect.gen(function* () {
        for (const scheduledTaskId of otherProjectTaskIds) {
          for (const bindToCurrentThread of [undefined, false]) {
            const result = yield* callTool(caller, (tk) =>
              tk.orchestrator.handle("update_scheduled_task", {
                scheduledTaskId,
                prompt: "Run elsewhere",
                enabled: true,
                ...(bindToCurrentThread === undefined ? {} : { bindToCurrentThread }),
              }),
            );
            expect(result, `${caller} updating ${scheduledTaskId}`).toEqual({
              code: "capability_denied",
              calls: [],
            });
          }
        }
      }),
  );

  it.effect.each([
    { caller: participant, descendant: participantChild },
    { caller: participantChild, descendant: participantGrandchild },
  ] as const)(
    "checks the replacement binding when $caller updates a descendant's task",
    ({ caller, descendant }) =>
      Effect.gen(function* () {
        for (const bindToCurrentThread of [true, false]) {
          const result = yield* callTool(caller, (tk) =>
            tk.orchestrator.handle("update_scheduled_task", {
              scheduledTaskId: boundTaskId(descendant),
              bindToCurrentThread,
            }),
          );
          expect(result).toEqual(
            bindToCurrentThread
              ? {
                  code: "orchestration_error",
                  calls: [`update_scheduled_task:${boundTaskId(descendant)}`],
                }
              : { code: "capability_denied", calls: [] },
          );
        }
      }),
  );

  it.effect("leaves an unknown scheduled task to the service's not-found handling", () =>
    Effect.gen(function* () {
      const missing = ScheduledTaskId.make("task:missing");
      const result = yield* callTool(participant, (tk) =>
        tk.orchestrator.handle("update_scheduled_task", {
          scheduledTaskId: missing,
          bindToCurrentThread: false,
        }),
      );
      expect(result.calls).toEqual([`update_scheduled_task:${missing}`]);
    }),
  );

  it.effect("lets a participant subtree act on its own delegated subagents", () =>
    Effect.gen(function* () {
      for (const [name, invoke, call] of targetedTools) {
        for (const [caller, target] of [
          [participant, participantChild],
          [participant, participantGrandchild],
          [participantChild, participantGrandchild],
        ] as const) {
          const result = yield* callTool(caller, invoke(target));
          expect(result.calls, `${name}: ${caller} -> ${target}`).toEqual([call(target)]);
          expect(result.code, `${name}: ${caller} -> ${target}`).not.toBe("capability_denied");
        }
      }
    }),
  );

  it.effect("lets a participant keep scheduled work in its own conversation", () =>
    Effect.gen(function* () {
      const scheduled = yield* callTool(participant, (tk) =>
        tk.orchestrator.handle("schedule_task", { prompt: "Check again", schedule: everyHour }),
      );
      expect(scheduled.calls).toEqual(["schedule_task:true"]);
      const updated = yield* callTool(participant, (tk) =>
        tk.orchestrator.handle("update_scheduled_task", {
          scheduledTaskId: boundTaskId(participant),
          enabled: false,
        }),
      );
      expect(updated.calls).toEqual([`update_scheduled_task:${boundTaskId(participant)}`]);
    }),
  );

  it.effect("denies a participant's default schedule in an explicitly different project", () =>
    Effect.gen(function* () {
      const result = yield* callTool(participant, (tk) =>
        tk.orchestrator.handle("schedule_task", {
          projectId: ProjectId.make("other-project"),
          prompt: "Check again",
          schedule: everyHour,
        }),
      );
      expect(result).toEqual({ code: "capability_denied", calls: [] });
    }),
  );

  it.effect("denies forking an explicitly selected descendant into a top-level thread", () =>
    Effect.gen(function* () {
      const result = yield* callTool(participant, (tk) =>
        tk.thread.handle("t3_thread_fork", {
          threadId: participantChild,
          sourcePoint: { type: "latest_stable" },
        }),
      );
      expect(result).toEqual({ code: "capability_denied", calls: [] });
    }),
  );

  it.effect("keeps delegation available to participants", () =>
    Effect.gen(function* () {
      const result = yield* callTool(participant, (tk) =>
        tk.orchestrator.handle("delegate_task", { task: "Investigate" }),
      );
      expect(result.calls).toEqual(["delegate_task"]);
    }),
  );

  it.effect.each([owner, ordinarySubagent, ordinaryGrandchild])(
    "leaves ordinary thread %s unrestricted",
    (caller) =>
      Effect.gen(function* () {
        for (const [name, invoke] of threadCreatingTools) {
          const result = yield* callTool(caller, invoke);
          expect(result.calls, name).toHaveLength(1);
          expect(result.code, name).not.toBe("capability_denied");
        }
        for (const [name, invoke, call] of targetedTools) {
          const result = yield* callTool(caller, invoke(participant));
          expect(result.calls, name).toEqual([call(participant)]);
          expect(result.code, name).not.toBe("capability_denied");
        }
      }),
  );
});

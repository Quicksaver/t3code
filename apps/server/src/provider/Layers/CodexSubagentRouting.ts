import * as NodeCrypto from "node:crypto";

import { ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import * as CodexRpc from "effect-codex-app-server/rpc";

export interface CodexSubagentRoutingInfo {
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: TurnId | undefined;
  readonly parentItemId: ProviderItemId | undefined;
  readonly providerThreadId: string;
  readonly childThreadId: ThreadId;
  readonly rawPrompt: string | undefined;
  readonly detail: string | undefined;
  readonly source: "collabAgentToolCall" | "subAgentActivity";
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

type CodexLifecycleNotification = Extract<
  CodexServerNotification,
  { readonly method: "item/started" | "item/completed" }
>;

type CodexLifecycleItem = CodexLifecycleNotification["params"]["item"];

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function deterministicSubagentThreadId(input: {
  readonly parentThreadId: ThreadId;
  readonly providerThreadId: string;
}): ThreadId {
  const hash = NodeCrypto.createHash("sha256")
    .update(`${input.parentThreadId}\0${input.providerThreadId}`)
    .digest("base64url")
    .slice(0, 32);
  return ThreadId.make(`subagent_${hash}`);
}

function collabToolCallDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "prompt" in item ? item.prompt : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
  ];
  for (const candidate of candidates) {
    const detail = trimText(candidate);
    if (detail) return detail;
  }
  return undefined;
}

function collabToolCallPrompt(item: CodexLifecycleItem): string | undefined {
  return trimText("prompt" in item ? item.prompt : undefined);
}

function isPromptBearingCollabToolCall(item: CodexLifecycleItem): boolean {
  if (!("tool" in item)) return false;
  return item.tool === "spawnAgent" || item.tool === "resumeAgent" || item.tool === "sendInput";
}

function normalizeAgentPath(value: string | undefined): string | undefined {
  const path = trimText(value)?.replace(/\/+$/, "");
  return path && path.length > 0 ? path : undefined;
}

function isDirectChildAgentPath(input: {
  readonly parentPath: string | undefined;
  readonly childPath: string | undefined;
}): boolean {
  const parentPath = normalizeAgentPath(input.parentPath) ?? "/root";
  const childPath = normalizeAgentPath(input.childPath);
  if (!childPath?.startsWith(`${parentPath}/`)) {
    return false;
  }
  return !childPath.slice(parentPath.length + 1).includes("/");
}

function rememberReceiver(input: {
  readonly routes: Map<string, CodexSubagentRoutingInfo>;
  readonly providerThreadId: string;
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: TurnId | undefined;
  readonly parentItemId: ProviderItemId;
  readonly startsNewParentActivity: boolean;
  readonly rawPrompt: string | undefined;
  readonly detail: string | undefined;
  readonly source: CodexSubagentRoutingInfo["source"];
}): void {
  const existing = input.routes.get(input.providerThreadId);
  input.routes.set(input.providerThreadId, {
    parentThreadId: input.parentThreadId,
    parentTurnId: input.startsNewParentActivity
      ? input.parentTurnId
      : (existing?.parentTurnId ?? input.parentTurnId),
    parentItemId: input.startsNewParentActivity
      ? input.parentItemId
      : (existing?.parentItemId ?? input.parentItemId),
    providerThreadId: input.providerThreadId,
    childThreadId:
      existing?.childThreadId ??
      deterministicSubagentThreadId({
        parentThreadId: input.parentThreadId,
        providerThreadId: input.providerThreadId,
      }),
    rawPrompt: input.startsNewParentActivity
      ? input.rawPrompt
      : (existing?.rawPrompt ?? input.rawPrompt),
    detail: input.startsNewParentActivity ? input.detail : (existing?.detail ?? input.detail),
    source: input.source,
  });
}

export function rememberCodexSubagentRoutes(
  routes: Map<string, CodexSubagentRoutingInfo>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
  parentThreadId: ThreadId,
): boolean {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return false;
  }

  const item = notification.params.item;
  const parentItemId = ProviderItemId.make(item.id);

  if (item.type === "subAgentActivity") {
    const currentRoute = routes.get(notification.params.threadId);
    const existingTargetRoute = routes.get(item.agentThreadId);
    if (
      !isDirectChildAgentPath({
        parentPath: currentRoute?.source === "subAgentActivity" ? currentRoute.detail : undefined,
        childPath: item.agentPath,
      }) ||
      (existingTargetRoute !== undefined && existingTargetRoute.parentThreadId !== parentThreadId)
    ) {
      return false;
    }

    rememberReceiver({
      routes,
      providerThreadId: item.agentThreadId,
      parentThreadId,
      parentTurnId,
      parentItemId,
      startsNewParentActivity: item.kind !== "interrupted",
      rawPrompt: undefined,
      detail: trimText(item.agentPath),
      source: "subAgentActivity",
    });
    return true;
  }

  if (item.type !== "collabAgentToolCall") return false;

  const rawPrompt = collabToolCallPrompt(item);
  const detail = collabToolCallDetail(item);
  const startsNewParentActivity =
    isPromptBearingCollabToolCall(item) && Boolean(rawPrompt || detail);
  for (const providerThreadId of item.receiverThreadIds) {
    rememberReceiver({
      routes,
      providerThreadId,
      parentThreadId,
      parentTurnId,
      parentItemId,
      startsNewParentActivity,
      rawPrompt,
      detail,
      source: "collabAgentToolCall",
    });
  }
  return true;
}

export function resolveCodexSubagentRoute(
  routes: Map<string, CodexSubagentRoutingInfo>,
  providerConversationId: string | undefined,
  currentProviderThreadId?: string | undefined,
): CodexSubagentRoutingInfo | undefined {
  if (!providerConversationId) return undefined;

  const direct = routes.get(providerConversationId);
  if (direct) return direct;

  if (
    currentProviderThreadId &&
    providerConversationId !== currentProviderThreadId &&
    routes.size === 1
  ) {
    const onlyRoute = routes.values().next().value;
    return onlyRoute?.source === "collabAgentToolCall" ? onlyRoute : undefined;
  }

  return undefined;
}

export function codexSubagentChildrenFromNotification(
  routes: Map<string, CodexSubagentRoutingInfo>,
  notification: CodexServerNotification,
  routeAccepted: boolean,
): ReadonlyArray<{
  readonly providerThreadId: string;
  readonly childThreadId: string;
  readonly parentItemId?: string | undefined;
  readonly rawPrompt?: string | undefined;
  readonly titleSeed?: string | undefined;
  readonly startsChildTurn?: boolean | undefined;
}> {
  if (!routeAccepted) return [];
  if (notification.method !== "item/started" && notification.method !== "item/completed") return [];

  const item = notification.params.item;
  const providerThreadIds =
    item.type === "collabAgentToolCall"
      ? item.receiverThreadIds
      : item.type === "subAgentActivity"
        ? [item.agentThreadId]
        : [];

  return providerThreadIds.flatMap((providerThreadId) => {
    const info = routes.get(providerThreadId);
    if (!info) return [];
    return [
      {
        providerThreadId,
        childThreadId: String(info.childThreadId),
        ...(info.parentItemId ? { parentItemId: String(info.parentItemId) } : {}),
        ...(info.rawPrompt ? { rawPrompt: info.rawPrompt } : {}),
        ...(info.detail ? { titleSeed: info.detail } : {}),
        ...(item.type === "subAgentActivity" ? { startsChildTurn: item.kind === "started" } : {}),
      },
    ];
  });
}

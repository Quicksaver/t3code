import {
  type EnvironmentId,
  type EnvironmentApi,
  isProviderDriverKind,
  type KeybindingCommand,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectedSubagentLifecycle } from "@t3tools/client-runtime/state/subagentRuntime";
import { type ChatMessage, type Thread, type ThreadShell } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

const TERMINAL_KEYBINDING_COMMANDS = new Set<KeybindingCommand>([
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
]);
type CloseTerminalSessionApi = {
  readonly terminal: Pick<EnvironmentApi["terminal"], "clear" | "write"> &
    Partial<Pick<EnvironmentApi["terminal"], "close">>;
};

export function isTerminalKeybindingCommand(command: KeybindingCommand): boolean {
  return TERMINAL_KEYBINDING_COMMANDS.has(command);
}

export function isTerminalUiAvailable(input: {
  readonly enableTerminal: boolean;
  readonly hasActiveProject: boolean;
}): boolean {
  return input.enableTerminal && input.hasActiveProject;
}

export function terminalThreadRefsToCloseWhenDisabled(input: {
  readonly enableTerminal: boolean;
  readonly openTerminalThreadKeys: readonly string[];
}): ScopedThreadRef[] {
  if (input.enableTerminal) {
    return [];
  }
  return input.openTerminalThreadKeys.map(parseScopedThreadKey).filter(isScopedThreadRef);
}

export function closeTerminalSession(input: {
  readonly api: CloseTerminalSessionApi;
  readonly threadId: ThreadId;
  readonly terminalId?: string;
  readonly isFinalTerminal?: boolean;
}): void {
  const fallbackExitWrite = () => {
    if (!input.terminalId) {
      return Promise.resolve();
    }
    return input.api.terminal
      .write({ threadId: input.threadId, terminalId: input.terminalId, data: "exit\n" })
      .catch(() => undefined);
  };
  const terminalClose = input.api.terminal.close;

  if (typeof terminalClose === "function") {
    void (async () => {
      if (input.terminalId && input.isFinalTerminal) {
        await input.api.terminal
          .clear({ threadId: input.threadId, terminalId: input.terminalId })
          .catch(() => undefined);
      }
      await terminalClose({
        threadId: input.threadId,
        ...(input.terminalId ? { terminalId: input.terminalId } : {}),
        deleteHistory: true,
      });
    })().catch(() => fallbackExitWrite());
  } else {
    void fallbackExitWrite();
  }
}

function isScopedThreadRef(threadRef: ScopedThreadRef | null): threadRef is ScopedThreadRef {
  return threadRef !== null;
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export interface AgentChildConversation {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

type ConversationVisibilityThreadShell = Pick<ThreadShell, "environmentId" | "parentRelation">;

/**
 * Child conversation detail is deliberately gated at the subscription
 * boundary. Shells stay available for agent progress, lineage, and archive
 * behavior even when standalone child conversations are disabled.
 */
export function canLoadStandaloneThreadConversation(input: {
  readonly threadShell: ConversationVisibilityThreadShell | null;
  readonly hasLocalDraft: boolean;
  readonly clientSettingsHydrated: boolean;
  readonly subagentConversationVisibilityEnabled: boolean;
}): boolean {
  if (input.hasLocalDraft) return true;
  if (!input.threadShell) return false;
  return (
    input.threadShell.parentRelation?.kind !== "magi" &&
    (input.threadShell.parentRelation?.kind !== "subagent" ||
      (input.clientSettingsHydrated && input.subagentConversationVisibilityEnabled))
  );
}

export function resolveDisabledSubagentParentThreadRef(input: {
  readonly threadShell: ConversationVisibilityThreadShell | null;
  readonly clientSettingsHydrated: boolean;
  readonly subagentConversationVisibilityEnabled: boolean;
}): ScopedThreadRef | null {
  const relation = input.threadShell?.parentRelation;
  if (
    !input.clientSettingsHydrated ||
    (input.subagentConversationVisibilityEnabled && relation?.kind === "subagent") ||
    (relation?.kind !== "subagent" && relation?.kind !== "magi") ||
    !input.threadShell
  ) {
    return null;
  }
  return scopeThreadRef(input.threadShell.environmentId, relation.parentThreadId);
}

type AgentConversationThreadShell = Pick<
  ThreadShell,
  "environmentId" | "id" | "title" | "parentRelation"
>;

export function deriveAgentChildConversationByProviderId(input: {
  activeThread: Pick<ThreadShell, "environmentId" | "id" | "parentRelation"> | null | undefined;
  threadShells: ReadonlyArray<AgentConversationThreadShell>;
  enabled?: boolean;
}): ReadonlyMap<string, AgentChildConversation> {
  const conversations = new Map<string, AgentChildConversation>();
  if (!input.activeThread || input.enabled === false) return conversations;

  const rootThreadId =
    input.activeThread.parentRelation?.kind === "subagent"
      ? input.activeThread.parentRelation.rootThreadId
      : input.activeThread.id;
  for (const shell of input.threadShells) {
    const relation = shell.parentRelation;
    if (
      shell.environmentId === input.activeThread.environmentId &&
      relation?.kind === "subagent" &&
      relation.rootThreadId === rootThreadId
    ) {
      conversations.set(relation.providerThreadId, {
        threadRef: scopeThreadRef(shell.environmentId, shell.id),
        title: shell.title,
      });
    }
  }
  return conversations;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
  };
}

/**
 * Child lifecycle stays available independently of the standalone-child UI
 * preference. The Agents panel needs it to settle parent activity rows even
 * when child conversation navigation is disabled.
 */
export function deriveAgentChildLifecycleByProviderId(input: {
  activeThread: Pick<ThreadShell, "environmentId" | "id" | "parentRelation"> | null | undefined;
  threadShells: ReadonlyArray<AgentConversationThreadShell>;
}): ReadonlyMap<string, ProjectedSubagentLifecycle> {
  const lifecycles = new Map<string, ProjectedSubagentLifecycle>();
  if (!input.activeThread) return lifecycles;

  const rootThreadId =
    input.activeThread.parentRelation?.kind === "subagent"
      ? input.activeThread.parentRelation.rootThreadId
      : input.activeThread.id;
  for (const shell of input.threadShells) {
    const relation = shell.parentRelation;
    if (
      shell.environmentId === input.activeThread.environmentId &&
      relation?.kind === "subagent" &&
      relation.rootThreadId === rootThreadId
    ) {
      lifecycles.set(relation.providerThreadId, {
        status: relation.status,
        completedAt: relation.completedAt,
      });
    }
  }
  return lifecycles;
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

export function clearThreadErrorRecord(
  existing: Record<string, string | null>,
  threadKey: string,
): Record<string, string | null> {
  if ((existing[threadKey] ?? null) === null) {
    return existing;
  }
  return {
    ...existing,
    [threadKey]: null,
  };
}

export function retainThreadKeyRecord<T>(
  existing: Record<string, T>,
  retainedThreadKeys: ReadonlySet<string>,
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [threadKey, value] of Object.entries(existing)) {
    if (retainedThreadKeys.has(threadKey)) {
      next[threadKey] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : existing;
}

export function isLatestRequestSequence(input: {
  readonly currentSequence: number | undefined;
  readonly requestSequence: number;
}): boolean {
  return input.currentSequence === input.requestSequence;
}

export const shouldApplySourceControlMetadataUpdateResult = isLatestRequestSequence;

export function buildThreadTurnInterruptInput(
  thread: Pick<Thread, "id" | "latestTurn" | "parentRelation" | "session">,
): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const parentRelation = thread.parentRelation;
  if (parentRelation?.kind === "subagent") {
    if (parentRelation.status === "running" && thread.latestTurn?.state === "running") {
      return { threadId: thread.id, turnId: thread.latestTurn.turnId };
    }
    return { threadId: thread.id };
  }

  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThreadStarted: boolean;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  return input.serverThreadStarted ? input.serverThreadRef : null;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// Thread and composer values are instance routing keys, while session provider
// names are driver kinds. Resolve both through the streamed instance registry
// so custom instances lock to their implementing driver on every client.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}
export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

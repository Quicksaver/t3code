import type { UpdateThreadMetadataInput } from "@t3tools/client-runtime/operations";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type ProjectScript,
  type ServerSettings,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerThreadTarget, DraftId } from "../composerDraftStore";
import {
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import type { SourceControlEnvironmentCandidate } from "./source-control/SourceControlPanel.logic";

type UpdateThreadMetadata = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: UpdateThreadMetadataInput;
}) => Promise<AtomCommandResult<unknown, unknown>>;

type SetDraftThreadContext = (
  target: ComposerThreadTarget,
  context: {
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
  },
) => void;

interface SourceControlThreadRefChange {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

interface UseSourceControlThreadMetadataRoutingInput {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadKey: string | null;
  readonly draftId: DraftId | null;
  readonly existingThreadKeys: ReadonlySet<string>;
  readonly isServerThread: boolean;
  readonly setDraftThreadContext: SetDraftThreadContext;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

interface SourceControlThreadMetadataRouting {
  readonly sourceControlMetadataError: string | null;
  readonly clearActiveSourceControlMetadataError: () => void;
  readonly handleSourceControlThreadRefChange: (
    input: SourceControlThreadRefChange,
  ) => Promise<void>;
}

interface UseSourceControlRightPanelSurfaceInput {
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly panelSupported: boolean;
  readonly rightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlRightPanelSurfaceState {
  readonly addSourceControlSurface: () => void;
  readonly sourceControlAvailable: boolean;
  readonly visibleActiveRightPanelSurface: RightPanelSurface | null;
  readonly visibleRightPanelSurfaces: readonly RightPanelSurface[];
}

interface SourceControlPanelTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ScopedThreadRef["threadId"];
  readonly cwd: string;
}

export type SourceControlEnvironmentOption = EnvironmentOption &
  Omit<SourceControlEnvironmentCandidate, "project"> & {
    readonly project: NonNullable<SourceControlEnvironmentCandidate["project"]>;
  };

/** Build the patch from the destination server, including when its project id is also used locally. */
export function buildSourceControlProjectScriptPatch(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly scripts: readonly ProjectScript[];
  readonly environments: ReadonlyMap<
    string,
    {
      readonly serverConfig: {
        readonly environment: {
          readonly capabilities: { readonly projectSettingsOverrides?: boolean };
        };
        readonly settings: Pick<ServerSettings, "projectSettingsOverrides">;
      } | null;
    }
  >;
}) {
  const config = input.environments.get(input.environmentId)?.serverConfig;
  return config?.environment.capabilities.projectSettingsOverrides === true
    ? {
        projectSettingsOverrides: {
          [input.projectId]: {
            ...config.settings.projectSettingsOverrides[input.projectId],
            defaultProjectScripts: input.scripts,
          },
        },
      }
    : { projectScriptOverrides: { [input.projectId]: input.scripts } };
}

export function buildSourceControlEnvironmentOption(input: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: readonly ProjectScript[];
  };
  readonly label: string;
  readonly isPrimary: boolean;
  readonly machine: EnvironmentMachineKind;
  readonly connected: boolean;
  readonly preferredScriptId: string | null;
}): SourceControlEnvironmentOption {
  return {
    environmentId: input.project.environmentId,
    projectId: input.project.id,
    label: input.label,
    isPrimary: input.isPrimary,
    machine: input.machine,
    cwd: input.project.workspaceRoot,
    connected: input.connected,
    project: {
      id: input.project.id,
      workspaceRoot: input.project.workspaceRoot,
      scripts: input.project.scripts,
      preferredScriptId: input.preferredScriptId,
    },
  };
}

interface SourceControlServerMetadataUpdateInput {
  readonly activeThreadRef: ScopedThreadRef;
  readonly metadata: SourceControlThreadRefChange;
  readonly requestSequence: number;
  readonly getCurrentSequence: () => number | undefined;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

interface QueuedSourceControlServerMetadataUpdateInput {
  readonly activeThreadRef: ScopedThreadRef;
  readonly metadata: SourceControlThreadRefChange;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

type SourceControlServerMetadataUpdateResult =
  | {
      readonly _tag: "Success";
    }
  | {
      readonly _tag: "Stale";
    }
  | {
      readonly _tag: "Interrupted";
    }
  | {
      readonly _tag: "Failure";
      readonly message: string;
    };

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

export type ThreadErrorSource = "draft" | "local-server" | "source-control" | "session";

/**
 * A local server error usually mirrors the session's `lastError`, so clearing it also masks the
 * banner; otherwise the same text resurfaces from the session and dismissal takes two clicks.
 */
export function resolveThreadErrorDismissAction(
  source: ThreadErrorSource | null,
): "clear-thread" | "clear-thread-and-mask" | "clear-source-control" | "mask-only" {
  if (source === "draft") return "clear-thread";
  if (source === "local-server") return "clear-thread-and-mask";
  if (source === "source-control") return "clear-source-control";
  return "mask-only";
}

export function resolveThreadErrorPresentation(input: {
  readonly isServerThread: boolean;
  readonly localDraftError: string | null;
  readonly localServerError: string | null;
  readonly sessionError: string | null;
  readonly sourceControlMetadataError: string | null;
}): { readonly error: string | null; readonly source: ThreadErrorSource | null } {
  if (!input.isServerThread) {
    return input.localDraftError === null
      ? { error: null, source: null }
      : { error: input.localDraftError, source: "draft" };
  }
  if (input.localServerError !== null) {
    return { error: input.localServerError, source: "local-server" };
  }
  if (input.sourceControlMetadataError !== null) {
    return { error: input.sourceControlMetadataError, source: "source-control" };
  }
  return input.sessionError === null
    ? { error: null, source: null }
    : { error: input.sessionError, source: "session" };
}

export function sourceControlMetadataErrorFromFailure(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = "message" in error ? error.message : null;
    const code = "code" in error ? error.code : null;
    if (typeof message === "string" && message.length > 0) {
      return typeof code === "string" && code.length > 0 ? `${message} (${code})` : message;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      return "Failed to update thread source control.";
    }
  }
  return "Failed to update thread source control.";
}

/** `panelSupported` is the thread environment's `sourceControlPanel` capability. */
export function isSourceControlAvailable(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly panelSupported: boolean;
}): boolean {
  return (
    input.activeThreadRef !== null &&
    input.gitCwd !== null &&
    input.isGitRepo &&
    input.panelSupported
  );
}

export function normalizeSourceControlRightPanelPresence(input: {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurface: RightPanelSurface | null;
  readonly sourceControlAvailable: boolean;
}): {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurface: RightPanelSurface | null;
} {
  const surfaces = input.sourceControlAvailable
    ? input.surfaces
    : input.surfaces.filter((surface) => surface.kind !== "source-control");
  const activeSurface =
    input.activeSurface?.kind === "source-control" && !input.sourceControlAvailable
      ? (surfaces[0] ?? null)
      : input.activeSurface;
  return { activeSurface, surfaces };
}

export function resolveSourceControlPanelTarget(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly surface: RightPanelSurface | null;
}): SourceControlPanelTarget | null {
  if (input.surface?.kind !== "source-control" || !input.activeThreadRef || !input.gitCwd) {
    return null;
  }
  return {
    environmentId: input.activeThreadRef.environmentId,
    threadId: input.activeThreadRef.threadId,
    cwd: input.gitCwd,
  };
}

export function retargetOpenSourceControlSurface(input: {
  readonly currentThreadRef: ScopedThreadRef;
  readonly nextThreadRef: ScopedThreadRef;
}): void {
  if (scopedThreadKey(input.currentThreadRef) === scopedThreadKey(input.nextThreadRef)) return;
  const store = useRightPanelStore.getState();
  const activeSurface = selectActiveRightPanelSurface(store.byThreadKey, input.currentThreadRef);
  if (activeSurface?.kind !== "source-control") return;
  store.open(input.nextThreadRef, "source-control");
}

export async function runSourceControlServerMetadataUpdate(
  input: SourceControlServerMetadataUpdateInput,
): Promise<SourceControlServerMetadataUpdateResult> {
  const { activeThreadRef, getCurrentSequence, metadata, requestSequence, updateThreadMetadata } =
    input;
  let result: AtomCommandResult<unknown, unknown>;
  try {
    result = await updateThreadMetadata({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadRef.threadId,
        branch: metadata.branch,
        worktreePath: metadata.worktreePath,
      },
    });
  } catch (error) {
    if (getCurrentSequence() !== requestSequence) {
      return { _tag: "Stale" };
    }
    return {
      _tag: "Failure",
      message: sourceControlMetadataErrorFromFailure(error),
    };
  }

  if (getCurrentSequence() !== requestSequence) {
    return { _tag: "Stale" };
  }
  if (result._tag === "Success") {
    return { _tag: "Success" };
  }
  if (isAtomCommandInterrupted(result)) {
    return { _tag: "Interrupted" };
  }
  return {
    _tag: "Failure",
    message: sourceControlMetadataErrorFromFailure(squashAtomCommandFailure(result)),
  };
}

/**
 * Serializes metadata writes per thread. Only the newest request enqueued for a
 * thread applies: superseded requests skip their write and resolve as stale.
 */
export function createSourceControlServerMetadataUpdateQueue() {
  const pendingByThreadKey = new Map<string, Promise<void>>();
  const sequenceByThreadKey = new Map<string, number>();

  return {
    enqueue(
      input: QueuedSourceControlServerMetadataUpdateInput,
    ): Promise<SourceControlServerMetadataUpdateResult> {
      const targetThreadKey = scopedThreadKey(input.activeThreadRef);
      const requestSequence = (sequenceByThreadKey.get(targetThreadKey) ?? 0) + 1;
      sequenceByThreadKey.set(targetThreadKey, requestSequence);
      const getCurrentSequence = () => sequenceByThreadKey.get(targetThreadKey);
      const previous = pendingByThreadKey.get(targetThreadKey) ?? Promise.resolve();
      const result = previous.then((): Promise<SourceControlServerMetadataUpdateResult> =>
        getCurrentSequence() === requestSequence
          ? runSourceControlServerMetadataUpdate({
              activeThreadRef: input.activeThreadRef,
              getCurrentSequence,
              metadata: input.metadata,
              requestSequence,
              updateThreadMetadata: input.updateThreadMetadata,
            })
          : Promise.resolve({ _tag: "Stale" }),
      );
      const pending = result.then(
        () => undefined,
        () => undefined,
      );
      pendingByThreadKey.set(targetThreadKey, pending);
      void pending.finally(() => {
        if (pendingByThreadKey.get(targetThreadKey) === pending) {
          pendingByThreadKey.delete(targetThreadKey);
        }
      });
      return result;
    },
  };
}

export function useSourceControlRightPanelSurfaceState(
  input: UseSourceControlRightPanelSurfaceInput,
): SourceControlRightPanelSurfaceState {
  const {
    activeRightPanelSurface,
    activeThreadRef,
    gitCwd,
    isGitRepo,
    panelSupported,
    rightPanelSurfaces,
  } = input;
  const sourceControlAvailable = isSourceControlAvailable({
    activeThreadRef,
    gitCwd,
    isGitRepo,
    panelSupported,
  });
  const visiblePresence = useMemo(
    () =>
      normalizeSourceControlRightPanelPresence({
        activeSurface: activeRightPanelSurface,
        sourceControlAvailable,
        surfaces: rightPanelSurfaces,
      }),
    [activeRightPanelSurface, rightPanelSurfaces, sourceControlAvailable],
  );
  const addSourceControlSurface = useCallback(() => {
    if (!activeThreadRef || !sourceControlAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "source-control");
  }, [activeThreadRef, sourceControlAvailable]);

  return {
    addSourceControlSurface,
    sourceControlAvailable,
    visibleActiveRightPanelSurface: visiblePresence.activeSurface,
    visibleRightPanelSurfaces: visiblePresence.surfaces,
  };
}

export function useSourceControlThreadMetadataRouting(
  input: UseSourceControlThreadMetadataRoutingInput,
): SourceControlThreadMetadataRouting {
  const {
    activeThreadKey,
    activeThreadRef,
    draftId,
    existingThreadKeys,
    isServerThread,
    setDraftThreadContext,
    updateThreadMetadata,
  } = input;
  const metadataUpdateQueueRef = useRef<ReturnType<
    typeof createSourceControlServerMetadataUpdateQueue
  > | null>(null);
  const metadataUpdateQueue =
    metadataUpdateQueueRef.current ?? createSourceControlServerMetadataUpdateQueue();
  metadataUpdateQueueRef.current = metadataUpdateQueue;
  const [metadataErrorsByThreadKey, setMetadataErrorsByThreadKey] = useState<
    Record<string, string | null>
  >({});
  const sourceControlMetadataError =
    activeThreadKey === null ? null : (metadataErrorsByThreadKey[activeThreadKey] ?? null);

  useEffect(() => {
    setMetadataErrorsByThreadKey((existing) => retainThreadKeyRecord(existing, existingThreadKeys));
  }, [existingThreadKeys]);

  const clearActiveSourceControlMetadataError = useCallback(() => {
    // Draft metadata changes are local store updates and do not create dismissible metadata errors.
    if (!isServerThread || activeThreadKey === null) return;
    setMetadataErrorsByThreadKey((existing) => clearThreadErrorRecord(existing, activeThreadKey));
  }, [activeThreadKey, isServerThread]);

  const handleSourceControlThreadRefChange = useCallback(
    async (metadata: SourceControlThreadRefChange) => {
      if (!isServerThread) {
        const target = draftId ?? activeThreadRef;
        if (!target) return;
        setDraftThreadContext(target, {
          branch: metadata.branch,
          worktreePath: metadata.worktreePath,
        });
        return;
      }

      if (!activeThreadRef) return;
      const targetThreadKey = scopedThreadKey(activeThreadRef);
      const result = await metadataUpdateQueue.enqueue({
        activeThreadRef,
        metadata,
        updateThreadMetadata,
      });
      if (result._tag === "Success") {
        setMetadataErrorsByThreadKey((existing) =>
          clearThreadErrorRecord(existing, targetThreadKey),
        );
        return;
      }
      if (result._tag === "Stale" || result._tag === "Interrupted") return;
      setMetadataErrorsByThreadKey((existing) => ({
        ...existing,
        [targetThreadKey]: result.message,
      }));
    },
    [
      activeThreadRef,
      draftId,
      isServerThread,
      metadataUpdateQueue,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  return {
    clearActiveSourceControlMetadataError,
    handleSourceControlThreadRefChange,
    sourceControlMetadataError,
  };
}

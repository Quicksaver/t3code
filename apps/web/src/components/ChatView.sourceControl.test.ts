import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import {
  fileSurfaceId,
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  buildSourceControlProjectScriptPatch,
  clearThreadErrorRecord,
  createSourceControlServerMetadataUpdateQueue,
  isSourceControlAvailable,
  normalizeSourceControlRightPanelPresence,
  resolveSourceControlPanelTarget,
  resolveThreadErrorDismissAction,
  resolveThreadErrorPresentation,
  retainThreadKeyRecord,
  retargetOpenSourceControlSurface,
  runSourceControlServerMetadataUpdate,
  sourceControlMetadataErrorFromFailure,
} from "./ChatView.sourceControl";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const activeThreadRef = { environmentId, threadId };
const metadata = {
  branch: "feature/source-control",
  worktreePath: "/tmp/source-control",
};

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("sourceControlMetadataErrorFromFailure", () => {
  it("formats structured object errors without collapsing to object text", () => {
    expect(
      sourceControlMetadataErrorFromFailure({
        code: "ECONNRESET",
        message: "metadata update failed",
      }),
    ).toBe("metadata update failed (ECONNRESET)");
    expect(sourceControlMetadataErrorFromFailure({ detail: "raw provider failure" })).toBe(
      '{"detail":"raw provider failure"}',
    );
  });
});

describe("resolveThreadErrorPresentation", () => {
  it("keeps lower-priority failures available when every source has the same message", () => {
    const repeatedMessage = "transport failed";
    const input = {
      isServerThread: true,
      localDraftError: null,
      localServerError: repeatedMessage,
      sessionError: repeatedMessage,
      sourceControlMetadataError: repeatedMessage,
    } as const;

    expect(resolveThreadErrorPresentation(input)).toEqual({
      error: repeatedMessage,
      source: "local-server",
    });
    expect(resolveThreadErrorPresentation({ ...input, localServerError: null })).toEqual({
      error: repeatedMessage,
      source: "source-control",
    });
    expect(
      resolveThreadErrorPresentation({
        ...input,
        localServerError: null,
        sourceControlMetadataError: null,
      }),
    ).toEqual({ error: repeatedMessage, source: "session" });
  });

  it("keeps draft errors independent from server-only error sources", () => {
    expect(
      resolveThreadErrorPresentation({
        isServerThread: false,
        localDraftError: "draft failed",
        localServerError: "ignored server error",
        sessionError: "ignored session error",
        sourceControlMetadataError: "ignored metadata error",
      }),
    ).toEqual({ error: "draft failed", source: "draft" });
  });

  it("dismisses only the error source currently presented", () => {
    expect(resolveThreadErrorDismissAction("draft")).toBe("clear-thread");
    expect(resolveThreadErrorDismissAction("local-server")).toBe("clear-thread-and-mask");
    expect(resolveThreadErrorDismissAction("source-control")).toBe("clear-source-control");
    expect(resolveThreadErrorDismissAction("session")).toBe("mask-only");
    expect(resolveThreadErrorDismissAction(null)).toBe("mask-only");
  });
});

describe("source control right panel surface visibility", () => {
  const sourceControlSurface = { id: "source-control", kind: "source-control" } as const;
  const pullRequestSurface = {
    id: "pull-request:project-a:pingdotgg%2Ft3code:6392",
    kind: "pull-request",
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 6392,
  } as const;
  const filesSurface = { id: "files", kind: "files" } as const;
  const assertActiveSourceControlSurface = (
    phase: string,
    expectedSurfaces: readonly RightPanelSurface[],
  ) => {
    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    const panelState = selectThreadRightPanelState(byThreadKey, activeThreadRef);
    const activeSurface = selectActiveRightPanelSurface(byThreadKey, activeThreadRef);
    const visiblePresence = normalizeSourceControlRightPanelPresence({
      activeSurface,
      sourceControlAvailable: true,
      surfaces: panelState.surfaces,
    });

    expect(panelState.isOpen, `${phase}: panel is open`).toBe(true);
    expect(panelState.activeSurfaceId, `${phase}: Source Control is active`).toBe("source-control");
    expect(panelState.surfaces, `${phase}: surface list`).toEqual(expectedSurfaces);
    expect(visiblePresence.surfaces, `${phase}: Source Control is visible`).toContainEqual(
      sourceControlSurface,
    );
    expect(visiblePresence.activeSurface, `${phase}: visible active surface`).toEqual(
      sourceControlSurface,
    );
  };

  it("requires a thread ref, a Git cwd, and a server with the panel before making Source Control available", () => {
    const available = {
      activeThreadRef,
      gitCwd: "/repo",
      isGitRepo: true,
      panelSupported: true,
    } as const;
    expect(isSourceControlAvailable(available)).toBe(true);
    expect(isSourceControlAvailable({ ...available, activeThreadRef: null })).toBe(false);
    expect(isSourceControlAvailable({ ...available, gitCwd: null })).toBe(false);
    expect(isSourceControlAvailable({ ...available, isGitRepo: false })).toBe(false);
    // Older servers lack the capability and reject every vcs.panel.* request.
    expect(isSourceControlAvailable({ ...available, panelSupported: false })).toBe(false);
  });

  it("hides unavailable Source Control surfaces without affecting other surfaces", () => {
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: filesSurface,
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, filesSurface],
      }),
    ).toEqual({ activeSurface: filesSurface, surfaces: [filesSurface] });

    const surfaces = [sourceControlSurface, filesSurface];
    const normalized = normalizeSourceControlRightPanelPresence({
      activeSurface: sourceControlSurface,
      sourceControlAvailable: true,
      surfaces,
    });
    expect(normalized.surfaces).toBe(surfaces);
    expect(normalized.activeSurface).toBe(sourceControlSurface);
  });

  it("keeps pull-request tabs visible when Source Control becomes unavailable", () => {
    const visiblePresence = normalizeSourceControlRightPanelPresence({
      activeSurface: sourceControlSurface,
      sourceControlAvailable: false,
      surfaces: [sourceControlSurface, pullRequestSurface, filesSurface],
    });

    expect(visiblePresence).toEqual({
      activeSurface: pullRequestSurface,
      surfaces: [pullRequestSurface, filesSurface],
    });
  });

  it("falls back from an unavailable active Source Control surface to another visible surface", () => {
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: sourceControlSurface,
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, filesSurface],
      }),
    ).toEqual({ activeSurface: filesSurface, surfaces: [filesSurface] });
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: filesSurface,
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, filesSurface],
      }),
    ).toEqual({ activeSurface: filesSurface, surfaces: [filesSurface] });
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: sourceControlSurface,
        sourceControlAvailable: true,
        surfaces: [sourceControlSurface, filesSurface],
      }),
    ).toEqual({
      activeSurface: sourceControlSurface,
      surfaces: [sourceControlSurface, filesSurface],
    });
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: sourceControlSurface,
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface],
      }),
    ).toEqual({ activeSurface: null, surfaces: [] });

    const siblingFileSurface = {
      id: fileSurfaceId("src/index.ts", "/repo/sibling"),
      kind: "file",
      cwd: "/repo/sibling",
      relativePath: "src/index.ts",
      revealLine: 12,
      revealRequestId: 3,
    } as const;
    expect(
      normalizeSourceControlRightPanelPresence({
        activeSurface: sourceControlSurface,
        sourceControlAvailable: false,
        surfaces: [sourceControlSurface, siblingFileSurface],
      }),
    ).toEqual({ activeSurface: siblingFileSurface, surfaces: [siblingFileSurface] });
  });

  it("retargets an open singleton surface across grouped project drafts without leaking errors", () => {
    const sharedDraftThreadId = ThreadId.make("grouped-draft");
    const groupedProjectARef = scopeThreadRef(
      EnvironmentId.make("environment-project-a"),
      sharedDraftThreadId,
    );
    const groupedProjectBRef = scopeThreadRef(
      EnvironmentId.make("environment-project-b"),
      sharedDraftThreadId,
    );
    const groupedProjectACwd = "/repos/grouped-project-a";
    const groupedProjectBCwd = "/repos/grouped-project-b";

    useRightPanelStore.getState().open(groupedProjectARef, "source-control");

    const initialByThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectActiveRightPanelSurface(initialByThreadKey, groupedProjectBRef)).toBeNull();

    retargetOpenSourceControlSurface({
      currentThreadRef: groupedProjectARef,
      nextThreadRef: groupedProjectBRef,
    });

    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(byThreadKey, groupedProjectARef).surfaces).toEqual([
      sourceControlSurface,
    ]);
    expect(selectThreadRightPanelState(byThreadKey, groupedProjectBRef).surfaces).toEqual([
      sourceControlSurface,
    ]);
    const projectASurface = selectActiveRightPanelSurface(byThreadKey, groupedProjectARef);
    const projectBSurface = selectActiveRightPanelSurface(byThreadKey, groupedProjectBRef);
    expect(
      resolveSourceControlPanelTarget({
        activeThreadRef: groupedProjectARef,
        gitCwd: groupedProjectACwd,
        surface: projectASurface,
      }),
    ).toEqual({
      environmentId: groupedProjectARef.environmentId,
      threadId: groupedProjectARef.threadId,
      cwd: groupedProjectACwd,
    });
    expect(
      resolveSourceControlPanelTarget({
        activeThreadRef: groupedProjectBRef,
        gitCwd: groupedProjectBCwd,
        surface: projectBSurface,
      }),
    ).toEqual({
      environmentId: groupedProjectBRef.environmentId,
      threadId: groupedProjectBRef.threadId,
      cwd: groupedProjectBCwd,
    });

    const projectAThreadKey = scopedThreadKey(groupedProjectARef);
    const projectBThreadKey = scopedThreadKey(groupedProjectBRef);
    const metadataErrors = {
      [projectAThreadKey]: "stale project A metadata failure",
    };

    expect(retainThreadKeyRecord(metadataErrors, new Set([projectBThreadKey]))).toEqual({});
  });

  it("does not update the store when retargeting to the same scoped thread", () => {
    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    const initialByThreadKey = useRightPanelStore.getState().byThreadKey;

    retargetOpenSourceControlSurface({
      currentThreadRef: activeThreadRef,
      nextThreadRef: activeThreadRef,
    });

    expect(useRightPanelStore.getState().byThreadKey).toBe(initialByThreadKey);
  });

  it("keeps Source Control stable while preview stores change independently", () => {
    const previewTabId = "background-preview";
    const previewSurface = {
      id: `browser:${previewTabId}`,
      kind: "preview",
      resourceId: previewTabId,
    } as const;

    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    assertActiveSourceControlSurface("after opening Source Control", [sourceControlSurface]);

    usePreviewMiniPlayerStore
      .getState()
      .open(activeThreadRef, { kind: "browser", tabId: previewTabId });
    assertActiveSourceControlSurface("after opening the mini-player", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toMatchObject({ source: { kind: "browser", tabId: previewTabId } });

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, [previewTabId]);
    assertActiveSourceControlSurface("after adding the browser surface", [
      sourceControlSurface,
      previewSurface,
    ]);

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, []);
    assertActiveSourceControlSurface("after removing the browser surface", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toMatchObject({ source: { kind: "browser", tabId: previewTabId } });

    usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    assertActiveSourceControlSurface("after closing the mini-player", [sourceControlSurface]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toBeNull();
  });

  it("keeps Source Control stable when the mini-player closes before browser reconciliation", () => {
    const previewTabId = "background-preview";
    const previewSurface = {
      id: `browser:${previewTabId}`,
      kind: "preview",
      resourceId: previewTabId,
    } as const;

    useRightPanelStore.getState().open(activeThreadRef, "source-control");
    usePreviewMiniPlayerStore
      .getState()
      .open(activeThreadRef, { kind: "browser", tabId: previewTabId });
    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, [previewTabId]);

    usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    assertActiveSourceControlSurface("after closing the mini-player first", [
      sourceControlSurface,
      previewSurface,
    ]);
    expect(
      selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        activeThreadRef,
      ),
    ).toBeNull();

    useRightPanelStore.getState().reconcileBrowserSurfaces(activeThreadRef, []);
    assertActiveSourceControlSurface("after reconciling the browser surface", [
      sourceControlSurface,
    ]);
  });
});

describe("runSourceControlServerMetadataUpdate", () => {
  it("sends server-thread metadata and reports success", async () => {
    const calls: unknown[] = [];
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async (input) => {
        calls.push(input);
        return AsyncResult.success(undefined);
      },
    });

    expect(result).toEqual({ _tag: "Success" });
    expect(calls).toEqual([
      {
        environmentId,
        input: {
          threadId,
          branch: metadata.branch,
          worktreePath: metadata.worktreePath,
        },
      },
    ]);
  });

  it("drops stale results after a newer server-thread metadata request", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      getCurrentSequence: () => 2,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => AsyncResult.failure(Cause.fail("old failure")),
    });

    expect(result).toEqual({ _tag: "Stale" });
  });

  it("serializes a thread's writes and skips requests a newer one supersedes", async () => {
    const queue = createSourceControlServerMetadataUpdateQueue();
    const branches: Array<string | null> = [];
    let releaseFirst = () => {};
    const updateThreadMetadata = async (
      input: Parameters<Parameters<typeof queue.enqueue>[0]["updateThreadMetadata"]>[0],
    ) => {
      branches.push(input.input.branch ?? null);
      if (branches.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return AsyncResult.success(undefined);
    };
    const enqueue = (branch: string) =>
      queue.enqueue({
        activeThreadRef,
        metadata: { branch, worktreePath: null },
        updateThreadMetadata,
      });

    const first = enqueue("feature/one");
    await Promise.resolve();
    expect(branches).toEqual(["feature/one"]);

    const second = enqueue("feature/two");
    const third = enqueue("feature/three");
    releaseFirst();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { _tag: "Stale" },
      { _tag: "Stale" },
      { _tag: "Success" },
    ]);
    expect(branches).toEqual(["feature/one", "feature/three"]);
  });

  it("drops stale thrown errors after a newer server-thread metadata request", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      getCurrentSequence: () => 2,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => {
        throw { code: "NETWORK", message: "old network failure" };
      },
    });

    expect(result).toEqual({ _tag: "Stale" });
  });

  it("converts thrown update errors into controlled metadata failures", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => {
        throw { code: "NETWORK", message: "network failed" };
      },
    });

    expect(result).toEqual({
      _tag: "Failure",
      message: "network failed (NETWORK)",
    });
  });

  it("keeps interrupted command results silent", async () => {
    const result = await runSourceControlServerMetadataUpdate({
      activeThreadRef,
      getCurrentSequence: () => 1,
      metadata,
      requestSequence: 1,
      updateThreadMetadata: async () => AsyncResult.failure(Cause.interrupt(1)),
    });

    expect(result).toEqual({ _tag: "Interrupted" });
  });
});

describe("clearThreadErrorRecord", () => {
  it("clears only the selected thread error", () => {
    expect(
      clearThreadErrorRecord(
        {
          "environment-local:thread-1": "metadata failed",
          "environment-local:thread-2": "send failed",
        },
        "environment-local:thread-1",
      ),
    ).toEqual({
      "environment-local:thread-1": null,
      "environment-local:thread-2": "send failed",
    });
  });

  it("keeps the same object when the selected thread has no error", () => {
    const existing = {
      "environment-local:thread-1": null,
      "environment-local:thread-2": "send failed",
    };

    expect(clearThreadErrorRecord(existing, "environment-local:thread-1")).toBe(existing);
    expect(clearThreadErrorRecord(existing, "environment-local:thread-3")).toBe(existing);
  });
});

describe("retainThreadKeyRecord", () => {
  it("drops stale thread keys", () => {
    expect(
      retainThreadKeyRecord(
        {
          "environment-local:thread-1": "send failed",
          "environment-local:thread-2": null,
        },
        new Set(["environment-local:thread-1"]),
      ),
    ).toEqual({
      "environment-local:thread-1": "send failed",
    });
  });

  it("preserves reference identity when no keys are pruned", () => {
    const existing = {
      "environment-local:thread-1": "send failed",
    };

    expect(retainThreadKeyRecord(existing, new Set(["environment-local:thread-1"]))).toBe(existing);
  });
});

describe("federated source control project scripts", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const projectId = ProjectId.make("shared-id");
  const script = {
    id: "test",
    name: "Test",
    command: "vp test",
    icon: "play" as const,
    runOnWorktreeCreate: false,
  };
  const scripts = [script];
  it.each([new Map(), new Map([[remote, { serverConfig: null }]])])(
    "uses the legacy script patch before destination configuration is available",
    (environments) => {
      expect(
        buildSourceControlProjectScriptPatch({
          environmentId: remote,
          projectId,
          scripts,
          environments,
        }),
      ).toEqual({ projectScriptOverrides: { [projectId]: scripts } });
    },
  );
  const config = (modern: boolean, customInstructions: string) => ({
    serverConfig: {
      environment: { capabilities: { projectSettingsOverrides: modern } },
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWritingStyle: {
              mode: "custom" as const,
              customInstructions,
              followChangeRequestTemplates: true,
            },
          },
        },
      },
    },
  });

  it("preserves destination overrides when both environments use the same project id", () => {
    const target = config(true, "Remote instructions");
    const environments = new Map([
      [local, config(false, "Local instructions")],
      [remote, target],
    ]);
    expect(
      buildSourceControlProjectScriptPatch({
        environmentId: remote,
        projectId,
        scripts,
        environments,
      }),
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          ...target.serverConfig.settings.projectSettingsOverrides[projectId],
          defaultProjectScripts: scripts,
        },
      },
    });
  });

  it("uses the destination legacy format even when the active environment is modern", () => {
    const environments = new Map([
      [local, config(true, "Local instructions")],
      [remote, config(false, "Remote instructions")],
    ]);
    expect(
      buildSourceControlProjectScriptPatch({
        environmentId: remote,
        projectId,
        scripts: [],
        environments,
      }),
    ).toEqual({
      projectScriptOverrides: { [projectId]: [] },
    });
  });
});

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  clearDraftThread: vi.fn(),
  getComposerDraft: vi.fn(),
  releaseDraftAttachments: vi.fn(),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      clearDraftThread: mocks.clearDraftThread,
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      getComposerDraft: mocks.getComposerDraft,
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    }),
  },
}));

vi.mock("./attachmentUploadQueue", () => ({
  releaseDraftAttachments: mocks.releaseDraftAttachments,
}));

import { discardComposerDraft, releaseComposerDraftUploads } from "./composerDraftUploads";

describe("discardComposerDraft", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

  beforeEach(() => {
    mocks.clearDraftThread.mockReset();
    mocks.getComposerDraft.mockReset();
    mocks.releaseDraftAttachments.mockReset();
  });

  it("releases every pending draft attachment upload", () => {
    const images = [{ id: "image-1" }, { id: "image-2" }];
    const files = [{ id: "file-1" }];
    mocks.getComposerDraft.mockReturnValue({ images, files });

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseDraftAttachments).toHaveBeenCalledWith([...images, ...files]);
  });

  it("does nothing when the thread has no composer draft", () => {
    mocks.getComposerDraft.mockReturnValue(null);

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseDraftAttachments).not.toHaveBeenCalled();
  });

  it("releases image and file/video uploads before clearing the draft", () => {
    const image = { id: "image-1", type: "image" };
    const file = { id: "video-1", mimeType: "video/mp4", type: "file" };
    mocks.getComposerDraft.mockReturnValue({ images: [image], files: [file] });

    discardComposerDraft(threadRef);

    expect(mocks.releaseDraftAttachments).toHaveBeenCalledWith([image, file]);
    expect(mocks.clearDraftThread).toHaveBeenCalledWith(threadRef);
    expect(mocks.releaseDraftAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearDraftThread.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("still clears a draft that has no stored composer state", () => {
    const draftId = "draft-1" as DraftId;
    mocks.getComposerDraft.mockReturnValue(null);

    discardComposerDraft(draftId);

    expect(mocks.releaseDraftAttachments).not.toHaveBeenCalled();
    expect(mocks.clearDraftThread).toHaveBeenCalledWith(draftId);
  });
});

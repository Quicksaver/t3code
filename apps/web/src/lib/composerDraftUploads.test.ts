import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getComposerDraft: vi.fn(),
  releaseAttachmentUploads: vi.fn(),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: mocks.getComposerDraft,
    }),
  },
}));

vi.mock("./attachmentUploadQueue", () => ({
  releaseAttachmentUploads: mocks.releaseAttachmentUploads,
}));

import { releaseComposerDraftUploads } from "./composerDraftUploads";

describe("releaseComposerDraftUploads", () => {
  beforeEach(() => {
    mocks.getComposerDraft.mockReset();
    mocks.releaseAttachmentUploads.mockReset();
  });

  it("releases every pending draft image upload", () => {
    const images = [{ id: "image-1" }, { id: "image-2" }];
    mocks.getComposerDraft.mockReturnValue({ images });

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseAttachmentUploads).toHaveBeenCalledWith(images);
  });

  it("does nothing when the thread has no composer draft", () => {
    mocks.getComposerDraft.mockReturnValue(null);

    releaseComposerDraftUploads({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(mocks.releaseAttachmentUploads).not.toHaveBeenCalled();
  });
});

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  connectionStateAtom: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: mocks.connectionStateAtom },
}));

vi.mock("../state/assets", () => ({
  assetEnvironment: { createUrl: (target: unknown) => target },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.test/" }),
}));

import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";
import {
  releaseArchivedComposerDraftUploads,
  releaseComposerDraftUploads,
} from "./composerDraftUploads";

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  readonly listeners = new Map<string, () => void>();
  readonly upload = { addEventListener: () => {} };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(): void {}
  setRequestHeader(): void {}
  send(): void {}

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  abort(): void {
    this.listeners.get("abort")?.();
  }

  complete(): void {
    this.status = 204;
    this.listeners.get("load")?.();
  }
}

const environmentId = EnvironmentId.make("environment-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const uploadedAttachmentId = "pending-hydrated-report-pdf";
const connectionStates = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(AsyncResult.success({ phase: "connected" })),
);

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

/** A draft file as it hydrates after a reload: no bytes, only its server upload. */
function makeHydratedFile(id: string): ComposerFileAttachment {
  return { ...makeFile(id), file: null, uploadedAttachmentId, uploadEnvironmentId: environmentId };
}

function removedAttachmentIds(): string[] {
  return mocks.runAtomCommand.mock.calls.flatMap(([, command, target]) =>
    command === mocks.removeUpload
      ? [(target as { readonly input: { readonly attachmentId: string } }).input.attachmentId]
      : [],
  );
}

/** Uploads the image and verifies the hydrated file, as reopening the draft does. */
async function settleDraftUploads(
  image: ComposerImageAttachment,
  file: ComposerFileAttachment,
): Promise<void> {
  startAttachmentUpload({ environmentId, image, draftTarget: threadRef });
  startAttachmentUpload({ environmentId, image: file, draftTarget: threadRef });
  await Promise.resolve();
  const settled = awaitAttachmentUploads([image.id, file.id]);
  TestXmlHttpRequest.requests[0]!.complete();
  await settled;
}

describe("composer draft uploads", () => {
  beforeEach(() => {
    TestXmlHttpRequest.requests = [];
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
    mocks.connectionStateAtom.mockImplementation(connectionStates);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: { readonly input: { readonly name?: string } },
      ) =>
        command === mocks.createUploadUrl
          ? {
              _tag: "Success",
              value: {
                attachmentId: `pending-${target.input.name}`,
                relativeUrl: `/api/attachments/upload/pending-${target.input.name}`,
                expiresAt: 1,
              },
            }
          : { _tag: "Success", value: undefined },
    );
  });

  afterEach(() => {
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    for (const id of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(id);
    }
    vi.unstubAllGlobals();
  });

  it("keeps a hydrated draft file's upload on archive and releases the image upload", async () => {
    const image = makeImage("screenshot");
    const file = makeHydratedFile("report");
    const store = useComposerDraftStore.getState();
    store.addImage(threadRef, image);
    store.addFiles(threadRef, [file]);
    await settleDraftUploads(image, file);

    releaseArchivedComposerDraftUploads(threadRef);

    expect(removedAttachmentIds()).toEqual(["pending-screenshot.png"]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "ready",
      attachmentId: uploadedAttachmentId,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.files).toMatchObject([
      { id: file.id, uploadedAttachmentId, uploadEnvironmentId: environmentId },
    ]);
  });

  it("lets an in-flight file upload finish onto the archived draft", async () => {
    const file = makeFile("notes");
    useComposerDraftStore.getState().addFiles(threadRef, [file]);
    startAttachmentUpload({ environmentId, image: file, draftTarget: threadRef });
    await Promise.resolve();

    releaseArchivedComposerDraftUploads(threadRef);
    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(removedAttachmentIds()).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.files).toMatchObject([
      { id: file.id, uploadedAttachmentId: "pending-notes.pdf" },
    ]);
  });

  it("releases the hydrated file upload too when the draft is discarded", async () => {
    const image = makeImage("screenshot");
    const file = makeHydratedFile("report");
    const store = useComposerDraftStore.getState();
    store.addImage(threadRef, image);
    store.addFiles(threadRef, [file]);
    await settleDraftUploads(image, file);

    releaseComposerDraftUploads(threadRef);

    expect(removedAttachmentIds().toSorted()).toEqual(
      [uploadedAttachmentId, "pending-screenshot.png"].toSorted(),
    );
    expect(readAttachmentUpload(file.id)).toBeUndefined();
  });
});

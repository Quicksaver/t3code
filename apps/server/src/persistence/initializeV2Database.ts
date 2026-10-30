import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

// Legacy names have no PID; newer copies stay while their process is alive.
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  for (const entry of entries) {
    const copy = /^\.v2-import-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(entry);
    if (copy === null || (copy[1] !== undefined && isProcessAlive(Number(copy[1])))) continue;
    yield* fs.remove(path.join(directory, entry), { recursive: true });
  }
});

// VACUUM INTO copies off the event loop. Its connection's auto_vacuum setting
// makes NONE-mode sources incremental without writing them; FULL and INCREMENTAL
// sources keep their mode. Cold storage can then reclaim pages in short steps.
const SNAPSHOT_WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const source = new DatabaseSync(workerData.sourcePath, { readOnly: true });
try {
  // Changing an auto-vacuum mode that is already on would write the source.
  if (source.prepare("PRAGMA auto_vacuum").get().auto_vacuum === 0) {
    source.exec("PRAGMA auto_vacuum = INCREMENTAL");
  }
  source.prepare("VACUUM INTO ?").run(workerData.snapshotPath);
} finally {
  source.close();
}
`;

const snapshotInWorker = (sourcePath: string, snapshotPath: string) =>
  new Promise<void>((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(SNAPSHOT_WORKER_SOURCE, {
      eval: true,
      workerData: { sourcePath, snapshotPath },
    });
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`V1 snapshot worker exited with code ${code}`)),
    );
  });

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* removeAbandonedCopies(directory).pipe(Effect.ignore({ log: true }));
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: `.v2-import-${process.pid}-`,
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(() => snapshotInWorker(sourcePath, snapshotPath));
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs.link(snapshotPath, destinationPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        (_error) => Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});

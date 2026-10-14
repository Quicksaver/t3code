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

// A compacted copy in incremental auto-vacuum mode, so cold storage can later
// return freed pages in short steps. The full-file copy runs in a worker so it
// never blocks the event loop; `auto_vacuum` set on the source connection
// applies to the VACUUM INTO output. A source already in FULL or INCREMENTAL
// mode keeps it.
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

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(() => snapshotInWorker(sourcePath, snapshotPath));
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});

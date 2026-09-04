// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Standalone worktree coordination must run before a test runtime starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export const RUNTIME_RESOURCES = ["mobile", "desktop"] as const;

export type RuntimeResource = (typeof RUNTIME_RESOURCES)[number];

export const RUNTIME_CAPACITIES: Readonly<Record<RuntimeResource, number>> = {
  desktop: 1,
  mobile: 2,
};

export interface RuntimeSlotHolder {
  readonly acquiredAt: string;
  readonly requestId?: string;
  readonly worktree: string;
}

export interface RuntimeSlotRequest {
  readonly cancelledAt: string | null;
  readonly requestedAt: string;
  readonly resource: RuntimeResource;
  readonly worktree: string;
}

interface StoredRuntimeSlotRequest {
  readonly cancelledAt: string | null;
  readonly requestedAt: string;
  readonly resource: RuntimeResource | "web";
  readonly worktree: string;
}

export interface RuntimeSlotState {
  readonly desktop: readonly RuntimeSlotHolder[];
  readonly mobile: readonly RuntimeSlotHolder[];
  readonly requests: Readonly<Record<string, RuntimeSlotRequest>>;
  readonly version: 4;
}

type RuntimeSlotLogger = Pick<Console, "log">;

export interface RuntimeSlotManagerOptions {
  readonly lockRetryMs?: number;
  readonly lockStaleAfterMs?: number;
  readonly logger?: RuntimeSlotLogger;
  readonly pollIntervalMs?: number;
  readonly stateFilePath: string;
}

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const ACQUISITION_INTERRUPT_GRACE_MS = 500;
const LOCK_OWNER_FILE_NAME = "owner";
const LOCK_RECLAIM_DIRECTORY_SUFFIX = ".reclaim";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const initialState = (): RuntimeSlotState => ({
  desktop: [],
  mobile: [],
  requests: {},
  version: 4,
});

const delay = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const isExisting = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";

const isRuntimeSlotHolder = (value: unknown): value is RuntimeSlotHolder => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.acquiredAt === "string" &&
    (record.requestId === undefined ||
      (typeof record.requestId === "string" && REQUEST_ID_PATTERN.test(record.requestId))) &&
    typeof record.worktree === "string"
  );
};

const isStoredRuntimeSlotRequest = (value: unknown): value is StoredRuntimeSlotRequest => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.cancelledAt === null || typeof record.cancelledAt === "string") &&
    typeof record.requestedAt === "string" &&
    (record.resource === "web" || record.resource === "mobile" || record.resource === "desktop") &&
    typeof record.worktree === "string"
  );
};

const isRuntimeSlotRequests = (
  value: unknown,
): value is Readonly<Record<string, StoredRuntimeSlotRequest>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([requestId, request]) =>
      REQUEST_ID_PATTERN.test(requestId) && isStoredRuntimeSlotRequest(request),
  );

const parseState = (text: string, stateFilePath: string): RuntimeSlotState => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Runtime-slot state is invalid JSON at ${stateFilePath}.`, {
      cause: error,
    });
  }

  if (typeof value !== "object" || value === null) {
    throw new Error(`Runtime-slot state must be an object at ${stateFilePath}.`);
  }

  const record = value as Record<string, unknown>;
  const isSingleHolderVersion =
    record.version === 1 || record.version === 2 || record.version === 3;
  const requests =
    record.version === 1 || record.version === 2
      ? {}
      : isRuntimeSlotRequests(record.requests)
        ? record.requests
        : undefined;
  const validSingleHolderState =
    isSingleHolderVersion &&
    (record.mobile === null || isRuntimeSlotHolder(record.mobile)) &&
    (record.desktop === undefined ||
      record.desktop === null ||
      isRuntimeSlotHolder(record.desktop)) &&
    requests !== undefined;
  const validCurrentState =
    record.version === 4 &&
    Array.isArray(record.mobile) &&
    record.mobile.every(isRuntimeSlotHolder) &&
    record.mobile.length <= RUNTIME_CAPACITIES.mobile &&
    Array.isArray(record.desktop) &&
    record.desktop.every(isRuntimeSlotHolder) &&
    record.desktop.length <= RUNTIME_CAPACITIES.desktop &&
    requests !== undefined;
  if (!(validSingleHolderState || validCurrentState)) {
    throw new Error(`Runtime-slot state has an unsupported shape at ${stateFilePath}.`);
  }

  const supportedRequests: Record<string, RuntimeSlotRequest> = {};
  for (const [requestId, request] of Object.entries(requests ?? {})) {
    if (request.resource !== "mobile" && request.resource !== "desktop") continue;
    supportedRequests[requestId] = { ...request, resource: request.resource };
  }
  return {
    desktop: isSingleHolderVersion
      ? record.desktop === undefined || record.desktop === null
        ? []
        : [record.desktop as RuntimeSlotHolder]
      : (record.desktop as readonly RuntimeSlotHolder[]),
    mobile: isSingleHolderVersion
      ? record.mobile === null
        ? []
        : [record.mobile as RuntimeSlotHolder]
      : (record.mobile as readonly RuntimeSlotHolder[]),
    requests: supportedRequests,
    version: 4,
  };
};

const withoutRequest = (
  requests: Readonly<Record<string, RuntimeSlotRequest>>,
  requestId: string | undefined,
): Readonly<Record<string, RuntimeSlotRequest>> => {
  if (requestId === undefined || requests[requestId] === undefined) return requests;
  const next = { ...requests };
  delete next[requestId];
  return next;
};

const withLockMutation = async <A>(
  lockPath: string,
  lockRetryMs: number,
  action: () => Promise<A>,
): Promise<A> => {
  const mutationPath = `${lockPath}${LOCK_RECLAIM_DIRECTORY_SUFFIX}`;
  while (true) {
    try {
      await NodeFSP.mkdir(mutationPath);
      break;
    } catch (error) {
      if (!isExisting(error)) throw error;
      await delay(lockRetryMs);
    }
  }

  try {
    return await action();
  } finally {
    await NodeFSP.rm(mutationPath, { recursive: true, force: true });
  }
};

export class RuntimeSlotManager {
  readonly #lockPath: string;
  readonly #lockRetryMs: number;
  readonly #lockStaleAfterMs: number;
  readonly #logger: RuntimeSlotLogger;
  readonly #pollIntervalMs: number;
  readonly #stateFilePath: string;

  constructor(options: RuntimeSlotManagerOptions) {
    this.#stateFilePath = NodePath.resolve(options.stateFilePath);
    this.#lockPath = `${this.#stateFilePath}.lock`;
    this.#lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.#lockStaleAfterMs = options.lockStaleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#logger = options.logger ?? console;
  }

  async acquire(
    resource: RuntimeResource,
    worktree: string,
    requestId: string,
  ): Promise<"acquired" | "cancelled"> {
    let lastHolders = "";

    while (true) {
      const result = await this.#withStateLock(async () => {
        const state = await this.#readState();
        const existingRequest = state.requests[requestId];
        if (
          existingRequest !== undefined &&
          (existingRequest.resource !== resource || existingRequest.worktree !== worktree)
        ) {
          throw new Error(
            `Runtime-slot request ${requestId} belongs to ${existingRequest.resource} for ${existingRequest.worktree}.`,
          );
        }
        if (existingRequest !== undefined && existingRequest.cancelledAt !== null) {
          await this.#writeState({
            ...state,
            requests: withoutRequest(state.requests, requestId),
          });
          return {
            acquired: false,
            cancelled: true,
            existing: false,
            holders: [] as readonly RuntimeSlotHolder[],
          } as const;
        }

        const requests =
          existingRequest !== undefined
            ? state.requests
            : {
                ...state.requests,
                [requestId]: {
                  cancelledAt: null,
                  requestedAt: new Date().toISOString(),
                  resource,
                  worktree,
                },
              };
        const holders = state[resource];
        const existingHolder = holders.find((holder) => holder.worktree === worktree);
        if (existingHolder !== undefined) {
          if (requestId !== existingHolder.requestId) {
            throw new Error(
              `${worktree} already holds the ${resource} runtime slot under ${
                existingHolder.requestId === undefined
                  ? "an unscoped acquisition"
                  : `request ${existingHolder.requestId}`
              }.`,
            );
          }
          if (requests !== state.requests) await this.#writeState({ ...state, requests });
          return { acquired: true, cancelled: false, existing: true, holders } as const;
        }
        if (holders.length < RUNTIME_CAPACITIES[resource]) {
          await this.#writeState({
            ...state,
            [resource]: [
              ...holders,
              {
                acquiredAt: new Date().toISOString(),
                requestId,
                worktree,
              },
            ],
            requests,
          });
          return { acquired: true, cancelled: false, existing: false, holders } as const;
        }
        if (requests !== state.requests) await this.#writeState({ ...state, requests });
        return { acquired: false, cancelled: false, holders } as const;
      });

      if (result.cancelled) {
        this.#logger.log(
          `Cancelled ${resource} runtime-slot request ${requestId} for ${worktree}.`,
        );
        return "cancelled";
      }
      if (result.acquired) {
        this.#logger.log(
          result.existing
            ? `${worktree} already holds the ${resource} runtime slot under request ${requestId}.`
            : `Acquired ${resource} runtime slot for ${worktree} under request ${requestId}.`,
        );
        return "acquired";
      }

      const holderSummary = result.holders.map((holder) => holder.worktree).join(", ");
      if (holderSummary !== lastHolders) {
        this.#logger.log(`Waiting for ${resource} capacity held by ${holderSummary}.`);
        lastHolders = holderSummary;
      }
      await delay(this.#pollIntervalMs);
    }
  }

  async cancel(resource: RuntimeResource, worktree: string, requestId: string): Promise<boolean> {
    return await this.#withStateLock(async () => {
      const state = await this.#readState();
      const existingRequest = state.requests[requestId];
      if (
        existingRequest !== undefined &&
        (existingRequest.resource !== resource || existingRequest.worktree !== worktree)
      ) {
        throw new Error(
          `Runtime-slot request ${requestId} belongs to ${existingRequest.resource} for ${existingRequest.worktree}.`,
        );
      }

      const holders = state[resource];
      const released = holders.some(
        (holder) => holder.worktree === worktree && holder.requestId === requestId,
      );
      const cancelledAt = new Date().toISOString();
      const cancelledRequest: RuntimeSlotRequest = {
        cancelledAt,
        requestedAt: existingRequest?.requestedAt ?? cancelledAt,
        resource,
        worktree,
      };
      await this.#writeState({
        ...state,
        [resource]: released
          ? holders.filter(
              (holder) => !(holder.worktree === worktree && holder.requestId === requestId),
            )
          : holders,
        requests: released
          ? withoutRequest(state.requests, requestId)
          : { ...state.requests, [requestId]: cancelledRequest },
      });
      return released;
    });
  }

  async cleanup(worktree: string): Promise<readonly RuntimeResource[]> {
    return await this.#withStateLock(async () => {
      const state = await this.#readState();
      const released = RUNTIME_RESOURCES.filter((resource) =>
        state[resource].some((holder) => holder.worktree === worktree),
      );
      const requests = Object.fromEntries(
        Object.entries(state.requests).filter(([, request]) => request.worktree !== worktree),
      );
      if (
        released.length === 0 &&
        Object.keys(requests).length === Object.keys(state.requests).length
      )
        return [];

      const nextState: RuntimeSlotState = {
        desktop: state.desktop.filter((holder) => holder.worktree !== worktree),
        mobile: state.mobile.filter((holder) => holder.worktree !== worktree),
        requests,
        version: 4,
      };
      await this.#writeState(nextState);
      return released;
    });
  }

  async release(resource: RuntimeResource, worktree: string, requestId: string): Promise<boolean> {
    return await this.#withStateLock(async () => {
      const state = await this.#readState();
      const holders = state[resource];
      const holder = holders.find((candidate) => candidate.worktree === worktree);
      if (holder === undefined) {
        if (holders.length === 0) return false;
        throw new Error(
          `Cannot release ${resource} runtime slot for ${worktree}; capacity is held by ${holders
            .map((candidate) => candidate.worktree)
            .join(", ")}.`,
        );
      }
      if (holder.requestId !== requestId) {
        throw new Error(
          `Cannot release ${resource} runtime slot for request ${requestId}; it is held under ${
            holder.requestId === undefined
              ? "an unscoped acquisition"
              : `request ${holder.requestId}`
          }.`,
        );
      }
      await this.#writeState({
        ...state,
        [resource]: holders.filter((candidate) => candidate !== holder),
        requests: withoutRequest(state.requests, holder.requestId),
      });
      return true;
    });
  }

  async status(): Promise<RuntimeSlotState> {
    return await this.#withStateLock(async () => await this.#readState());
  }

  async #readState(): Promise<RuntimeSlotState> {
    try {
      return parseState(await NodeFSP.readFile(this.#stateFilePath, "utf8"), this.#stateFilePath);
    } catch (error) {
      if (isMissing(error)) return initialState();
      throw error;
    }
  }

  async #withStateLock<A>(action: () => Promise<A>): Promise<A> {
    await NodeFSP.mkdir(NodePath.dirname(this.#stateFilePath), { recursive: true });
    const ownerPath = NodePath.join(this.#lockPath, LOCK_OWNER_FILE_NAME);
    const ownerId = NodeCrypto.randomUUID();

    while (true) {
      try {
        await NodeFSP.mkdir(this.#lockPath);
        try {
          await NodeFSP.writeFile(ownerPath, ownerId, { flag: "wx" });
        } catch (error) {
          await NodeFSP.rm(this.#lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (!isExisting(error)) throw error;

        try {
          const stat = await NodeFSP.stat(this.#lockPath);
          if (Date.now() - stat.mtimeMs > this.#lockStaleAfterMs) {
            await withLockMutation(this.#lockPath, this.#lockRetryMs, async () => {
              try {
                const current = await NodeFSP.stat(this.#lockPath);
                if (Date.now() - current.mtimeMs > this.#lockStaleAfterMs) {
                  await NodeFSP.rm(this.#lockPath, { recursive: true });
                }
              } catch (currentError) {
                if (!isMissing(currentError)) throw currentError;
              }
            });
            continue;
          }
        } catch (statError) {
          if (isMissing(statError)) continue;
          throw statError;
        }

        await delay(this.#lockRetryMs);
      }
    }

    try {
      return await action();
    } finally {
      await withLockMutation(this.#lockPath, this.#lockRetryMs, async () => {
        try {
          if ((await NodeFSP.readFile(ownerPath, "utf8")) === ownerId) {
            await NodeFSP.rm(this.#lockPath, { recursive: true });
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      });
    }
  }

  async #writeState(state: RuntimeSlotState): Promise<void> {
    const temporaryPath = `${this.#stateFilePath}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await NodeFSP.rename(temporaryPath, this.#stateFilePath);
    } catch (error) {
      await NodeFSP.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

const SCRIPT_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const STATE_FILE_PATH = NodePath.join(SCRIPT_ROOT, ".t3", "worktree-runtime-slots.json");

const runGit = (args: readonly string[]): string => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd: SCRIPT_ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${String(result.status)}: ${(
        result.stderr ?? ""
      ).trim()}`,
    );
  }
  return result.stdout.trim();
};

const resolveActiveWorktree = async (inputPath: string): Promise<string> => {
  const root = runGit(["-C", NodePath.resolve(inputPath), "rev-parse", "--show-toplevel"]);
  const canonicalRoot = await NodeFSP.realpath(root);
  const activeWorktrees = runGit(["-C", SCRIPT_ROOT, "worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => NodePath.resolve(line.slice("worktree ".length)));

  for (const worktree of activeWorktrees) {
    try {
      if ((await NodeFSP.realpath(worktree)) === canonicalRoot) return canonicalRoot;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  throw new Error(`${canonicalRoot} is not an active Git worktree.`);
};

const readWorktreeArgument = (args: readonly string[]): string => {
  const index = args.indexOf("--worktree");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === "") {
    throw new Error("Expected --worktree /absolute/path/to/worktree.");
  }
  return value;
};

const readRequestIdArgument = (args: readonly string[], required: boolean): string | undefined => {
  const index = args.indexOf("--request-id");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) {
    if (required) throw new Error("Expected --request-id <unique-id>.");
    return undefined;
  }
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new Error(
      "--request-id must use 1-200 letters, digits, dots, colons, underscores, or hyphens.",
    );
  }
  return value;
};

const readResource = (value: string | undefined): RuntimeResource => {
  if (value === "mobile" || value === "desktop") return value;
  throw new Error("Expected runtime resource mobile or desktop.");
};

const usage = (): string =>
  [
    "Usage:",
    "  node scripts/worktree-runtime-slot.ts acquire <mobile|desktop> --worktree <path> --request-id <unique-id>",
    "  node scripts/worktree-runtime-slot.ts cancel <mobile|desktop> --worktree <path> --request-id <unique-id>",
    "  node scripts/worktree-runtime-slot.ts release <mobile|desktop> --worktree <path> --request-id <unique-id>",
    "  node scripts/worktree-runtime-slot.ts cleanup --worktree <path>",
    "  node scripts/worktree-runtime-slot.ts status",
  ].join("\n");

export type AcquisitionSignal = "SIGINT" | "SIGTERM";

const acquisitionSignalExitCode: Readonly<Record<AcquisitionSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export const acquireWithCancellationSignal = async (
  manager: RuntimeSlotManager,
  resource: RuntimeResource,
  worktree: string,
  requestId: string,
  signalPromise: Promise<AcquisitionSignal>,
  interruptGraceMs = ACQUISITION_INTERRUPT_GRACE_MS,
): Promise<AcquisitionSignal | undefined> => {
  const acquisition = manager.acquire(resource, worktree, requestId);
  const first = await Promise.race([
    acquisition.then((result) => ({ result, tag: "acquisition" }) as const),
    signalPromise.then((signal) => ({ signal, tag: "signal" }) as const),
  ]);
  const signal =
    first.tag === "signal"
      ? first.signal
      : first.result === "acquired"
        ? await Promise.race([delay(interruptGraceMs).then(() => undefined), signalPromise])
        : undefined;
  if (signal === undefined) return undefined;

  await manager.cancel(resource, worktree, requestId);
  await acquisition;
  return signal;
};

const acquireWithSignalCleanup = async (
  manager: RuntimeSlotManager,
  resource: RuntimeResource,
  worktree: string,
  requestId: string,
): Promise<void> => {
  let resolveSignal!: (signal: AcquisitionSignal) => void;
  let receivedSignal: AcquisitionSignal | undefined;
  const signalPromise = new Promise<AcquisitionSignal>((resolve) => {
    resolveSignal = resolve;
  });
  const handlers: Readonly<Record<AcquisitionSignal, () => void>> = {
    SIGINT: () => {
      if (receivedSignal !== undefined) return;
      receivedSignal = "SIGINT";
      resolveSignal("SIGINT");
    },
    SIGTERM: () => {
      if (receivedSignal !== undefined) return;
      receivedSignal = "SIGTERM";
      resolveSignal("SIGTERM");
    },
  };
  process.on("SIGINT", handlers.SIGINT);
  process.on("SIGTERM", handlers.SIGTERM);

  try {
    const signal = await acquireWithCancellationSignal(
      manager,
      resource,
      worktree,
      requestId,
      signalPromise,
    );
    if (signal === undefined) return;

    NodeProcess.stderr.write(
      `Interrupted ${resource} runtime-slot request ${requestId} for ${worktree}; request cancelled and matching holder released.\n`,
    );
    process.exitCode = acquisitionSignalExitCode[signal];
  } finally {
    process.off("SIGINT", handlers.SIGINT);
    process.off("SIGTERM", handlers.SIGTERM);
  }
};

export const main = async (args: readonly string[]): Promise<void> => {
  const [command, resourceValue] = args;
  const manager = new RuntimeSlotManager({ stateFilePath: STATE_FILE_PATH });

  if (command === "status") {
    NodeProcess.stdout.write(`${JSON.stringify(await manager.status(), null, 2)}\n`);
    return;
  }

  if (command === "acquire") {
    const resource = readResource(resourceValue);
    const requestId = readRequestIdArgument(args, true)!;
    const worktree = await resolveActiveWorktree(readWorktreeArgument(args));
    await acquireWithSignalCleanup(manager, resource, worktree, requestId);
    return;
  }

  if (command === "cancel") {
    const resource = readResource(resourceValue);
    const worktree = await resolveActiveWorktree(readWorktreeArgument(args));
    const requestId = readRequestIdArgument(args, true)!;
    const released = await manager.cancel(resource, worktree, requestId);
    NodeProcess.stdout.write(
      released
        ? `Cancelled ${resource} runtime-slot request ${requestId} for ${worktree} and released its slot.\n`
        : `Cancelled ${resource} runtime-slot request ${requestId} for ${worktree}; no matching held slot needed release.\n`,
    );
    return;
  }

  if (command === "release") {
    const resource = readResource(resourceValue);
    const requestId = readRequestIdArgument(args, true)!;
    const worktree = await resolveActiveWorktree(readWorktreeArgument(args));
    const released = await manager.release(resource, worktree, requestId);
    NodeProcess.stdout.write(
      released
        ? `Released ${resource} runtime slot for ${worktree}.\n`
        : `${resource} runtime slot is already free.\n`,
    );
    return;
  }

  if (command === "cleanup") {
    const worktree = await resolveActiveWorktree(readWorktreeArgument(args));
    const released = await manager.cleanup(worktree);
    NodeProcess.stdout.write(
      released.length === 0
        ? `No runtime slots are held by ${worktree}.\n`
        : `Released ${released.join(" and ")} runtime slot${
            released.length === 1 ? "" : "s"
          } for ${worktree}.\n`,
    );
    return;
  }

  throw new Error(usage());
};

const isDirectRun =
  NodeProcess.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(NodeProcess.argv[1])).href;

if (isDirectRun) {
  main(NodeProcess.argv.slice(2)).catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(1);
  });
}

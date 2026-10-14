import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  cachedThreadGeneration,
  evictCachedThread,
  isCachedThreadEvicted,
  persistCachedThread,
  retainCachedThreadUnsafe,
  retainLiveCachedThread,
} from "./threadCache.ts";
import { archiveThreadAndEvictCache } from "./threadCommands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const LIVE_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

// Starts a live shell listing `threadId` at `shellSequence` (default 1) and an
// archive command whose acknowledgement returns the next sequence once
// `acknowledge` runs. A warm snapshot retains the thread's cache state like a
// closed detail subscription.
const startArchiveWithLateAcknowledgement = Effect.fn("startArchiveWithLateAcknowledgement")(
  function* (threadId: ThreadId, shellSequence = 1) {
    const thread = { ...v2ShellSnapshot.threads[0]!, id: threadId };
    const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    const subscribed = yield* SubscriptionRef.make(false);
    const archiveStarted = yield* Deferred.make<void>();
    const archiveAcknowledged = yield* Deferred.make<void>();
    const removedThreads = yield* Ref.make<ThreadId[]>([]);
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
        Stream.unwrap(
          SubscriptionRef.set(subscribed, true).pipe(Effect.as(Stream.fromQueue(events))),
        ),
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () =>
        Deferred.succeed(archiveStarted, undefined).pipe(
          Effect.andThen(Deferred.await(archiveAcknowledged)),
          Effect.as({ sequence: shellSequence + 1 }),
        ),
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session(client))),
      prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: (_environmentId, removedThreadId) =>
        Ref.update(removedThreads, (threadIds) => [...threadIds, removedThreadId]),
      listThreadIds: () => Effect.succeed([]),
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const warm = { evictions: 0 };
    const releaseWarmSnapshot = retainCachedThreadUnsafe(
      cache,
      TARGET.environmentId,
      threadId,
      () => {
        warm.evictions += 1;
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(releaseWarmSnapshot));
    const shellState = yield* makeEnvironmentShellState().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(
        ShellSnapshotLoader.ShellSnapshotLoader,
        ShellSnapshotLoader.ShellSnapshotLoader.of({
          load: () =>
            Effect.succeedSome({
              ...v2ShellSnapshot,
              snapshotSequence: shellSequence,
              threads: [thread],
            }),
        }),
      ),
    );
    yield* SubscriptionRef.changes(subscribed).pipe(
      Stream.filter((value) => value),
      Stream.runHead,
    );
    const archive = yield* archiveThreadAndEvictCache({
      commandId: CommandId.make("archive-command"),
      threadId,
    }).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(archiveStarted);
    const awaitShellSequence = (sequence: number) =>
      SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (value) =>
            Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === sequence,
        ),
        Stream.runHead,
      );

    return {
      cache,
      warm,
      removedThreads,
      // The server coalesced this client's archive (sequence 2) and another
      // client's unarchive into one active update, leaving membership unchanged.
      deliverCoalescedRestore: Effect.gen(function* () {
        yield* Queue.offer(events, {
          kind: "thread.updated",
          sequence: shellSequence + 2,
          location: "active",
          thread,
        });
        yield* awaitShellSequence(shellSequence + 2);
      }),
      // A replaced server sequence space: an authoritative snapshot below the
      // applied one that still lists the thread as active.
      deliverResetSnapshot: (sequence: number) =>
        Queue.offer(events, {
          kind: "snapshot",
          snapshot: { ...v2ShellSnapshot, snapshotSequence: sequence, threads: [thread] },
        }).pipe(Effect.andThen(awaitShellSequence(sequence))),
      acknowledge: Deferred.succeed(archiveAcknowledged, undefined).pipe(
        Effect.andThen(Fiber.join(archive)),
      ),
    };
  },
);

describe("environment shell synchronization", () => {
  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // Cold cache with no HTTP snapshot available → falls back to the
      // socket-embedded snapshot.
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeedNone,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      const synchronizing = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "synchronizing" && Option.isSome(state.snapshot)),
        Stream.runHead,
      );
      expect(Option.getOrThrow(Option.getOrThrow(synchronizing).snapshot)).toEqual(
        LIVE_SHELL_SNAPSHOT,
      );

      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      const state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(LIVE_SHELL_SNAPSHOT);
    }),
  );

  it.live.each([
    { bufferSize: Infinity, expectedSequences: [51] },
    // RpcClient defaults to a 16-event buffer, which splits larger server chunks.
    { bufferSize: 16, expectedSequences: [17, 33, 49, 51] },
  ])("batches live events with a $bufferSize event buffer", ({ bufferSize, expectedSequences }) =>
    Effect.gen(function* () {
      const events = yield* Queue.bounded<OrchestrationV2ShellStreamItem>(bufferSize);
      const batchSnapshot = { ...LIVE_SHELL_SNAPSHOT, threads: [] };
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(
          ShellSnapshotLoader.ShellSnapshotLoader,
          ShellSnapshotLoader.ShellSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
        ),
      );
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, { kind: "snapshot", snapshot: batchSnapshot });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // Observe before publishing so no batch can arrive before the subscription.
      const observed = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.drop(1),
        Stream.takeUntil(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.threads.length === 50,
        ),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.offerAll(
        events,
        Array.from({ length: 50 }, (_, index) => ({
          kind: "thread.updated" as const,
          sequence: 2 + index,
          location: "active" as const,
          thread: { ...v2ShellSnapshot.threads[0]!, id: `thread-${index}` } as never,
        })),
      );
      const states = yield* Fiber.join(observed);
      const snapshots = states.map((state) => Option.getOrThrow(state.snapshot));
      expect(snapshots.map((snapshot) => snapshot.snapshotSequence)).toEqual(expectedSequences);
      expect(snapshots.at(-1)!.threads.map((thread) => thread.id)).toEqual(
        Array.from({ length: 50 }, (_, index) => `thread-${index}`),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes a warm shell cache from HTTP before resuming", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const capturedAfterSequence = yield* SubscriptionRef.make<number | undefined>(undefined);
      const capturedCompletionMarker = yield* Ref.make(false);
      const loaderCalls = yield* SubscriptionRef.make(0);
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 9,
      };
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: true;
        }) =>
          Stream.unwrap(
            Effect.all([
              Ref.set(capturedCompletionMarker, input.requestCompletionMarker === true),
              SubscriptionRef.set(capturedAfterSequence, input.afterSequence),
            ]).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedSome(cachedSnapshot),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          SubscriptionRef.update(loaderCalls, (count) => count + 1).pipe(
            Effect.as(Option.some(httpSnapshot)),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      // Wait until the subscription is established from the warm cache.
      yield* SubscriptionRef.changes(capturedAfterSequence).pipe(
        Stream.filter((value) => value !== undefined),
        Stream.runHead,
      );

      expect(yield* SubscriptionRef.get(capturedAfterSequence)).toBe(9);
      expect(yield* Ref.get(capturedCompletionMarker)).toBe(true);
      expect(yield* SubscriptionRef.get(loaderCalls)).toBe(1);
      const synchronizing = yield* SubscriptionRef.get(shellState);
      expect(synchronizing.status).toBe("synchronizing");
      expect(Option.getOrThrow(synchronizing.snapshot)).toEqual(httpSnapshot);

      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );
    }),
  );

  it.effect("evicts details for threads a new shell snapshot drops and revives added ones", () =>
    Effect.gen(function* () {
      const shellThread = (id: string) => ({ ...v2ShellSnapshot.threads[0]!, id }) as never;
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        threads: [shellThread("stale-thread")],
      };
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...cachedSnapshot,
        snapshotSequence: 9,
        threads: [shellThread("archived-after-http-snapshot")],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const capturedInput = yield* SubscriptionRef.make<{
        readonly afterSequence?: number;
        readonly requestCompletionMarker?: boolean;
      } | null>(null);
      const loaderCalls = yield* SubscriptionRef.make(0);
      const removedThreads = yield* Ref.make<string[]>([]);
      const savedThreads = yield* Ref.make<string[]>([]);
      const addedThreadId = ThreadId.make("archived-after-http-snapshot");
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
        }) =>
          Stream.unwrap(
            SubscriptionRef.set(capturedInput, input).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedSome(cachedSnapshot),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: (_environmentId, snapshot) =>
          Ref.update(savedThreads, (threadIds) => [...threadIds, snapshot.projection.thread.id]),
        removeThread: (_environmentId, threadId) =>
          Ref.update(removedThreads, (threadIds) => [...threadIds, threadId]),
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      yield* retainLiveCachedThread(cache, TARGET.environmentId, addedThreadId);
      const staleGeneration = cachedThreadGeneration(cache, TARGET.environmentId, addedThreadId);
      yield* evictCachedThread(cache, TARGET.environmentId, addedThreadId);
      yield* Ref.set(removedThreads, []);
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          SubscriptionRef.update(loaderCalls, (count) => count + 1).pipe(
            Effect.as(Option.some(httpSnapshot)),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      // Wait until the subscription resumes after the HTTP refresh.
      yield* SubscriptionRef.changes(capturedInput).pipe(
        Stream.filter((value) => value !== null),
        Stream.runHead,
      );
      expect(yield* SubscriptionRef.get(loaderCalls)).toBe(1);
      const synchronizing = yield* SubscriptionRef.get(shellState);
      expect(synchronizing.status).toBe("synchronizing");
      expect(Option.getOrThrow(synchronizing.snapshot).threads).toEqual(httpSnapshot.threads);
      expect(yield* Ref.get(removedThreads)).toEqual(["stale-thread"]);
      const detail = (id: ThreadId) =>
        ({ snapshotSequence: 9, projection: { thread: { id } } }) as never;
      yield* persistCachedThread(
        cache,
        TARGET.environmentId,
        detail(addedThreadId),
        staleGeneration,
      );
      expect(yield* Ref.get(savedThreads)).toEqual([]);
      yield* persistCachedThread(
        cache,
        TARGET.environmentId,
        detail(addedThreadId),
        cachedThreadGeneration(cache, TARGET.environmentId, addedThreadId),
      );
      expect(yield* Ref.get(savedThreads)).toEqual([addedThreadId]);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...httpSnapshot, snapshotSequence: 10, threads: [] },
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );
      expect(Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot).threads).toEqual(
        [],
      );
      expect(yield* Ref.get(removedThreads)).toEqual([
        "stale-thread",
        "archived-after-http-snapshot",
      ]);
    }),
  );

  it.effect(
    "preserves the shell across an authorization session handoff until the replacement snapshot archives it",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("archived-during-authorization-refresh");
        const activeSnapshot: OrchestrationV2ShellSnapshot = {
          ...v2ShellSnapshot,
          snapshotSequence: 1,
          threads: [{ ...v2ShellSnapshot.threads[0]!, id: threadId }],
        };
        const firstEvents = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const replacementEvents = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const subscriptionCount = yield* SubscriptionRef.make(0);
        const removedThreads = yield* Ref.make<ThreadId[]>([]);
        const savedThreads = yield* Ref.make<ThreadId[]>([]);
        const makeClient = (events: Queue.Queue<OrchestrationV2ShellStreamItem>) =>
          ({
            [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
              Stream.unwrap(
                SubscriptionRef.update(subscriptionCount, (count) => count + 1).pipe(
                  Effect.as(Stream.fromQueue(events)),
                ),
              ),
          }) as unknown as WsRpcProtocolClient;
        const firstSession = session(makeClient(firstEvents));
        const replacementSession = session(makeClient(replacementEvents));
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some(firstSession),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedSome(activeSnapshot),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: (_environmentId, snapshot) =>
            Ref.update(savedThreads, (threadIds) => [...threadIds, snapshot.projection.thread.id]),
          removeThread: (_environmentId, removedThreadId) =>
            Ref.update(removedThreads, (threadIds) => [...threadIds, removedThreadId]),
          listThreadIds: () => Effect.succeed([]),
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        yield* retainLiveCachedThread(cache, TARGET.environmentId, threadId);
        const generationBeforeArchive = cachedThreadGeneration(
          cache,
          TARGET.environmentId,
          threadId,
        );
        const loaderCalls = yield* Ref.make(0);
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          Effect.provideService(
            ShellSnapshotLoader.ShellSnapshotLoader,
            ShellSnapshotLoader.ShellSnapshotLoader.of({
              load: () =>
                Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
                  Effect.map((count) =>
                    count === 1 ? Option.some(activeSnapshot) : Option.none(),
                  ),
                ),
            }),
          ),
        );

        const awaitSubscription = (count: number) =>
          SubscriptionRef.changes(subscriptionCount).pipe(
            Stream.filter((value) => value === count),
            Stream.runHead,
          );
        yield* awaitSubscription(1);
        yield* Queue.offer(firstEvents, { kind: "snapshot", snapshot: activeSnapshot });
        yield* Queue.offer(firstEvents, { kind: "synchronized" });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter((value) => value.status === "live"),
          Stream.runHead,
        );

        // The supervisor publishes a replacement session only after its new
        // authorization is ready. Shell synchronization keeps the previous
        // authoritative baseline until that session supplies its own snapshot.
        yield* SubscriptionRef.set(activeSession, Option.some(replacementSession));
        yield* awaitSubscription(2);
        expect(yield* Ref.get(loaderCalls)).toBe(2);
        expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot).threads,
        ).toEqual(activeSnapshot.threads);
        expect(yield* Ref.get(removedThreads)).toEqual([]);

        yield* Queue.offer(replacementEvents, {
          kind: "snapshot",
          snapshot: { ...activeSnapshot, snapshotSequence: 2, threads: [] },
        });
        yield* Queue.offer(replacementEvents, { kind: "synchronized" });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (value) =>
              value.status === "live" &&
              Option.isSome(value.snapshot) &&
              value.snapshot.value.snapshotSequence === 2,
          ),
          Stream.runHead,
        );

        expect(yield* Ref.get(removedThreads)).toEqual([threadId]);
        yield* persistCachedThread(
          cache,
          TARGET.environmentId,
          { snapshotSequence: 1, projection: { thread: { id: threadId } } } as never,
          generationBeforeArchive,
        );
        expect(yield* Ref.get(savedThreads)).toEqual([]);
      }),
  );

  it.effect("retries failed detail eviction while the thread remains absent", () =>
    Effect.gen(function* () {
      const staleThreadId = ThreadId.make("stale-thread");
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 1,
        threads: [{ ...v2ShellSnapshot.threads[0]!, id: staleThreadId }],
      };
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...cachedSnapshot,
        snapshotSequence: 2,
        threads: [],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const capturedInput = yield* SubscriptionRef.make(false);
      const evictionAttempts = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(
            SubscriptionRef.set(capturedInput, true).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedSome(cachedSnapshot),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () =>
          Ref.updateAndGet(evictionAttempts, (attempts) => attempts + 1).pipe(
            Effect.flatMap((attempts) =>
              attempts < 3
                ? Effect.fail(
                    new Persistence.ConnectionPersistenceError({
                      operation: "remove-thread",
                      message: "temporary failure",
                    }),
                  )
                : Effect.void,
            ),
          ),
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(
          ShellSnapshotLoader.ShellSnapshotLoader,
          ShellSnapshotLoader.ShellSnapshotLoader.of({
            load: () => Effect.succeed(Option.some(httpSnapshot)),
          }),
        ),
      );

      yield* SubscriptionRef.changes(capturedInput).pipe(
        Stream.filter((subscribed) => subscribed),
        Stream.runHead,
      );
      expect(yield* Ref.get(evictionAttempts)).toBe(1);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...httpSnapshot, snapshotSequence: 3 },
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (value) => Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === 3,
        ),
        Stream.runHead,
      );

      expect(yield* Ref.get(evictionAttempts)).toBe(2);

      // A batch that leaves membership unchanged still retries pending removals,
      // then stops once the removal succeeds.
      const awaitSequence = (sequence: number) =>
        SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (value) =>
              Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === sequence,
          ),
          Stream.runHead,
        );
      yield* Queue.offer(events, { kind: "project.updated", sequence: 4, project: v2Project });
      yield* awaitSequence(4);
      expect(yield* Ref.get(evictionAttempts)).toBe(3);
      yield* Queue.offer(events, { kind: "project.updated", sequence: 5, project: v2Project });
      yield* awaitSequence(5);
      expect(yield* Ref.get(evictionAttempts)).toBe(3);
    }),
  );

  it.effect("evicts persisted details missing from an authoritative active shell", () =>
    Effect.gen(function* () {
      const activeThreadId = ThreadId.make("active-thread");
      const archivedThreadId = ThreadId.make("archived-before-restart");
      const liveThreadId = ThreadId.make("created-after-snapshot");
      const warmThreadId = ThreadId.make("archived-while-warm");
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 2,
        threads: [{ ...v2ShellSnapshot.threads[0]!, id: activeThreadId }],
        archivedThreads: [],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const subscribed = yield* SubscriptionRef.make(false);
      const removedThreads = yield* Ref.make<ThreadId[]>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(
            SubscriptionRef.set(subscribed, true).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      // A restart lost the in-memory retry, and the shell cache is empty.
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: (_environmentId, threadId) =>
          Ref.update(removedThreads, (threadIds) => [...threadIds, threadId]),
        listThreadIds: () =>
          Effect.succeed([activeThreadId, archivedThreadId, liveThreadId, warmThreadId]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // An open detail owns its own lifecycle and may postdate the snapshot.
      yield* retainLiveCachedThread(cache, TARGET.environmentId, liveThreadId);
      // A warm resume snapshot outlives its closed subscription and does not
      // observe the archive, so it must not exempt the persisted detail.
      let warmEvictions = 0;
      const releaseWarmSnapshot = retainCachedThreadUnsafe(
        cache,
        TARGET.environmentId,
        warmThreadId,
        () => (warmEvictions += 1),
      );
      yield* Effect.addFinalizer(() => Effect.sync(releaseWarmSnapshot));
      yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(
          ShellSnapshotLoader.ShellSnapshotLoader,
          ShellSnapshotLoader.ShellSnapshotLoader.of({
            load: () => Effect.succeed(Option.some(httpSnapshot)),
          }),
        ),
      );

      yield* SubscriptionRef.changes(subscribed).pipe(
        Stream.filter((value) => value),
        Stream.runHead,
      );
      expect(yield* Ref.get(removedThreads)).toEqual([archivedThreadId, warmThreadId]);
      expect(warmEvictions).toBe(1);
      expect(isCachedThreadEvicted(cache, TARGET.environmentId, warmThreadId)).toBe(true);
    }),
  );

  it.effect(
    "keeps a thread archived and restored in one batch through a late archive acknowledgement",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("restored-in-batch");
        const thread = { ...v2ShellSnapshot.threads[0]!, id: threadId };
        const activeSnapshot: OrchestrationV2ShellSnapshot = {
          ...v2ShellSnapshot,
          snapshotSequence: 1,
          threads: [thread],
        };
        const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const subscribed = yield* SubscriptionRef.make(false);
        const archiveStarted = yield* Deferred.make<void>();
        const archiveAcknowledged = yield* Deferred.make<void>();
        const removedThreads = yield* Ref.make<ThreadId[]>([]);
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
            Stream.unwrap(
              SubscriptionRef.set(subscribed, true).pipe(Effect.as(Stream.fromQueue(events))),
            ),
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () =>
            Deferred.succeed(archiveStarted, undefined).pipe(
              Effect.andThen(Deferred.await(archiveAcknowledged)),
              Effect.as({ sequence: 2 }),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: (_environmentId, removedThreadId) =>
            Ref.update(removedThreads, (threadIds) => [...threadIds, removedThreadId]),
          listThreadIds: () => Effect.succeed([]),
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        // The detail subscription closed; only its warm snapshot remains.
        let warmEvictions = 0;
        const releaseWarmSnapshot = retainCachedThreadUnsafe(
          cache,
          TARGET.environmentId,
          threadId,
          () => (warmEvictions += 1),
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseWarmSnapshot));
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          Effect.provideService(
            ShellSnapshotLoader.ShellSnapshotLoader,
            ShellSnapshotLoader.ShellSnapshotLoader.of({
              load: () => Effect.succeed(Option.some(activeSnapshot)),
            }),
          ),
        );
        yield* SubscriptionRef.changes(subscribed).pipe(
          Stream.filter((value) => value),
          Stream.runHead,
        );

        const archive = yield* archiveThreadAndEvictCache({
          commandId: CommandId.make("archive-command"),
          threadId,
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(archiveStarted);

        // This client's archive and another client's unarchive arrive together,
        // so the batch leaves shell membership unchanged.
        yield* Queue.offerAll(events, [
          { kind: "thread.removed", sequence: 2, location: "active", threadId },
          { kind: "thread.updated", sequence: 3, location: "active", thread },
        ]);
        const restored = yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (value) => Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === 3,
          ),
          Stream.runHead,
        );
        expect(
          Option.getOrThrow(Option.getOrThrow(restored).snapshot).threads.map(({ id }) => id),
        ).toEqual([threadId]);

        yield* Deferred.succeed(archiveAcknowledged, undefined);
        expect(yield* Fiber.join(archive)).toEqual({ sequence: 2 });
        expect(isCachedThreadEvicted(cache, TARGET.environmentId, threadId)).toBe(false);
        expect(yield* Ref.get(removedThreads)).toEqual([]);
        expect(warmEvictions).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps a thread an active update restored before the archive acknowledgement", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restored-before-acknowledgement");
      const harness = yield* startArchiveWithLateAcknowledgement(threadId);

      yield* harness.deliverCoalescedRestore;
      expect(yield* harness.acknowledge).toEqual({ sequence: 2 });

      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(false);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
      expect(harness.warm.evictions).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("revives a thread an active update restored after the archive acknowledgement", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restored-after-acknowledgement");
      const harness = yield* startArchiveWithLateAcknowledgement(threadId);

      expect(yield* harness.acknowledge).toEqual({ sequence: 2 });
      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(true);
      const evictedGeneration = cachedThreadGeneration(
        harness.cache,
        TARGET.environmentId,
        threadId,
      );

      yield* harness.deliverCoalescedRestore;

      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(false);
      expect(cachedThreadGeneration(harness.cache, TARGET.environmentId, threadId)).toBeGreaterThan(
        evictedGeneration,
      );
    }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("revives an acknowledged eviction that a sequence reset lists as active", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("reset-after-acknowledgement");
      const harness = yield* startArchiveWithLateAcknowledgement(threadId, 100);

      expect(yield* harness.acknowledge).toEqual({ sequence: 101 });
      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(true);

      yield* harness.deliverResetSnapshot(5);

      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("skips an archive acknowledgement that crosses a sequence reset", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("reset-before-acknowledgement");
      const harness = yield* startArchiveWithLateAcknowledgement(threadId, 100);

      yield* harness.deliverResetSnapshot(5);
      expect(yield* harness.acknowledge).toEqual({ sequence: 101 });

      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(false);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
      expect(harness.warm.evictions).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("evicts on the archive acknowledgement without a later active update", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("archived");
      const harness = yield* startArchiveWithLateAcknowledgement(threadId);

      expect(yield* harness.acknowledge).toEqual({ sequence: 2 });

      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, threadId)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([threadId]);
      expect(harness.warm.evictions).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("resubscribes from the in-memory shell cursor when the app becomes active", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
      const loaderCalls = yield* Ref.make(0);
      const capturedAfterSequences = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {
          readonly afterSequence?: number;
        }) =>
          Stream.unwrap(
            Ref.update(capturedAfterSequences, (captured) => [
              ...captured,
              input.afterSequence,
            ]).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedSome(LIVE_SHELL_SNAPSHOT),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
            Effect.map((count) =>
              Option.some({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: count * 10 }),
            ),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
        Effect.provideService(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
        ),
      );

      // A new session starts from an authoritative HTTP snapshot.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 1) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10]);
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );

      // A newer snapshot arrives on the stream and advances the cursor.
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 40 },
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (value) => Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === 40,
        ),
        Stream.runHead,
      );

      yield* Queue.offer(wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40]);
      yield* Queue.offer(events, { kind: "synchronized" });

      yield* Queue.offer(wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40, 40]);

      yield* Queue.offer(wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect((yield* Ref.get(capturedAfterSequences)).length).toBe(3);
      expect(yield* Ref.get(loaderCalls)).toBe(1);

      // Replacing the session performs another authoritative refresh.
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 4) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40, 40, 20]);
      expect(yield* Ref.get(loaderCalls)).toBe(2);
    }),
  );

  it.effect("throttles shell writes and flushes the latest snapshot on disconnect", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Ref.update(saved, (values) => [...values, snapshot]),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });

      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      const sendSnapshot = Effect.fn(function* (sequence: number) {
        yield* Queue.offer(events, {
          kind: "snapshot",
          snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: sequence },
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (state) =>
              Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === sequence,
          ),
          Stream.runHead,
        );
      });
      yield* sendSnapshot(1);
      yield* TestClock.adjust("500 millis");
      for (let sequence = 2; sequence <= 10; sequence++) {
        yield* sendSnapshot(sequence);
        yield* TestClock.adjust("1 second");
      }
      expect((yield* Ref.get(saved)).map((snapshot) => snapshot.snapshotSequence)).toEqual([1]);
      yield* TestClock.adjust("1 second");
      expect((yield* Ref.get(saved)).map((snapshot) => snapshot.snapshotSequence)).toEqual([1, 10]);
      yield* sendSnapshot(11);
      yield* SubscriptionRef.set(supervisorState, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: false,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "cached"),
        Stream.runHead,
      );
      // The disconnect flush runs independently from the connection-state update.
      yield* TestClock.adjust("0 millis");
      expect((yield* Ref.get(saved)).map((snapshot) => snapshot.snapshotSequence)).toEqual([
        1, 10, 11,
      ]);
    }),
  );

  it.effect("flushes the latest live snapshot without blocking connection state updates", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(Ref.update(saved, (values) => [...values, snapshot])),
          ),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });

      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 2,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* SubscriptionRef.set(supervisorState, {
        desired: false,
        network: "online",
        phase: "available",
        stage: null,
        attempt: 2,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      });
      yield* Deferred.await(saveStarted);

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 100; index += 1) {
        if ((yield* SubscriptionRef.get(shellState)).status === "synchronizing") break;
        yield* Effect.yieldNow;
      }

      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      expect(yield* Ref.get(saved)).toEqual([]);

      yield* Deferred.succeed(releaseSave, undefined);
      for (let index = 0; index < 100; index += 1) {
        if ((yield* Ref.get(saved)).length > 0) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(saved)).toEqual([LIVE_SHELL_SNAPSHOT]);
    }),
  );

  it.effect("re-persists same-sequence enrichment when an older in-flight save completes", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repo.git",
        },
      };
      const unenrichedSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 1,
        projects: [{ ...v2Project, repositoryIdentity: null }],
      };
      const enrichedSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 1,
        projects: [{ ...v2Project, repositoryIdentity }],
      };

      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const unenrichedSaveStarted = yield* Deferred.make<void>();
      const releaseUnenrichedSave = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Effect.gen(function* () {
            if (snapshot.projects[0]?.repositoryIdentity == null) {
              yield* Deferred.succeed(unenrichedSaveStarted, undefined);
              yield* Deferred.await(releaseUnenrichedSave);
            }
            yield* Ref.update(saved, (values) => [...values, snapshot]);
          }),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });

      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: unenrichedSnapshot,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // Disconnect flush starts an immediate persist of the unenriched snapshot
      // (debounced path needs TestClock advancement; flush does not).
      yield* SubscriptionRef.set(supervisorState, {
        desired: false,
        network: "online",
        phase: "available",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* Deferred.await(unenrichedSaveStarted);

      // Same sequence, different content. Session stays open so the stream can
      // still apply enrichment while the older save is in flight.
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: enrichedSnapshot,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) =>
            Option.isSome(state.snapshot) &&
            state.snapshot.value.projects[0]?.repositoryIdentity != null,
        ),
        Stream.runHead,
      );

      // Completing the older same-sequence save must re-persist the latest object.
      yield* Deferred.succeed(releaseUnenrichedSave, undefined);
      for (let index = 0; index < 100; index += 1) {
        const values = yield* Ref.get(saved);
        if (values.length > 0 && values.at(-1)?.projects[0]?.repositoryIdentity != null) {
          break;
        }
        yield* Effect.yieldNow;
      }

      const finalSaved = (yield* Ref.get(saved)).at(-1);
      expect(finalSaved?.snapshotSequence).toBe(1);
      expect(finalSaved?.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    }),
  );

  it.effect("scope teardown flush stays stable while a save is blocked", () =>
    Effect.gen(function* () {
      const lateSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 2,
        projects: [{ ...v2Project, title: "Late stream event" }],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(Ref.update(saved, (values) => [...values, snapshot])),
          ),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });

      const scope = yield* Scope.make();
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
        Scope.provide(scope),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // Close scope so the finalizer flush blocks on save. Workers must be
      // interrupted before that flush; late stream events must not extend it.
      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Deferred.await(saveStarted);
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: lateSnapshot,
      });
      for (let index = 0; index < 50; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(releaseSave, undefined);
      yield* Fiber.join(closeFiber);

      const values = yield* Ref.get(saved);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((snapshot) => snapshot.snapshotSequence === 1)).toBe(true);
      expect(values.every((snapshot) => snapshot.projects[0]?.title !== "Late stream event")).toBe(
        true,
      );
    }),
  );

  it.effect("applies authoritative lower-sequence HTTP resets over client-ahead cache", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 20,
        projects: [{ ...v2Project, title: "Client ahead" }],
      };
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, title: "Server reset" }],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.some(httpSnapshot)),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 4,
        ),
        Stream.runHead,
      );

      const state = yield* SubscriptionRef.get(shellState);
      expect(Option.getOrThrow(state.snapshot).snapshotSequence).toBe(4);
      expect(Option.getOrThrow(state.snapshot).projects[0]?.title).toBe("Server reset");
    }),
  );

  it.effect("fills deferred cached pull request links without overwriting newer rows", () =>
    Effect.gen(function* () {
      const link = (number: number): ThreadPullRequestLink => ({
        host: "github.com",
        repository: "pingdotgg/t3code",
        number,
        url: `https://github.com/pingdotgg/t3code/pull/${number}`,
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      });
      const otherThreadId = ThreadId.make("thread-other");
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        threads: [v2ThreadShell, { ...v2ThreadShell, id: otherThreadId }],
      };
      const linksReady = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () =>
          Effect.succeedSome({
            ...cachedSnapshot,
            loadPullRequests: Deferred.await(linksReady).pipe(
              Effect.as(
                new Map([
                  [v2ThreadShell.id, [link(1)]],
                  [otherThreadId, [link(2)]],
                ]),
              ),
            ),
          }),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // No HTTP snapshot, so the cached rows stay until the socket sends deltas.
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeedNone,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      const threadsOf = (state: {
        readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
      }) => Option.getOrThrow(state.snapshot).threads;
      expect(threadsOf(yield* SubscriptionRef.get(shellState))).toEqual(cachedSnapshot.threads);

      // The server updates one row before the cached links finish decoding.
      const serverRow = { ...v2ThreadShell, title: "From server", pullRequests: [link(9)] };
      yield* Queue.offer(events, {
        kind: "thread.updated",
        sequence: 6,
        location: "active",
        thread: serverRow,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => threadsOf(state)[0]?.title === "From server"),
        Stream.runHead,
      );

      yield* Deferred.succeed(linksReady, undefined);
      const filled = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.map(threadsOf),
        Stream.filter((threads) => threads[1]?.pullRequests !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(filled[0]).toBe(serverRow);
      expect(filled[1]?.pullRequests).toEqual([link(2)]);
    }),
  );

  it.effect("shows HTTP rows before their pull request links and saves them once filled", () =>
    Effect.gen(function* () {
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
      };
      const linksReady = yield* Deferred.make<void>();
      const saved = yield* Queue.unbounded<OrchestrationV2ShellSnapshot>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) => Queue.offer(saved, snapshot),
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          Effect.succeedSome({
            ...httpSnapshot,
            loadPullRequests: Deferred.await(linksReady).pipe(
              Effect.as(new Map([[v2ThreadShell.id, [link]]])),
            ),
          }),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      const rows = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => Option.isSome(state.snapshot)),
        Stream.runHead,
        Effect.map((state) => Option.getOrThrow(Option.getOrThrow(state).snapshot)),
      );
      expect(rows.threads[0]?.pullRequests).toBeUndefined();
      expect(rows).not.toHaveProperty("loadPullRequests");

      yield* Deferred.succeed(linksReady, undefined);
      const filled = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.map((state) => Option.getOrThrow(state.snapshot).threads[0]),
        Stream.filter((thread) => thread?.pullRequests !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(filled?.pullRequests).toEqual([link]);

      // The cache must end up with the links: the last save carries them.
      yield* TestClock.adjust("30 seconds");
      const saves = yield* Queue.takeAll(saved);
      expect(saves.at(-1)?.threads[0]?.pullRequests).toEqual([link]);
    }),
  );

  it.effect("does not save rows whose deferred links are still pending", () =>
    Effect.gen(function* () {
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 8,
        url: "https://github.com/pingdotgg/t3code/pull/8",
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) => Ref.update(saved, (all) => [...all, snapshot]),
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          Effect.succeedSome({
            ...v2ShellSnapshot,
            snapshotSequence: 3,
            // Links never finish decoding before the shell closes.
            loadPullRequests: Effect.never.pipe(Effect.as(new Map([[v2ThreadShell.id, [link]]]))),
          }),
      });
      const scope = yield* Scope.make();
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
        Scope.provide(scope),
      );
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => Option.isSome(state.snapshot)),
        Stream.runHead,
      );

      // Neither the throttled worker nor the closing flush may save the rows without links.
      yield* TestClock.adjust("30 seconds");
      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(saved)).toEqual([]);
    }),
  );

  it.effect("drops an older snapshot's links once a newer snapshot reuses its rows", () =>
    Effect.gen(function* () {
      const link = (number: number): ThreadPullRequestLink => ({
        host: "github.com",
        repository: "pingdotgg/t3code",
        number,
        url: `https://github.com/pingdotgg/t3code/pull/${number}`,
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      });
      const firstLinks = yield* Deferred.make<void>();
      const secondLinks = yield* Deferred.make<void>();
      // Set once each snapshot's links start decoding, i.e. once its rows are applied.
      const firstFillStarted = yield* Deferred.make<void>();
      const loads = yield* Ref.make(0);
      const subscriptions = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(Ref.update(subscriptions, (n) => n + 1).pipe(Effect.as(Stream.never))),
      } as unknown as WsRpcProtocolClient;
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        listThreadIds: () => Effect.succeed([]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // Both snapshots carry the same row; only its pull request links differ.
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          Ref.updateAndGet(loads, (n) => n + 1).pipe(
            Effect.map((n) =>
              Option.some({
                ...v2ShellSnapshot,
                snapshotSequence: n,
                loadPullRequests: (n === 1
                  ? Deferred.succeed(firstFillStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(firstLinks)),
                    )
                  : Deferred.await(secondLinks)
                ).pipe(Effect.as(new Map([[v2ThreadShell.id, [link(n)]]]))),
              }),
            ),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );
      yield* Deferred.await(firstFillStarted);

      // A new session loads a second snapshot that reuses the bare row.
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 2,
        ),
        Stream.runHead,
      );

      // The superseded first fill finishes first, then the second.
      yield* Deferred.succeed(firstLinks, undefined);
      yield* Deferred.succeed(secondLinks, undefined);
      const filled = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.map((state) => Option.getOrThrow(state.snapshot).threads[0]?.pullRequests),
        Stream.filter((links) => links !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(filled).toEqual([link(2)]);
    }),
  );
});

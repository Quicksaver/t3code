import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
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
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { type EnvironmentShellState, makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import {
  v2Project,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "./orchestrationV2TestFixtures.ts";
import {
  cachedThreadGeneration,
  evictCachedThread,
  isCachedThreadEvicted,
  persistCachedThread,
  retainCachedThreadUnsafe,
  retainLiveCachedThread,
  restoreCachedThread,
  observeActiveCachedThreads,
} from "./threadCache.ts";
import { archiveThreadAndEvictCache } from "./threadCommands.ts";
import * as ThreadCache from "./threadCache.ts";

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
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makePersistenceHarness = Effect.fn("test.makeShellPersistenceHarness")(function* (
  saveShell: Persistence.EnvironmentCacheStore["Service"]["saveShell"],
) {
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
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell,
    listThreadIds: () => Effect.succeed([]),
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
      load: () => Effect.succeedNone,
    }),
  );
  const send = Effect.fn("test.sendShellItem")(function* (
    item: OrchestrationV2ShellStreamItem,
    ready: (snapshot: OrchestrationV2ShellSnapshot) => boolean,
  ) {
    const previous = yield* SubscriptionRef.get(state);
    yield* Queue.offer(events, item);
    return yield* SubscriptionRef.changes(state).pipe(
      Stream.filter((value) => value !== previous),
      Stream.map((value) => value.snapshot),
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
      Stream.filter(ready),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });
  yield* send({ kind: "snapshot", snapshot: LIVE_SHELL_SNAPSHOT }, () => true);
  return { state, send };
});

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

  it.effect("skips unchanged shell writes, persists resets and flushes changed rows", () =>
    Effect.gen(function* () {
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makePersistenceHarness((_id, snapshot) =>
            SubscriptionRef.update(saved, (values) => [...values, snapshot]),
          );
          yield* TestClock.adjust("500 millis");
          yield* h.send(
            { kind: "thread.updated", sequence: 10, location: "active", thread: v2ThreadShell },
            (snapshot) => snapshot.snapshotSequence === 10,
          );
          yield* TestClock.adjust("10 seconds");
          expect(
            (yield* SubscriptionRef.get(saved)).map((snapshot) => snapshot.snapshotSequence),
          ).toEqual([1]);
          const live = Option.getOrThrow((yield* SubscriptionRef.get(h.state)).snapshot);
          expect(live.snapshotSequence).toBe(10);
          const enriched = yield* h.send(
            {
              kind: "snapshot",
              snapshot: { ...live, projects: live.projects.map((project) => ({ ...project })) },
              resolvedRepositoryIdentityRoots: live.projects.map(
                (project) => project.workspaceRoot,
              ),
            },
            () => true,
          );
          expect(enriched.projects).toEqual(live.projects);
          expect(enriched.snapshotSequence).toBe(10);
          yield* TestClock.adjust("10 seconds");
          expect(
            (yield* SubscriptionRef.get(saved)).map((snapshot) => snapshot.snapshotSequence),
          ).toEqual([1]);
          yield* h.send(
            { kind: "snapshot", snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 4 } },
            (snapshot) => snapshot.snapshotSequence === 4,
          );
          yield* TestClock.adjust("10 seconds");
          yield* h.send(
            {
              kind: "snapshot",
              snapshot: {
                ...LIVE_SHELL_SNAPSHOT,
                snapshotSequence: 4,
                projects: [{ ...v2Project, title: "Changed at same sequence" }],
              },
            },
            (snapshot) => snapshot.projects[0]?.title === "Changed at same sequence",
          );
        }),
      );
      expect(
        (yield* SubscriptionRef.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.projects[0]?.title,
        ]),
      ).toEqual([
        [1, v2Project.title],
        [4, v2Project.title],
        [4, "Changed at same sequence"],
      ]);
    }),
  );

  it.effect("retries a failed shell save after a cursor-only update", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makePersistenceHarness((_id, snapshot) =>
            Effect.gen(function* () {
              const values = yield* Ref.updateAndGet(attempts, (values) => [
                ...values,
                snapshot.snapshotSequence,
              ]);
              if (values.length === 1)
                return yield* new Persistence.ConnectionPersistenceError({
                  operation: "save-shell",
                  message: "test failure",
                });
            }),
          );
          yield* TestClock.adjust("500 millis");
          yield* h.send(
            { kind: "thread.updated", sequence: 2, location: "active", thread: v2ThreadShell },
            (snapshot) => snapshot.snapshotSequence === 2,
          );
          yield* TestClock.adjust("10 seconds");
        }),
      );
      expect(yield* Ref.get(attempts)).toEqual([1, 2]);
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
            load: () => Effect.succeedSome(httpSnapshot),
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
            load: () => Effect.succeedSome(httpSnapshot),
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
              load: () => Effect.succeedSome(activeSnapshot),
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

  it.effect("flushes the latest live snapshot without blocking connection state updates", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
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
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(SubscriptionRef.update(saved, (values) => [...values, snapshot])),
          ),
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
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "synchronizing"),
        Stream.runHead,
      );

      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      expect(yield* SubscriptionRef.get(saved)).toEqual([]);

      yield* Deferred.succeed(releaseSave, undefined);
      yield* SubscriptionRef.changes(saved).pipe(
        Stream.filter((values) => values.length > 0),
        Stream.runHead,
      );

      expect(yield* SubscriptionRef.get(saved)).toEqual([LIVE_SHELL_SNAPSHOT]);
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
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
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
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) =>
          Effect.gen(function* () {
            if (snapshot.projects[0]?.repositoryIdentity == null) {
              yield* Deferred.succeed(unenrichedSaveStarted, undefined);
              yield* Deferred.await(releaseUnenrichedSave);
            }
            yield* SubscriptionRef.update(saved, (values) => [...values, snapshot]);
          }),
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

      yield* Deferred.succeed(releaseUnenrichedSave, undefined);
      yield* SubscriptionRef.changes(saved).pipe(
        Stream.filter((values) => values.at(-1)?.projects[0]?.repositoryIdentity != null),
        Stream.runHead,
      );

      const finalSaved = (yield* SubscriptionRef.get(saved)).at(-1);
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
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
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
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(SubscriptionRef.update(saved, (values) => [...values, snapshot])),
          ),
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
        load: () => Effect.succeedNone,
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

      const values = yield* SubscriptionRef.get(saved);
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
        load: () => Effect.succeedSome(httpSnapshot),
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

  it.effect.each([
    "supported",
    "unsupported",
    "failed",
    "stale",
    "live",
    "revived",
    "newer-active",
  ] as const)(
    "%s membership validation preserves active omissions and cleans disconnected archives",
    (mode) =>
      Effect.gen(function* () {
        const archived = ThreadId.make("archived-offline");
        const omitted = ThreadId.make("older-settled-active");
        const savedOnly = ThreadId.make("archived-without-shell-cache");
        const removed = yield* Ref.make<ThreadId[]>([]);
        const checked = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
        const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const activeIds = yield* Ref.make([omitted]);
        const savedIds = yield* Ref.make([archived, omitted, savedOnly]);
        const subscribed = yield* Deferred.make<void>();
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
            Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
            ),
          "orchestration.getActiveThreadIds": (input: { threadIds: ReadonlyArray<ThreadId> }) =>
            Ref.set(checked, input.threadIds).pipe(
              Effect.andThen(
                mode === "failed"
                  ? Effect.fail({ _tag: "MembershipLookupFailed" as const })
                  : Effect.void,
              ),
              Effect.andThen(
                mode === "revived"
                  ? restoreCachedThread(cache, TARGET.environmentId, archived)
                  : Effect.void,
              ),
              Effect.andThen(
                mode === "newer-active"
                  ? Effect.sync(() =>
                      observeActiveCachedThreads(cache, TARGET.environmentId, [archived], 4, false),
                    )
                  : Effect.void,
              ),
              Effect.andThen(Ref.get(activeIds)),
              Effect.map((threadIds) => ({
                snapshotSequence: mode === "stale" ? 0 : 3,
                threadIds,
              })),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
            Option.some({
              ...session(client),
              initialConfig: Effect.succeed({
                shellResumeCompletionMarker: true,
                shellThreadFamilies: true,
                shellOlderSettled: true,
                shellThreadMembership: mode !== "unsupported",
              } as never),
            }),
          ),
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () =>
            Effect.succeedSome({
              ...LIVE_SHELL_SNAPSHOT,
              threads: [archived, omitted].map((id) => ({ ...v2ThreadShell, id })),
            }),
          saveShell: () => Effect.void,
          listThreadIds: () => Ref.get(savedIds),
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: (_environmentId, threadId) =>
            Ref.update(removed, (ids) => [...ids, threadId]),
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        if (mode === "live") yield* retainLiveCachedThread(cache, TARGET.environmentId, archived);
        if (mode === "newer-active") {
          const release = retainCachedThreadUnsafe(cache, TARGET.environmentId, archived);
          yield* Effect.addFinalizer(() => Effect.sync(release));
        }
        const state = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
            load: () => Effect.succeedSome({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 2 }),
          }),
        );
        yield* Deferred.await(subscribed);
        const current = yield* SubscriptionRef.get(state);
        if (mode === "unsupported" || mode === "failed" || mode === "stale") {
          expect(yield* Ref.get(removed)).toEqual([]);
          expect(current.removedAt.size).toBe(0);
          if (mode === "unsupported") expect(yield* Ref.get(checked)).toEqual([]);
          return;
        }
        expect(yield* Ref.get(removed)).toEqual(
          mode === "supported" ? [archived, savedOnly] : [savedOnly],
        );
        expect(current.removedAt.get(archived)).toBe(
          mode === "supported" || mode === "live" ? 3 : undefined,
        );
        expect(new Set(yield* Ref.get(checked))).toEqual(new Set([archived, omitted, savedOnly]));
        expect(current.removedAt.has(omitted)).toBe(false);
        expect(Option.getOrThrow(current.snapshot).threads).toEqual(LIVE_SHELL_SNAPSHOT.threads);
        // Even without a saved detail, the omitted UI baseline needs validation on reconnect.
        yield* Ref.set(savedIds, []);
        yield* Ref.set(activeIds, []);
        yield* Queue.offer(events, {
          kind: "snapshot",
          snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 3 },
        });
        yield* SubscriptionRef.changes(state).pipe(
          Stream.filter((value) => value.removedAt.has(omitted)),
          Stream.runHead,
        );
        expect(yield* Ref.get(removed)).toEqual(
          mode === "supported" ? [archived, savedOnly, omitted] : [savedOnly, omitted],
        );
        yield* Queue.offer(events, {
          kind: "thread.updated",
          sequence: 4,
          location: "active",
          thread: { ...v2ThreadShell, id: omitted },
        });
        yield* SubscriptionRef.changes(state).pipe(
          Stream.filter((value) =>
            Option.exists(value.snapshot, (snapshot) => snapshot.snapshotSequence === 4),
          ),
          Stream.runHead,
        );
        expect(isCachedThreadEvicted(cache, TARGET.environmentId, omitted)).toBe(false);
      }),
  );

  it.effect.each(["membership", "detail"] as const)(
    "%s revival cancels a failed membership eviction retry",
    (revival) =>
      Effect.gen(function* () {
        const threadId = v2ThreadShell.id;
        const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const subscribed = yield* Deferred.make<void>();
        const activeIds = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
        const removals = yield* Ref.make(0);
        const saves = yield* Ref.make(0);
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
            Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
            ),
          [ORCHESTRATION_V2_WS_METHODS.getActiveThreadIds]: () =>
            Ref.get(activeIds).pipe(
              Effect.map((threadIds) => ({ snapshotSequence: 2, threadIds })),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
            Option.some({
              ...session(client),
              initialConfig: Effect.succeed({
                shellThreadFamilies: true,
                shellThreadMembership: true,
              } as never),
            }),
          ),
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedSome(LIVE_SHELL_SNAPSHOT),
          saveShell: () => Effect.void,
          listThreadIds: () => Effect.succeed([threadId]),
          loadThread: () => Effect.succeedNone,
          saveThread: () => Ref.update(saves, (count) => count + 1),
          removeThread: () =>
            Ref.updateAndGet(removals, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.fail(
                      new Persistence.ConnectionPersistenceError({
                        operation: "remove-thread",
                        message: "temporary failure",
                      }),
                    )
                  : Effect.void,
              ),
            ),
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        const shell = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
            load: () =>
              Effect.succeedSome({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 2, threads: [] }),
          }),
        );
        yield* Deferred.await(subscribed);
        expect(yield* Ref.get(removals)).toBe(1);
        expect(isCachedThreadEvicted(cache, TARGET.environmentId, threadId)).toBe(true);
        const generation = (yield* SubscriptionRef.get(shell)).generation;
        if (revival === "membership") {
          yield* Ref.set(activeIds, [threadId]);
          yield* Queue.offer(events, {
            kind: "snapshot",
            snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 2, threads: [] },
          });
        } else {
          yield* restoreCachedThread(cache, TARGET.environmentId, threadId);
          yield* retainLiveCachedThread(cache, TARGET.environmentId, threadId);
          observeActiveCachedThreads(cache, TARGET.environmentId, [threadId], 4, false);
          yield* persistCachedThread(
            cache,
            TARGET.environmentId,
            { snapshotSequence: 4, projection: v2Projection },
            cachedThreadGeneration(cache, TARGET.environmentId, threadId),
          );
          yield* Queue.offer(events, { kind: "project.updated", sequence: 3, project: v2Project });
        }
        yield* SubscriptionRef.changes(shell).pipe(
          Stream.filter((value) =>
            revival === "membership"
              ? value.generation > generation
              : Option.exists(value.snapshot, (snapshot) => snapshot.snapshotSequence === 3),
          ),
          Stream.runHead,
        );
        expect(yield* Ref.get(removals)).toBe(1);
        expect(isCachedThreadEvicted(cache, TARGET.environmentId, threadId)).toBe(false);
        yield* persistCachedThread(
          cache,
          TARGET.environmentId,
          { snapshotSequence: 4, projection: v2Projection },
          cachedThreadGeneration(cache, TARGET.environmentId, threadId),
        );
        expect(yield* Ref.get(saves)).toBe(revival === "detail" ? 2 : 1);
      }),
  );

  it.effect("membership revival preserves a newer archive queued behind persistence", () =>
    Effect.gen(function* () {
      const threadId = v2ThreadShell.id;
      const writeStarted = yield* Deferred.make<void>();
      const finishWrite = yield* Deferred.make<void>();
      const revive = ThreadCache.reviveCachedThread;
      // Queue a newer archive after the shell's generation check but before revival gets the lock.
      using _revive = vi.spyOn(ThreadCache, "reviveCachedThread").mockImplementation((...args) =>
        Effect.gen(function* () {
          const write = yield* persistCachedThread(
            cache,
            TARGET.environmentId,
            { snapshotSequence: 1, projection: v2Projection },
            0,
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(writeStarted);
          const archive = yield* evictCachedThread(
            cache,
            TARGET.environmentId,
            threadId,
            () => true,
            3,
          ).pipe(Effect.forkChild({ startImmediately: true }));
          const revival = yield* revive(...args).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(finishWrite, undefined);
          yield* Fiber.join(write);
          yield* Fiber.join(archive);
          yield* Fiber.join(revival);
        }),
      );
      const subscribed = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.never))),
        [ORCHESTRATION_V2_WS_METHODS.getActiveThreadIds]: () =>
          Effect.succeed({ snapshotSequence: 2, threadIds: [threadId] }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some({
            ...session(client),
            initialConfig: Effect.succeed({
              shellThreadFamilies: true,
              shellThreadMembership: true,
            } as never),
          }),
        ),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedSome(LIVE_SHELL_SNAPSHOT),
        saveShell: () => Effect.void,
        listThreadIds: () => Effect.succeed([threadId]),
        loadThread: () => Effect.succeedNone,
        saveThread: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishWrite)),
          ),
        removeThread: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-thread",
              message: "temporary failure",
            }),
          ),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const release = retainCachedThreadUnsafe(cache, TARGET.environmentId, threadId);
      yield* Effect.addFinalizer(() => Effect.sync(release));
      yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
          load: () =>
            Effect.succeedSome({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 2, threads: [] }),
        }),
      );
      yield* Deferred.await(subscribed);
      expect(isCachedThreadEvicted(cache, TARGET.environmentId, threadId)).toBe(true);
      expect(cachedThreadGeneration(cache, TARGET.environmentId, threadId)).toBe(1);
      expect(
        yield* persistCachedThread(
          cache,
          TARGET.environmentId,
          { snapshotSequence: 2, projection: v2Projection },
          1,
        ),
      ).toBe(false);
    }),
  );

  it.effect("opts in to shell omissions and counts authoritative snapshots and removals", () =>
    Effect.gen(function* () {
      const removedDetails = yield* Ref.make<ThreadId[]>([]);
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const subscribeInput = yield* Deferred.make<unknown>();
      const loadOptions = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: unknown) =>
          Stream.unwrap(
            Deferred.succeed(subscribeInput, input).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const familySession: RpcSession.RpcSession = {
        ...session(client),
        initialConfig: Effect.succeed({
          shellResumeCompletionMarker: true,
          shellThreadFamilies: true,
          shellOlderSettled: true,
        } as never),
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(familySession)),
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
        removeThread: (_environmentId, threadId) =>
          Ref.update(removedDetails, (ids) => [...ids, threadId]),
        listThreadIds: () => Effect.succeed([ThreadId.make("omitted-idle-child")]),
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: (_prepared, options) =>
          Ref.update(loadOptions, (all) => [...all, options]).pipe(
            Effect.as(Option.some(LIVE_SHELL_SNAPSHOT)),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );
      const stateWhere = (predicate: (state: EnvironmentShellState) => boolean) =>
        SubscriptionRef.changes(shellState).pipe(Stream.filter(predicate), Stream.runHead);

      // Both transports must omit, or omitted children would come back through the socket.
      expect(yield* Deferred.await(subscribeInput)).toMatchObject({
        afterSequence: 1,
        omitIdleSubagents: true,
        omitOlderSettled: true,
      });
      expect(yield* Ref.get(loadOptions)).toEqual([
        { omitIdleSubagents: true, omitOlderSettled: true },
      ]);
      const loaded = Option.getOrThrow(yield* stateWhere((state) => state.generation > 0));
      expect(loaded.removedAt.size).toBe(0);
      expect(yield* Ref.get(removedDetails)).toEqual([]);

      const gone = ThreadId.make("thread-gone");
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, threads: [] },
        resolvedRepositoryIdentityRoots: [],
      });
      yield* Queue.offer(events, {
        kind: "thread.removed",
        sequence: 2,
        location: "active",
        threadId: gone,
      });
      const removed = Option.getOrThrow(yield* stateWhere((state) => state.removedAt.size > 0));
      // An enrichment refresh is not authoritative.
      expect(removed.generation).toBe(loaded.generation);
      expect(removed.removedAt.get(gone)).toBe(2);
      expect(yield* Ref.get(removedDetails)).toEqual([gone]);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 5, threads: [] },
      });
      const reset = Option.getOrThrow(
        yield* stateWhere((state) => state.generation > loaded.generation),
      );
      expect(reset.removedAt.size).toBe(0);
      expect(yield* Ref.get(removedDetails)).toEqual([gone]);
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

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 2,
        ),
        Stream.runHead,
      );

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

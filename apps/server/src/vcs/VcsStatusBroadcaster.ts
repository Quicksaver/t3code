import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsProcess from "./VcsProcess.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const VCS_STATUS_WATCH_IGNORED_ROOTS = new Set([".git"]);

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

interface ActiveLocalWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export interface VcsStatusBroadcasterShape {
  readonly getStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: VcsStatusInput,
    options?: StreamStatusOptions,
  ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  VcsStatusBroadcasterShape
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

function watchEventPath(path: Path.Path, rawCwd: string, eventPath: string): string | null {
  const relativePath = path.isAbsolute(eventPath) ? path.relative(rawCwd, eventPath) : eventPath;
  if (!relativePath || relativePath === ".") return null;
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join("/");
}

export function shouldIgnoreWatchEventPath(relativePath: string): boolean {
  const [rootSegment] = relativePath.split("/");
  return rootSegment ? VCS_STATUS_WATCH_IGNORED_ROOTS.has(rootSegment) : false;
}

export function localWatchRefreshSignals<E, R, R2>(
  relativePaths: Stream.Stream<string, E, R>,
  shouldRefreshForPaths: (relativePaths: readonly string[]) => Effect.Effect<boolean, never, R2>,
  debounceDuration: Duration.Duration = Duration.millis(150),
): Stream.Stream<void, E, R | R2> {
  return relativePaths.pipe(
    Stream.filter((relativePath) => !shouldIgnoreWatchEventPath(relativePath)),
    Stream.groupedWithin(512, debounceDuration),
    Stream.map((paths) => [...new Set(paths)]),
    Stream.filter((paths) => paths.length > 0),
    Stream.filterEffect(shouldRefreshForPaths),
    Stream.map(() => undefined),
  );
}

export const layer = Layer.effect(
  VcsStatusBroadcaster,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* Effect.serviceOption(VcsProcess.VcsProcess);
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<VcsStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
    const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
    const watchersRef = yield* SynchronizedRef.make(new Map<string, ActiveLocalWatcher>());

    const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
      cwd: string,
    ) {
      return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
    });

    const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
      function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
        const nextLocal = {
          fingerprint: fingerprintStatusPart(local),
          value: local,
        } satisfies CachedValue<VcsStatusLocalResult>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            local: nextLocal,
          });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "localUpdated",
              local,
            },
          });
        }

        return local;
      },
    );

    const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
      function* (
        cwd: string,
        remote: VcsStatusRemoteResult | null,
        options?: { publish?: boolean },
      ) {
        const nextRemote = {
          fingerprint: fingerprintStatusPart(remote),
          value: remote,
        } satisfies CachedValue<VcsStatusRemoteResult | null>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            remote: nextRemote,
          });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "remoteUpdated",
              remote,
            },
          });
        }

        return remote;
      },
    );

    const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
      cwd: string,
      local: VcsStatusLocalResult,
      remote: VcsStatusRemoteResult | null,
      options?: { publish?: boolean },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          local: nextLocal,
          remote: nextRemote,
        });
        return [
          previous.local?.fingerprint !== nextLocal.fingerprint ||
            previous.remote?.fingerprint !== nextRemote.fingerprint,
          nextCache,
        ] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "snapshot",
            local,
            remote,
          },
        });
      }

      return mergeGitStatusParts(local, remote);
    });

    const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
      cwd: string,
    ) {
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local);
    });

    const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
      cwd: string,
    ) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(cwd);
    });

    const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

    const getStatus: VcsStatusBroadcasterShape["getStatus"] = Effect.fn(
      "VcsStatusBroadcaster.getStatus",
    )(function* (input) {
      const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local && cached.remote) {
        return mergeGitStatusParts(cached.local.value, cached.remote.value);
      }
      const [local, remote] = yield* Effect.all(
        [
          cached?.local ? Effect.succeed(cached.local.value) : workflow.localStatus({ cwd }),
          cached?.remote ? Effect.succeed(cached.remote.value) : workflow.remoteStatus({ cwd }),
        ],
        { concurrency: "unbounded" },
      );
      return yield* updateCachedStatus(cwd, local, remote);
    });

    const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
      function* (cwd: string) {
        yield* workflow.invalidateLocalStatus(cwd);
        const local = yield* workflow.localStatus({ cwd });
        return yield* updateCachedLocalStatus(cwd, local, { publish: true });
      },
    );

    const refreshLocalStatus: VcsStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshLocalStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* refreshLocalStatusCore(cwd);
    });

    const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
      cwd: string,
      options?: { readonly refreshUpstream?: boolean },
    ) {
      if (options?.refreshUpstream !== false) {
        yield* workflow.invalidateRemoteStatus(cwd);
      }
      const remote = yield* workflow.remoteStatus({ cwd }, options);
      return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
    });

    const refreshStatus: VcsStatusBroadcasterShape["refreshStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      yield* Effect.all(
        [workflow.invalidateLocalStatus(cwd), workflow.invalidateRemoteStatus(cwd)],
        { concurrency: "unbounded", discard: true },
      );
      const [local, remote] = yield* Effect.all(
        [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
        { concurrency: "unbounded" },
      );
      return yield* updateCachedStatus(cwd, local, remote, { publish: true });
    });

    const makeRemoteRefreshLoop = (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
      refreshImmediately: boolean,
    ) => {
      return Effect.gen(function* () {
        const consecutiveFailuresRef = yield* Ref.make(0);
        const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
        const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          const activeInterval = Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval;
          const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
          if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
            return activeInterval;
          }

          const exit = yield* refreshRemoteStatus(cwd, {
            refreshUpstream: !Duration.isZero(configuredInterval),
          }).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            yield* Ref.set(needsInitialRefreshRef, false);
            yield* Ref.set(consecutiveFailuresRef, 0);
            return activeInterval;
          }

          const consecutiveFailures = yield* Ref.updateAndGet(
            consecutiveFailuresRef,
            (count) => count + 1,
          );
          const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
          yield* Effect.logWarning("VCS remote status refresh failed", {
            cwd,
            detail: exit.cause.toString(),
            consecutiveFailures,
            nextDelayMs: Duration.toMillis(nextDelay),
          });
          return nextDelay;
        });

        if (!refreshImmediately) {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          yield* Effect.sleep(
            Duration.isZero(configuredInterval)
              ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
              : configuredInterval,
          );
        }

        return yield* refreshRemoteStatusIfEnabled.pipe(
          Effect.repeat(
            Schedule.identity<Duration.Duration>().pipe(
              Schedule.addDelay((delay) => Effect.succeed(delay)),
            ),
          ),
          Effect.asVoid,
        );
      });
    };

    const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
      refreshImmediately: boolean,
    ) {
      yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
        const existing = activePollers.get(cwd);
        if (existing) {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextPollers] as const);
        }

        return makeRemoteRefreshLoop(cwd, automaticRemoteRefreshInterval, refreshImmediately).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              fiber,
              subscriberCount: 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      });
    });

    const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
      cwd: string,
    ) {
      const pollerToInterrupt = yield* SynchronizedRef.modify(pollersRef, (activePollers) => {
        const existing = activePollers.get(cwd);
        if (!existing) {
          return [null, activePollers] as const;
        }

        if (existing.subscriberCount > 1) {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount - 1,
          });
          return [null, nextPollers] as const;
        }

        const nextPollers = new Map(activePollers);
        nextPollers.delete(cwd);
        return [existing.fiber, nextPollers] as const;
      });

      if (pollerToInterrupt) {
        yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
      }
    });

    const makeLocalWatchLoop = (cwd: string) =>
      localWatchRefreshSignals(
        fs.watch(cwd).pipe(
          Stream.map((event) => watchEventPath(path, cwd, event.path)),
          Stream.filter((relativePath): relativePath is string => relativePath !== null),
        ),
        (relativePaths) =>
          Option.match(vcsProcess, {
            onNone: () => Effect.succeed(true),
            onSome: (process) =>
              process
                .run({
                  operation: "VcsStatusBroadcaster.watch.checkIgnore",
                  command: "git",
                  args: ["check-ignore", "-z", "--stdin"],
                  cwd,
                  stdin: `${relativePaths.join("\0")}\0`,
                  allowNonZeroExit: true,
                  timeoutMs: 5_000,
                  maxOutputBytes: 1_000_000,
                })
                .pipe(
                  Effect.map((result) => {
                    if (result.exitCode !== 0) return true;
                    const ignoredPaths = new Set(
                      result.stdout.split("\0").filter((ignoredPath) => ignoredPath.length > 0),
                    );
                    return relativePaths.some((relativePath) => !ignoredPaths.has(relativePath));
                  }),
                  Effect.orElseSucceed(() => true),
                ),
          }),
      ).pipe(
        Stream.runForEach(() => refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }))),
        Effect.ignoreCause({ log: true }),
      );

    const retainLocalWatcher = Effect.fn("VcsStatusBroadcaster.retainLocalWatcher")(function* (
      cwd: string,
    ) {
      yield* SynchronizedRef.modifyEffect(watchersRef, (activeWatchers) => {
        const existing = activeWatchers.get(cwd);
        if (existing) {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextWatchers] as const);
        }

        return makeLocalWatchLoop(cwd).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextWatchers = new Map(activeWatchers);
            nextWatchers.set(cwd, {
              fiber,
              subscriberCount: 1,
            });
            return [undefined, nextWatchers] as const;
          }),
        );
      });
    });

    const releaseLocalWatcher = Effect.fn("VcsStatusBroadcaster.releaseLocalWatcher")(function* (
      cwd: string,
    ) {
      const watcherToInterrupt = yield* SynchronizedRef.modify(watchersRef, (activeWatchers) => {
        const existing = activeWatchers.get(cwd);
        if (!existing) {
          return [null, activeWatchers] as const;
        }

        if (existing.subscriberCount > 1) {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount - 1,
          });
          return [null, nextWatchers] as const;
        }

        const nextWatchers = new Map(activeWatchers);
        nextWatchers.delete(cwd);
        return [existing.fiber, nextWatchers] as const;
      });

      if (watcherToInterrupt) {
        yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
      }
    });

    const streamStatus: VcsStatusBroadcasterShape["streamStatus"] = (input, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const initialLocal = yield* getOrLoadLocalStatus(cwd);
          const cachedStatus = yield* getCachedStatus(cwd);
          const initialRemote = cachedStatus?.remote?.value ?? null;
          yield* retainRemotePoller(
            cwd,
            options?.automaticRemoteRefreshInterval ??
              Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
          yield* retainLocalWatcher(cwd);

          const release = Effect.all([releaseRemotePoller(cwd), releaseLocalWatcher(cwd)], {
            concurrency: "unbounded",
          }).pipe(Effect.ignore, Effect.asVoid);

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.cwd === cwd),
              Stream.map((event) => event.event),
            ),
          ).pipe(Stream.ensuring(release));
        }),
      );

    return VcsStatusBroadcaster.of({
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    });
  }),
);

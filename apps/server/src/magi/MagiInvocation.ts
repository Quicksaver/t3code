import { MagiValidationError, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

const NativeCursor = Schema.Struct({ threadId: Schema.String });
const NativeChild = Schema.Struct({
  id: ThreadId,
  modelSelection: Schema.Struct({ instanceId: ProviderInstanceId }),
  parentRelation: Schema.Struct({
    kind: Schema.Literal("subagent"),
    parentThreadId: ThreadId,
    providerThreadId: Schema.String,
  }),
});
const decodeNativeCursor = Schema.decodeUnknownOption(NativeCursor);
const decodeNativeChild = Schema.decodeUnknownOption(NativeChild);

const unavailable = (scope: McpInvocationScope, reason: string) =>
  Effect.logWarning("Magi native caller routing failed", {
    threadId: scope.threadId,
    nativeThreadId:
      typeof scope.nativeThreadId === "string"
        ? scope.nativeThreadId.slice(0, 128)
        : typeof scope.nativeThreadId,
    reason,
  }).pipe(
    Effect.andThen(
      Effect.fail(
        new MagiValidationError({
          reason: "invalid-protocol-state",
          message:
            "Magi could not resolve the native caller within this credential's conversation. Retry after the child conversation is registered.",
          field: null,
        }),
      ),
    ),
  );

/** Resolve inherited Codex credentials without granting access outside their native child tree. */
export const resolveMagiInvocation = Effect.fn("Magi.resolveInvocation")(
  function* <E, E2>(
    scope: McpInvocationScope,
    dependencies: {
      readonly getBinding: (
        threadId: ThreadId,
      ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, E>;
      readonly getThreads: () => Effect.Effect<ReadonlyArray<unknown>, E2>;
    },
  ) {
    if (scope.nativeThreadId === undefined) return scope;
    const binding = yield* dependencies
      .getBinding(scope.threadId)
      .pipe(Effect.catch(() => unavailable(scope, "binding-read-failed")));
    if (Option.isNone(binding)) return yield* unavailable(scope, "binding-missing");
    if (binding.value.providerInstanceId !== scope.providerInstanceId) {
      return yield* unavailable(scope, "provider-instance-mismatch");
    }
    // Other providers retain their credential routing; threadId is Codex request metadata.
    if (binding.value.provider !== "codex") return scope;
    if (typeof scope.nativeThreadId !== "string" || scope.nativeThreadId.trim().length === 0) {
      return yield* unavailable(scope, "invalid-native-id");
    }
    const cursor = decodeNativeCursor(binding.value.resumeCursor);
    if (Option.isSome(cursor) && cursor.value.threadId === scope.nativeThreadId) return scope;

    const threads = yield* dependencies
      .getThreads()
      .pipe(Effect.catch(() => unavailable(scope, "lineage-read-failed")));
    const children = threads.flatMap((thread) => {
      const child = decodeNativeChild(thread);
      return Option.isSome(child) &&
        child.value.modelSelection.instanceId === scope.providerInstanceId
        ? [child.value]
        : [];
    });
    const byId = new Map(children.map((child) => [child.id, child]));
    const matches = children.filter((child) => {
      if (child.parentRelation.providerThreadId !== scope.nativeThreadId) return false;
      const visited = new Set<ThreadId>();
      let current: typeof child | undefined = child;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.parentRelation.parentThreadId === scope.threadId) return true;
        current = byId.get(current.parentRelation.parentThreadId);
      }
      return false;
    });
    if (matches.length !== 1)
      return yield* unavailable(
        scope,
        matches.length === 0 ? "caller-not-registered" : "ambiguous-caller",
      );
    return { ...scope, threadId: matches[0]!.id };
  },
  (effect, scope) =>
    effect.pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () => unavailable(scope, "lookup-timeout")),
    ),
);

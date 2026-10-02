import { MagiValidationError, type ThreadId, type MagiNativeOwner } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

export type MagiCaller =
  | ThreadId
  | { readonly threadId: ThreadId; readonly nativeOwner: MagiNativeOwner };
export const magiCallerThreadId = (caller: MagiCaller) =>
  typeof caller === "string" ? caller : caller.threadId;
export const magiCallerNativeOwner = (caller: MagiCaller) =>
  typeof caller === "string" ? null : caller.nativeOwner;
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const magiCallerKey = (caller: MagiCaller) =>
  encodeKey([
    magiCallerThreadId(caller),
    magiCallerNativeOwner(caller)?.providerInstanceId ?? null,
    magiCallerNativeOwner(caller)?.nativeThreadId ?? null,
  ]);
export const magiInvocationCaller = (scope: McpInvocationScope): MagiCaller =>
  typeof scope.nativeThreadId === "string"
    ? {
        threadId: scope.threadId,
        nativeOwner: {
          nativeThreadId: scope.nativeThreadId,
          providerInstanceId: scope.providerInstanceId,
        },
      }
    : scope.threadId;
const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.String }));
const unavailable = () =>
  new MagiValidationError({
    reason: "invalid-protocol-state",
    message:
      "Magi could not verify this native caller's ancestry and context within the credential's provider session.",
    field: null,
  });
const rejectNativeCaller = (scope: McpInvocationScope, reason: string, error = unavailable()) =>
  Effect.logWarning("Magi native caller rejected", {
    threadId: scope.threadId,
    providerInstanceId: scope.providerInstanceId,
    nativeThreadId:
      typeof scope.nativeThreadId === "string" ? scope.nativeThreadId.slice(0, 128) : null,
    reason,
  }).pipe(Effect.andThen(Effect.fail(error)));

/** Authenticate native descendants at the provider boundary, independently of T3 conversations. */
export const resolveMagiInvocation = Effect.fn("Magi.resolveInvocation")(
  function* <E, E2>(
    scope: McpInvocationScope,
    dependencies: {
      readonly getBinding: (
        threadId: ThreadId,
      ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, E>;
      readonly verifyNativeCaller: (
        threadId: ThreadId,
        nativeThreadId: string,
      ) => Effect.Effect<unknown, E2>;
    },
  ) {
    if (scope.nativeThreadId === undefined) return scope;
    const binding = yield* dependencies
      .getBinding(scope.threadId)
      .pipe(Effect.catch(() => rejectNativeCaller(scope, "binding-read-failed")));
    if (Option.isNone(binding)) return yield* rejectNativeCaller(scope, "binding-missing");
    if (binding.value.providerInstanceId !== scope.providerInstanceId)
      return yield* rejectNativeCaller(scope, "provider-instance-mismatch");
    if (binding.value.provider !== "codex")
      return yield* rejectNativeCaller(
        scope,
        "unsupported-provider",
        new MagiValidationError({
          reason: "invalid-protocol-state",
          message: "This provider does not support verified native Magi caller identities.",
          field: null,
        }),
      );
    if (
      typeof scope.nativeThreadId !== "string" ||
      !scope.nativeThreadId.trim() ||
      scope.nativeThreadId.length > 512
    )
      return yield* rejectNativeCaller(scope, "invalid-native-id");
    const cursor = decodeCursor(binding.value.resumeCursor);
    if (Option.isSome(cursor) && cursor.value.threadId === scope.nativeThreadId)
      return { ...scope, nativeThreadId: undefined };
    yield* dependencies
      .verifyNativeCaller(scope.threadId, scope.nativeThreadId)
      .pipe(Effect.catch(() => rejectNativeCaller(scope, "ancestry-verification-failed")));
    return scope;
  },
  (effect, scope) =>
    effect.pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag("TimeoutError", () => rejectNativeCaller(scope, "lookup-timeout")),
    ),
);

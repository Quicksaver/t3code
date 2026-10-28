import { expect, it } from "@effect/vitest";
import { ContextArtifactId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { MagiService } from "../../../magi/MagiService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ContextArtifactToolkitHandlersLive } from "../context/handlers.ts";
import { ContextArtifactToolkit } from "../context/tools.ts";
import { MagiToolkitHandlersLive } from "./handlers.ts";
import { MagiToolkit } from "./tools.ts";

const clientDependencies = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session",
    thread: undefined,
    client: { sessionId: "session", label: "External agent", access: "full-access" },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
  Layer.mock(MagiService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
);

it.effect("a full-access OAuth client cannot use a conversation's Magi tools", () =>
  Effect.gen(function* () {
    const toolkit = yield* MagiToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(MagiToolkitHandlersLive).pipe(
          Layer.provide(clientDependencies),
        ),
      ),
    );
    for (const name of ["magi_get_options", "magi_list_context_activities"] as const) {
      const results = yield* toolkit
        .handle(name, {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(clientDependencies));
      expect(results.at(-1)).toMatchObject({
        isFailure: true,
        result: { reason: "invalid-protocol-state", field: null },
      });
      expect(results.at(-1)?.result).toHaveProperty(
        "message",
        expect.stringContaining("inside T3 Code"),
      );
    }
  }),
);

it.effect("a full-access OAuth client cannot read conversation-scoped context artifacts", () =>
  Effect.gen(function* () {
    const toolkit = yield* ContextArtifactToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ContextArtifactToolkitHandlersLive).pipe(
          Layer.provide(clientDependencies),
        ),
      ),
    );
    const results = yield* toolkit
      .handle("context_read", {
        artifactIds: [ContextArtifactId.make("artifact:private")],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(clientDependencies));
    expect(results.at(-1)).toMatchObject({
      isFailure: true,
      result: { reason: "invalid-protocol-state", field: null },
    });
    expect(results.at(-1)?.result).toHaveProperty(
      "message",
      expect.stringContaining("inside T3 Code"),
    );
  }),
);

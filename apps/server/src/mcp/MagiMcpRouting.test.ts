import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { resolveMagiInvocation } from "../magi/MagiInvocation.ts";
import * as ServerConfig from "../config.ts";
import * as MagiControlBroker from "./MagiControlBroker.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "routes native caller metadata per HTTP call even when parent and children share a bearer and MCP session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("parent"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "credential",
          issuedAt: 0,
          capabilities: new Set(["magi-control"]),
        };
        yield* MagiControlBroker.installActiveHandlers({
          ...MagiControlBroker.proxy,
          resolveInvocation: (scope) =>
            resolveMagiInvocation(scope, {
              getBinding: () =>
                Effect.succeed(
                  Option.some({
                    threadId: owner.threadId,
                    provider: ProviderDriverKind.make("codex"),
                    providerInstanceId: owner.providerInstanceId,
                    resumeCursor: { threadId: "native-parent" },
                  }),
                ),
              getThreads: () =>
                Effect.succeed(
                  ["child-a", "child-b"].map((id) => ({
                    id,
                    modelSelection: { instanceId: "codex" },
                    parentRelation: {
                      kind: "subagent",
                      parentThreadId: "parent",
                      providerThreadId: `native-${id}`,
                    },
                  })),
                ),
            }),
          listContextActivities: (scope) =>
            Effect.succeed({
              activities: [
                {
                  activityId: EventId.make(`${scope.threadId}-evidence`),
                  turnId: TurnId.make(`${scope.threadId}-turn`),
                  kind: "tool.completed",
                  summary: `${scope.threadId} marker`,
                  byteLength: 32,
                },
              ],
            }),
        });
        yield* HttpRouter.serve(
          McpHttpServer.layer.pipe(
            Layer.provide(
              Layer.succeed(McpSessionRegistry.McpSessionRegistry, {
                issue: () => Effect.die("unused"),
                resolve: (token) => Effect.succeed(token === "test-bearer" ? owner : undefined),
                touch: () => Effect.void,
                revokeAll: Effect.void,
                revokeProviderSession: () => Effect.void,
                revokeThread: () => Effect.void,
              }),
            ),
            Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-magi-routing-test-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);
        const client = yield* HttpClient.HttpClient;
        const headers = {
          authorization: "Bearer test-bearer",
          accept: "application/json, text/event-stream",
        };
        const initialized = yield* client.post("/mcp/magi", {
          headers,
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "codex", version: "test" },
              },
            }),
            "application/json",
          ),
        });
        expect(initialized.status).toBe(200);
        const initializationBody = yield* initialized.text;
        expect(initializationBody).toContain("protocolVersion");
        const session = initialized.headers["mcp-session-id"]!;
        const invoke = (nativeThreadId: unknown, id: number) =>
          client
            .post("/mcp/magi", {
              headers: {
                ...headers,
                "mcp-session-id": session,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id,
                  method: "tools/call",
                  params: {
                    name: "magi_list_context_activities",
                    arguments: {},
                    _meta: { threadId: nativeThreadId },
                  },
                }),
                "application/json",
              ),
            })
            .pipe(
              Effect.flatMap((response) => {
                expect(response.status).toBe(200);
                return response.text;
              }),
            );
        const results = yield* Effect.all(
          ["parent", "child-a", "child-b"].map((id, index) => invoke(`native-${id}`, index + 2)),
          { concurrency: "unbounded" },
        );
        for (const [index, id] of ["parent", "child-a", "child-b"].entries()) {
          expect(results[index]).toContain(`${id}-evidence`);
          for (const other of ["parent", "child-a", "child-b"].filter((value) => value !== id)) {
            expect(results[index]).not.toContain(`${other}-evidence`);
          }
        }
        for (const nativeThreadId of ["native-foreign", 42, ""]) {
          const result = yield* invoke(nativeThreadId, 10);
          expect(result).toContain('"isError":true');
          expect(result).not.toContain("parent-evidence");
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

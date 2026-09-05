import * as NodeAssert from "node:assert/strict";

import { ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";

import {
  codexSubagentChildrenFromNotification,
  type CodexSubagentRoutingInfo,
  rememberCodexSubagentRoutes,
  resolveCodexSubagentRoute,
} from "./CodexSubagentRouting.ts";

type RoutingNotification = Parameters<typeof rememberCodexSubagentRoutes>[1];

function subagentActivity(input: {
  readonly itemId: string;
  readonly providerParentThreadId: string;
  readonly providerChildThreadId: string;
  readonly turnId: string;
  readonly agentPath: string;
  readonly kind: "started" | "interacted" | "interrupted";
}): RoutingNotification {
  return {
    method: "item/completed",
    params: {
      threadId: input.providerParentThreadId,
      turnId: input.turnId,
      completedAtMs: 1_767_225_600_000,
      item: {
        id: input.itemId,
        type: "subAgentActivity",
        agentThreadId: input.providerChildThreadId,
        agentPath: input.agentPath,
        kind: input.kind,
      },
    },
  } as RoutingNotification;
}

describe("CodexSubagentRouting", () => {
  it("routes multi-agent v2 activity and child events into a deterministic child thread", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const parentThreadId = ThreadId.make("local-parent");
    const notification = subagentActivity({
      itemId: "activity-1",
      providerParentThreadId: "provider-parent",
      providerChildThreadId: "provider-child",
      turnId: "parent-turn",
      agentPath: "/root/protocol_audit",
      kind: "started",
    });

    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      notification,
      TurnId.make("parent-turn"),
      parentThreadId,
    );

    const route = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.ok(route);
    NodeAssert.equal(route.parentThreadId, parentThreadId);
    NodeAssert.equal(route.parentTurnId, "parent-turn");
    NodeAssert.equal(route.parentItemId, "activity-1");
    NodeAssert.match(route.childThreadId, /^subagent_/);
    NodeAssert.equal(route.detail, "/root/protocol_audit");
    NodeAssert.equal(route.source, "subAgentActivity");
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, notification, routeAccepted),
      [
        {
          providerThreadId: "provider-child",
          childThreadId: route.childThreadId,
          parentItemId: "activity-1",
          titleSeed: "/root/protocol_audit",
          startsChildTurn: true,
        },
      ],
    );
    NodeAssert.equal(resolveCodexSubagentRoute(routes, "provider-unknown"), undefined);
  });

  it("uses a threaded child as the direct parent of nested v2 activity", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "child-activity",
        providerParentThreadId: "provider-root",
        providerChildThreadId: "provider-child",
        turnId: "root-turn",
        agentPath: "/root/child",
        kind: "started",
      }),
      TurnId.make("root-turn"),
      rootThreadId,
    );
    const child = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.ok(child);

    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "grandchild-activity",
        providerParentThreadId: "provider-child",
        providerChildThreadId: "provider-grandchild",
        turnId: "child-turn",
        agentPath: "/root/child/grandchild",
        kind: "started",
      }),
      TurnId.make("child-turn"),
      child.childThreadId,
    );

    const grandchild = resolveCodexSubagentRoute(routes, "provider-grandchild");
    NodeAssert.ok(grandchild);
    NodeAssert.equal(grandchild.parentThreadId, child.childThreadId);
    NodeAssert.notEqual(grandchild.childThreadId, child.childThreadId);
  });

  it("does not route an ancestor interaction as a child of the current subagent", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "child-activity",
        providerParentThreadId: "provider-root",
        providerChildThreadId: "provider-child",
        turnId: "root-turn",
        agentPath: "/root/child",
        kind: "started",
      }),
      TurnId.make("root-turn"),
      rootThreadId,
    );
    const child = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.ok(child);

    const ancestorInteraction = subagentActivity({
      itemId: "ancestor-interaction",
      providerParentThreadId: "provider-child",
      providerChildThreadId: "provider-root",
      turnId: "child-turn",
      agentPath: "/root",
      kind: "interacted",
    });
    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      ancestorInteraction,
      TurnId.make("child-turn"),
      child.childThreadId,
    );

    NodeAssert.equal(resolveCodexSubagentRoute(routes, "provider-root"), undefined);
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, ancestorInteraction, routeAccepted),
      [],
    );
  });

  it("does not reparent an existing descendant when an ancestor interacts with it", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "child-activity",
        providerParentThreadId: "provider-root",
        providerChildThreadId: "provider-child",
        turnId: "root-turn",
        agentPath: "/root/child",
        kind: "started",
      }),
      TurnId.make("root-turn"),
      rootThreadId,
    );
    const child = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.ok(child);
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "grandchild-activity",
        providerParentThreadId: "provider-child",
        providerChildThreadId: "provider-grandchild",
        turnId: "child-turn",
        agentPath: "/root/child/grandchild",
        kind: "started",
      }),
      TurnId.make("child-turn"),
      child.childThreadId,
    );
    const grandchild = resolveCodexSubagentRoute(routes, "provider-grandchild");
    NodeAssert.ok(grandchild);

    const ancestorInteraction = subagentActivity({
      itemId: "ancestor-grandchild-interaction",
      providerParentThreadId: "provider-root",
      providerChildThreadId: "provider-grandchild",
      turnId: "root-followup-turn",
      agentPath: "/root/child/grandchild",
      kind: "interacted",
    });
    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      ancestorInteraction,
      TurnId.make("root-followup-turn"),
      rootThreadId,
    );

    NodeAssert.equal(routeAccepted, false);
    NodeAssert.equal(
      resolveCodexSubagentRoute(routes, "provider-grandchild")?.parentThreadId,
      child.childThreadId,
    );
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, ancestorInteraction, routeAccepted),
      [],
    );
  });

  it("only infers a direct root child when the route map has not seen the sender", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    const directInteraction = subagentActivity({
      itemId: "unknown-child-interaction",
      providerParentThreadId: "provider-root",
      providerChildThreadId: "provider-child",
      turnId: "root-turn",
      agentPath: "/root/child",
      kind: "interacted",
    });
    NodeAssert.equal(
      rememberCodexSubagentRoutes(
        routes,
        directInteraction,
        TurnId.make("root-turn"),
        rootThreadId,
      ),
      true,
    );
    NodeAssert.ok(resolveCodexSubagentRoute(routes, "provider-child"));

    const descendantInteraction = subagentActivity({
      itemId: "unknown-grandchild-interaction",
      providerParentThreadId: "provider-root",
      providerChildThreadId: "provider-grandchild",
      turnId: "root-turn",
      agentPath: "/root/child/grandchild",
      kind: "interacted",
    });

    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      descendantInteraction,
      TurnId.make("root-turn"),
      rootThreadId,
    );

    NodeAssert.equal(routeAccepted, false);
    NodeAssert.equal(resolveCodexSubagentRoute(routes, "provider-grandchild"), undefined);
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, descendantInteraction, routeAccepted),
      [],
    );
  });

  it("does not reparent an existing child when a different parent reports it as started", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "child-activity",
        providerParentThreadId: "provider-root",
        providerChildThreadId: "provider-child",
        turnId: "root-turn",
        agentPath: "/root/child",
        kind: "started",
      }),
      TurnId.make("root-turn"),
      rootThreadId,
    );
    const initialRoute = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.ok(initialRoute);
    rememberCodexSubagentRoutes(
      routes,
      subagentActivity({
        itemId: "other-parent-activity",
        providerParentThreadId: "provider-root",
        providerChildThreadId: "provider-other-parent",
        turnId: "root-turn",
        agentPath: "/root/other-parent",
        kind: "started",
      }),
      TurnId.make("root-turn"),
      rootThreadId,
    );
    const otherParentRoute = resolveCodexSubagentRoute(routes, "provider-other-parent");
    NodeAssert.ok(otherParentRoute);

    const duplicateStart = subagentActivity({
      itemId: "duplicate-child-activity",
      providerParentThreadId: "provider-other-parent",
      providerChildThreadId: "provider-child",
      turnId: "other-turn",
      agentPath: "/root/other-parent/child",
      kind: "started",
    });
    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      duplicateStart,
      TurnId.make("other-turn"),
      otherParentRoute.childThreadId,
    );

    NodeAssert.equal(routeAccepted, false);
    NodeAssert.deepStrictEqual(resolveCodexSubagentRoute(routes, "provider-child"), initialRoute);
  });

  it("does not emit an already-known sibling for a rejected interaction", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const rootThreadId = ThreadId.make("local-root");
    for (const [itemId, providerChildThreadId, agentPath] of [
      ["child-a-activity", "provider-child-a", "/root/child-a"],
      ["child-b-activity", "provider-child-b", "/root/child-b"],
    ] as const) {
      rememberCodexSubagentRoutes(
        routes,
        subagentActivity({
          itemId,
          providerParentThreadId: "provider-root",
          providerChildThreadId,
          turnId: "root-turn",
          agentPath,
          kind: "started",
        }),
        TurnId.make("root-turn"),
        rootThreadId,
      );
    }
    const childA = resolveCodexSubagentRoute(routes, "provider-child-a");
    NodeAssert.ok(childA);

    const siblingInteraction = subagentActivity({
      itemId: "sibling-interaction",
      providerParentThreadId: "provider-child-a",
      providerChildThreadId: "provider-child-b",
      turnId: "child-a-turn",
      agentPath: "/root/child-b",
      kind: "interacted",
    });
    const routeAccepted = rememberCodexSubagentRoutes(
      routes,
      siblingInteraction,
      TurnId.make("child-a-turn"),
      childA.childThreadId,
    );

    NodeAssert.equal(routeAccepted, false);
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, siblingInteraction, routeAccepted),
      [],
    );
  });

  it("preserves the legacy single-receiver fallback for mismatched child notification ids", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const parentThreadId = ThreadId.make("local-parent");
    const notification = {
      method: "item/completed",
      params: {
        threadId: "provider-parent",
        turnId: "parent-turn",
        completedAtMs: 1_767_225_600_000,
        item: {
          id: "legacy-spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "provider-parent",
          receiverThreadIds: ["provider-child"],
          prompt: "Inspect routing",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    } as RoutingNotification;
    rememberCodexSubagentRoutes(routes, notification, TurnId.make("parent-turn"), parentThreadId);

    const fallback = resolveCodexSubagentRoute(
      routes,
      "provider-child-event-alias",
      "provider-parent",
    );
    NodeAssert.ok(fallback);
    NodeAssert.equal(fallback.providerThreadId, "provider-child");
    NodeAssert.equal(
      resolveCodexSubagentRoute(routes, "provider-parent", "provider-parent"),
      undefined,
    );
  });

  it("records interaction without starting a child turn and preserves it on interruption", () => {
    const routes = new Map<string, CodexSubagentRoutingInfo>();
    const parentThreadId = ThreadId.make("local-parent");
    const started = subagentActivity({
      itemId: "activity-started",
      providerParentThreadId: "provider-parent",
      providerChildThreadId: "provider-child",
      turnId: "turn-1",
      agentPath: "/root/child",
      kind: "started",
    });
    rememberCodexSubagentRoutes(routes, started, TurnId.make("turn-1"), parentThreadId);
    const initialChildThreadId = resolveCodexSubagentRoute(routes, "provider-child")?.childThreadId;

    const interacted = subagentActivity({
      itemId: "activity-interacted",
      providerParentThreadId: "provider-parent",
      providerChildThreadId: "provider-child",
      turnId: "turn-2",
      agentPath: "/root/child",
      kind: "interacted",
    });
    const interactionAccepted = rememberCodexSubagentRoutes(
      routes,
      interacted,
      TurnId.make("turn-2"),
      parentThreadId,
    );
    NodeAssert.equal(
      resolveCodexSubagentRoute(routes, "provider-child")?.parentItemId,
      ProviderItemId.make("activity-interacted"),
    );
    NodeAssert.deepStrictEqual(
      codexSubagentChildrenFromNotification(routes, interacted, interactionAccepted),
      [
        {
          providerThreadId: "provider-child",
          childThreadId: initialChildThreadId,
          parentItemId: "activity-interacted",
          titleSeed: "/root/child",
          startsChildTurn: false,
        },
      ],
    );

    const interrupted = subagentActivity({
      itemId: "activity-interrupted",
      providerParentThreadId: "provider-parent",
      providerChildThreadId: "provider-child",
      turnId: "turn-3",
      agentPath: "/root/child",
      kind: "interrupted",
    });
    rememberCodexSubagentRoutes(routes, interrupted, TurnId.make("turn-3"), parentThreadId);
    const finalRoute = resolveCodexSubagentRoute(routes, "provider-child");
    NodeAssert.equal(finalRoute?.childThreadId, initialChildThreadId);
    NodeAssert.equal(finalRoute?.parentItemId, "activity-interacted");
    NodeAssert.equal(finalRoute?.parentTurnId, "turn-2");
  });
});

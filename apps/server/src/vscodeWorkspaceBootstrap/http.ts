import {
  AuthOrchestrationOperateScope,
  DesktopBootstrapWorkspaceFolder,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { bootstrapVscodeWorkspaces, VscodeWorkspaceBootstrapError } from "./bootstrap.ts";

const VscodeWorkspaceBootstrapRequest = Schema.Struct({
  workspaceFolders: Schema.Array(DesktopBootstrapWorkspaceFolder),
  activeWorkspaceFolderKey: Schema.optional(TrimmedNonEmptyString),
});

const bootstrapErrorStatus = (
  status: VscodeWorkspaceBootstrapError["status"],
): 400 | 401 | 403 | 500 =>
  status === 400 || status === 401 || status === 403 || status === 500 ? status : 500;

const respondToBootstrapError = (error: VscodeWorkspaceBootstrapError) =>
  Effect.gen(function* () {
    const status = bootstrapErrorStatus(error.status);
    if (status === 500) {
      yield* Effect.logError("VS Code workspace bootstrap route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      { error: status === 500 ? "Internal server error" : error.message },
      { status },
    );
  });

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.mapError(
      (cause) =>
        new VscodeWorkspaceBootstrapError({
          message: "Authentication required to bootstrap VS Code workspaces.",
          status: 401,
          cause,
        }),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* new VscodeWorkspaceBootstrapError({
      message: "Insufficient scope to bootstrap VS Code workspaces.",
      status: 403,
    });
  }
  return session;
});

export const vscodeWorkspaceBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/vscode/workspace-bootstrap",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(VscodeWorkspaceBootstrapRequest).pipe(
      Effect.mapError(
        (cause) =>
          new VscodeWorkspaceBootstrapError({
            message: "Invalid VS Code workspace bootstrap request.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* bootstrapVscodeWorkspaces(input);
    return HttpServerResponse.jsonUnsafe(result);
  }).pipe(
    Effect.catchTags({
      VscodeWorkspaceBootstrapError: respondToBootstrapError,
    }),
  ),
);

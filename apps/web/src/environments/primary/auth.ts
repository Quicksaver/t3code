import type {
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthBearerBootstrapResult,
  AuthClientMetadata,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionId,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "@t3tools/contracts";

import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export class BootstrapHttpError extends Data.TaggedError("BootstrapHttpError")<{
  readonly message: string;
  readonly status: number;
}> {}
const isBootstrapHttpError = (u: unknown): u is BootstrapHttpError =>
  Predicate.isTagged(u, "BootstrapHttpError");

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie" | "bearer-session-token";
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: {
  readonly bootstrapCredential: string | null;
  readonly promise: Promise<ServerAuthGateState>;
} | null = null;
let resolvedAuthenticatedGateState: {
  readonly bootstrapCredential: string | null;
  readonly state: ServerAuthGateState;
} | null = null;
let hostBearerToken: {
  readonly bootstrapCredential: string;
  readonly sessionToken: string;
} | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() === url.toString()) {
    return;
  }
  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

function getHostBootstrap() {
  return (
    window.t3HostBridge?.getLocalEnvironmentBootstrap() ??
    window.desktopBridge?.getLocalEnvironmentBootstrap() ??
    null
  );
}

function getHostBootstrapCredential(): string | null {
  const bootstrap = getHostBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

function getInjectedBearerToken(): string | null {
  const bootstrap = window.t3HostBridge?.getLocalEnvironmentBootstrap();
  return typeof bootstrap?.bearerToken === "string" && bootstrap.bearerToken.length > 0
    ? bootstrap.bearerToken
    : null;
}

function getActiveBearerToken(): string | null {
  const bootstrapCredential = getHostBootstrapCredential();
  if (hostBearerToken && hostBearerToken.bootstrapCredential !== bootstrapCredential) {
    hostBearerToken = null;
  }

  return hostBearerToken?.sessionToken ?? getInjectedBearerToken();
}

function shouldUseBearerSessionAuth(): boolean {
  return window.t3HostBridge !== undefined;
}

function makePrimaryAuthRequestInit(input?: {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
}): RequestInit {
  const headers: Record<string, string> = {};
  if (input?.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const bearerToken = getActiveBearerToken();
  if (bearerToken && isValidBearerToken(bearerToken)) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  return {
    ...(input?.method ? { method: input.method } : {}),
    ...(input?.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(!headers.authorization && !shouldUseBearerSessionAuth()
      ? { credentials: "include" as RequestCredentials }
      : {}),
  };
}

export async function fetchSessionState(): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    const response = await fetch(
      resolvePrimaryEnvironmentHttpUrl("/api/auth/session"),
      makePrimaryAuthRequestInit(),
    );
    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server auth session state (${response.status}).`,
        status: response.status,
      });
    }
    return (await response.json()) as AuthSessionState;
  });
}

async function readErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text();
  return text || fallbackMessage;
}

const INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES = new Set([
  "Invalid bootstrap credential.",
  "Unknown bootstrap credential.",
]);

function parseBootstrapErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    // Not JSON; fall back to plain text.
  }

  return trimmed;
}

function toFriendlyBootstrapErrorMessage(status: number, message: string): string {
  const parsedMessage = parseBootstrapErrorMessage(message);
  if (status === 401 && INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES.has(parsedMessage)) {
    return "Invalid pairing token. Check the token and try again.";
  }

  return parsedMessage;
}

async function exchangeBootstrapCredentialForBearerSession(
  credential: string,
): Promise<AuthBearerBootstrapResult> {
  return retryTransientBootstrap(async () => {
    const payload: AuthBootstrapInput = { credential };
    const response = await fetch(
      resolvePrimaryEnvironmentHttpUrl("/api/auth/bootstrap/bearer"),
      makePrimaryAuthRequestInit({
        body: payload,
        method: "POST",
      }),
    );

    if (!response.ok) {
      const message = toFriendlyBootstrapErrorMessage(response.status, await response.text());
      throw new BootstrapHttpError({
        message: message || `Failed to bootstrap auth session (${response.status}).`,
        status: response.status,
      });
    }

    const result = (await response.json()) as AuthBearerBootstrapResult;
    const activeBootstrapCredential = getHostBootstrapCredential();
    if (activeBootstrapCredential === null || activeBootstrapCredential === credential) {
      hostBearerToken = {
        bootstrapCredential: credential,
        sessionToken: result.sessionToken,
      };
    }
    return result;
  });
}

async function exchangeBootstrapCredentialForBrowserSession(
  credential: string,
): Promise<AuthBootstrapResult> {
  return retryTransientBootstrap(async () => {
    const payload: AuthBootstrapInput = { credential };
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/bootstrap"), {
      body: JSON.stringify(payload),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      const message = toFriendlyBootstrapErrorMessage(response.status, await response.text());
      throw new BootstrapHttpError({
        message: message || `Failed to bootstrap auth session (${response.status}).`,
        status: response.status,
      });
    }

    return (await response.json()) as AuthBootstrapResult;
  });
}

async function exchangeBootstrapCredential(credential: string): Promise<AuthBootstrapResult> {
  return shouldUseBearerSessionAuth()
    ? await exchangeBootstrapCredentialForBearerSession(credential)
    : await exchangeBootstrapCredentialForBrowserSession(credential);
}

async function issuePrimaryWebSocketToken(bearerToken: string): Promise<AuthWebSocketTokenResult> {
  if (!isValidBearerToken(bearerToken)) {
    throw new Error("Invalid bearer token.");
  }

  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/ws-token"), {
    headers: {
      authorization: `Bearer ${bearerToken}`,
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to issue websocket token (${response.status}).`),
    );
  }

  return (await response.json()) as AuthWebSocketTokenResult;
}

function isValidBearerToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && !/[\r\n]/.test(token);
}

export async function resolvePrimaryEnvironmentWebSocketConnectionUrl(
  wsBaseUrl: string,
): Promise<string> {
  const bearerToken = getActiveBearerToken();
  if (!bearerToken) {
    return wsBaseUrl;
  }

  const issued = await issuePrimaryWebSocketToken(bearerToken);
  const url = new URL(wsBaseUrl, window.location.origin);
  // VS Code webviews cannot set arbitrary WebSocket headers or subprotocol
  // credentials reliably, so localhost bearer sessions use a short-lived
  // one-time token in the URL. The backend only accepts these tokens on the
  // local environment connection.
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();
    if (session.authenticated) {
      return session;
    }

    if (Date.now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new Error("Timed out waiting for authenticated session after bootstrap.");
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isBootstrapHttpError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const bootstrapCredential = getHostBootstrapCredential();
  const currentSession = await fetchSessionState();
  if (currentSession.authenticated) {
    return { status: "authenticated" };
  }

  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    await waitForAuthenticatedSessionAfterBootstrap();
    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new Error("Enter a pairing token to continue.");
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

export async function createServerPairingCredential(
  label?: string,
): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = label?.trim();
  const payload: AuthCreatePairingCredentialInput = trimmedLabel ? { label: trimmedLabel } : {};
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-token"),
    makePrimaryAuthRequestInit({
      body: payload,
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to create pairing credential (${response.status}).`),
    );
  }

  return (await response.json()) as AuthPairingCredentialResult;
}

export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links"),
    makePrimaryAuthRequestInit(),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load pairing links (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerPairingLinkRecord>;
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  const payload: AuthRevokePairingLinkInput = { id };
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links/revoke"),
    makePrimaryAuthRequestInit({
      body: payload,
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke pairing link (${response.status}).`),
    );
  }
}

export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients"),
    makePrimaryAuthRequestInit(),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load paired clients (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerClientSessionRecord>;
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  const payload: AuthRevokeClientSessionInput = { sessionId };
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke"),
    makePrimaryAuthRequestInit({
      body: payload,
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke client session (${response.status}).`),
    );
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke-others"),
    makePrimaryAuthRequestInit({ method: "POST" }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to revoke other client sessions (${response.status}).`,
      ),
    );
  }

  const result = (await response.json()) as { revokedCount?: number };
  return result.revokedCount ?? 0;
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  const bootstrapCredential = getHostBootstrapCredential();
  if (
    resolvedAuthenticatedGateState?.bootstrapCredential === bootstrapCredential &&
    resolvedAuthenticatedGateState.state.status === "authenticated"
  ) {
    return resolvedAuthenticatedGateState.state;
  }

  if (bootstrapPromise?.bootstrapCredential === bootstrapCredential) {
    return bootstrapPromise.promise;
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = { bootstrapCredential, promise: nextPromise };
  return nextPromise
    .then(async (result) => {
      if (getHostBootstrapCredential() !== bootstrapCredential) {
        return await resolveInitialServerAuthGateState();
      }
      if (result.status === "authenticated") {
        resolvedAuthenticatedGateState = { bootstrapCredential, state: result };
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise?.promise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
  hostBearerToken = null;
}

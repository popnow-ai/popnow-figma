import { randomToken, sha256 } from "./encoding";

/**
 * Sign-in with a PopNow account from a Figma plugin: OAuth 2.1 authorization code with PKCE and a
 * dynamically registered public client, the same flow MCP clients use against https://api.popnow.ai/mcp.
 *
 * A plugin cannot receive a redirect, so the redirect goes to PopNow Connect (https://connect.popnow.ai),
 * which keeps the code under `state = base64url(sha256(nonce))` for five minutes. The plugin knows the
 * nonce and claims the code with it; the browser only ever sees the hash. The code is useless without the
 * PKCE verifier, which never leaves the plugin. No API key is involved and the relay never sees a token.
 */

export const DEFAULT_MCP_URL = "https://api.popnow.ai/mcp";
export const DEFAULT_RELAY_URL = "https://connect.popnow.ai";
export const SCOPES = "generate read";
export const CLIENT_NAME = "PopNow for Figma";
export const CLAIM_INTERVAL_MS = 1500;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

/** What the plugin keeps in figma.clientStorage. Never shown, never logged. */
export interface AccountSession {
  issuer: string;
  mcpUrl: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Unix milliseconds; absent when the server did not say. */
  expiresAt?: number;
  scope?: string;
}

export type Fetch = typeof fetch;

export class SignInError extends Error {
  constructor(
    message: string,
    readonly reason: "canceled" | "denied" | "timeout" | "failed" | "insecure" = "failed",
  ) {
    super(message);
    this.name = "SignInError";
  }
}

async function getJson(fetchImpl: Fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new SignInError(`PopNow sign-in is unavailable (${response.status})`);
  return (await response.json()) as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new SignInError(`the sign-in server did not return ${what}`);
  return value;
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** Only https, except a server on this computer (for local testing). */
export function requireSecure(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new SignInError(`${what} must use https: ${url.origin}`, "insecure");
  }
  return url;
}

const trimSlash = (value: string): string => value.replace(/\/$/, "");

/** Finds the authorization server from the MCP endpoint's protected-resource metadata (RFC 9728). */
export async function discover(fetchImpl: Fetch, mcpUrl: string): Promise<AuthServer> {
  const mcp = requireSecure(mcpUrl, "the PopNow server");
  const resourceMeta = await getJson(
    fetchImpl,
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
  );
  const servers = resourceMeta.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : mcp.origin;
  requireSecure(issuer, "the sign-in server");
  const meta = await getJson(fetchImpl, `${trimSlash(issuer)}/.well-known/oauth-authorization-server`);
  const declared = str(meta.issuer, "an issuer");
  if (trimSlash(declared) !== trimSlash(issuer)) {
    throw new SignInError("the sign-in server's metadata does not match it (issuer mismatch)", "insecure");
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    requireSecure(str(meta[key], key.replace(/_/g, " ")), "the sign-in server");
  }
  const revocation = meta.revocation_endpoint;
  if (typeof revocation === "string") requireSecure(revocation, "the sign-in server");
  return {
    issuer: declared,
    authorizationEndpoint: str(meta.authorization_endpoint, "an authorization endpoint"),
    tokenEndpoint: str(meta.token_endpoint, "a token endpoint"),
    registrationEndpoint: str(meta.registration_endpoint, "a registration endpoint"),
    ...(typeof revocation === "string" ? { revocationEndpoint: revocation } : {}),
  };
}

export async function registerClient(fetchImpl: Fetch, server: AuthServer, redirectUri: string): Promise<string> {
  const response = await fetchImpl(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
  });
  if (!response.ok) throw new SignInError(`PopNow did not register the plugin (${response.status})`);
  return str(((await response.json()) as Record<string, unknown>).client_id, "a client id");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256(verifier) };
}

export function authorizeUrl(
  server: AuthServer,
  options: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  return url.toString();
}

interface TokenReply {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

async function tokenRequest(fetchImpl: Fetch, endpoint: string, form: Record<string, string>): Promise<TokenReply> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const reply = (await response.json().catch(() => ({}))) as TokenReply;
  if (!response.ok || typeof reply.access_token !== "string") {
    const reason = typeof reply.error === "string" ? reply.error : String(response.status);
    throw new SignInError(`the sign-in server refused the request (${reason})`);
  }
  return reply;
}

function sessionFrom(reply: TokenReply, base: Omit<AccountSession, "accessToken">, now: number): AccountSession {
  const expiresIn = typeof reply.expires_in === "number" ? reply.expires_in : undefined;
  const session: AccountSession = { ...base, accessToken: reply.access_token as string };
  if (typeof reply.refresh_token === "string") session.refreshToken = reply.refresh_token;
  if (expiresIn !== undefined) session.expiresAt = now + expiresIn * 1000;
  if (typeof reply.scope === "string") session.scope = reply.scope;
  return session;
}

/** Resolves after `ms`, or rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SignInError("sign-in was canceled", "canceled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SignInError("sign-in was canceled", "canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ClaimOptions {
  fetch: Fetch;
  relayUrl: string;
  nonce: string;
  issuer: string;
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Polls PopNow Connect until the browser came back. A reply from an unexpected issuer is dropped and the
 * wait goes on (the slot is free again, so the real reply can still land); a refused sign-in ends it.
 */
export async function claimCode(options: ClaimOptions): Promise<string> {
  const relay = requireSecure(options.relayUrl, "the sign-in relay");
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const interval = options.intervalMs ?? CLAIM_INTERVAL_MS;
  for (;;) {
    if (options.signal?.aborted) throw new SignInError("sign-in was canceled", "canceled");
    let response: Response | undefined;
    try {
      response = await options.fetch(`${relay.origin}/oauth/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ nonce: options.nonce }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw new SignInError("sign-in was canceled", "canceled");
      response = undefined; // offline for a moment: keep trying until the deadline
      void error;
    }
    if (response?.status === 200) {
      const body = (await response.json().catch(() => ({}))) as { code?: unknown; iss?: unknown; error?: unknown };
      if (body.error === "access_denied") throw new SignInError("sign-in was canceled in the browser", "denied");
      if (typeof body.error === "string") throw new SignInError("sign-in did not finish; try again", "failed");
      const issOk = body.iss === null || body.iss === undefined || (typeof body.iss === "string" && trimSlash(body.iss) === trimSlash(options.issuer));
      if (typeof body.code === "string" && body.code && issOk) return body.code;
    } else if (response && response.status !== 404 && response.status !== 429 && response.status < 500) {
      throw new SignInError(`the sign-in relay refused the request (${response.status})`);
    }
    if (now() + interval > deadline) throw new SignInError("sign-in timed out; try again", "timeout");
    await sleep(interval, options.signal);
  }
}

export interface LoginOptions {
  fetch: Fetch;
  mcpUrl?: string;
  relayUrl?: string;
  /** Opens the sign-in page in the browser (figma.openExternal through the plugin's main thread). */
  openUrl: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface PendingLogin {
  /** The sign-in link, so the user can open it again. */
  url: string;
  session: Promise<AccountSession>;
}

/** Starts a sign-in: registers the plugin, opens the browser and waits for the code through the relay. */
export async function startLogin(options: LoginOptions): Promise<PendingLogin> {
  const mcpUrl = options.mcpUrl ?? DEFAULT_MCP_URL;
  const relay = requireSecure(options.relayUrl ?? DEFAULT_RELAY_URL, "the sign-in relay");
  const redirectUri = `${relay.origin}/oauth/callback`;
  const server = await discover(options.fetch, mcpUrl);
  const clientId = await registerClient(options.fetch, server, redirectUri);
  const { verifier, challenge } = await pkcePair();
  const nonce = randomToken(32);
  const state = await sha256(nonce);
  const url = authorizeUrl(server, { clientId, redirectUri, state, challenge, resource: mcpUrl });
  await options.openUrl(url);
  const session = (async () => {
    const code = await claimCode({
      fetch: options.fetch,
      relayUrl: relay.origin,
      nonce,
      issuer: server.issuer,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.now ? { now: options.now } : {}),
    });
    const reply = await tokenRequest(options.fetch, server.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: mcpUrl,
    });
    return sessionFrom(
      reply,
      {
        issuer: server.issuer,
        mcpUrl,
        tokenEndpoint: server.tokenEndpoint,
        ...(server.revocationEndpoint === undefined ? {} : { revocationEndpoint: server.revocationEndpoint }),
        clientId,
      },
      (options.now ?? Date.now)(),
    );
  })();
  return { url, session };
}

/** Uses the refresh token; throws when there is none or the server refuses it. */
export async function refresh(fetchImpl: Fetch, session: AccountSession, now: number = Date.now()): Promise<AccountSession> {
  if (!session.refreshToken) throw new SignInError("your PopNow sign-in expired");
  const reply = await tokenRequest(fetchImpl, session.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: session.mcpUrl,
  });
  const { accessToken: _old, ...base } = session;
  void _old;
  return sessionFrom(reply, base, now);
}

/** Best effort: a failed revocation never blocks signing out. */
export async function revoke(fetchImpl: Fetch, session: AccountSession): Promise<boolean> {
  if (!session.revocationEndpoint) return false;
  let ok = true;
  for (const [token, hint] of [
    [session.refreshToken, "refresh_token"],
    [session.accessToken, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      const response = await fetchImpl(session.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: session.clientId }).toString(),
      });
      ok &&= response.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** A stored session is only used when it has every field the client needs. */
export function validSession(value: unknown): AccountSession | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Partial<AccountSession>;
  for (const key of ["accessToken", "clientId", "tokenEndpoint", "mcpUrl", "issuer"] as const) {
    if (typeof v[key] !== "string" || !v[key]) return undefined;
  }
  return v as AccountSession;
}

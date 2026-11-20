import { refresh, type AccountSession, type Fetch } from "./oauth";

/**
 * A small Streamable HTTP MCP client for the PopNow account server (https://api.popnow.ai/mcp).
 * The server is stateless: initialize once per client, then call tools. A 401 refreshes the token once.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface McpContent {
  type: string;
  text?: string;
  uri?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The sign-in is gone (refresh refused or missing): the UI shows "Sign in again". */
export class SignInRequiredError extends Error {
  constructor(message = "Your PopNow sign-in expired") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/** PopNow could not be reached at all (offline, DNS, blocked). */
export class OfflineError extends Error {
  constructor(message = "Can't reach PopNow. Check your connection and try again.") {
    super(message);
    this.name = "OfflineError";
  }
}

export function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), ms);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** Reads a JSON-RPC reply that came back either as JSON or as a server-sent event stream. */
export async function readReply(response: Response, id: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else if (text.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  const reply = messages.find(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object" && (message as Record<string, unknown>).id === id,
  );
  if (!reply) throw new Error("PopNow sent no reply");
  const error = reply.error as { message?: string } | undefined;
  if (error) throw new Error(error.message ?? "PopNow returned an error");
  return (reply.result ?? {}) as Record<string, unknown>;
}

export interface ClientOptions {
  fetch: Fetch;
  session: AccountSession;
  /** Called with a refreshed session so the caller can store it. */
  onSession: (session: AccountSession) => void | Promise<void>;
  clientVersion: string;
  now?: () => number;
}

export class PopNowClient {
  private session: AccountSession;
  private sessionId: string | undefined;
  private protocolVersion = PROTOCOL_VERSION;
  private initializing: Promise<void> | undefined;
  private nextId = 1;

  constructor(private readonly options: ClientOptions) {
    this.session = options.session;
  }

  get endpoint(): string {
    return this.session.mcpUrl;
  }

  get currentSession(): AccountSession {
    return this.session;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async renew(): Promise<void> {
    try {
      this.session = await refresh(this.options.fetch, this.session, this.now());
    } catch {
      throw new SignInRequiredError();
    }
    await this.options.onSession(this.session);
  }

  private async post(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, retried = false): Promise<Response> {
    if (!retried && this.session.expiresAt !== undefined && this.session.expiresAt - 30_000 < this.now()) {
      await this.renew();
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.session.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    let response: Response;
    try {
      response = await this.options.fetch(this.session.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OfflineError();
    }
    if (response.status === 401 && !retried) {
      await this.renew();
      return this.post(body, timeoutMs, signal, true);
    }
    if (response.status === 401) throw new SignInRequiredError();
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
      throw new Error(`PopNow answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    return response;
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (method !== "initialize") await this.initialize();
    const id = this.nextId++;
    // Creation tools wait up to about 40 seconds on the server before handing back a job id.
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, method === "tools/call" ? 120_000 : 30_000, signal);
    return readReply(response, id);
  }

  private initialize(): Promise<void> {
    this.initializing ??= (async () => {
      const result = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "popnow-figma", version: this.options.clientVersion },
      });
      if (typeof result.protocolVersion === "string" && result.protocolVersion) this.protocolVersion = result.protocolVersion;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 30_000);
    })().catch((error: unknown) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args }, signal)) as McpToolResult;
  }
}

/** All text parts of a result, joined. */
export function resultText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake PopNow (OAuth server + account MCP endpoint + upload window + storage) and a fake PopNow Connect
 * relay, both on 127.0.0.1. Close enough to the real ones for the plugin's core logic.
 */

export interface Call {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
  auth?: string;
}

export interface Fake {
  origin: string;
  server: Server;
  calls: Call[];
  registered: Record<string, unknown>[];
  authorized: URLSearchParams[];
  tokens: { issued: number; refreshed: number; revoked: string[]; refuseRefresh: boolean };
  uploads: string[];
  putHeaders: Record<string, string | string[] | undefined>[];
  /** Answer MCP calls as JSON instead of an event stream. */
  json: boolean;
  /** The next MCP request with this bearer token gets one 401. */
  expire?: string;
  /** Prices per tool; a tool runs when max_credits >= price. */
  prices: Record<string, number>;
  balance: number;
  /** Tools that stop for consent until consent: true. */
  consentTools: Set<string>;
  /** get_job answers "running" this many times before it is done. */
  pendingPolls: number;
  /** Tools that hand back a job id instead of waiting. */
  slowTools: Set<string>;
  /** The issuer in the redirect (to simulate a mix-up). */
  redirectIss?: string;
  close(): Promise<void>;
}

export interface Relay {
  origin: string;
  server: Server;
  claims: number;
  /** Answer the first N claims with 404 even when the code is there. */
  holdClaims: number;
  store: Map<string, string>;
  close(): Promise<void>;
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const closer = (server: Server) => (): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

export async function startRelay(): Promise<Relay> {
  const relay: Relay = { origin: "", server: createServer(), claims: 0, holdClaims: 0, store: new Map(), close: async () => undefined };
  relay.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", relay.origin);
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/callback") {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return void response.writeHead(400).end("bad state");
      if (error || !code) {
        relay.store.set(state, JSON.stringify({ error: error === "access_denied" ? "access_denied" : "failed" }));
        return void response.writeHead(400).end("did not finish");
      }
      if (!relay.store.has(state)) relay.store.set(state, JSON.stringify({ code, iss: url.searchParams.get("iss") }));
      return void response.writeHead(200, { "content-type": "text/html" }).end("<h1>Signed in to PopNow</h1>");
    }
    if (url.pathname === "/oauth/claim" && request.method === "POST") {
      relay.claims++;
      const { nonce } = JSON.parse(await body(request)) as { nonce?: string };
      if (typeof nonce !== "string" || nonce.length < 32) return json(400, { error: "invalid_request" });
      const state = b64url(createHash("sha256").update(nonce).digest());
      const stored = relay.store.get(state);
      if (!stored || relay.claims <= relay.holdClaims) return json(404, { error: "pending" });
      relay.store.delete(state);
      return json(200, JSON.parse(stored));
    }
    json(404, { error: "not_found" });
  });
  relay.origin = await listen(relay.server);
  relay.close = closer(relay.server);
  return relay;
}

export async function startFake(): Promise<Fake> {
  const fake: Fake = {
    origin: "",
    server: createServer(),
    calls: [],
    registered: [],
    authorized: [],
    tokens: { issued: 0, refreshed: 0, revoked: [], refuseRefresh: false },
    uploads: [],
    putHeaders: [],
    json: false,
    prices: { create_image: 48, edit_image: 48, remove_background: 12, create_video: 185, split_layers: 60 },
    balance: 1000,
    consentTools: new Set(),
    pendingPolls: 0,
    slowTools: new Set(),
    close: async () => undefined,
  };
  const challenges = new Map<string, string>();
  let polls = 0;

  fake.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", fake.origin);
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const p = url.pathname;
    if (p === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: `${fake.origin}/mcp`, authorization_servers: [fake.origin] });
    }
    if (p === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: fake.origin,
        authorization_endpoint: `${fake.origin}/oauth/authorize`,
        token_endpoint: `${fake.origin}/oauth/token`,
        registration_endpoint: `${fake.origin}/oauth/register`,
        revocation_endpoint: `${fake.origin}/oauth/revoke`,
      });
    }
    if (p === "/oauth/register") {
      const reg = JSON.parse(await body(request)) as Record<string, unknown>;
      fake.registered.push(reg);
      return json(201, { client_id: "pnc_figma", redirect_uris: reg.redirect_uris });
    }
    if (p === "/oauth/authorize") {
      const q = url.searchParams;
      fake.authorized.push(q);
      challenges.set("code-1", q.get("code_challenge") ?? "");
      const back = new URL(q.get("redirect_uri") ?? "");
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", fake.redirectIss ?? fake.origin);
      response.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (p === "/oauth/token") {
      const form = new URLSearchParams(await body(request));
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const expected = challenges.get(form.get("code") ?? "");
        if (!expected || b64url(createHash("sha256").update(verifier).digest()) !== expected) return json(400, { error: "invalid_grant" });
        if (form.get("resource") !== `${fake.origin}/mcp`) return json(400, { error: "invalid_target" });
        fake.tokens.issued++;
        return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "generate read" });
      }
      if (fake.tokens.refuseRefresh || form.get("refresh_token") !== "rt-1") return json(400, { error: "invalid_grant" });
      fake.tokens.refreshed++;
      return json(200, { access_token: "at-2", expires_in: 3600 });
    }
    if (p === "/oauth/revoke") {
      fake.tokens.revoked.push(new URLSearchParams(await body(request)).get("token") ?? "");
      response.writeHead(200).end();
      return;
    }
    if (p.startsWith("/console/v1/upload-sessions/tok123")) {
      const rest = p.slice("/console/v1/upload-sessions/tok123".length);
      const sent = await body(request);
      fake.uploads.push(`${request.method} ${rest}`);
      if (rest === "/files") {
        const req = JSON.parse(sent) as { name: string; bytes: number; contentType: string };
        fake.uploads.push(`ticket ${req.name}:${req.bytes}:${req.contentType}`);
        return json(200, {
          code: 200,
          data: { fileId: "f1", uploadUrl: `${fake.origin}/put/f1`, method: "PUT", headers: { "content-type": req.contentType } },
        });
      }
      return json(200, { code: 200, data: { state: rest === "/close" ? "closed" : "open" } });
    }
    if (p.startsWith("/put/")) {
      fake.putHeaders.push(request.headers);
      fake.uploads.push(`PUT ${p}:${(await body(request)).length}`);
      response.writeHead(200).end();
      return;
    }
    if (p === "/mcp") {
      const auth = request.headers.authorization ?? "";
      if (fake.expire && auth === `Bearer ${fake.expire}`) {
        fake.expire = undefined;
        response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
        return;
      }
      if (auth !== "Bearer at-1" && auth !== "Bearer at-2") {
        response.writeHead(401).end();
        return;
      }
      const message = JSON.parse(await body(request)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      fake.calls.push({
        method: message.method,
        auth,
        ...(message.params?.name ? { name: message.params.name } : {}),
        ...(message.params?.arguments ? { args: message.params.arguments } : {}),
      });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = mcpResult(fake, message.method, message.params?.name, message.params?.arguments ?? {}, () => polls++);
      const payload = { jsonrpc: "2.0", id: message.id, result };
      if (fake.json) return json(200, payload);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  fake.origin = await listen(fake.server);
  fake.close = closer(fake.server);
  return fake;
}

function text(t: string, structured?: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

function mcpResult(fake: Fake, method: string, name: string | undefined, args: Record<string, unknown>, poll: () => number): unknown {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "popnow", version: "1" } };
  if (method === "tools/list") return { tools: [] };
  if (method !== "tools/call") return {};
  switch (name) {
    case "check_balance":
      return text(`You have ${fake.balance} PopNow credits.`, { currency: "credits", credits: fake.balance, held: 0 });
    case "list_models":
      return text(
        args.category === "video"
          ? "Video models (default: MiniMax H3). Pass the model id to create_video:\n- MiniMax H3 (model: minimax-h3) by MiniMax: text to video [create_video], photo to video [create_video], about 185 credits\n- Kling 4.0 (model: kling-4-0) by Kuaishou: photo to video [create_video], about 300 credits\n"
          : "Image models (default: Nano Banana 2.1). Pass the model id to create_image or edit_image:\n- Nano Banana 2.1 (model: nano-banana-2-1) by Google: create images [create_image], edit images [edit_image], about 48 credits\n- Seedream 5.0 Pro (model: seedream-5-0-pro) by ByteDance: create images [create_image], about 60 credits\n- Upscaler (model: upscaler-v1) by PopNow: upscale [upscale], about 20 credits\n",
      );
    case "estimate_cost": {
      const tool = String(args.tool);
      const price = fake.prices[tool] ?? 30;
      return text(`${tool} would cost about ${price} credits (the user has ${fake.balance}).`, {
        currency: "credits",
        credits: price,
        balance: fake.balance,
        steps: [price],
      });
    }
    case "request_upload":
      return text("Upload page ready.", { upload_id: "up_1", url: `${fake.origin}/upload/tok123` });
    case "get_upload":
      return text("1 file uploaded.", { upload_id: "up_1", state: "closed", files: [{ popnow_link: "popnow://f/abc", name: "Hero.png", type: "image/png" }] });
    case "get_job": {
      if (poll() < fake.pendingPolls) return text("Still making it.", { job_id: args.job_id, status: "running", currency: "credits", credits: 185 });
      return text("Done.", { job_id: args.job_id, status: "succeeded", credits: 185, files: [{ url: `${fake.origin}/out/v.mp4`, popnow_link: "popnow://g/job/0", type: "video/mp4" }] });
    }
    default: {
      const tool = String(name);
      const price = fake.prices[tool] ?? 30;
      const max = Number(args.max_credits ?? 0);
      if (fake.consentTools.has(tool) && args.consent !== true) {
        return text("Needs consent.", { needs_consent: true });
      }
      if (price > fake.balance) return text(`Not enough credits: this costs ${price} and you have ${fake.balance}.`, undefined, true);
      if (max > 0 && max < price) {
        // Like the real server when the price went up after the user approved a lower one.
        return text(`Not started: the price is now ${price} credits, more than the ${max} the user agreed to. Nothing was charged.`);
      }
      if (max <= 0) {
        return text(`Needs confirmation, nothing started yet. Costs ${price} credits.`, { currency: "credits", needs_confirmation: true, credits: price, balance: fake.balance });
      }
      fake.balance -= price;
      if (fake.slowTools.has(tool)) return text("Started.", { job_id: "task_9", status: "running", credits: price });
      const files =
        tool === "split_layers"
          ? [0, 1, 2].map((i) => ({ url: `${fake.origin}/out/l${i}.png`, popnow_link: `popnow://g/job/${i}`, type: "image/png" }))
          : [{ url: `${fake.origin}/out/x.png`, popnow_link: "popnow://g/job/0", type: "image/png" }];
      return text("Done.", { job_id: "task_1", status: "succeeded", credits: price, model: "Nano Banana 2.1", files });
    }
  }
}

/** The browser: follows the sign-in link to PopNow, which redirects to the relay. */
export async function browse(url: string): Promise<number> {
  const first = await fetch(url, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) return first.status;
  return (await fetch(location)).status;
}

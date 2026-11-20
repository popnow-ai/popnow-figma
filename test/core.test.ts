import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildArgs, buttonLabel, defaultFields, formatElapsed, ready } from "../src/core/actions";
import { OfflineError, PopNowClient, SignInRequiredError } from "../src/core/mcp";
import { SignInError, claimCode, discover, revoke, startLogin, type AccountSession } from "../src/core/oauth";
import { checkBalance, listModels, parseModels, pollJob, quote, run } from "../src/core/pricing";
import { uploadFiles } from "../src/core/upload";
import { browse, startFake, startRelay, type Fake, type Relay } from "./fake";

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let fake: Fake;
let relay: Relay;

beforeEach(async () => {
  fake = await startFake();
  relay = await startRelay();
});
afterEach(async () => {
  await fake.close();
  await relay.close();
});

async function signIn(): Promise<AccountSession> {
  const pending = await startLogin({
    fetch,
    mcpUrl: `${fake.origin}/mcp`,
    relayUrl: relay.origin,
    intervalMs: 5,
    openUrl: (url) => void browse(url),
  });
  return pending.session;
}

function client(session: AccountSession, saved: AccountSession[] = []): PopNowClient {
  return new PopNowClient({ fetch, session, clientVersion: "test", onSession: (s) => void saved.push(s) });
}

describe("sign-in through PopNow Connect", () => {
  it("registers the relay callback, uses PKCE and claims the code with the nonce", async () => {
    const session = await signIn();
    const reg = fake.registered[0] as Record<string, unknown>;
    expect(reg.redirect_uris).toEqual([`${relay.origin}/oauth/callback`]);
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.scope).toBe("generate read");
    expect(reg.client_name).toBe("PopNow for Figma");

    const q = fake.authorized[0] as URLSearchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(`${fake.origin}/mcp`);
    expect(q.get("redirect_uri")).toBe(`${relay.origin}/oauth/callback`);
    // The state is a 43-character hash; the relay only hands the code to whoever knows the nonce behind it.
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(relay.store.size).toBe(0);

    expect(session).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", clientId: "pnc_figma", issuer: fake.origin, mcpUrl: `${fake.origin}/mcp` });
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(fake.tokens.issued).toBe(1);
  });

  it("keeps polling while the relay answers 404, then exchanges the code", async () => {
    relay.holdClaims = 3;
    const session = await signIn();
    expect(session.accessToken).toBe("at-1");
    expect(relay.claims).toBeGreaterThanOrEqual(4);
  });

  it("drops a code from an unexpected issuer and keeps waiting", async () => {
    fake.redirectIss = "https://evil.example";
    const pending = await startLogin({
      fetch,
      mcpUrl: `${fake.origin}/mcp`,
      relayUrl: relay.origin,
      intervalMs: 5,
      timeoutMs: 400,
      openUrl: (url) => void browse(url),
    });
    await expect(pending.session).rejects.toMatchObject({ reason: "timeout" });
    // The mixed-up code was claimed (the slot is free for the real reply) but never exchanged.
    expect(relay.store.size).toBe(0);
    expect(relay.claims).toBeGreaterThan(2);
    expect(fake.tokens.issued).toBe(0);
  });

  it("stops when the user refuses in the browser", async () => {
    const nonce = "n".repeat(43);
    const state = b64url(createHash("sha256").update(nonce).digest());
    await fetch(`${relay.origin}/oauth/callback?state=${state}&error=access_denied`);
    await expect(claimCode({ fetch, relayUrl: relay.origin, nonce, issuer: fake.origin, intervalMs: 5 })).rejects.toMatchObject({ reason: "denied" });
  });

  it("can be canceled while waiting", async () => {
    const controller = new AbortController();
    const waiting = claimCode({ fetch, relayUrl: relay.origin, nonce: "m".repeat(43), issuer: fake.origin, intervalMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(waiting).rejects.toMatchObject({ reason: "canceled" });
  });

  it("refuses an insecure relay or server and an issuer that does not match", async () => {
    await expect(claimCode({ fetch, relayUrl: "http://connect.example", nonce: "x".repeat(43), issuer: "x" })).rejects.toBeInstanceOf(SignInError);
    await expect(discover(fetch, "http://api.example/mcp")).rejects.toThrow(/https/);
    const lying: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("protected-resource")) return Response.json({ authorization_servers: ["https://api.example"] });
      return Response.json({ issuer: "https://other.example", authorization_endpoint: "https://a", token_endpoint: "https://t", registration_endpoint: "https://r" });
    };
    await expect(discover(lying, "https://api.example/mcp")).rejects.toThrow(/issuer mismatch/);
  });
});

describe("account MCP", () => {
  it("speaks JSON and event-stream replies and initializes once", async () => {
    const c = client(await signIn());
    expect(await checkBalance(c)).toBe(1000);
    fake.json = true;
    expect(await checkBalance(c)).toBe(1000);
    expect(fake.calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  });

  it("refreshes an expired token once and hands the new session to storage", async () => {
    const saved: AccountSession[] = [];
    const c = client(await signIn(), saved);
    fake.expire = "at-1";
    expect(await checkBalance(c)).toBe(1000);
    expect(fake.tokens.refreshed).toBe(1);
    expect(saved.at(-1)).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("asks to sign in again when the refresh is refused", async () => {
    const c = client(await signIn());
    fake.expire = "at-1";
    fake.tokens.refuseRefresh = true;
    await expect(checkBalance(c)).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("reports PopNow being unreachable as offline", async () => {
    const session = await signIn();
    const c = new PopNowClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      session,
      clientVersion: "t",
      onSession: () => undefined,
    });
    await expect(checkBalance(c)).rejects.toBeInstanceOf(OfflineError);
  });

  it("reads the model list with Auto first", async () => {
    const c = client(await signIn());
    expect(await listModels(c, "image", "create_image")).toEqual([
      { id: "", name: "Auto" },
      { id: "nano-banana-2-1", name: "Nano Banana 2.1" },
      { id: "seedream-5-0-pro", name: "Seedream 5.0 Pro" },
    ]);
    expect((await listModels(c, "image", "edit_image")).map((m) => m.id)).toEqual(["", "nano-banana-2-1"]);
    expect(parseModels("nothing here", "create_video")).toEqual([{ id: "", name: "Auto" }]);
  });

  it("signs out by revoking both tokens", async () => {
    const session = await signIn();
    expect(await revoke(fetch, session)).toBe(true);
    expect(fake.tokens.revoked).toEqual(["rt-1", "at-1"]);
  });
});

describe("prices and runs", () => {
  it("quotes with estimate_cost and runs nothing until the user clicks", async () => {
    const c = client(await signIn());
    const q = await quote(c, "remove_background", { image_url: "popnow://f/abc", max_credits: 999 });
    expect(q).toEqual({ credits: 12, balance: 1000, enough: true });
    const est = fake.calls.find((x) => x.name === "estimate_cost");
    // max_credits never goes into a quote
    expect(est?.args).toEqual({ tool: "remove_background", arguments: { image_url: "popnow://f/abc" } });
    // Declined: the user never clicked, so the tool itself was never called and nothing was charged.
    expect(fake.calls.some((x) => x.name === "remove_background")).toBe(false);
    expect(fake.balance).toBe(1000);
  });

  it("runs with exactly the approved price and places the files", async () => {
    const c = client(await signIn());
    const outcome = await run(c, "edit_image", { prompt: "make it night", image_url: "popnow://f/abc" }, 48);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.job.files[0]).toMatchObject({ url: `${fake.origin}/out/x.png`, link: "popnow://g/job/0" });
    expect(fake.calls.find((x) => x.name === "edit_image")?.args).toEqual({ prompt: "make it night", image_url: "popnow://f/abc", max_credits: 48 });
  });

  it("never raises the limit when the price went up", async () => {
    const c = client(await signIn());
    fake.prices.create_image = 60;
    const outcome = await run(c, "create_image", { prompt: "a lighthouse" }, 48);
    expect(outcome).toEqual({ kind: "confirm", credits: 60 });
    const runs = fake.calls.filter((x) => x.name === "create_image");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args?.max_credits).toBe(48);
    expect(fake.balance).toBe(1000);
    await expect(run(c, "create_image", { prompt: "x" }, 0)).rejects.toThrow(/approve/);
  });

  it("says when the balance is too low, before and after the click", async () => {
    const c = client(await signIn());
    fake.balance = 20;
    expect((await quote(c, "create_image", { prompt: "x" })).enough).toBe(false);
    expect((await run(c, "create_image", { prompt: "x" }, 48)).kind).toBe("not-enough");
  });

  it("only sends consent after the user ticked it", async () => {
    const c = client(await signIn());
    fake.consentTools.add("create_video");
    expect(await run(c, "create_video", { prompt: "walk", image_url: "popnow://f/abc" }, 185)).toEqual({ kind: "consent" });
    expect(fake.calls.at(-1)?.args).not.toHaveProperty("consent");
    expect((await run(c, "create_video", { prompt: "walk", image_url: "popnow://f/abc", consent: true }, 185)).kind).toBe("consent");
    const ok = await run(c, "create_video", { prompt: "walk", image_url: "popnow://f/abc" }, 185, { consent: true });
    expect(ok.kind).toBe("done");
    expect(fake.calls.at(-1)?.args?.consent).toBe(true);
  });

  it("polls get_job until the video is done, and can stop waiting", async () => {
    const c = client(await signIn());
    fake.slowTools.add("create_video");
    fake.pendingPolls = 2;
    const started = await run(c, "create_video", { prompt: "walk", image_url: "popnow://f/abc" }, 185);
    expect(started.kind).toBe("pending");
    if (started.kind !== "pending") return;
    const updates: string[] = [];
    const done = await pollJob(c, started.jobId, { waitSeconds: 0, onUpdate: (job) => updates.push(job.status ?? "") });
    expect(done.kind).toBe("done");
    expect(updates).toEqual(["running", "running"]);
    expect(fake.calls.filter((x) => x.name === "get_job").every((x) => x.args?.job_id === "task_9")).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(pollJob(c, "task_9", { signal: controller.signal })).rejects.toThrow(/stopped waiting/);
  });

  it("returns every layer from split_layers", async () => {
    const c = client(await signIn());
    const outcome = await run(c, "split_layers", { image_url: "popnow://f/abc" }, 60);
    expect(outcome.kind === "done" && outcome.job.files.length).toBe(3);
  });
});

describe("upload window", () => {
  it("uploads layer bytes without the PopNow token and returns the popnow link", async () => {
    const c = client(await signIn());
    const links = await uploadFiles(c, fetch, [{ name: "Hero.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(links).toEqual(["popnow://f/abc"]);
    expect(fake.uploads).toEqual(["POST /files", "ticket Hero.png:4:image/png", "PUT /put/f1:4", "POST /files/f1/commit", "POST /close"]);
    expect(fake.putHeaders[0]?.authorization).toBeUndefined();
    expect(fake.calls.find((x) => x.name === "request_upload")?.args).toMatchObject({ kinds: ["image"], max_files: 1 });
    expect(fake.calls.find((x) => x.name === "get_upload")?.args).toEqual({ upload_id: "up_1", wait_seconds: 0 });
  });
});

describe("actions", () => {
  it("builds exact tool arguments and button labels", () => {
    const edit = { ...defaultFields("edit"), prompt: " neon sign ", image: "popnow://f/abc" };
    expect(ready("edit", edit)).toBe(true);
    expect(ready("edit", { ...edit, image: undefined })).toBe(false);
    expect(buildArgs("edit", edit)).toEqual({ image_url: "popnow://f/abc", prompt: "neon sign" });
    expect(buildArgs("upscale", { ...defaultFields("upscale"), image: "popnow://f/x" })).toEqual({ image_url: "popnow://f/x", size: "4k" });
    expect(buildArgs("generate", { ...defaultFields("generate"), prompt: "a cat", model: "seedream-5-0-pro" })).toEqual({
      prompt: "a cat",
      aspect_ratio: "1:1",
      model: "seedream-5-0-pro",
    });
    expect(buildArgs("video", { ...defaultFields("video"), prompt: "walk", image: "popnow://f/x" })).toEqual({
      image_url: "popnow://f/x",
      prompt: "walk",
      duration_seconds: 5,
    });
    expect(ready("removeBg", { ...defaultFields("removeBg"), image: "popnow://f/x" })).toBe(true);
    expect(buttonLabel("edit", 48)).toBe("Edit · 48 credits");
    expect(buttonLabel("removeBg", 1200)).toBe("Remove background · 1,200 credits");
    expect(buttonLabel("generate")).toBe("Generate");
    expect(formatElapsed(83_400)).toBe("1:23");
  });
});

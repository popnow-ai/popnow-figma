// Renders the panel in headless Chrome with a fake Figma host and a fake PopNow, and saves
// store/screenshots/{light,dark}-{sign-in,generate,selection}.png. Nothing goes to PopNow.
//
//   npm run screenshots            (CHROME=/path/to/chrome to override the browser)
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "store/screenshots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9347);
const W = 340;
const H = 600;

const ui = await readFile(join(root, "dist/ui.html"), "utf8");
const sample = (await readFile(join(root, "scripts/fixtures/sample.jpg"))).toString("base64");

// Runs inside the panel before its own script: Figma's theme class and a canned PopNow.
const stub = (theme) => `<script>
document.documentElement.classList.add(${JSON.stringify(theme === "dark" ? "figma-dark" : "figma-light")});
(() => {
  const prices = { create_image: 48, edit_image: 48, relight_photo: 30, remove_background: 12, upscale: 20, expand_image: 30, change_camera_angle: 30, split_layers: 60, create_video: 185 };
  const models = {
    image: "- Nano Banana 2.1 (model: nano-banana-2-1) by Google: create images [create_image], edit images [edit_image], about 48 credits\\n- Seedream 5.0 Pro (model: seedream-5-0-pro) by ByteDance: create images [create_image], about 60 credits\\n- GPT Image 2.6 (model: gpt-image-2-6) by OpenAI: create images [create_image], edit images [edit_image], about 90 credits\\n",
    video: "- MiniMax H3 (model: minimax-h3) by MiniMax: photo to video [create_video], about 185 credits\\n- Kling 4.0 (model: kling-4-0) by Kuaishou: photo to video [create_video], about 300 credits\\n",
  };
  const reply = (id, result) => new Response("event: message\\ndata: " + JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
  const text = (t, sc) => ({ content: [{ type: "text", text: t }], structuredContent: sc });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith("/mcp")) {
      const m = JSON.parse(init.body);
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") return reply(m.id, { protocolVersion: "2025-06-18" });
      const a = m.params.arguments || {};
      switch (m.params.name) {
        case "check_balance": return reply(m.id, text("", { credits: 12480 }));
        case "list_models": return reply(m.id, text(models[a.category] || ""));
        case "estimate_cost": return reply(m.id, text("", { credits: prices[a.tool] || 30, balance: 12480 }));
        case "request_upload": return reply(m.id, text("", { upload_id: "up_1", url: "https://popnow.ai/upload/tok" }));
        case "create_video": return reply(m.id, text("Started.", { job_id: "task_1", status: "running", credits: 185 }));
        case "get_job": await new Promise((r) => setTimeout(r, 3000)); return reply(m.id, text("Still making it.", { job_id: "task_1", status: "running" }));
        case "get_upload": return reply(m.id, text("", { files: [{ popnow_link: "popnow://f/abc", name: "Perfume.png" }] }));
      }
      return reply(m.id, text("", {}));
    }
    if (url.includes("/upload-sessions/")) {
      const data = url.endsWith("/files") ? { fileId: "f1", uploadUrl: "https://storage.example/put", method: "PUT", headers: {} } : {};
      return Response.json({ code: 200, data });
    }
    if (url.startsWith("https://storage.example")) return new Response(null, { status: 200 });
    return new Response("{}", { status: 404 });
  };
})();
</script>`;

// A string literal that is safe inside an inline <script>.
const inline = (value) => JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const harness = (theme, scenario) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${theme === "dark" ? "#2c2c2c" : "#fff"}}iframe{display:block;border:0;width:${W}px;height:${H}px}</style></head><body>
<iframe id="f"></iframe>
<script>
const scenario = ${JSON.stringify(scenario)};
const frame = document.getElementById("f");
const session = { issuer: "https://api.popnow.ai", mcpUrl: "https://api.popnow.ai/mcp", tokenEndpoint: "https://api.popnow.ai/oauth/token", clientId: "pnc_demo", accessToken: "demo" };
const selection = scenario === "selection" || scenario === "progress" ? { id: "1:2", name: "Perfume hero", width: 1080, height: 1080, count: 1 } : null;
const sample = Uint8Array.from(atob(${JSON.stringify(sample)}), (c) => c.charCodeAt(0));
const toUI = (m) => frame.contentWindow.postMessage({ pluginMessage: m }, "*");
window.addEventListener("message", (e) => {
  const m = e.data && e.data.pluginMessage;
  if (!m) return;
  if (m.type === "ready") toUI({ type: "init", session: scenario === "sign-in" ? null : session, editor: "figma", selection });
  if (m.type === "export") toUI({ type: "exported", requestId: m.requestId, id: m.id, bytes: sample, width: 360, height: 360 });
});
frame.srcdoc = ${inline(ui.replace("<head>", "<head>" + stub(theme)))};
frame.onload = async () => {
  const d = frame.contentDocument;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);
  if (scenario === "generate") {
    const p = d.getElementById("gen-prompt");
    p.value = "A glass perfume bottle on travertine, late afternoon sun, soft shadows";
    p.dispatchEvent(new Event("input"));
    d.querySelectorAll("#gen-aspects button")[1].click();
  }
  if (scenario === "selection") {
    await wait(300);
    d.querySelector('.tool[data-action="edit"]').click();
    await wait(300);
    const p = d.getElementById("sel-prompt");
    p.value = "Remove the glare and the water spots";
    p.dispatchEvent(new Event("input"));
  }
  if (scenario === "progress") {
    await wait(300);
    d.querySelector('.tool[data-action="video"]').click();
    await wait(300);
    const p = d.getElementById("sel-prompt");
    p.value = "The bottle turns slowly as light sweeps across the glass";
    p.dispatchEvent(new Event("input"));
    await wait(1200);
    d.getElementById("go").click();
    await wait(4200);
  }
  await wait(1400);
  document.title = "ready";
};
</script></body></html>`;

// ---------- a tiny CDP client ----------
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (process.env.DEBUG && (msg.method === "Runtime.exceptionThrown" || msg.method === "Runtime.consoleAPICalled")) {
      console.error(JSON.stringify(msg.params).slice(0, 600));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => ws.close(),
  };
}

const profile = await mkdtemp(join(tmpdir(), "popnow-figma-shots-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" });
const cleanup = async () => {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
};

try {
  let version;
  for (let i = 0; i < 50 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => undefined);
    if (!version) await new Promise((r) => setTimeout(r, 200));
  }
  if (!version) throw new Error("Chrome did not start");
  const browser = await cdp(version.webSocketDebuggerUrl);
  await mkdir(out, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), "popnow-figma-harness-"));
  for (const theme of ["light", "dark"]) {
    for (const scenario of (process.env.SCENARIOS ?? "sign-in,generate,selection,progress").split(",")) {
      const file = join(tmp, `${theme}-${scenario}.html`);
      await writeFile(file, harness(theme, scenario));
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => browser.send(m, p, sessionId);
      await s("Page.enable");
      if (process.env.DEBUG) await s("Runtime.enable");
      await s("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
      await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await s("Page.navigate", { url: pathToFileURL(file).href });
      for (let i = 0; i < 120; i++) {
        const { result } = await s("Runtime.evaluate", { expression: "document.title" });
        if (result.value === "ready") break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (process.env.DEBUG) {
        const { result } = await s("Runtime.evaluate", { expression: "document.title + ' ' + (document.getElementById('f').contentDocument?.getElementById('app')?.dataset.phase)" });
        console.error(theme, scenario, result.value);
      }
      const { data } = await s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
      await writeFile(join(out, `${theme}-${scenario}.png`), Buffer.from(data, "base64"));
      await browser.send("Target.closeTarget", { targetId });
      console.log(`store/screenshots/${theme}-${scenario}.png`);
    }
  }
  browser.close();
  await rm(tmp, { recursive: true, force: true });
} finally {
  await cleanup();
}

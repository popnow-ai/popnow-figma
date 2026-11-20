import {
  ACTIONS,
  SELECTION_ACTIONS,
  buildArgs,
  buttonLabel,
  defaultFields,
  formatCredits,
  formatElapsed,
  ready,
  type ActionId,
  type Fields,
} from "../core/actions";
import { digestBytes } from "../core/encoding";
import { OfflineError, PopNowClient, SignInRequiredError, resultText } from "../core/mcp";
import { DEFAULT_MCP_URL, DEFAULT_RELAY_URL, SignInError, revoke, startLogin, type AccountSession } from "../core/oauth";
import { checkBalance, parseModels, pollJob, quote, run, type JobInfo, type ModelChoice, type Quote, type RunOutcome } from "../core/pricing";
import { uploadFiles } from "../core/upload";
import type { Editor, PlaceImage, PlaceRequest, SelectionInfo, ToMain, ToUI } from "../shared/messages";
import { ICONS } from "./icons";
import { fetchPlaceable, videoCover, type Placeable } from "./media";

declare const __VERSION__: string;
declare const __MCP_URL__: string;
declare const __RELAY_URL__: string;

const MCP_URL = typeof __MCP_URL__ === "string" && __MCP_URL__ ? __MCP_URL__ : DEFAULT_MCP_URL;
const RELAY_URL = typeof __RELAY_URL__ === "string" && __RELAY_URL__ ? __RELAY_URL__ : DEFAULT_RELAY_URL;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";
const LIBRARY = "https://popnow.ai/assets";
const UPLOAD_TTL_MS = 25 * 60_000;
const QUOTE_DELAY_MS = 450;
const doFetch: typeof fetch = (input, init) => fetch(input, init);

// ---------- Host bridge ----------

function post(message: ToMain): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

let nextRequest = 1;
const waiting = new Map<number, { resolve: (value: ToUI) => void }>();
function ask(build: (requestId: number) => ToMain): Promise<ToUI> {
  const requestId = nextRequest++;
  return new Promise((resolve) => {
    waiting.set(requestId, { resolve });
    post(build(requestId));
  });
}

// ---------- State ----------

type Tab = "generate" | "selection";
type Phase = "boot" | "out" | "signing" | "in";

interface Layer {
  id: string;
  name: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  hash: string;
  thumb: string;
}

interface QuoteState {
  key: string;
  loading: boolean;
  q?: Quote;
  error?: string;
}

const state = {
  phase: "boot" as Phase,
  editor: "figma" as Editor,
  session: null as AccountSession | null,
  client: null as PopNowClient | null,
  tab: "generate" as Tab,
  balance: undefined as number | undefined,
  models: { create_image: [], edit_image: [], create_video: [] } as Record<string, ModelChoice[]>,
  selection: null as SelectionInfo | null,
  layer: null as Layer | null,
  layerLoading: false,
  preparing: false,
  action: "edit" as ActionId,
  fields: Object.fromEntries(Object.keys(ACTIONS).map((id) => [id, defaultFields(id as ActionId)])) as Record<ActionId, Fields>,
  quote: null as QuoteState | null,
  running: null as { controller: AbortController; startedAt: number; timer: number; video: boolean } | null,
  consentNeeded: false,
  login: null as { controller: AbortController; url?: string } | null,
  expired: false,
};
const uploads = new Map<string, { link: string; at: number }>();
const uploading = new Map<string, Promise<string>>();

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const currentAction = (): ActionId => (state.tab === "generate" ? "generate" : state.action);

// ---------- Rendering ----------

function setPhase(phase: Phase): void {
  state.phase = phase;
  $("app").dataset.phase = phase;
}

function notice(text: string, kind: "info" | "error" | "ok" = "info", action?: { label: string; run: () => void }): void {
  const box = $("notice");
  box.hidden = !text;
  box.dataset.kind = kind;
  $("notice-text").textContent = text;
  const button = $<HTMLButtonElement>("notice-action");
  button.hidden = !action;
  button.textContent = action?.label ?? "";
  button.onclick = action ? () => action.run() : null;
}

function renderBalance(): void {
  const label = state.balance === undefined ? "—" : formatCredits(state.balance);
  $("balance-n").textContent = label;
  $("balance").classList.toggle("low", state.quote?.q?.enough === false);
}

function renderTabs(): void {
  for (const tab of ["generate", "selection"] as Tab[]) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(state.tab === tab));
  }
  $("view-generate").hidden = state.tab !== "generate";
  $("view-selection").hidden = state.tab !== "selection";
  $("tab-dot").hidden = !(state.tab === "generate" && state.selection);
}

function segButtons(container: HTMLElement, values: string[], current: string, label: (v: string) => string, onPick: (v: string) => void): void {
  container.replaceChildren(
    ...values.map((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(value === current));
      button.textContent = label(value);
      button.onclick = () => onPick(value);
      return button;
    }),
  );
}

function fillModels(select: HTMLSelectElement, models: ModelChoice[], current: string): void {
  const list = models.length ? models : [{ id: "", name: "Auto" }];
  select.replaceChildren(
    ...list.map((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      return option;
    }),
  );
  select.value = list.some((m) => m.id === current) ? current : "";
}

function renderGenerate(): void {
  const f = state.fields.generate;
  segButtons($("gen-aspects"), ACTIONS.generate.aspects ?? [], f.aspect, (v) => v, (v) => {
    f.aspect = v;
    renderGenerate();
    scheduleQuote();
  });
  fillModels($<HTMLSelectElement>("gen-model"), state.models.create_image ?? [], f.model);
}

function renderTools(): void {
  const tools = $("tools");
  if (!tools.childElementCount) {
    tools.replaceChildren(
      ...SELECTION_ACTIONS.map((id) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tool";
        button.dataset.action = id;
        button.setAttribute("role", "radio");
        button.innerHTML = `${ICONS[iconFor(id)]}<span>${ACTIONS[id].label}</span>`;
        button.onclick = () => pickAction(id);
        return button;
      }),
    );
  }
  for (const button of tools.querySelectorAll<HTMLButtonElement>(".tool")) {
    button.setAttribute("aria-checked", String(button.dataset.action === state.action));
  }
}

function iconFor(id: ActionId): keyof typeof ICONS {
  return ({ generate: "sparkles", edit: "edit", removeBg: "removeBg", upscale: "upscale", expand: "expand", relight: "relight", angle: "angle", layers: "layers", video: "video" } as const)[id];
}

function renderOptions(): void {
  const id = state.action;
  const spec = ACTIONS[id];
  const f = state.fields[id];
  const presets = $("sel-presets");
  presets.replaceChildren(
    ...(spec.presets ?? []).map((text) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.setAttribute("aria-pressed", String(f.prompt === text));
      button.onclick = () => {
        f.prompt = text;
        $<HTMLTextAreaElement>("sel-prompt").value = text;
        renderOptions();
        scheduleQuote(0);
      };
      return button;
    }),
  );
  const prompt = $<HTMLTextAreaElement>("sel-prompt");
  prompt.hidden = !spec.prompt;
  prompt.placeholder = spec.placeholder ?? "";
  if (prompt.value !== f.prompt) prompt.value = f.prompt;

  const choices = $("sel-choices");
  if (spec.sizes) {
    segButtons(choices, spec.sizes, f.size, (v) => v.toUpperCase(), (v) => { f.size = v; renderOptions(); scheduleQuote(0); });
  } else if (spec.aspects) {
    segButtons(choices, spec.aspects, f.aspect, (v) => v, (v) => { f.aspect = v; renderOptions(); scheduleQuote(0); });
  } else if (spec.seconds) {
    segButtons(choices, spec.seconds.map(String), String(f.seconds), (v) => `${v}s`, (v) => { f.seconds = Number(v); renderOptions(); scheduleQuote(0); });
  } else {
    choices.replaceChildren();
  }
  choices.setAttribute("aria-label", spec.sizes ? "Size" : spec.aspects ? "Aspect ratio" : "Length");

  $("sel-model-wrap").hidden = !spec.models;
  if (spec.models) fillModels($<HTMLSelectElement>("sel-model"), state.models[spec.tool] ?? [], f.model);
}

function renderSelection(): void {
  const sel = state.selection;
  $("sel-empty").hidden = !!sel;
  $("sel-body").hidden = !sel;
  if (!sel) return;
  $("sel-name").textContent = sel.count > 1 ? `${sel.name} (+${sel.count - 1})` : sel.name;
  $("sel-size").textContent = `${sel.width} × ${sel.height}`;
  const thumb = $("sel-thumb");
  if (state.layer && state.layer.id === sel.id) {
    const img = thumb.querySelector("img");
    if (!img || img.src !== state.layer.thumb) {
      const el = document.createElement("img");
      el.src = state.layer.thumb;
      el.alt = "";
      thumb.replaceChildren(el);
    }
  } else {
    thumb.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  }
  renderTools();
  renderOptions();
}

function renderGo(): void {
  const id = currentAction();
  const button = $<HTMLButtonElement>("go");
  const label = $("go-label");
  const q = state.quote;
  const busy = state.preparing || (q?.loading ?? false);
  const blocked = state.tab === "selection" && !state.selection;
  label.textContent = buttonLabel(id, q && !q.loading ? q.q?.credits : undefined);
  button.dataset.busy = String(busy && !state.running);
  const consentOk = !state.consentNeeded || $<HTMLInputElement>("consent-box").checked;
  button.disabled = blocked || !q?.q || busy || !q.q.enough || !consentOk || !!state.running;
  $("get-credits").hidden = !(q?.q && !q.q.enough);
  $("consent").hidden = !state.consentNeeded;
  $("go-row").hidden = !!state.running;
  $("progress").hidden = !state.running;
  renderBalance();
}

function renderAll(): void {
  renderTabs();
  renderGenerate();
  renderSelection();
  renderGo();
}

// ---------- Account ----------

function setSession(session: AccountSession): void {
  state.session = session;
  state.expired = false;
  state.client = new PopNowClient({
    fetch: doFetch,
    session,
    clientVersion: VERSION,
    onSession: (fresh) => {
      state.session = fresh;
      post({ type: "session:save", session: fresh });
    },
  });
  setPhase("in");
  renderAll();
  void loadAccount();
}

async function loadAccount(): Promise<void> {
  const client = state.client;
  if (!client) return;
  try {
    const [balance, images, videos] = await Promise.all([
      checkBalance(client),
      client.callTool("list_models", { category: "image" }),
      client.callTool("list_models", { category: "video" }),
    ]);
    state.balance = balance;
    const imageText = resultText(images);
    state.models.create_image = parseModels(imageText, "create_image");
    state.models.edit_image = parseModels(imageText, "edit_image");
    state.models.create_video = parseModels(resultText(videos), "create_video");
    renderAll();
    scheduleQuote(0);
  } catch (error) {
    handleError(error, () => void loadAccount());
  }
}

async function refreshBalance(): Promise<void> {
  if (!state.client) return;
  try {
    state.balance = await checkBalance(state.client);
    renderBalance();
  } catch {
    // the next quote shows the balance again
  }
}

function expire(): void {
  state.expired = true;
  state.client = null;
  state.session = null;
  post({ type: "session:clear" });
  $("sign-in").textContent = "Sign in again";
  $("gate-error").textContent = "Your PopNow sign-in expired.";
  setPhase("out");
}

async function signIn(): Promise<void> {
  const controller = new AbortController();
  state.login = { controller };
  $("gate-error").textContent = "";
  setPhase("signing");
  try {
    const pending = await startLogin({
      fetch: doFetch,
      mcpUrl: MCP_URL,
      relayUrl: RELAY_URL,
      openUrl: (url) => post({ type: "open", url }),
      signal: controller.signal,
    });
    state.login.url = pending.url;
    const session = await pending.session;
    post({ type: "session:save", session });
    state.login = null;
    $("sign-in").textContent = "Sign in with PopNow";
    setSession(session);
  } catch (error) {
    state.login = null;
    setPhase("out");
    if (error instanceof SignInError && error.reason === "canceled") return;
    $("gate-error").textContent =
      error instanceof SignInError
        ? capitalize(error.message)
        : "Can't reach PopNow. Check your connection and try again.";
  }
}

async function signOut(): Promise<void> {
  const session = state.client?.currentSession ?? state.session;
  state.running?.controller.abort();
  state.client = null;
  state.session = null;
  state.balance = undefined;
  state.quote = null;
  post({ type: "session:clear" });
  setPhase("out");
  if (session) await revoke(doFetch, session);
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function handleError(error: unknown, retry?: () => void): void {
  if (error instanceof SignInRequiredError) {
    expire();
    return;
  }
  if (error instanceof OfflineError || (error instanceof TypeError && /fetch/i.test(error.message))) {
    notice("Can't reach PopNow. Check your connection.", "error", retry ? { label: "Try again", run: retry } : undefined);
    return;
  }
  notice(error instanceof Error && error.message ? capitalize(error.message) : "Something went wrong.", "error", retry ? { label: "Try again", run: retry } : undefined);
}

// ---------- Selection ----------

/** Exports the selected layer (again when `fresh`, so edits made on the canvas are picked up). */
async function loadLayer(fresh = false): Promise<void> {
  const sel = state.selection;
  if (!sel || state.tab !== "selection" || state.layerLoading) return;
  if (!fresh && state.layer?.id === sel.id) return;
  state.layerLoading = true;
  const reply = await ask((requestId) => ({ type: "export", requestId, id: sel.id }));
  state.layerLoading = false;
  if (state.selection?.id !== sel.id) return;
  if (reply.type !== "exported") {
    notice(reply.type === "export-failed" ? reply.message : "Figma could not export this layer.", "error");
    return;
  }
  const copy = new Uint8Array(reply.bytes);
  const hash = await digestBytes(copy);
  if (state.layer?.id === sel.id && state.layer.hash === hash) return;
  if (state.layer?.thumb) URL.revokeObjectURL(state.layer.thumb);
  state.layer = {
    id: sel.id,
    name: sel.name,
    bytes: copy,
    width: reply.width,
    height: reply.height,
    hash,
    thumb: URL.createObjectURL(new Blob([copy], { type: "image/png" })),
  };
  renderSelection();
  scheduleQuote(0);
}

function safeName(name: string): string {
  return (name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "layer") + ".png";
}

/** Uploads the selected layer once per content, and reuses the link for 25 minutes. */
async function layerLink(): Promise<string> {
  const layer = state.layer;
  const client = state.client;
  if (!layer || !client) throw new Error("Select a layer first");
  const cached = uploads.get(layer.hash);
  if (cached && Date.now() - cached.at < UPLOAD_TTL_MS) return cached.link;
  let pending = uploading.get(layer.hash);
  if (!pending) {
    pending = uploadFiles(client, doFetch, [{ name: safeName(layer.name), contentType: "image/png", bytes: layer.bytes }])
      .then(([link]) => {
        if (!link) throw new Error("PopNow did not return a link");
        uploads.set(layer.hash, { link, at: Date.now() });
        return link;
      })
      .finally(() => uploading.delete(layer.hash));
    uploading.set(layer.hash, pending);
  }
  return pending;
}

// ---------- Quote ----------

let quoteTimer: number | undefined;
let quoteSeq = 0;

function scheduleQuote(delay = QUOTE_DELAY_MS): void {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(() => void refreshQuote(), delay);
}

function fieldsFor(id: ActionId): Fields {
  return state.fields[id];
}

async function refreshQuote(): Promise<void> {
  const client = state.client;
  if (!client || state.running) return;
  const id = currentAction();
  const spec = ACTIONS[id];
  const f = fieldsFor(id);
  const seq = ++quoteSeq;
  if (spec.needsImage) {
    if (!state.selection || state.layer?.id !== state.selection.id) {
      state.quote = null;
      renderGo();
      return;
    }
    // Upload only once the rest is filled in, so nothing leaves Figma before the user picked a tool and wrote what to do.
    if (!ready(id, { ...f, image: "pending" })) {
      state.quote = null;
      renderGo();
      return;
    }
    const cached = uploads.get(state.layer.hash);
    if (cached && Date.now() - cached.at < UPLOAD_TTL_MS) f.image = cached.link;
    else {
      state.preparing = true;
      renderGo();
      try {
        f.image = await layerLink();
      } catch (error) {
        state.preparing = false;
        if (seq !== quoteSeq) return;
        state.quote = null;
        renderGo();
        if (error instanceof SignInRequiredError || error instanceof OfflineError) handleError(error, () => scheduleQuote(0));
        else notice("Couldn't upload this layer to PopNow.", "error", { label: "Try again", run: () => scheduleQuote(0) });
        return;
      }
      state.preparing = false;
      if (seq !== quoteSeq) return;
    }
  }
  if (!ready(id, f)) {
    state.quote = null;
    renderGo();
    return;
  }
  const args = buildArgs(id, f);
  const key = `${spec.tool}:${JSON.stringify(args)}`;
  if (state.quote?.key === key && state.quote.q) {
    renderGo();
    return;
  }
  state.quote = { key, loading: true };
  state.consentNeeded = false;
  renderGo();
  try {
    const q = await quote(client, spec.tool, args);
    if (seq !== quoteSeq) return;
    state.quote = { key, loading: false, q };
    if (q.balance !== undefined) state.balance = q.balance;
    if ($("notice").dataset.kind === "error") notice("");
    if (!q.enough) notice(`You need ${formatCredits(q.credits)}.`, "error");
  } catch (error) {
    if (seq !== quoteSeq) return;
    state.quote = { key, loading: false, error: error instanceof Error ? error.message : "no price" };
    handleError(error, () => {
      state.quote = null;
      scheduleQuote(0);
    });
  }
  renderGo();
}

// ---------- Run ----------

function startProgress(video: boolean): AbortController {
  const controller = new AbortController();
  const startedAt = Date.now();
  const tick = (): void => {
    $("elapsed").textContent = formatElapsed(Date.now() - startedAt);
  };
  tick();
  state.running = { controller, startedAt, timer: window.setInterval(tick, 1000), video };
  $("progress-label").textContent = video ? "Making the video" : "Making it";
  notice("");
  renderGo();
  return controller;
}

function stopProgress(): void {
  if (state.running) window.clearInterval(state.running.timer);
  state.running = null;
  renderGo();
}

async function go(): Promise<void> {
  const client = state.client;
  const id = currentAction();
  const spec = ACTIONS[id];
  const q = state.quote?.q;
  if (!client || !q || !q.enough || state.running) return;
  const args = buildArgs(id, fieldsFor(id));
  if (state.quote?.key !== `${spec.tool}:${JSON.stringify(args)}`) return;
  const consent = state.consentNeeded && $<HTMLInputElement>("consent-box").checked;
  const anchor = spec.needsImage ? state.layer : null;
  const controller = startProgress(!!spec.video);
  let outcome: RunOutcome | undefined;
  try {
    outcome = await run(client, spec.tool, args, q.credits, { consent, signal: controller.signal });
    if (outcome.kind === "pending") outcome = await pollJob(client, outcome.jobId, { signal: controller.signal, pauseMs: 1000 });
  } catch (error) {
    stopProgress();
    if (controller.signal.aborted) {
      notice("Stopped waiting. PopNow keeps making it.", "info", { label: "My library", run: () => post({ type: "open", url: LIBRARY }) });
    } else {
      handleError(error);
    }
    void refreshBalance();
    return;
  }
  stopProgress();
  await settle(id, outcome, anchor);
  if (!state.quote) scheduleQuote(0);
}

async function settle(id: ActionId, outcome: RunOutcome, anchor: Layer | null): Promise<void> {
  const quoteState = state.quote;
  switch (outcome.kind) {
    case "done":
      state.consentNeeded = false;
      $<HTMLInputElement>("consent-box").checked = false;
      await placeResults(id, outcome.job, anchor);
      void refreshBalance();
      return;
    case "confirm":
      // Never raise the limit for the user: show the new price on the button and wait for another click.
      if (quoteState) quoteState.q = { credits: outcome.credits, ...(outcome.balance === undefined ? {} : { balance: outcome.balance }), enough: (outcome.balance ?? state.balance ?? Infinity) >= outcome.credits };
      notice(`The price is now ${formatCredits(outcome.credits)}. Nothing was charged.`, "info");
      renderGo();
      return;
    case "consent":
      state.consentNeeded = true;
      notice("Confirm the line above to continue. Nothing was charged.", "info");
      renderGo();
      return;
    case "not-enough":
      if (quoteState?.q) quoteState.q.enough = false;
      notice("Not enough credits. Nothing was charged.", "error");
      renderGo();
      return;
    case "failed":
      notice(capitalize(outcome.message.split("\n")[0] ?? "This creation failed."), "error");
      void refreshBalance();
      return;
    case "pending":
      return;
  }
}

async function placeResults(id: ActionId, job: JobInfo, anchor: Layer | null): Promise<void> {
  const spec = ACTIONS[id];
  const label = `PopNow · ${spec.label}`;
  const images: PlaceImage[] = [];
  let video: PlaceRequest["video"];
  if (spec.video) {
    const file = job.files.find((f) => f.type?.startsWith("video/")) ?? job.files[0];
    if (!file) return notice("PopNow did not return the video.", "error");
    let cover: Placeable | undefined;
    try {
      cover = await videoCover(file.url);
    } catch {
      if (anchor) cover = { bytes: anchor.bytes, width: anchor.width, height: anchor.height };
    }
    if (!cover) return notice("The video is ready in your PopNow library.", "ok", { label: "Open", run: () => post({ type: "open", url: LIBRARY }) });
    images.push({ ...cover, name: label });
    video = { url: file.url, library: LIBRARY };
  } else {
    let n = 0;
    for (const file of job.files) {
      if (file.type && !file.type.startsWith("image/")) continue;
      n++;
      const name = spec.group ? `Layer ${n}` : label;
      try {
        images.push({ ...(await fetchPlaceable(file.url)), name });
      } catch {
        images.push({ url: file.url, name });
      }
    }
  }
  if (!images.length) return notice("PopNow did not return an image.", "error");
  const reply = await ask((requestId) => ({
    type: "place",
    requestId,
    label,
    images,
    ...(anchor ? { anchorId: anchor.id } : {}),
    ...(spec.group ? { group: true } : {}),
    ...(video ? { video } : {}),
  }));
  if (reply.type === "placed") {
    const spent = job.credits ?? state.quote?.q?.credits;
    notice(spent ? `Added to the canvas · ${formatCredits(spent)}` : "Added to the canvas", "ok");
  } else {
    notice(reply.type === "place-failed" ? reply.message : "Figma could not add the result.", "error", {
      label: "My library",
      run: () => post({ type: "open", url: LIBRARY }),
    });
  }
}

// ---------- Events ----------

function pickAction(id: ActionId): void {
  if (state.running) return;
  state.action = id;
  state.quote = null;
  state.consentNeeded = false;
  notice("");
  renderSelection();
  renderGo();
  void loadLayer(true).then(() => scheduleQuote(0));
}

function setTab(tab: Tab): void {
  if (state.running || state.tab === tab) return;
  state.tab = tab;
  state.quote = null;
  state.consentNeeded = false;
  notice("");
  renderAll();
  if (tab === "selection") void loadLayer(true).then(() => scheduleQuote(0));
  else scheduleQuote(0);
}

function wire(): void {
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => setTab(el.dataset.tab as Tab));
  });
  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-href], a[data-open]");
    if (!target) return;
    event.preventDefault();
    const url = target.dataset.href ?? (target as HTMLAnchorElement).href;
    post({ type: "open", url });
    closeMenu();
  });
  $("sign-in").addEventListener("click", () => void signIn());
  $("reopen").addEventListener("click", () => {
    if (state.login?.url) post({ type: "open", url: state.login.url });
  });
  $("cancel-sign-in").addEventListener("click", () => state.login?.controller.abort());
  $("sign-out").addEventListener("click", () => {
    closeMenu();
    void signOut();
  });
  $("menu-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const open = $("menu").hidden;
    $("menu").hidden = !open;
    $("menu-btn").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest(".menu-wrap")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !$<HTMLButtonElement>("go").disabled) void go();
  });

  const genPrompt = $<HTMLTextAreaElement>("gen-prompt");
  genPrompt.addEventListener("input", () => {
    state.fields.generate.prompt = genPrompt.value;
    scheduleQuote();
  });
  $<HTMLSelectElement>("gen-model").addEventListener("change", (event) => {
    state.fields.generate.model = (event.target as HTMLSelectElement).value;
    scheduleQuote(0);
  });
  const selPrompt = $<HTMLTextAreaElement>("sel-prompt");
  selPrompt.addEventListener("input", () => {
    state.fields[state.action].prompt = selPrompt.value;
    for (const chip of $("sel-presets").querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.textContent === selPrompt.value));
    scheduleQuote();
  });
  $<HTMLSelectElement>("sel-model").addEventListener("change", (event) => {
    state.fields[state.action].model = (event.target as HTMLSelectElement).value;
    scheduleQuote(0);
  });
  $<HTMLInputElement>("consent-box").addEventListener("change", () => renderGo());
  $("go").addEventListener("click", () => void go());
  $("stop").addEventListener("click", () => state.running?.controller.abort());
}

function closeMenu(): void {
  $("menu").hidden = true;
  $("menu-btn").setAttribute("aria-expanded", "false");
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = (event.data as { pluginMessage?: ToUI } | null)?.pluginMessage;
  if (!message) return;
  if ("requestId" in message && waiting.has(message.requestId)) {
    waiting.get(message.requestId)?.resolve(message);
    waiting.delete(message.requestId);
    return;
  }
  if (message.type === "init") {
    state.editor = message.editor;
    document.documentElement.dataset.editor = message.editor;
    state.selection = message.selection;
    if (message.selection) state.tab = "selection";
    if (message.session) setSession(message.session);
    else setPhase("out");
    renderAll();
    if (state.tab === "selection") void loadLayer();
  } else if (message.type === "selection") {
    const had = state.selection;
    state.selection = message.selection;
    if (!had && message.selection && state.tab === "generate" && !state.fields.generate.prompt && !state.running) {
      state.tab = "selection";
    }
    if (state.selection?.id !== state.layer?.id) {
      state.quote = null;
      state.consentNeeded = false;
    }
    renderAll();
    if (state.tab === "selection") void loadLayer();
    scheduleQuote(0);
  }
});

wire();
post({ type: "ready" });

import { resultText, type McpToolResult, type PopNowClient } from "./mcp";

/**
 * Prices first, then runs only what the user clicked. The plugin always asks `estimate_cost` (free, creates
 * nothing) and puts the price on the button. A click runs the tool with `max_credits` set to exactly the
 * price the user saw. If PopNow now wants more, nothing starts and the new price goes back on the button:
 * the limit is never raised for the user.
 */

export interface Quote {
  credits: number;
  /** The user's balance when PopNow said it. */
  balance?: number;
  enough: boolean;
}

export interface ResultFile {
  url: string;
  link?: string;
  type?: string;
}

export interface JobInfo {
  jobId?: string;
  status?: string;
  credits?: number;
  model?: string;
  files: ResultFile[];
  text: string;
}

export type RunOutcome =
  | { kind: "done"; job: JobInfo }
  | { kind: "pending"; jobId: string; job: JobInfo }
  /** Nothing started: PopNow wants this many credits, more than the user approved. */
  | { kind: "confirm"; credits: number; balance?: number }
  /** Nothing started: the user must confirm the rights to the people in their media. */
  | { kind: "consent" }
  | { kind: "not-enough"; message: string }
  | { kind: "failed"; message: string };

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export async function quote(client: PopNowClient, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Quote> {
  const { max_credits: _drop, consent: _consent, ...exact } = args;
  void _drop;
  void _consent;
  const result = await client.callTool("estimate_cost", { tool, arguments: exact }, signal);
  const credits = num(result.structuredContent?.credits);
  if (result.isError || credits === undefined) throw new Error(resultText(result) || "PopNow could not price this");
  const balance = num(result.structuredContent?.balance);
  return { credits, ...(balance === undefined ? {} : { balance }), enough: balance === undefined || balance >= credits };
}

function jobFrom(result: McpToolResult): JobInfo {
  const data = result.structuredContent ?? {};
  const files: ResultFile[] = [];
  if (Array.isArray(data.files)) {
    for (const item of data.files as Record<string, unknown>[]) {
      if (typeof item?.url !== "string" || !item.url) continue;
      files.push({
        url: item.url,
        ...(typeof item.popnow_link === "string" ? { link: item.popnow_link } : {}),
        ...(typeof item.type === "string" ? { type: item.type } : {}),
      });
    }
  }
  const credits = num(data.credits);
  return {
    ...(typeof data.job_id === "string" ? { jobId: data.job_id } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(credits === undefined ? {} : { credits }),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    files,
    text: resultText(result),
  };
}

const NOT_ENOUGH = /not enough credits|more credits|insufficient/i;

/** Reads a creation tool's or get_job's reply. */
export function interpret(result: McpToolResult): RunOutcome {
  const data = result.structuredContent ?? {};
  if (data.needs_consent === true) return { kind: "consent" };
  if (data.needs_confirmation === true) {
    const credits = num(data.credits);
    const balance = num(data.balance);
    if (credits !== undefined) return { kind: "confirm", credits, ...(balance === undefined ? {} : { balance }) };
  }
  const text = resultText(result);
  const changed = /price is now (\d+) credits/i.exec(text);
  if (changed) return { kind: "confirm", credits: Number(changed[1]) };
  if (result.isError) {
    return NOT_ENOUGH.test(text)
      ? { kind: "not-enough", message: text }
      : { kind: "failed", message: text || "PopNow could not make this" };
  }
  const job = jobFrom(result);
  if (job.status === "failed" || job.status === "blocked") {
    return { kind: "failed", message: job.text || "This creation failed. Failed creations are refunded." };
  }
  if (job.files.length > 0 && (job.status === undefined || job.status === "succeeded")) return { kind: "done", job };
  if (job.jobId) return { kind: "pending", jobId: job.jobId, job };
  return { kind: "failed", message: job.text || "PopNow did not return a result" };
}

export interface RunOptions {
  /** Only when the user ticked the consent box themselves. */
  consent?: boolean;
  signal?: AbortSignal;
}

/** Runs a paid tool with the price the user approved on the button. */
export async function run(
  client: PopNowClient,
  tool: string,
  args: Record<string, unknown>,
  approvedCredits: number,
  options: RunOptions = {},
): Promise<RunOutcome> {
  if (!Number.isInteger(approvedCredits) || approvedCredits <= 0) throw new TypeError("approve a price first");
  const { max_credits: _drop, consent: _consent, ...rest } = args;
  void _drop;
  void _consent;
  const call: Record<string, unknown> = { ...rest, max_credits: approvedCredits };
  if (options.consent === true) call.consent = true;
  return interpret(await client.callTool(tool, call, options.signal));
}

export interface PollOptions {
  signal?: AbortSignal;
  /** How long the server may hold each get_job call, 0 to 50. */
  waitSeconds?: number;
  /** Pause between calls (the server already waits, so this is short). */
  pauseMs?: number;
  onUpdate?: (job: JobInfo) => void;
}

/** Waits for a job. Aborting only stops waiting here; the creation keeps going on PopNow. */
export async function pollJob(client: PopNowClient, jobId: string, options: PollOptions = {}): Promise<RunOutcome> {
  for (;;) {
    if (options.signal?.aborted) throw new DOMException("stopped waiting", "AbortError");
    const outcome = interpret(await client.callTool("get_job", { job_id: jobId, wait_seconds: options.waitSeconds ?? 20 }, options.signal));
    if (outcome.kind !== "pending") return outcome;
    options.onUpdate?.(outcome.job);
    if (options.pauseMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.pauseMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("stopped waiting", "AbortError"));
          },
          { once: true },
        );
      });
    }
  }
}

export async function checkBalance(client: PopNowClient, signal?: AbortSignal): Promise<number | undefined> {
  const result = await client.callTool("check_balance", {}, signal);
  return num(result.structuredContent?.credits);
}

export interface ModelChoice {
  /** Empty for Auto (PopNow's default). */
  id: string;
  name: string;
}

/**
 * Reads list_models' text ("- Name (model: id) by Maker: create images [create_image], ..., price") and keeps
 * the models the given tool can use. Auto comes first.
 */
export function parseModels(text: string, tool: string): ModelChoice[] {
  const out: ModelChoice[] = [{ id: "", name: "Auto" }];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^- (.+?) \(model: ([^)\s]+)\)(?: by [^:]+)?: (.*)$/.exec(line.trim());
    if (!m || !m[3]?.includes(`[${tool}]`) || seen.has(m[2] as string)) continue;
    seen.add(m[2] as string);
    out.push({ id: m[2] as string, name: m[1] as string });
  }
  return out;
}

export async function listModels(client: PopNowClient, category: "image" | "video", tool: string, signal?: AbortSignal): Promise<ModelChoice[]> {
  const result = await client.callTool("list_models", { category }, signal);
  return parseModels(resultText(result), tool);
}

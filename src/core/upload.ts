import { timeoutSignal, type PopNowClient } from "./mcp";
import type { Fetch } from "./oauth";

/**
 * Puts layer exports into the signed-in account and returns their popnow:// links, in order.
 *
 * It uses the upload window an AI app opens with `request_upload`: the window's link ends in a one-time
 * token, files go straight to storage through the window's public endpoints, and `get_upload` hands back
 * the links. The signed storage address never gets the PopNow token.
 */

export interface UploadFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

function kindOf(contentType: string): "image" | "video" | "audio" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  throw new TypeError(`only images, videos and audio can be uploaded (got ${contentType})`);
}

async function envelope(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: unknown };
  if (!response.ok || body.code !== 200) {
    throw new Error(body.msg ? `Upload failed: ${body.msg}` : `Upload failed (${response.status})`);
  }
  return (body.data ?? {}) as Record<string, unknown>;
}

export async function uploadFiles(client: PopNowClient, fetchImpl: Fetch, files: readonly UploadFile[], signal?: AbortSignal): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > 10) throw new TypeError("upload at most 10 files at once");
  const kinds = [...new Set(files.map((file) => kindOf(file.contentType)))];
  const opened = await client.callTool("request_upload", { kinds, max_files: files.length, note: "Layers from Figma" }, signal);
  const data = opened.structuredContent ?? {};
  const uploadId = typeof data.upload_id === "string" ? data.upload_id : undefined;
  const pageUrl = typeof data.url === "string" ? data.url : undefined;
  if (!uploadId || !pageUrl) throw new Error("PopNow did not open an upload window");
  const token = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  const api = `${new URL(client.endpoint).origin}/console/v1/upload-sessions/${encodeURIComponent(token)}`;
  const post = (path: string, body?: unknown): Promise<Response> =>
    fetchImpl(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeoutSignal(30_000, signal),
    });

  for (const file of files) {
    const ticket = await envelope(await post("/files", { contentType: file.contentType, bytes: file.bytes.byteLength, name: file.name }));
    const uploadUrl = ticket.uploadUrl;
    const fileId = ticket.fileId;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") throw new Error("Upload failed: no upload address");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((ticket.headers ?? {}) as Record<string, string>)) {
      // The browser sets these itself; Authorization is never sent to the signed storage address.
      if (!/^(content-length|host|authorization)$/i.test(key)) headers[key] = value;
    }
    const put = await fetchImpl(uploadUrl, {
      method: typeof ticket.method === "string" ? ticket.method : "PUT",
      headers,
      body: file.bytes as BodyInit,
      signal: timeoutSignal(5 * 60_000, signal),
    });
    if (!put.ok) throw new Error(`Upload of ${file.name} failed (${put.status})`);
    await envelope(await post(`/files/${encodeURIComponent(fileId)}/commit`));
  }
  await post("/close").then(envelope).catch(() => undefined);

  const result = await client.callTool("get_upload", { upload_id: uploadId, wait_seconds: 0 }, signal);
  const listed = Array.isArray(result.structuredContent?.files)
    ? (result.structuredContent.files as { popnow_link?: unknown; name?: unknown }[])
    : [];
  const unused = [...listed];
  return files.map((file) => {
    const at = unused.findIndex((item) => item.name === file.name);
    const item = at >= 0 ? unused.splice(at, 1)[0] : unused.shift();
    if (!item || typeof item.popnow_link !== "string") throw new Error(`PopNow did not return a link for ${file.name}`);
    return item.popnow_link;
  });
}

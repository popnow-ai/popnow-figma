import { validSession } from "./core/oauth";
import type { Editor, PlaceRequest, SelectionInfo, ToMain, ToUI } from "./shared/messages";

/**
 * The plugin's main thread: canvas access only. It reads the selection, exports layers as PNG, keeps the
 * sign-in in figma.clientStorage and places results next to the source layer. All network calls happen in
 * the UI iframe.
 */

const SESSION_KEY = "popnow.session";
const RESULT_KEY = "popnow.source";
const GAP = 48;
const MAX_EXPORT_SIDE = 2048;

const editor: Editor = figma.editorType === "figjam" ? "figjam" : "figma";

figma.showUI(__html__, { width: 340, height: 600, themeColors: true, title: "PopNow" });

function post(message: ToUI): void {
  figma.ui.postMessage(message);
}

function exportable(node: SceneNode): boolean {
  return "exportAsync" in node && node.visible !== false && node.width >= 1 && node.height >= 1;
}

function selectionInfo(): SelectionInfo | null {
  const all = figma.currentPage.selection;
  const node = all.find(exportable);
  if (!node) return null;
  return { id: node.id, name: node.name, width: Math.round(node.width), height: Math.round(node.height), count: all.length };
}

figma.on("selectionchange", () => post({ type: "selection", selection: selectionInfo() }));
figma.on("currentpagechange", () => post({ type: "selection", selection: selectionInfo() }));

async function exportNode(requestId: number, id: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("exportAsync" in node)) {
    post({ type: "export-failed", requestId, message: "That layer is gone. Select it again." });
    return;
  }
  const scene = node as SceneNode & ExportMixin;
  const side = Math.max(scene.width, scene.height);
  // Sharp enough for AI tools, small enough to upload quickly.
  const scale = Math.max(0.05, Math.min(2, MAX_EXPORT_SIDE / side));
  try {
    const bytes = await scene.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    post({ type: "exported", requestId, id, bytes, width: Math.round(scene.width * scale), height: Math.round(scene.height * scale) });
  } catch {
    post({ type: "export-failed", requestId, message: "Figma could not export this layer." });
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(node: SceneNode): Box {
  const b = node.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** Right of the source and right of earlier PopNow results for it, so nothing is covered. */
function nextSpot(anchor: SceneNode | null): { x: number; y: number; height?: number } {
  if (!anchor) {
    const c = figma.viewport.center;
    return { x: Math.round(c.x), y: Math.round(c.y) };
  }
  const box = boxOf(anchor);
  let right = box.x + box.width;
  for (const node of figma.currentPage.children) {
    if (node.getPluginData(RESULT_KEY) === anchor.id) {
      const b = boxOf(node);
      if (b.y < box.y + box.height && b.y + b.height > box.y) right = Math.max(right, b.x + b.width);
    }
  }
  return { x: Math.round(right + GAP), y: Math.round(box.y), height: box.height };
}

async function imageRect(image: PlaceRequest["images"][number]): Promise<RectangleNode> {
  const img = image.bytes ? figma.createImage(image.bytes) : await figma.createImageAsync(image.url ?? "");
  let { width, height } = image;
  if (!width || !height) ({ width, height } = await img.getSizeAsync());
  const rect = figma.createRectangle();
  rect.name = image.name;
  rect.resize(Math.max(1, width), Math.max(1, height));
  rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
  return rect;
}

function fitHeight(node: SceneNode & { resize(w: number, h: number): void }, height: number | undefined): void {
  if (height) {
    const ratio = node.width / node.height;
    node.resize(Math.max(1, Math.round(height * ratio)), Math.round(height));
  } else {
    // A fresh image: real pixels, but no bigger than 1024 on the canvas.
    const scale = Math.min(1, 1024 / Math.max(node.width, node.height));
    node.resize(Math.round(node.width * scale), Math.round(node.height * scale));
  }
}

async function linkText(text: string, links: { from: number; to: number; url: string }[]): Promise<TextNode | null> {
  let font: FontName | undefined;
  for (const candidate of [{ family: "Inter", style: "Medium" }, { family: "Inter", style: "Regular" }, { family: "Roboto", style: "Regular" }]) {
    try {
      await figma.loadFontAsync(candidate);
      font = candidate;
      break;
    } catch {
      // try the next one
    }
  }
  if (!font) return null;
  const node = figma.createText();
  node.fontName = font;
  node.characters = text;
  node.fontSize = 14;
  node.fills = [{ type: "SOLID", color: { r: 0.208, g: 0.133, b: 0.259 } }];
  for (const link of links) {
    node.setRangeHyperlink(link.from, link.to, { type: "URL", value: link.url });
    node.setRangeTextDecoration(link.from, link.to, "UNDERLINE");
    node.setRangeFills(link.from, link.to, [{ type: "SOLID", color: { r: 0.902, g: 0.353, b: 0.184 } }]);
  }
  return node;
}

async function place(request: PlaceRequest): Promise<number> {
  const anchor = request.anchorId ? ((await figma.getNodeByIdAsync(request.anchorId)) as SceneNode | null) : null;
  const spot = nextSpot(anchor);
  const page = figma.currentPage;
  const rects: RectangleNode[] = [];
  for (const image of request.images) rects.push(await imageRect(image));
  if (rects.length === 0) throw new Error("nothing to place");

  let result: SceneNode;
  if (request.group && rects.length > 1) {
    // Layers come back at the source's size: stack them, bottom layer first, and group them.
    const first = rects[0] as RectangleNode;
    for (const rect of rects) {
      page.appendChild(rect);
      rect.resize(first.width, first.height);
    }
    const group = figma.group([...rects].reverse(), page);
    group.name = request.label;
    group.rescale((spot.height ?? Math.min(1024, group.height)) / group.height);
    result = group;
  } else {
    const rect = rects[0] as RectangleNode;
    rect.name = request.label;
    page.appendChild(rect);
    fitHeight(rect, spot.height);
    result = rect;
  }
  if (anchor) {
    result.x = spot.x;
    result.y = spot.y;
  } else {
    result.x = spot.x - Math.round(result.width / 2);
    result.y = spot.y - Math.round(result.height / 2);
  }

  const placed: SceneNode[] = [result];
  if (request.video) {
    const text = "Play video  ·  Open in PopNow";
    const label = await linkText(text, [
      { from: 0, to: 10, url: request.video.url },
      { from: 15, to: text.length, url: request.video.library },
    ]);
    if (label) {
      page.appendChild(label);
      label.x = result.x;
      label.y = result.y + result.height + 12;
      const group = figma.group([result, label], page);
      group.name = request.label;
      placed[0] = group;
    }
  }
  for (const node of placed) if (anchor) node.setPluginData(RESULT_KEY, anchor.id);
  page.selection = placed;
  figma.viewport.scrollAndZoomIntoView(anchor ? [anchor, ...placed] : placed);
  return request.images.length;
}

figma.ui.onmessage = async (message: ToMain) => {
  switch (message.type) {
    case "ready": {
      let session = null;
      try {
        session = validSession(await figma.clientStorage.getAsync(SESSION_KEY)) ?? null;
      } catch {
        session = null;
      }
      post({ type: "init", session, editor, selection: selectionInfo() });
      break;
    }
    case "session:save":
      await figma.clientStorage.setAsync(SESSION_KEY, message.session);
      break;
    case "session:clear":
      await figma.clientStorage.deleteAsync(SESSION_KEY);
      break;
    case "open":
      // Only PopNow pages are opened from the panel.
      if (/^https:\/\/([a-z0-9-]+\.)?popnow\.ai\//.test(message.url)) figma.openExternal(message.url);
      break;
    case "export":
      await exportNode(message.requestId, message.id);
      break;
    case "place":
      try {
        const count = await place(message);
        post({ type: "placed", requestId: message.requestId, count });
      } catch (error) {
        post({
          type: "place-failed",
          requestId: message.requestId,
          message: error instanceof Error && error.message ? `Figma could not add the result: ${error.message}` : "Figma could not add the result.",
        });
      }
      break;
    case "notify":
      figma.notify(message.text, message.error ? { error: true } : undefined);
      break;
  }
};

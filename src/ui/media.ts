/** Turns PopNow results into something Figma can place: PNG/JPEG/GIF bytes, at most 4096 px a side. */

const FIGMA_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_SIDE = 4096;

export interface Placeable {
  bytes: Uint8Array;
  width: number;
  height: number;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("could not encode the image"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function placeableFromBlob(blob: Blob): Promise<Placeable> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (FIGMA_TYPES.has(blob.type) && Math.max(width, height) <= MAX_SIDE) {
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
    }
    const canvas = draw(bitmap, width, height);
    return { bytes: await canvasToPng(canvas), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

export async function fetchPlaceable(url: string, signal?: AbortSignal): Promise<Placeable> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  return placeableFromBlob(await response.blob());
}

/** The first frame of a video, as a cover image. */
export function videoCover(url: string, timeoutMs = 20_000): Promise<Placeable> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const timer = setTimeout(() => fail(new Error("the video took too long to load")), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
    };
    const fail = (error: Error): void => {
      done();
      reject(error);
    };
    video.addEventListener("error", () => fail(new Error("the video could not be read")), { once: true });
    video.addEventListener(
      "loadeddata",
      () => {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      },
      { once: true },
    );
    video.addEventListener(
      "seeked",
      async () => {
        try {
          const canvas = draw(video, video.videoWidth, video.videoHeight);
          const bytes = await canvasToPng(canvas);
          done();
          resolve({ bytes, width: canvas.width, height: canvas.height });
        } catch (error) {
          fail(error instanceof Error ? error : new Error("the video could not be read"));
        }
      },
      { once: true },
    );
    video.src = url;
  });
}

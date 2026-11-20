import type { AccountSession } from "../core/oauth";

/** Messages between the plugin's main thread (code.ts, canvas access) and its UI iframe (network). */

export type Editor = "figma" | "figjam";

export interface SelectionInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  /** How many layers are selected; the first exportable one is used. */
  count: number;
}

export interface PlaceImage {
  /** PNG, JPEG or GIF bytes, at most 4096 px a side. */
  bytes?: Uint8Array;
  /** Used when the bytes could not be read in the UI: Figma loads the image itself. */
  url?: string;
  width?: number;
  height?: number;
  name: string;
}

export interface PlaceRequest {
  requestId: number;
  anchorId?: string;
  /** Layer name for the result, e.g. "PopNow · Relight". */
  label: string;
  images: PlaceImage[];
  /** Several images become one group (Split layers). */
  group?: boolean;
  /** For videos: the first frame is placed with a link under it. */
  video?: { url: string; library: string };
}

export type ToMain =
  | { type: "ready" }
  | { type: "session:save"; session: AccountSession }
  | { type: "session:clear" }
  | { type: "open"; url: string }
  | { type: "export"; requestId: number; id: string }
  | ({ type: "place" } & PlaceRequest)
  | { type: "notify"; text: string; error?: boolean };

export type ToUI =
  | { type: "init"; session: AccountSession | null; editor: Editor; selection: SelectionInfo | null }
  | { type: "selection"; selection: SelectionInfo | null }
  | { type: "exported"; requestId: number; id: string; bytes: Uint8Array; width: number; height: number }
  | { type: "export-failed"; requestId: number; message: string }
  | { type: "placed"; requestId: number; count: number }
  | { type: "place-failed"; requestId: number; message: string };

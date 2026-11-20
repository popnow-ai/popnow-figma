/**
 * What the plugin can do, as PopNow tool calls. Names follow popnow.ai. Each action builds the exact
 * arguments for its tool from the panel's fields, so the quote and the run always send the same thing.
 */

export type ActionId = "generate" | "edit" | "removeBg" | "upscale" | "expand" | "relight" | "angle" | "layers" | "video";

export interface Fields {
  prompt: string;
  aspect: string;
  model: string;
  size: string;
  seconds: number;
  /** popnow:// link of the uploaded layer (selection actions only). */
  image?: string;
}

export interface ActionSpec {
  id: ActionId;
  tool: string;
  label: string;
  /** Short verb for the button: "Edit · 48 credits". */
  verb: string;
  needsImage: boolean;
  /** "required" when the tool needs words, "optional" when it can do without. */
  prompt?: "required" | "optional";
  placeholder?: string;
  /** Quick picks that fill the prompt. */
  presets?: string[];
  aspects?: string[];
  sizes?: string[];
  seconds?: number[];
  models?: "image" | "video";
  /** The result is a video (placed as its first frame plus a link). */
  video?: boolean;
  /** The result is several layers, placed as one group. */
  group?: boolean;
}

export const ACTIONS: Record<ActionId, ActionSpec> = {
  generate: {
    id: "generate", tool: "create_image", label: "Generate", verb: "Generate", needsImage: false,
    prompt: "required", placeholder: "Describe the image", aspects: ["1:1", "4:5", "3:2", "16:9", "9:16"], models: "image",
  },
  edit: {
    id: "edit", tool: "edit_image", label: "Edit image", verb: "Edit", needsImage: true,
    prompt: "required", placeholder: "What should change?", models: "image",
  },
  removeBg: { id: "removeBg", tool: "remove_background", label: "Remove background", verb: "Remove background", needsImage: true },
  upscale: { id: "upscale", tool: "upscale", label: "Upscale", verb: "Upscale", needsImage: true, sizes: ["2k", "4k", "8k"] },
  expand: {
    id: "expand", tool: "expand_image", label: "Expand", verb: "Expand", needsImage: true,
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2"],
  },
  relight: {
    id: "relight", tool: "relight_photo", label: "Relight", verb: "Relight", needsImage: true,
    prompt: "required", placeholder: "Describe the light",
    presets: ["Golden hour sun from the left", "Soft studio light", "Neon night", "Overcast daylight"],
  },
  angle: {
    id: "angle", tool: "change_camera_angle", label: "Camera angle", verb: "Change angle", needsImage: true,
    prompt: "required", placeholder: "Describe the new viewpoint",
    presets: ["From above", "Side view from the left", "Close-up", "Wide shot from behind"],
  },
  layers: {
    id: "layers", tool: "split_layers", label: "Split layers", verb: "Split", needsImage: true,
    prompt: "optional", placeholder: "Parts to separate (optional)", group: true,
  },
  video: {
    id: "video", tool: "create_video", label: "Image to video", verb: "Make video", needsImage: true,
    prompt: "required", placeholder: "What happens in the video?", seconds: [5, 10], models: "video", video: true,
  },
};

export const SELECTION_ACTIONS: ActionId[] = ["edit", "removeBg", "upscale", "expand", "relight", "angle", "layers", "video"];

export function defaultFields(id: ActionId): Fields {
  const spec = ACTIONS[id];
  return {
    prompt: "",
    aspect: spec.aspects?.[0] ?? "",
    model: "",
    size: spec.sizes?.[1] ?? "",
    seconds: spec.seconds?.[0] ?? 5,
  };
}

/** Whether the fields are complete enough to ask for a price. */
export function ready(id: ActionId, fields: Fields): boolean {
  const spec = ACTIONS[id];
  if (spec.needsImage && !fields.image) return false;
  if (spec.prompt === "required" && !fields.prompt.trim()) return false;
  return true;
}

/** The exact tool arguments (without max_credits). */
export function buildArgs(id: ActionId, fields: Fields): Record<string, unknown> {
  const spec = ACTIONS[id];
  const args: Record<string, unknown> = {};
  if (spec.needsImage) args.image_url = fields.image;
  const prompt = fields.prompt.trim();
  if (spec.prompt && prompt) args.prompt = prompt;
  if (spec.aspects && fields.aspect) args.aspect_ratio = fields.aspect;
  if (spec.models && fields.model) args.model = fields.model;
  if (spec.sizes && fields.size) args.size = fields.size;
  if (spec.seconds) args.duration_seconds = fields.seconds;
  return args;
}

export function formatCredits(credits: number): string {
  return `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`;
}

export function buttonLabel(id: ActionId, credits?: number): string {
  const verb = ACTIONS[id].verb;
  return credits === undefined ? verb : `${verb} · ${formatCredits(credits)}`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

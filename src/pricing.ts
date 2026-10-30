import type { ModelPrice, Usage } from "./types.js";

export function lookupPrice(
  model: string,
  pricing: Record<string, ModelPrice>,
  fallback: ModelPrice,
): { price: ModelPrice; matched: string | null } {
  if (pricing[model]) return { price: pricing[model], matched: model };
  const keys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return { price: pricing[key], matched: key };
  }
  return { price: fallback, matched: null };
}

export function estimateCostUsd(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPrice>,
  fallback: ModelPrice,
): { costUsd: number; matched: string | null } {
  const { price, matched } = lookupPrice(model, pricing, fallback);
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncachedPrompt = Math.max(0, usage.promptTokens - cached);
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
  const costUsd =
    (uncachedPrompt / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * cachedRate +
    (usage.completionTokens / 1_000_000) * price.outputPerMillion;
  return { costUsd, matched };
}

export function parseUsage(payload: unknown): Usage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return null;
  const prompt = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0;
  const completion = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0;
  const details = usage.prompt_tokens_details;
  const cachedFromDetails =
    details && typeof details === "object" ? num((details as { cached_tokens?: unknown }).cached_tokens) : undefined;
  const cached = cachedFromDetails ?? num(usage.cached_tokens) ?? 0;
  const total = num(usage.total_tokens) ?? prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: total };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const CHARS_PER_TOKEN = 4;

/**
 * Tokens reserved for one image when detail is omitted, auto, high, or original.
 * Pixel size is not known here. This is a stand-in so a screenshot is not priced
 * as one token per four base64 characters, and a remote URL is not priced as a
 * handful of characters.
 */
export const IMAGE_PREFLIGHT_TOKENS = 16_384;

/** Tokens reserved for an image part with detail "low". */
export const LOW_DETAIL_IMAGE_PREFLIGHT_TOKENS = 4_096;

/** Tokens reserved for one audio clip or file payload. Base64 length is not the token count. */
export const BINARY_MEDIA_PREFLIGHT_TOKENS = 16_384;

const IMAGE_TYPES = new Set(["image_url", "input_image", "image"]);
const MEDIA_TYPES = new Set(["input_audio", "audio", "input_file", "file"]);
const IMAGE_PAYLOAD_KEYS = new Set(["image_url", "file_id", "image_base64", "url"]);
const MEDIA_PAYLOAD_KEYS = new Set(["input_audio", "data", "file_data", "file", "audio"]);

export type Preflight = {
  usage: Usage;
  /** True when output is capped (max_tokens / embeddings). False holds the remaining hard headroom. */
  outputBounded: boolean;
  costUsd: number;
  promptCostUsd: number;
};

function finiteNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function textChars(value: unknown): number {
  if (typeof value === "string") return charsOfString(value);
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += textChars(item);
    return n;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isImagePart(obj)) return tokenChars(imageTokensFor(obj)) + textCharsExcept(obj, IMAGE_PAYLOAD_KEYS);
    if (isMediaPart(obj)) return tokenChars(BINARY_MEDIA_PREFLIGHT_TOKENS) + textCharsExcept(obj, MEDIA_PAYLOAD_KEYS);
    let n = 0;
    for (const v of Object.values(obj)) n += textChars(v);
    return n;
  }
  return 0;
}

function textCharsExcept(obj: Record<string, unknown>, skip: Set<string>): number {
  let n = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key)) continue;
    n += textChars(value);
  }
  return n;
}

function isImagePart(obj: Record<string, unknown>): boolean {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (!IMAGE_TYPES.has(type)) return false;
  return "image_url" in obj || "file_id" in obj || "image_base64" in obj || "url" in obj;
}

function isMediaPart(obj: Record<string, unknown>): boolean {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (!MEDIA_TYPES.has(type)) return false;
  return "input_audio" in obj || "data" in obj || "file_data" in obj || "file" in obj || "audio" in obj;
}

function imageTokensFor(obj: Record<string, unknown>): number {
  return imageDetail(obj) === "low" ? LOW_DETAIL_IMAGE_PREFLIGHT_TOKENS : IMAGE_PREFLIGHT_TOKENS;
}

function imageDetail(obj: Record<string, unknown>): string {
  if (typeof obj.detail === "string") return obj.detail.trim().toLowerCase();
  const nested = obj.image_url;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const detail = (nested as Record<string, unknown>).detail;
    if (typeof detail === "string") return detail.trim().toLowerCase();
  }
  return "";
}

function charsOfString(value: string): number {
  const tokens = dataUrlTokens(value);
  return tokens == null ? value.length : tokenChars(tokens);
}

/** Image and file data URLs are payloads, not prompt text. Other strings stay as text. */
function dataUrlTokens(value: string): number | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma <= 5 || comma > 256) return null;
  const header = value.slice(0, comma);
  if (!/;base64/i.test(header)) return null;
  const mime = /^data:([^;,]+)/i.exec(header)?.[1]?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return IMAGE_PREFLIGHT_TOKENS;
  return BINARY_MEDIA_PREFLIGHT_TOKENS;
}

function tokenChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

export function roughTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Rough input size from chat messages, completion prompts, or embedding inputs. */
export function preflightFromBody(
  model: string,
  body: Record<string, unknown> | null,
  pathname: string,
  pricing: Record<string, ModelPrice>,
  fallback: ModelPrice,
): Preflight {
  let promptChars = 0;
  if (body) {
    if (body.messages != null) promptChars += textChars(body.messages);
    if (body.prompt != null) promptChars += textChars(body.prompt);
    if (body.input != null) promptChars += textChars(body.input);
  }
  const promptTokens = roughTokens(promptChars);
  const embeddings = pathname.endsWith("/embeddings");
  let outputTokens = 0;
  let outputBounded = embeddings;
  if (!embeddings && body) {
    const cap = finiteNum(body.max_completion_tokens) ?? finiteNum(body.max_tokens);
    if (cap != null && cap >= 0) {
      outputTokens = Math.floor(cap);
      outputBounded = true;
    }
  }
  const usage: Usage = {
    promptTokens,
    completionTokens: outputTokens,
    cachedTokens: 0,
    totalTokens: promptTokens + outputTokens,
  };
  const promptUsage: Usage = { ...usage, completionTokens: 0, totalTokens: promptTokens };
  return {
    usage,
    outputBounded,
    costUsd: estimateCostUsd(model, usage, pricing, fallback).costUsd,
    promptCostUsd: estimateCostUsd(model, promptUsage, pricing, fallback).costUsd,
  };
}

export function completionCharsFromSseData(data: string): number {
  if (!data || data === "[DONE]") return 0;
  try {
    return completionCharsFromPayload(JSON.parse(data));
  } catch {
    return 0;
  }
}

function completionCharsFromPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return 0;
  let chars = 0;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const row = choice as { delta?: unknown; text?: unknown; message?: unknown };
    if (typeof row.text === "string") chars += row.text.length;
    chars += deltaChars(row.delta);
    chars += deltaChars(row.message);
  }
  return chars;
}

function deltaChars(delta: unknown): number {
  if (!delta || typeof delta !== "object") return 0;
  const d = delta as { content?: unknown; refusal?: unknown; tool_calls?: unknown };
  let chars = 0;
  if (typeof d.content === "string") chars += d.content.length;
  if (typeof d.refusal === "string") chars += d.refusal.length;
  if (Array.isArray(d.tool_calls)) {
    for (const call of d.tool_calls) {
      if (!call || typeof call !== "object") continue;
      const args = (call as { function?: { arguments?: unknown } }).function?.arguments;
      if (typeof args === "string") chars += args.length;
    }
  }
  return chars;
}

export function extractUsageFromSse(buffer: string): Usage | null {
  let found: Usage | null = null;
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const usage = parseUsage(JSON.parse(data));
      if (usage && (usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0)) {
        found = usage;
      }
    } catch {
      // ignore partial JSON
    }
  }
  return found;
}

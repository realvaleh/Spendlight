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
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += textChars(item);
    return n;
  }
  if (value && typeof value === "object") {
    let n = 0;
    for (const v of Object.values(value as Record<string, unknown>)) n += textChars(v);
    return n;
  }
  return 0;
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

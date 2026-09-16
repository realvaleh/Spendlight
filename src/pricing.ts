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

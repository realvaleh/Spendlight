import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BudgetLimit, Config, ModelPrice } from "./types.js";

/** Default USD prices per 1M tokens. Overridable via spendlight.config.json. */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.025 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: 0.1 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2, cachedInputPerMillion: 0.025 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 },
  "gpt-5.6": { inputPerMillion: 5, outputPerMillion: 30, cachedInputPerMillion: 0.5 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.275 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55 },
  "o3": { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  "o1-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55 },
  "o1": { inputPerMillion: 15, outputPerMillion: 60, cachedInputPerMillion: 7.5 },
  "gpt-3.5-turbo": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  "text-embedding-3-small": { inputPerMillion: 0.02, outputPerMillion: 0 },
  "text-embedding-3-large": { inputPerMillion: 0.13, outputPerMillion: 0 },
};

export const DEFAULT_FALLBACK: ModelPrice = {
  inputPerMillion: 5,
  outputPerMillion: 15,
  cachedInputPerMillion: 0.5,
};

type FileConfig = {
  host?: string;
  port?: number;
  dbPath?: string;
  upstream?: { baseUrl?: string; apiKey?: string };
  budgets?: {
    global?: Partial<BudgetLimit>;
    projects?: Record<string, Partial<BudgetLimit>>;
  };
  pricing?: Record<string, Partial<ModelPrice>>;
  fallbackPrice?: Partial<ModelPrice>;
};

function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseBudget(raw: Partial<BudgetLimit> | undefined): BudgetLimit {
  return {
    softUsd: raw?.softUsd == null ? null : Number(raw.softUsd),
    hardUsd: raw?.hardUsd == null ? null : Number(raw.hardUsd),
  };
}

export function parseArgs(argv: string[]): { configPath?: string; help?: boolean; version?: boolean } {
  const out: { configPath?: string; help?: boolean; version?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-c" || a === "--config") out.configPath = argv[++i];
    else if (a === "--port") process.env.SPENDLIGHT_PORT = argv[++i];
    else if (a === "--host") process.env.SPENDLIGHT_HOST = argv[++i];
    else if (a === "--db") process.env.SPENDLIGHT_DB = argv[++i];
  }
  return out;
}

export function loadConfig(explicitPath?: string): Config {
  const configPath =
    explicitPath ??
    process.env.SPENDLIGHT_CONFIG ??
    (existsSync(resolve("spendlight.config.json")) ? resolve("spendlight.config.json") : null);

  let file: FileConfig = {};
  if (configPath && existsSync(configPath)) {
    file = JSON.parse(readFileSync(configPath, "utf8")) as FileConfig;
  }

  const pricing = { ...DEFAULT_PRICING };
  for (const [model, price] of Object.entries(file.pricing ?? {})) {
    pricing[model] = {
      inputPerMillion: Number(price.inputPerMillion ?? DEFAULT_FALLBACK.inputPerMillion),
      outputPerMillion: Number(price.outputPerMillion ?? DEFAULT_FALLBACK.outputPerMillion),
      cachedInputPerMillion: price.cachedInputPerMillion == null ? undefined : Number(price.cachedInputPerMillion),
    };
  }

  const projects: Record<string, BudgetLimit> = {};
  for (const [name, b] of Object.entries(file.budgets?.projects ?? {})) {
    projects[name] = parseBudget(b);
  }

  const envSoft = numEnv("SPENDLIGHT_SOFT_BUDGET_USD");
  const envHard = numEnv("SPENDLIGHT_HARD_BUDGET_USD");
  const global = parseBudget(file.budgets?.global);
  if (envSoft !== undefined) global.softUsd = envSoft;
  if (envHard !== undefined) global.hardUsd = envHard;

  if (file.upstream?.apiKey && !process.env.OPENAI_API_KEY) {
    console.warn(
      "Spendlight: upstream.apiKey is set in the config file. Prefer OPENAI_API_KEY so the secret is not sitting in JSON.",
    );
  }

  return {
    host: process.env.SPENDLIGHT_HOST ?? file.host ?? "127.0.0.1",
    port: Number(process.env.SPENDLIGHT_PORT ?? file.port ?? 8787),
    dbPath: process.env.SPENDLIGHT_DB ?? file.dbPath ?? "./data/spendlight.db",
    configPath,
    upstreamBaseUrl: normalizeUpstreamUrl(
      process.env.OPENAI_BASE_URL ??
        process.env.SPENDLIGHT_UPSTREAM_URL ??
        file.upstream?.baseUrl ??
        "https://api.openai.com/v1",
    ),
    upstreamApiKey: process.env.OPENAI_API_KEY ?? file.upstream?.apiKey ?? null,
    budgets: { global, projects },
    pricing,
    fallbackPrice: {
      inputPerMillion: file.fallbackPrice?.inputPerMillion ?? DEFAULT_FALLBACK.inputPerMillion,
      outputPerMillion: file.fallbackPrice?.outputPerMillion ?? DEFAULT_FALLBACK.outputPerMillion,
      cachedInputPerMillion: file.fallbackPrice?.cachedInputPerMillion ?? DEFAULT_FALLBACK.cachedInputPerMillion,
    },
  };
}

export const HELP = `Spendlight — OpenAI-compatible spend proxy

Usage:
  spendlight [--config path] [--host 127.0.0.1] [--port 8787] [--db ./data/spendlight.db]

Point any OpenAI client at http://HOST:PORT/v1 and keep (or omit) your API key.

Env:
  OPENAI_API_KEY                 Upstream key (optional if clients send Authorization)
  OPENAI_BASE_URL                Upstream base, default https://api.openai.com/v1
  SPENDLIGHT_HOST                Bind address (default 127.0.0.1; Docker uses 0.0.0.0)
  SPENDLIGHT_PORT                Port (default 8787)
  SPENDLIGHT_DB                  SQLite path
  SPENDLIGHT_CONFIG              Config JSON path
  SPENDLIGHT_SOFT_BUDGET_USD     Global soft budget
  SPENDLIGHT_HARD_BUDGET_USD     Global hard budget (kill-switch)

Bind to 127.0.0.1 (the default). The dashboard, receipts, and /api/summary have no auth.
`;

/** http(s) only; strips userinfo so keys in the URL cannot leak via logs or fetch. */
export function normalizeUpstreamUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("OPENAI_BASE_URL must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL must be http or https");
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.href.replace(/\/$/, "");
}

export function isWildcardBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";
}

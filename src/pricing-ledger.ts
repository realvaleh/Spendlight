import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { admitMutating, evaluateBudget, fmt, spendWindow } from "./budget.js";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig } from "./config.js";
import {
  insertEvent,
  insertRequest,
  insertReservation,
  openDb,
  purgeStaleReservations,
  releaseReservation,
  reservedSpend,
  roundUsd,
  spendFor,
  type Db,
} from "./db.js";
import {
  completionCharsFromSseData,
  estimateCostUsd,
  extractUsageFromSse,
  lookupPrice,
  parseUsage,
  preflightFromBody,
  roughTokens,
} from "./pricing.js";
import { upstreamSearch } from "./proxy.js";
import { badgeSvg, receiptMarkdown } from "./receipts.js";
import { buildSummary, createApp, ledgerCsv, ledgerJson, listen, type App } from "./server.js";
import type { Config, Usage } from "./types.js";

const API_KEY = "sk-pricing-ledger-test";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "SPENDLIGHT_UPSTREAM_URL",
  "SPENDLIGHT_CONFIG",
  "SPENDLIGHT_SOFT_BUDGET_USD",
  "SPENDLIGHT_HARD_BUDGET_USD",
  "SPENDLIGHT_BUDGET_PERIOD",
  "SPENDLIGHT_BUDGET_TIMEZONE",
  "SPENDLIGHT_PORT",
  "SPENDLIGHT_HOST",
  "SPENDLIGHT_DB",
] as const;

function fail(message: string): never {
  throw new Error(`PRICING LEDGER FAIL: ${message}`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

function near(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

function usage(prompt: number, completion: number, cached: number, total = prompt + completion): Usage {
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: total };
}

function cost(model: string, prompt: number, completion: number, cached: number): number {
  return estimateCostUsd(model, usage(prompt, completion, cached), DEFAULT_PRICING, DEFAULT_FALLBACK).costUsd;
}

function withoutEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeConfig(dir: string, name: string, file: Record<string, unknown>): Config {
  const dbPath = join(dir, `${name}.db`);
  const configPath = join(dir, `${name}.json`);
  writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port: 0, dbPath, ...file }));
  return withoutEnv(() => loadConfig(configPath));
}

function openConfigured(dir: string, name: string, file: Record<string, unknown>): { config: Config; db: Db } {
  const config = writeConfig(dir, name, file);
  return { config, db: openDb(config.dbPath) };
}

function seed(
  db: Db,
  row: {
    id: string;
    createdAt: string;
    project?: string;
    model?: string;
    costUsd: number;
    tokens?: number;
    status?: number;
    error?: string | null;
    streamed?: boolean;
  },
): void {
  const tokens = row.tokens ?? 1;
  insertRequest(db, {
    id: row.id,
    createdAt: row.createdAt,
    project: row.project ?? "demo",
    model: row.model ?? "gpt-4o-mini",
    usage: usage(tokens, 0, 0, tokens),
    costUsd: row.costUsd,
    status: row.status ?? 200,
    error: row.error ?? null,
    path: "/v1/chat/completions",
    streamed: row.streamed ?? false,
  });
}

function testPriceMath(): void {
  near(cost("gpt-4o-mini", 1_000_000, 0, 0), 0.15, "mini input");
  near(cost("gpt-4o-mini", 100_000, 50_000, 0), 0.045, "mini prompt plus completion");
  near(cost("gpt-4o-mini", 1_000_000, 0, 800_000), 0.09, "mini cached discount");
  near(cost("gpt-4o-mini", 100, 0, 250), 0.0000075, "cache above the prompt is capped");
  near(cost("gpt-4o", 1_000_000, 100_000, 400_000), 3, "gpt-4o mix");
  near(cost("gpt-3.5-turbo", 1_000_000, 0, 1_000_000), 0.5, "missing cache rate uses input");
  near(cost("text-embedding-3-large", 1_000_000, 1_000_000, 0), 0.13, "embedding output is free");
  near(cost("text-embedding-3-small", 1_000_000, 0, 0), 0.02, "small embedding");
  near(cost("local-llama", 1_000_000, 1_000_000, 0), 20, "unknown model uses fallback");
  near(cost("local-llama", 1_000_000, 0, 1_000_000), 0.5, "unknown model cache uses fallback cache rate");

  const priced = (model: string) => lookupPrice(model, DEFAULT_PRICING, DEFAULT_FALLBACK);
  assert(priced("gpt-4o-mini").matched === "gpt-4o-mini", "exact mini");
  assert(priced("gpt-4o-mini-2024-07-18").matched === "gpt-4o-mini", "dated mini must not use gpt-4o");
  near(cost("gpt-4o-mini-2024-07-18", 1_000_000, 0, 0), 0.15, "dated mini price");
  assert(priced("gpt-4o-2024-08-06").matched === "gpt-4o", "dated gpt-4o");
  near(cost("gpt-4o-2024-08-06", 1_000_000, 0, 0), 2.5, "dated gpt-4o price");
  assert(priced("gpt-5.6-2026-01-01").matched === "gpt-5.6", "dated gpt-5.6 must not use gpt-5");
  assert(priced("gpt-4.1-mini-2025").matched === "gpt-4.1-mini", "dated 4.1 mini");
  assert(priced("o1-mini-2024-09-12").matched === "o1-mini", "dated o1-mini must not use o1");
  assert(priced("o1x").matched === "o1", "prefix o1");
  assert(priced("gpt-40").matched === null, "gpt-40 is not gpt-4o");
  assert(priced("local-llama").matched === null, "unknown match");

  assert(fmt(0.045) === "$0.0450", `fmt cent ${fmt(0.045)}`);
  assert(fmt(0.04) === "$0.0400", `fmt cap ${fmt(0.04)}`);
  assert(fmt(1) === "$1.00", `fmt dollar ${fmt(1)}`);
  assert(fmt(2.5) === "$2.50", `fmt 2.5 ${fmt(2.5)}`);
  assert(fmt(0.009) === "$0.009000", `fmt sub-cent ${fmt(0.009)}`);
  assert(fmt(null) === "—", "fmt null");
  assert(roundUsd(0.123456789) === 0.12345679, `roundUsd ${roundUsd(0.123456789)}`);
}

function testParseAndPreflight(): void {
  assert(roughTokens(0) === 0 && roughTokens(-4) === 0, "non-positive chars are zero tokens");
  assert(roughTokens(1) === 1 && roughTokens(4) === 1 && roughTokens(5) === 2, "chars per token");

  const chat = parseUsage({
    usage: {
      prompt_tokens: 100_000,
      completion_tokens: 50,
      total_tokens: 100_050,
      prompt_tokens_details: { cached_tokens: 40_000 },
      cached_tokens: 1,
    },
  });
  assert(chat?.cachedTokens === 40_000 && chat.promptTokens === 100_000 && chat.completionTokens === 50, "chat details win");

  const top = parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, cached_tokens: 4 } });
  assert(top?.cachedTokens === 4 && top.totalTokens === 11, `top-level cache ${JSON.stringify(top)}`);

  const emptyDetails = parseUsage({
    usage: { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: {}, cached_tokens: 9 },
  });
  assert(emptyDetails?.cachedTokens === 9, "details without cached_tokens fall through");

  const responses = parseUsage({ usage: { input_tokens: " 1000 ", output_tokens: "10" } });
  assert(
    responses?.promptTokens === 1000 && responses.completionTokens === 10 && responses.cachedTokens === 0 && responses.totalTokens === 1010,
    `responses usage ${JSON.stringify(responses)}`,
  );
  const explicitZero = parseUsage({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 0 } });
  assert(explicitZero?.totalTokens === 0, "explicit zero total is kept");
  assert(parseUsage({ usage: { prompt_tokens: "nope", completion_tokens: 2 } })?.promptTokens === 0, "bad token string is zero");
  assert(parseUsage(null) == null && parseUsage({}) == null && parseUsage({ usage: null }) == null, "missing usage");
  assert(parseUsage({ usage: "nope" }) == null, "non-object usage");

  const bothCaps = preflightFromBody(
    "gpt-4o-mini",
    { messages: [{ role: "user", content: "hi" }], max_tokens: 16, max_completion_tokens: 4 },
    "/v1/chat/completions",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(bothCaps.outputBounded && bothCaps.usage.completionTokens === 4, "max_completion_tokens wins");
  assert(bothCaps.usage.promptTokens === 2, "role text counts toward the rough prompt");
  near(bothCaps.costUsd, bothCaps.promptCostUsd + cost("gpt-4o-mini", 0, 4, 0), "bounded preflight adds output");

  const open = preflightFromBody(
    "gpt-4o-mini",
    { messages: [{ role: "user", content: "hi" }] },
    "/v1/chat/completions",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(!open.outputBounded && open.usage.completionTokens === 0, "no cap holds no output estimate");

  const nested = preflightFromBody(
    "gpt-4o-mini",
    { messages: [{ role: "user", content: [{ type: "text", text: "abcd" }] }] },
    "/v1/chat/completions",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(nested.usage.promptTokens === 3, `nested content tokens ${nested.usage.promptTokens}`);

  const emb = preflightFromBody(
    "text-embedding-3-small",
    { input: "abcd", max_tokens: 100 },
    "/v1/embeddings",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(emb.outputBounded && emb.usage.completionTokens === 0 && emb.usage.promptTokens === 1, "embeddings ignore max_tokens");
  near(emb.costUsd, cost("text-embedding-3-small", 1, 0, 0), "embedding preflight price");

  const input = preflightFromBody(
    "gpt-4o-mini",
    { input: "abcd" },
    "/v1/responses",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(input.usage.promptTokens === 1 && !input.outputBounded, "responses input is priced as prompt");

  assert(completionCharsFromSseData("[DONE]") === 0, "done frame");
  assert(completionCharsFromSseData("not-json") === 0, "bad sse json");
  assert(
    completionCharsFromSseData(
      JSON.stringify({
        choices: [{ delta: { content: "ab", refusal: "c", tool_calls: [{ function: { arguments: "de" } }] } }],
      }),
    ) === 5,
    "delta content, refusal, and tool arguments",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ choices: [{ message: { content: "ab" }, text: "c" }] })) === 3,
    "message and text",
  );

  const sse = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    "",
    'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    "",
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":4}}}',
    "",
    "data: [DONE]",
    "",
    "data: {",
    "",
  ].join("\n");
  const found = extractUsageFromSse(sse);
  assert(found?.promptTokens === 10 && found.completionTokens === 2 && found.cachedTokens === 4, `sse usage ${JSON.stringify(found)}`);

  assert(upstreamSearch("") === "" && upstreamSearch("?") === "", "empty search");
  assert(upstreamSearch("?project=demo") === "", "project only");
  assert(upstreamSearch("?tag=demo&user=abc") === "?user=abc", "tag stripped, user kept");
  assert(upstreamSearch("?user=a%2Fb&project=demo") === "?user=a%2Fb", "encoding preserved");
  assert(upstreamSearch("?%70roject=secret&user=keep") === "?user=keep", "encoded project name is still a label");
  assert(upstreamSearch("?project=demo&tag=x&n=1") === "?n=1", "both labels stripped");
  assert(upstreamSearch("project=demo&user=abc") === "?user=abc", "search without a leading question mark");
}

function testPriceConfig(dir: string): void {
  const partial = withoutEnv(() => {
    const path = join(dir, "partial-price.json");
    writeFileSync(
      path,
      JSON.stringify({
        pricing: {
          "gpt-4o": { inputPerMillion: 3 },
          "gpt-4o-mini": { cachedInputPerMillion: 0 },
          "local-llama": { inputPerMillion: 1 },
        },
        fallbackPrice: { inputPerMillion: 9 },
      }),
    );
    return loadConfig(path);
  });
  const gpt4o = partial.pricing["gpt-4o"];
  assert(gpt4o?.inputPerMillion === 3, `partial input ${gpt4o?.inputPerMillion}`);
  assert(gpt4o?.outputPerMillion === 10, `partial override dropped output (${gpt4o?.outputPerMillion})`);
  assert(gpt4o?.cachedInputPerMillion === 1.25, `partial override dropped cache (${gpt4o?.cachedInputPerMillion})`);
  const mini = partial.pricing["gpt-4o-mini"];
  assert(mini?.inputPerMillion === 0.15 && mini.outputPerMillion === 0.6 && mini.cachedInputPerMillion === 0, "explicit zero cache rate");
  near(
    estimateCostUsd("gpt-4o-mini", usage(1_000_000, 0, 1_000_000), partial.pricing, partial.fallbackPrice).costUsd,
    0,
    "zero cache rate is free",
  );
  const local = partial.pricing["local-llama"];
  assert(local?.inputPerMillion === 1 && local.outputPerMillion === 15, `new model output ${local?.outputPerMillion}`);
  assert(local?.cachedInputPerMillion === undefined, "new model without a cache rate stays unset");
  near(
    estimateCostUsd("local-llama", usage(1_000_000, 0, 1_000_000), partial.pricing, partial.fallbackPrice).costUsd,
    1,
    "unset cache rate bills at input",
  );
  assert(partial.pricing["gpt-5"]?.inputPerMillion === DEFAULT_PRICING["gpt-5"].inputPerMillion, "untouched model");
  assert(partial.fallbackPrice.inputPerMillion === 9, "fallback input override");
  assert(partial.fallbackPrice.outputPerMillion === 15 && partial.fallbackPrice.cachedInputPerMillion === 0.5, "fallback fields merge");

  const alias = withoutEnv(() => {
    process.env.SPENDLIGHT_UPSTREAM_URL = "https://user:sk-secret@example.test/v1/";
    const path = join(dir, "upstream-alias.json");
    writeFileSync(path, JSON.stringify({ budgets: { global: { hardUsd: 3, softUsd: 1 } } }));
    const fromAlias = loadConfig(path);
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1/";
    process.env.SPENDLIGHT_HARD_BUDGET_USD = "4";
    process.env.SPENDLIGHT_SOFT_BUDGET_USD = "";
    const fromOpenAi = loadConfig(path);
    process.env.SPENDLIGHT_HARD_BUDGET_USD = "nope";
    const ignored = loadConfig(path);
    return { fromAlias, fromOpenAi, ignored };
  });
  assert(alias.fromAlias.upstreamBaseUrl === "https://example.test/v1", `alias url ${alias.fromAlias.upstreamBaseUrl}`);
  assert(alias.fromOpenAi.upstreamBaseUrl === "https://api.openai.com/v1", "OPENAI_BASE_URL wins");
  assert(alias.fromOpenAi.budgets.global.hardUsd === 4, "env hard overrides the file");
  assert(alias.fromOpenAi.budgets.global.softUsd === 1, "empty soft env does not clear the file");
  assert(alias.ignored.budgets.global.hardUsd === 3, "non-numeric hard env leaves the file");

  const example = withoutEnv(() => loadConfig(resolve("spendlight.config.example.json")));
  assert(example.budgets.period === "day", "example period is day, not the weekExample note");
  assert(example.budgets.timezone === "America/New_York", "example timezone");
  assert(example.budgets.global.hardUsd === 10 && example.budgets.global.softUsd === 5, "example global budget");
  assert(example.budgets.projects.demo?.hardUsd === 2, "example demo hard cap");
  assert(example.pricing["gpt-4o"]?.outputPerMillion === 10, "example must not clobber gpt-4o");
  assert(example.pricing["gpt-4o-mini"]?.cachedInputPerMillion === 0.075, "example mini cache rate");
  assert(Object.keys(example.pricing).length === Object.keys(DEFAULT_PRICING).length, "example adds no extra model");
}

function testLedgerBudgets(dir: string): void {
  const life = openConfigured(dir, "life", {
    budgets: { global: { softUsd: 1, hardUsd: 5 }, projects: { demo: { softUsd: 1, hardUsd: 1 } } },
  });
  try {
    const empty = buildSummary(life.db, life.config);
    assert(empty.spendUsd === 0 && empty.requests === 0 && empty.tokens === 0, "empty totals");
    assert(empty.byProject.length === 0 && empty.byModel.length === 0 && empty.byProjectModel.length === 0, "empty groups");
    assert(empty.daily.length === 0 && empty.topRequests.length === 0 && empty.recent.length === 0, "empty lists");
    assert(empty.scopeProject === null && empty.scopeModel === null && empty.scopeWindowSpend === null, "unscoped");
    assert(evaluateBudget(life.db, life.config, "demo").status === "ok", "empty ledger is under budget");

    seed(life.db, { id: "b", createdAt: "2026-10-02T00:00:00.000Z", costUsd: 5, project: "beta", model: "gpt-4o", tokens: 10 });
    seed(life.db, { id: "a-mini", createdAt: "2026-10-02T00:00:00.000Z", costUsd: 5, project: "alpha", model: "gpt-4o-mini", tokens: 4 });
    seed(life.db, { id: "a-4o", createdAt: "2026-10-01T00:00:00.000Z", costUsd: 5, project: "alpha", model: "gpt-4o", tokens: 6 });
    seed(life.db, { id: "fail", createdAt: "2026-10-03T00:00:00.000Z", costUsd: 1.5, project: "beta", model: "gpt-4o", tokens: 3, status: 500, error: "boom" });
    seed(life.db, {
      id: "z-new",
      createdAt: "2026-10-04T00:00:00.000Z",
      costUsd: 9,
      project: "zeta",
      model: "gpt-4o-mini",
      tokens: 8,
    });

    const all = buildSummary(life.db, life.config);
    near(all.spendUsd, 25.5, "lifetime spend");
    assert(all.requests === 5 && all.tokens === 31, `counts ${all.requests}/${all.tokens}`);
    assert(
      all.byProject.map((row) => row.project).join(",") === "alpha,zeta,beta",
      `projects ${all.byProject.map((row) => row.project).join(",")}`,
    );
    near(all.byProject[0]?.spendUsd ?? NaN, 10, "alpha spend");
    near(all.byProject[1]?.spendUsd ?? NaN, 9, "zeta spend");
    near(all.byProject[2]?.spendUsd ?? NaN, 6.5, "beta spend");
    near(all.byProject.reduce((sum, row) => sum + row.spendUsd, 0), all.spendUsd, "project spend drifted");
    assert(all.byProject.reduce((sum, row) => sum + row.requests, 0) === all.requests, "project requests drifted");
    const pairs = all.byProjectModel.map((row) => `${row.project}/${row.model}`);
    assert(
      pairs.slice(0, 4).join(",") === "zeta/gpt-4o-mini,beta/gpt-4o,alpha/gpt-4o,alpha/gpt-4o-mini",
      `pair order ${pairs.join(",")}`,
    );
    assert(all.recent[0]?.id === "z-new" && all.recent.at(-1)?.id === "a-4o", "recent is newest first");
    assert(all.topRequests[0]?.id === "z-new" && all.topRequests.at(-1)?.id === "fail", `top ${all.topRequests.map((row) => row.id).join(",")}`);

    for (const [id, createdAt] of [
      ["a", "2026-10-06T00:00:00.000Z"],
      ["b", "2026-10-06T00:00:00.000Z"],
      ["c", "2026-10-05T00:00:00.000Z"],
    ] as const) {
      seed(life.db, { id: `tie-${id}`, createdAt, costUsd: 9, project: "tie", model: "gpt-4o" });
    }
    const ranked = buildSummary(life.db, life.config).topRequests.map((row) => row.id);
    assert(ranked[0] === "tie-a" && ranked[1] === "tie-b" && ranked[2] === "tie-c", `tie order ${ranked.slice(0, 3).join(",")}`);
    seed(life.db, { id: "extra-1", createdAt: "2026-10-07T00:00:00.000Z", costUsd: 2, project: "extra" });
    seed(life.db, { id: "extra-2", createdAt: "2026-10-07T01:00:00.000Z", costUsd: 2, project: "extra" });
    for (let n = 0; n < 8; n++) {
      seed(life.db, { id: `pad-${n}`, createdAt: `2026-09-0${n + 1}T00:00:00.000Z`, costUsd: 0.01, project: "pad" });
    }
    const top = buildSummary(life.db, life.config).topRequests;
    assert(top.length === 10, `top length ${top.length}`);
    assert(!top.some((row) => row.id.startsWith("pad-")), "cheaper rows must not enter the top ten");

    const slice = buildSummary(life.db, life.config, "alpha", "gpt-4o", {
      sinceIso: "2026-10-01T00:00:00.000Z",
      untilIso: "2026-10-02T00:00:00.000Z",
    });
    assert(slice.requests === 1 && slice.scopeProject === "alpha" && slice.scopeModel === "gpt-4o", "combined filter");
    near(slice.spendUsd, 5, "slice spend");
    assert(slice.scopeSince === "2026-10-01T00:00:00.000Z" && slice.scopeUntil === "2026-10-02T00:00:00.000Z", "slice bounds");
    const atUntil = buildSummary(life.db, life.config, undefined, undefined, {
      sinceIso: "2026-10-02T00:00:00.000Z",
      untilIso: "2026-10-02T00:00:00.000Z",
    });
    assert(atUntil.requests === 0, "until equal to since matches nothing");
    const blank = buildSummary(life.db, life.config, "");
    assert(blank.requests === 0 && blank.scopeProject === "", "blank project matches nothing");

    const daily = buildSummary(life.db, life.config, "alpha", undefined, {
      sinceIso: "2026-10-01T00:00:00.000Z",
      untilIso: "2026-10-04T00:00:00.000Z",
    });
    assert(
      daily.daily.map((row) => `${row.day}:${row.spendUsd}:${row.requests}`).join(",") === "2026-10-01:5:1,2026-10-02:5:1,2026-10-03:0:0",
      `daily ${JSON.stringify(daily.daily)}`,
    );

    const quoted = ledgerCsv([
      {
        id: "comma-row",
        createdAt: "2026-10-01T00:00:00.000Z",
        project: "demo",
        model: 'gpt"4,o',
        promptTokens: 1,
        completionTokens: 2,
        cachedTokens: 3,
        totalTokens: 4,
        costUsd: 0.5,
        status: 500,
        error: 'say "hi",\nnext',
        upstreamId: null,
        path: "/v1/chat/completions",
        streamed: 1,
      },
    ]);
    assert(quoted.includes('"gpt""4,o"'), quoted);
    assert(quoted.includes('"say ""hi"",\nnext"'), quoted);
    assert(quoted.startsWith("timestamp,project,model,promptTokens,completionTokens,cachedTokens,totalTokens,costUsd,streamed,id,error\n"), "csv header");
    const json = ledgerJson([
      {
        id: "comma-row",
        createdAt: "2026-10-01T00:00:00.000Z",
        project: "demo",
        model: 'gpt"4,o',
        promptTokens: 1,
        completionTokens: 2,
        cachedTokens: 3,
        totalTokens: 4,
        costUsd: 0.5,
        status: 500,
        error: 'say "hi",\nnext',
        upstreamId: null,
        path: "/v1/chat/completions",
        streamed: 1,
      },
    ]);
    assert(json[0]?.streamed === true && json[0].error === 'say "hi",\nnext' && json[0].model === 'gpt"4,o', "json keeps raw fields");
    assert(json[0].costUsd === 0.5 && json[0].cachedTokens === 3, "json numbers");

    seed(life.db, { id: "demo-over", createdAt: "2026-10-01T00:00:00.000Z", costUsd: 1.5, project: "demo" });
    const projectHard = evaluateBudget(life.db, life.config, "demo");
    assert(projectHard.status === "hard" && projectHard.allowed === false && projectHard.triggeredBy === "project", "project hard wins");
    assert(
      projectHard.message === "Spendlight hard budget exceeded (project 'demo'): $1.50 / $1.00. Kill-switch is on; further completions are rejected.",
      projectHard.message ?? "missing project hard message",
    );
    const globalHard = evaluateBudget(life.db, life.config, "other");
    assert(globalHard.triggeredBy === "global" && globalHard.status === "hard", "untagged project still hits the global cap");

    insertEvent(life.db, "soft_warn", "demo", "first");
    insertEvent(life.db, "soft_warn", "demo", "second");
    insertEvent(life.db, "hard_block", "demo", "blocked");
    insertEvent(life.db, "hard_block", "demo", "blocked again");
    const events = buildSummary(life.db, life.config, "alpha").events;
    assert(events.filter((event) => event.type === "soft_warn" && event.project === "demo").length === 1, "soft warn dedupes");
    assert(events.filter((event) => event.type === "hard_block").length === 2, "hard blocks are not deduped");
    assert(events[0]?.type === "hard_block", "events are newest first");
    assert(events.some((event) => event.project === "demo"), "project filter does not hide budget events");
  } finally {
    life.db.close();
  }

  const soft = openConfigured(dir, "soft", {
    budgets: { global: { softUsd: 10, hardUsd: 50 }, projects: { demo: { softUsd: 1, hardUsd: 20 } } },
  });
  try {
    seed(soft.db, { id: "s", createdAt: "2026-10-01T00:00:00.000Z", costUsd: 1, project: "demo" });
    const decision = evaluateBudget(soft.db, soft.config, "demo");
    assert(decision.status === "soft" && decision.allowed && decision.triggeredBy === "project", `soft ${decision.status}/${decision.triggeredBy}`);
    assert(decision.message === "Spendlight soft budget warning (project): $1.00 / $1.00.", decision.message ?? "missing soft message");
    seed(soft.db, { id: "g", createdAt: "2026-10-01T00:00:00.000Z", costUsd: 0.5, project: "other" });
    const under = evaluateBudget(soft.db, soft.config, "other");
    assert(under.status === "ok" && under.triggeredBy === null, "other project is under its missing cap and the global soft cap");
  } finally {
    soft.db.close();
  }

  const day = openConfigured(dir, "day", {
    budgets: { period: "day", timezone: "UTC", global: { softUsd: null, hardUsd: 10 } },
  });
  try {
    const window = spendWindow(day.config);
    assert(window, "day window");
    const yesterday = new Date(Date.parse(window.startIso) - 1000).toISOString();
    seed(day.db, { id: "old", createdAt: yesterday, costUsd: 9, project: "demo", model: "gpt-4o" });
    seed(day.db, { id: "now-4o", createdAt: window.startIso, costUsd: 2, project: "demo", model: "gpt-4o" });
    seed(day.db, { id: "now-mini", createdAt: window.startIso, costUsd: 4, project: "other", model: "gpt-4o-mini" });
    const summary = buildSummary(day.db, day.config);
    near(summary.spendUsd, 15, "hero stays lifetime");
    near(summary.budget.globalSpend, 6, "kill-switch is today");
    assert(summary.budget.status === "ok" && summary.scopeWindowSpend === null, "unscoped day summary");
    const model = buildSummary(day.db, day.config, undefined, "gpt-4o");
    near(model.spendUsd, 11, "model lifetime");
    near(model.scopeWindowSpend ?? NaN, 2, "model window spend");
    near(model.budget.globalSpend, 6, "model filter must not change the kill-switch");
    const project = buildSummary(day.db, day.config, "demo");
    near(project.budget.projectSpend, 2, "project window spend");
    near(project.spendUsd, 11, "project lifetime");
    const md = receiptMarkdown(project);
    assert(md.includes("| Total spend | $11.00 |"), md);
    assert(md.includes("| Spend in window | $2.00 |"), md);
    const past = buildSummary(day.db, day.config, "demo", undefined, { sinceIso: yesterday, untilIso: window.startIso });
    near(past.spendUsd, 9, "yesterday slice");
    near(past.budget.globalSpend, 6, "a time slice must not change the budget window");
    const badge = badgeSvg(past);
    assert(badge.includes("today $2.00"), badge);
    assert(!badge.includes("$9.00"), "badge must ignore the export slice");
    const tripped = evaluateBudget(
      day.db,
      { ...day.config, budgets: { ...day.config.budgets, global: { softUsd: null, hardUsd: 1 } } },
      "demo",
    );
    assert(tripped.status === "hard" && tripped.message?.includes(", today UTC"), tripped.message ?? "missing day clause");

    insertEvent(day.db, "soft_warn", "demo", "yesterday", { dedupeSinceIso: yesterday });
    day.db.prepare(`UPDATE events SET created_at = ? WHERE message = ?`).run(yesterday, "yesterday");
    insertEvent(day.db, "soft_warn", "demo", "today", { dedupeSinceIso: window.startIso });
    const warns = buildSummary(day.db, day.config).events.filter((event) => event.type === "soft_warn");
    assert(warns.length === 2, "a new day can warn again");
  } finally {
    day.db.close();
  }

  const reserve = openConfigured(dir, "reserve", { budgets: { global: { hardUsd: 0.1 } } });
  try {
    const open = preflightFromBody(
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "hi" }] },
      "/v1/chat/completions",
      reserve.config.pricing,
      reserve.config.fallbackPrice,
    );
    const first = admitMutating(reserve.db, reserve.config, "demo", open);
    assert(first.allowed && first.reservationId, "unbounded call reserves");
    near(first.reserveUsd, 0.1, "unbounded reserve is the remaining room");
    near(reservedSpend(reserve.db, "demo"), 0.1, "reservation is visible");
    assert(spendFor(reserve.db, "demo") === 0, "a reservation is not ledger spend");
    const second = admitMutating(reserve.db, reserve.config, "demo", open);
    assert(!second.allowed && second.reservationId === null, "second concurrent call sees the hold");
    releaseReservation(reserve.db, first.reservationId);
    assert(reservedSpend(reserve.db) === 0, "release drops the hold");

    const big = preflightFromBody(
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "hi" }], max_tokens: 1_000_000 },
      "/v1/chat/completions",
      reserve.config.pricing,
      reserve.config.fallbackPrice,
    );
    assert(big.outputBounded && big.costUsd > 0.1, "bounded estimate exceeds the cap");
    const rejected = admitMutating(reserve.db, reserve.config, "demo", big);
    assert(!rejected.allowed && rejected.decision.message?.includes("preflight"), rejected.decision.message ?? "missing preflight message");

    const huge = "x".repeat(4_000_000);
    const prompt = preflightFromBody(
      "gpt-4o-mini",
      { messages: [{ role: "user", content: huge }] },
      "/v1/chat/completions",
      reserve.config.pricing,
      reserve.config.fallbackPrice,
    );
    assert(!prompt.outputBounded && prompt.promptCostUsd > 0.1, "prompt alone can exceed the room");
    const promptRejected = admitMutating(reserve.db, reserve.config, "demo", prompt);
    assert(!promptRejected.allowed, "an unbounded call whose prompt exceeds the room is rejected");

    const fit = preflightFromBody(
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
      "/v1/chat/completions",
      reserve.config.pricing,
      reserve.config.fallbackPrice,
    );
    const held = admitMutating(reserve.db, reserve.config, "demo", fit);
    assert(held.allowed && held.reservationId, "bounded call that fits");
    near(held.reserveUsd, roundUsd(fit.costUsd), "bounded reserve is the preflight cost");
    releaseReservation(reserve.db, held.reservationId);

    insertReservation(reserve.db, "stale", "demo", 0.1);
    reserve.db.prepare(`UPDATE reservations SET created_at = ?`).run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
    insertReservation(reserve.db, "fresh", "other", 0.01);
    purgeStaleReservations(reserve.db);
    assert(reservedSpend(reserve.db, "demo") === 0, "stale reservation is dropped");
    near(reservedSpend(reserve.db, "other"), 0.01, "fresh reservation stays");
    const afterPurge = admitMutating(reserve.db, reserve.config, "demo", open);
    assert(afterPurge.allowed, "a stale hold must not wedge the kill-switch");
    releaseReservation(reserve.db, afterPurge.reservationId);
  } finally {
    reserve.db.close();
  }

  const noCap = openConfigured(dir, "nocap", { budgets: { global: { hardUsd: null, softUsd: null } } });
  try {
    assert(spendWindow(noCap.config) === null, "lifetime has no window");
    const pre = preflightFromBody(
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
      "/v1/chat/completions",
      noCap.config.pricing,
      noCap.config.fallbackPrice,
    );
    const admission = admitMutating(noCap.db, noCap.config, "demo", pre);
    assert(admission.allowed && admission.reservationId === null && admission.reserveUsd === 0, "no hard cap does not reserve");
    seed(noCap.db, { id: "over", createdAt: "2026-10-01T00:00:00.000Z", costUsd: 0.045 });
    const over = evaluateBudget(noCap.db, { ...noCap.config, budgets: { ...noCap.config.budgets, global: { softUsd: null, hardUsd: 0.04 } } }, "demo");
    assert(
      over.message === "Spendlight hard budget exceeded (global 'global'): $0.0450 / $0.0400. Kill-switch is on; further completions are rejected.",
      over.message ?? "missing formatted hard message",
    );
  } finally {
    noCap.db.close();
  }
}

type Seen = { url: string; authorization: string | null };

async function testProxyAndExports(dir: string): Promise<void> {
  const seen: Seen[] = [];
  const mock = createServer(async (req, res) => {
    seen.push({ url: req.url ?? "", authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null });
    const raw = await readReq(req);
    const body = raw ? (JSON.parse(raw) as { case?: string }) : {};
    const send = (payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)) });
      res.end(text);
    };
    if (body.case === "cached") {
      send({
        id: "chatcmpl-cached",
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 800_000 } },
      });
      return;
    }
    if (body.case === "prefix") {
      send({
        id: "chatcmpl-dated",
        model: "gpt-4o-2024-08-06",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      });
      return;
    }
    if (body.case === "unknown") {
      send({
        id: "chatcmpl-local",
        model: "local-llama",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      });
      return;
    }
    if (body.case === "embed") {
      send({
        id: "emb-1",
        model: "text-embedding-3-small",
        data: [{ embedding: [0.1], index: 0 }],
        usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
      });
      return;
    }
    if (body.case === "responses") {
      send({
        id: "resp-1",
        model: "gpt-4o-mini",
        output: [],
        usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((resolveListen) => mock.listen(0, "127.0.0.1", resolveListen));
  const address = mock.address();
  assert(address && typeof address === "object", "mock failed to bind");
  const mockUrl = `http://127.0.0.1:${address.port}/v1`;

  let app: App | null = null;
  try {
    const config = writeConfig(dir, "proxy", { upstream: { baseUrl: mockUrl }, budgets: { global: { hardUsd: 100 } } });
    config.upstreamApiKey = API_KEY;
    app = createApp(config);
    const base = await listen(app);

    const health = (await fetch(`${base}/health`).then((res) => res.json())) as { ok?: boolean; service?: string };
    assert(health.ok === true && health.service === "spendlight", "health");
    const dashboard = await fetch(`${base}/dashboard`);
    assert(dashboard.status === 200 && (dashboard.headers.get("content-type") ?? "").includes("text/html"), "dashboard alias");
    assert((await dashboard.text()).includes("Spendlight"), "dashboard body");

    const cached = await post(base, "/v1/chat/completions?%70roject=demo&user=keep-this", { case: "cached", model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    near(Number(cached.headers.get("x-spendlight-cost-usd")), 0.09, "cached cost header");
    await cached.text();
    const prefix = await post(
      base,
      "/v1/chat/completions?project=leak&user=prefix",
      { case: "prefix", model: "gpt-4o-2024-08-06", messages: [{ role: "user", content: "hi" }] },
      { "x-spendlight-project": "demo" },
    );
    near(Number(prefix.headers.get("x-spendlight-cost-usd")), 2.5, "dated model cost header");
    await prefix.text();
    const unknown = await post(
      base,
      "/v1/chat/completions",
      { case: "unknown", model: "local-llama", messages: [{ role: "user", content: "hi" }] },
      { "x-spendlight-project": "other" },
    );
    near(Number(unknown.headers.get("x-spendlight-cost-usd")), 5, "fallback cost header");
    await unknown.text();
    const embed = await post(base, "/v1/embeddings?tag=demo&user=emb", { case: "embed", model: "text-embedding-3-small", input: "abcd" });
    near(Number(embed.headers.get("x-spendlight-cost-usd")), 0.02, "embedding cost header");
    await embed.text();
    const responses = await post(
      base,
      "/v1/responses",
      { case: "responses", model: "gpt-4o-mini", input: "hello" },
      { "x-spendlight-project": "demo" },
    );
    near(Number(responses.headers.get("x-spendlight-cost-usd")), 0.15, "responses cost header");
    await responses.text();

    assert(seen.length === 5, `upstream calls ${seen.length}`);
    assert(seen.every((row) => row.authorization === `Bearer ${API_KEY}`), "upstream should see the configured key");
    assert(seen[0]?.url === "/v1/chat/completions?user=keep-this", `cached url ${seen[0]?.url}`);
    assert(seen[1]?.url === "/v1/chat/completions?user=prefix", `prefix url ${seen[1]?.url}`);
    assert(!seen.some((row) => /project|tag|leak|%70/i.test(row.url)), `label leaked upstream ${seen.map((row) => row.url).join(" ")}`);
    assert(seen[3]?.url === "/v1/embeddings?user=emb", `embed url ${seen[3]?.url}`);

    const summary = (await fetch(`${base}/api/summary`).then((res) => res.json())) as {
      spendUsd: number;
      requests: number;
      byProject: { project: string; spendUsd: number }[];
      recent: { project: string; model: string; costUsd: number; cachedTokens: number; upstreamId: string | null; path: string }[];
      budget: { globalSpend: number; status: string };
    };
    assert(summary.requests === 5, `logged ${summary.requests}`);
    near(summary.spendUsd, 7.76, "logged spend");
    near(summary.budget.globalSpend, 7.76, "kill-switch spend");
    assert(summary.budget.status === "ok", summary.budget.status);
    assert(!JSON.stringify(summary).includes(API_KEY), "summary stored the API key");
    const cachedRow = summary.recent.find((row) => row.upstreamId === "chatcmpl-cached");
    assert(cachedRow?.project === "demo" && cachedRow.cachedTokens === 800_000 && cachedRow.costUsd === 0.09, `cached row ${JSON.stringify(cachedRow)}`);
    const dated = summary.recent.find((row) => row.upstreamId === "chatcmpl-dated");
    assert(dated?.model === "gpt-4o-2024-08-06" && dated.project === "demo" && dated.costUsd === 2.5, `dated row ${JSON.stringify(dated)}`);
    const local = summary.recent.find((row) => row.upstreamId === "chatcmpl-local");
    assert(local?.project === "other" && local.costUsd === 5, `fallback row ${JSON.stringify(local)}`);
    const embRow = summary.recent.find((row) => row.path === "/v1/embeddings");
    assert(embRow?.project === "demo" && embRow.costUsd === 0.02, `embed row ${JSON.stringify(embRow)}`);
    const respRow = summary.recent.find((row) => row.path === "/v1/responses");
    assert(respRow?.costUsd === 0.15 && respRow.model === "gpt-4o-mini", `responses row ${JSON.stringify(respRow)}`);
    const demo = summary.byProject.find((row) => row.project === "demo");
    const other = summary.byProject.find((row) => row.project === "other");
    near(demo?.spendUsd ?? NaN, 2.76, "demo group");
    near(other?.spendUsd ?? NaN, 5, "other group");

    const exported = await fetch(`${base}/api/export.json`);
    assert((exported.headers.get("content-disposition") ?? "").includes('filename="spendlight-ledger.json"'), exported.headers.get("content-disposition") ?? "");
    const rows = (await exported.json()) as { id: string; costUsd: number; streamed: boolean; error: string | null }[];
    assert(rows.length === 5, `export rows ${rows.length}`);
    near(rows.reduce((sum, row) => sum + row.costUsd, 0), summary.spendUsd, "export drifted from the summary");
    assert(rows.every((row) => row.streamed === false && row.error === null), "successful rows");
    assert(!JSON.stringify(rows).includes(API_KEY), "export stored the API key");

    const named = await fetch(`${base}/api/export.json?project=demo&model=gpt-4o-2024-08-06&since=2020-01-01&until=2027-01-01`);
    assert(
      named.headers.get("content-disposition") === 'attachment; filename="spendlight-demo-gpt-4o-2024-08-06-2020-01-01_2027-01-01.json"',
      named.headers.get("content-disposition") ?? "missing filename",
    );
    const namedRows = (await named.json()) as { costUsd: number }[];
    assert(namedRows.length === 1 && namedRows[0]?.costUsd === 2.5, "filtered export");

    const missing = await fetch(`${base}/api/export.csv?project=missing-tag`);
    const missingCsv = await missing.text();
    assert(missingCsv === "timestamp,project,model,promptTokens,completionTokens,cachedTokens,totalTokens,costUsd,streamed,id,error\n", "empty csv");
    assert((missing.headers.get("content-disposition") ?? "").includes('filename="spendlight-missing-tag.csv"'), "empty scope filename");

    insertRequest(app.db, {
      id: "comma-row",
      createdAt: "2026-01-01T00:00:00.000Z",
      project: "demo",
      model: 'gpt"4,o',
      usage: usage(1, 2, 3, 4),
      costUsd: 0,
      status: 500,
      error: 'say "hi",\nnext',
      path: "/v1/chat/completions",
      streamed: true,
    });
    const csv = await fetch(`${base}/api/export.csv`).then((res) => res.text());
    assert(csv.includes('"gpt""4,o"') && csv.includes('"say ""hi"",\nnext"'), "csv quoting");
    const withComma = (await fetch(`${base}/api/export.json`).then((res) => res.json())) as { id: string; streamed: boolean; error: string | null }[];
    const comma = withComma.find((row) => row.id === "comma-row");
    assert(comma?.streamed === true && comma.error === 'say "hi",\nnext', "json quoting");

    const bad = await fetch(`${base}/api/export.json?since=yesterday`);
    const badBody = (await bad.json()) as { error?: { type?: string; code?: string; param?: string } };
    assert(bad.status === 400 && badBody.error?.code === "invalid_time_range" && badBody.error.param === "since", `bad range ${bad.status}`);
    const badSummary = await fetch(`${base}/api/summary?since=yesterday`);
    assert(badSummary.status === 400, "summary uses the same range error");
    await badSummary.text();
  } finally {
    await app?.close();
    await new Promise<void>((resolveClose) => mock.close(() => resolveClose()));
  }
}

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function readReq(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  testPriceMath();
  testParseAndPreflight();
  const dir = mkdtempSync(join(tmpdir(), "spendlight-pricing-ledger-"));
  try {
    testPriceConfig(dir);
    testLedgerBudgets(dir);
    await testProxyAndExports(dir);
    console.log("PRICING LEDGER OK: price table, cached cost, ledger, budgets, summary, exports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

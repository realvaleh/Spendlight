import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createApp, listen } from "./server.js";
import { estimateCostUsd } from "./pricing.js";
import { DEFAULT_FALLBACK, DEFAULT_PRICING } from "./config.js";

const MOCK_USAGE = {
  prompt_tokens: 100_000,
  completion_tokens: 50_000,
  total_tokens: 150_000,
  prompt_tokens_details: { cached_tokens: 0 },
};

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

async function main(): Promise<void> {
  const cost = estimateCostUsd(
    "gpt-4o-mini",
    { promptTokens: 100_000, completionTokens: 50_000, cachedTokens: 0, totalTokens: 150_000 },
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  ).costUsd;
  assert(Math.abs(cost - 0.045) < 1e-9, `expected $0.045 cost, got ${cost}`);

  const dir = mkdtempSync(join(tmpdir(), "spendlight-smoke-"));
  const dbPath = join(dir, "ledger.db");
  const configPath = join(dir, "spendlight.config.json");

  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions") {
      const body = JSON.stringify({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from the mock upstream" },
            finish_reason: "stop",
          },
        ],
        usage: MOCK_USAGE,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (url.pathname === "/models" || url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] }));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });

  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockAddr = mock.address();
  assert(mockAddr && typeof mockAddr === "object", "mock failed to bind");
  const mockUrl = `http://127.0.0.1:${mockAddr.port}/v1`;

  writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      upstream: { baseUrl: mockUrl },
      budgets: { global: { softUsd: 0.02, hardUsd: 0.04 } },
    }),
  );

  process.env.OPENAI_API_KEY = "sk-smoke";
  process.env.SPENDLIGHT_CONFIG = configPath;
  delete process.env.SPENDLIGHT_SOFT_BUDGET_USD;
  delete process.env.SPENDLIGHT_HARD_BUDGET_USD;
  delete process.env.SPENDLIGHT_PORT;
  delete process.env.SPENDLIGHT_HOST;
  delete process.env.SPENDLIGHT_DB;
  delete process.env.OPENAI_BASE_URL;

  const config = loadConfig(configPath);
  config.port = 0;
  const app = createApp(config);
  const base = await listen(app);
  console.log(`smoke: proxy ${base}  mock ${mockUrl}`);

  try {
    const health = (await fetch(`${base}/health`).then((r) => r.json())) as { ok?: boolean };
    assert(health.ok === true, "health check failed");

    const first = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spendlight-project": "demo",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert(first.status === 200, `first completion status ${first.status}`);
    const firstJson = (await first.json()) as { choices?: { message?: { content?: string } }[] };
    assert(firstJson.choices?.[0]?.message?.content?.includes("mock"), "did not proxy mock body");
    assert(first.headers.get("x-spendlight-project") === "demo", "missing project header");

    const summary = (await fetch(`${base}/api/summary`).then((r) => r.json())) as {
      spendUsd: number;
      requests: number;
      recent: { project: string; model: string; costUsd: number }[];
      budget: { status: string };
    };
    assert(summary.requests === 1, `expected 1 logged request, got ${summary.requests}`);
    assert(Math.abs(summary.spendUsd - 0.045) < 1e-6, `logged spend ${summary.spendUsd}`);
    assert(summary.recent[0]?.project === "demo", "project not logged");
    assert(summary.recent[0]?.model === "gpt-4o-mini", "model not logged");
    assert(
      summary.budget.status === "hard",
      `expected hard status after overshoot ($$${summary.spendUsd} >= $0.04), got ${summary.budget.status}`,
    );

    const second = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-spendlight-project": "demo" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "again" }] }),
    });
    assert(second.status === 402, `kill-switch should 402, got ${second.status}`);
    const blocked = (await second.json()) as { error?: { code?: string; type?: string; message?: string } };
    assert(blocked.error?.code === "budget_hard_limit", "missing budget_hard_limit code");
    assert(blocked.error?.type === "spendlight_budget_exceeded", "missing error type");
    assert(blocked.error?.message?.toLowerCase().includes("hard budget"), "unclear kill-switch message");

    const summary2 = (await fetch(`${base}/api/summary`).then((r) => r.json())) as { requests: number };
    assert(summary2.requests === 1, "blocked request should not add spend");

    const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
    assert(md.includes("Spendlight receipt"), "markdown receipt missing title");
    assert(md.includes("gpt-4o-mini"), "markdown receipt missing model");
    assert(md.includes("demo"), "markdown receipt missing project");

    const svg = await fetch(`${base}/receipt.svg`).then((r) => r.text());
    assert(svg.includes("<svg"), "svg receipt not svg");
    assert(svg.includes("SPENDLIGHT"), "svg receipt missing brand");
    assert(svg.includes("TOTAL"), "svg receipt missing total");

    const badge = await fetch(`${base}/badge.svg`).then((r) => r.text());
    assert(badge.includes("spendlight"), "badge missing label");

    const dash = await fetch(`${base}/`).then((r) => r.text());
    assert(dash.includes("Spend"), "dashboard missing brand");
    assert(dash.includes("/api/summary"), "dashboard missing summary fetch");

    const models = await fetch(`${base}/v1/models`);
    assert(models.status === 200, `pass-through /v1/models failed (${models.status})`);

    console.log("SMOKE OK: logged completion, hard kill-switch, receipts, pass-through");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig, normalizeUpstreamUrl } from "./config.js";
import { createApp, listen } from "./server.js";
import { estimateCostUsd } from "./pricing.js";
import { joinUpstream, sanitizeProject } from "./proxy.js";

const MOCK_USAGE = {
  prompt_tokens: 100_000,
  completion_tokens: 50_000,
  total_tokens: 150_000,
  prompt_tokens_details: { cached_tokens: 0 },
};

const SMALL_USAGE = {
  prompt_tokens: 100,
  completion_tokens: 100,
  total_tokens: 200,
  prompt_tokens_details: { cached_tokens: 0 },
};

const hits = { bounded: 0, unbounded: 0 };

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

  assert(normalizeUpstreamUrl("https://api.openai.com/v1/") === "https://api.openai.com/v1", "strip trailing slash");
  const redacted = normalizeUpstreamUrl("https://user:sk-secret@api.openai.com/v1");
  assert(redacted === "https://api.openai.com/v1", `userinfo should be stripped, got ${redacted}`);
  let rejected = false;
  try {
    normalizeUpstreamUrl("file:///etc/passwd");
  } catch {
    rejected = true;
  }
  assert(rejected, "file: upstream URLs must be rejected");
  rejected = false;
  try {
    normalizeUpstreamUrl("ftp://example.com");
  } catch {
    rejected = true;
  }
  assert(rejected, "non-http(s) upstream URLs must be rejected");

  assert(sanitizeProject("demo") === "demo", "plain project tag");
  assert(!sanitizeProject("demo\r\nX-Injected: 1").includes("\n"), "CR/LF stripped from project");
  assert(!sanitizeProject("<script>alert(1)</script>").includes("<"), "HTML stripped from project");
  assert(sanitizeProject("   ") === "default", "blank project becomes default");
  assert(
    joinUpstream("https://api.openai.com/v1", "/v1//evil.example/x") ===
      "https://api.openai.com/v1/evil.example/x",
    "protocol-relative join must not escape upstream host",
  );

  const dir = mkdtempSync(join(tmpdir(), "spendlight-smoke-"));
  const dbPath = join(dir, "ledger.db");
  const configPath = join(dir, "spendlight.config.json");

  const mock = createServer(async (req, res) => {
    res.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readReq(req);
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    if (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions") {
      if (payload.stream === true) {
        writeStream(res);
        return;
      }
      if (payload.delay === true) {
        if (typeof payload.max_tokens === "number") hits.bounded += 1;
        else hits.unbounded += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
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
        usage: payload.small === true ? SMALL_USAGE : MOCK_USAGE,
      });
      if (!res.writableEnded) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      }
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

    const evilCors = await fetch(`${base}/api/summary`, { headers: { origin: "https://evil.example" } });
    assert(evilCors.ok, "summary should still load without CORS");
    assert(
      evilCors.headers.get("access-control-allow-origin") == null,
      "non-local Origin must not receive CORS allow-origin",
    );
    const localCors = await fetch(`${base}/api/summary`, { headers: { origin: "http://127.0.0.1:9999" } });
    assert(
      localCors.headers.get("access-control-allow-origin") === "http://127.0.0.1:9999",
      "localhost Origin should be reflected",
    );
    const preflight = await fetch(`${base}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert(preflight.status === 204, `OPTIONS status ${preflight.status}`);
    assert(preflight.headers.get("access-control-allow-origin") == null, "preflight must not allow foreign origins");

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

    const images = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "should be blocked" }),
    });
    assert(images.status === 402, `kill-switch should cover non-chat mutating /v1, got ${images.status}`);

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
    assert(dash.includes("const esc"), "dashboard should HTML-escape untrusted fields");

    const models = await fetch(`${base}/v1/models`);
    assert(models.status === 200, `pass-through /v1/models failed (${models.status})`);

    await testUnboundedRace(dir, mockUrl);
    await testBoundedRace(dir, mockUrl);
    await testStreamCutoff(dir, mockUrl);

    console.log("SMOKE OK: logged completion, hard kill-switch, receipts, pass-through, cors, budget race, stream cutoff");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testUnboundedRace(dir: string, mockUrl: string): Promise<void> {
  hits.unbounded = 0;
  await withApp(dir, "race-unbounded", mockUrl, { softUsd: null, hardUsd: 0.04 }, async (base) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      delay: true,
      small: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const [a, b] = await Promise.all([postChat(base, "race", body), postChat(base, "race", body)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert(statuses[0] === 200 && statuses[1] === 402, `unbounded race statuses ${statuses.join(",")}`);
    assert(hits.unbounded === 1, `unbounded race reached upstream ${hits.unbounded} times`);
    const blocked = a.status === 402 ? a : b;
    const winner = a.status === 200 ? a : b;
    const blockedJson = (await blocked.json()) as { error?: { code?: string } };
    assert(blockedJson.error?.code === "budget_hard_limit", "unbounded race 402 missing budget code");
    await winner.text();
    const summary = await summaryOf(base);
    assert(summary.requests === 1, `unbounded race logged ${summary.requests} rows`);
    assert(summary.spendUsd < 0.001, `unbounded race should settle to actual usage, spend ${summary.spendUsd}`);
    assert(summary.spendUsd > 0, "unbounded race logged no spend");

    const again = await postChat(
      base,
      "race",
      JSON.stringify({ model: "gpt-4o-mini", small: true, messages: [{ role: "user", content: "next" }] }),
    );
    assert(again.status === 200, `headroom hold should release after settle, got ${again.status}`);
    await again.text();
  });
}

async function testBoundedRace(dir: string, mockUrl: string): Promise<void> {
  hits.bounded = 0;
  await withApp(dir, "race-bounded", mockUrl, { softUsd: null, hardUsd: 0.05 }, async (base) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 50_000,
      delay: true,
      small: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const [a, b] = await Promise.all([postChat(base, "bounded", body), postChat(base, "bounded", body)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert(statuses[0] === 200 && statuses[1] === 402, `bounded race statuses ${statuses.join(",")}`);
    assert(hits.bounded === 1, `bounded race reached upstream ${hits.bounded} times`);
    await Promise.all([a.text(), b.text()]);
    const summary = await summaryOf(base);
    assert(summary.requests === 1, `bounded race logged ${summary.requests} rows`);
    assert(summary.spendUsd < 0.001, `bounded race should settle to actual usage, spend ${summary.spendUsd}`);
    assert(summary.spendUsd > 0, "bounded race logged no spend");

    const again = await postChat(
      base,
      "bounded",
      JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 50_000,
        small: true,
        messages: [{ role: "user", content: "next" }],
      }),
    );
    assert(again.status === 200, `hold should release after settle, got ${again.status}`);
    await again.text();
  });
}

async function testStreamCutoff(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "stream-cut", mockUrl, { softUsd: null, hardUsd: 0.001 }, async (base) => {
    const res = await postChat(
      base,
      "stream",
      JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const text = await res.text();
    assert(res.status === 200, `stream status ${res.status}: ${text.slice(0, 180)}`);
    assert(text.includes("AAAAAAAA"), "stream forwarded no content");
    assert(!text.includes("END_OF_STREAM_MARKER"), "stream forwarded past the hard budget");
    assert(text.includes("budget_hard_limit"), "stream cutoff missing budget error frame");
    const summary = await summaryOf(base);
    assert(summary.requests === 1, `stream logged ${summary.requests} rows`);
    const row = summary.recent[0];
    assert(row?.streamed === 1, "stream row not marked streamed");
    assert(row?.error?.includes("hard budget") === true, `stream ledger error ${row?.error}`);
    assert(summary.spendUsd > 0.0004 && summary.spendUsd < 0.001, `stream partial spend ${summary.spendUsd}`);
    assert((row?.totalTokens ?? 0) < 20_000, `stream logged provider usage (${row?.totalTokens} tokens) instead of the cutoff`);
  });
}

async function withApp(
  dir: string,
  name: string,
  mockUrl: string,
  budgets: { softUsd: number | null; hardUsd: number | null },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const dbPath = join(dir, `${name}.db`);
  const configPath = join(dir, `${name}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      upstream: { baseUrl: mockUrl },
      budgets: { global: budgets },
    }),
  );
  const config = loadConfig(configPath);
  config.port = 0;
  const app = createApp(config);
  const base = await listen(app);
  try {
    await fn(base);
  } finally {
    await app.close();
  }
}

function postChat(base: string, project: string, body: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spendlight-project": project },
    body,
  });
}

async function summaryOf(base: string): Promise<{
  spendUsd: number;
  requests: number;
  recent: { streamed?: number; error?: string | null; totalTokens?: number; costUsd?: number }[];
}> {
  return (await fetch(`${base}/api/summary`).then((r) => r.json())) as {
    spendUsd: number;
    requests: number;
    recent: { streamed?: number; error?: string | null; totalTokens?: number; costUsd?: number }[];
  };
}

function readReq(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeStream(res: ServerResponse): void {
  const piece = "A".repeat(800);
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "END_OF_STREAM_MARKER" } }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ id: "chatcmpl-stream", usage: MOCK_USAGE })}\n\n`);
  events.push("data: [DONE]\n\n");
  try {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    for (const event of events) {
      if (res.destroyed || res.writableEnded) return;
      res.write(event);
    }
    if (!res.writableEnded) res.end();
  } catch {
    // The proxy closes the upstream once the hard cap is hit.
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

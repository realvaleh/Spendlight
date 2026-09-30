import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitMutating, evaluateBudget, spendWindow } from "./budget.js";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig, normalizeUpstreamUrl } from "./config.js";
import { calendarDayBounds } from "./day.js";
import { closeDb, insertRequest, openDb, type Db } from "./db.js";
import { createApp, listen, type App } from "./server.js";
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
  delete process.env.SPENDLIGHT_BUDGET_PERIOD;
  delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
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

    const csvRes = await fetch(`${base}/api/export.csv`);
    assert(csvRes.status === 200, `csv export status ${csvRes.status}`);
    const csvType = csvRes.headers.get("content-type") ?? "";
    assert(csvType.includes("text/csv"), `csv content-type ${csvType}`);
    const csv = await csvRes.text();
    const csvLines = csv.split(/\r?\n/).filter((line) => line.length > 0);
    assert(
      csvLines[0] ===
        "timestamp,project,model,promptTokens,completionTokens,cachedTokens,totalTokens,costUsd,streamed,id,error",
      `unexpected csv header ${csvLines[0]}`,
    );
    assert(
      csvLines.some((line) => line.includes(",demo,gpt-4o-mini,")),
      "csv missing logged demo project/model",
    );
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
    assert(!blocked.error?.message?.includes("today"), "lifetime kill-switch should not mention a day window");

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
    assert(!md.includes("Budget window"), "lifetime receipt should not show a day window");

    const svg = await fetch(`${base}/receipt.svg`).then((r) => r.text());
    assert(svg.includes("<svg"), "svg receipt not svg");
    assert(svg.includes("SPENDLIGHT"), "svg receipt missing brand");
    assert(svg.includes("TOTAL"), "svg receipt missing total");

    const badge = await fetch(`${base}/badge.svg`).then((r) => r.text());
    assert(badge.includes("spendlight"), "badge missing label");

    const dash = await fetch(`${base}/`).then((r) => r.text());
    assert(dash.includes("Spend"), "dashboard missing brand");
    assert(dash.includes("/api/summary"), "dashboard missing summary fetch");
    assert(dash.includes('href="/api/export.csv"'), "dashboard missing csv download");
    assert(dash.includes("Download CSV"), "dashboard missing csv label");
    assert(dash.includes("const esc"), "dashboard should HTML-escape untrusted fields");
    assert(dash.includes("Today ("), "dashboard should name the day window");
    assert(dash.includes("Estimated spend · lifetime"), "dashboard should label lifetime hero spend");

    const models = await fetch(`${base}/v1/models`);
    assert(models.status === 200, `pass-through /v1/models failed (${models.status})`);

    await testUnboundedRace(dir, mockUrl);
    await testBoundedRace(dir, mockUrl);
    await testStreamCutoff(dir, mockUrl);
    testCalendarDayBounds();
    testBudgetConfig(dir);
    testDayLedgerWindow(dir);
    testReservationOutsideDay(dir);
    await testDayWindow(dir, mockUrl);
    await testLifetimeStillAccumulates(dir, mockUrl);
    await testSoftWarnRefires(dir, mockUrl);
    await testSoftWarnLifetimeDedupe(dir, mockUrl);

    console.log("SMOKE OK: logged completion, csv export, hard kill-switch, receipts, pass-through, cors, budget race, stream cutoff, day window");
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

type SmokeBudgets = {
  softUsd: number | null;
  hardUsd: number | null;
  period?: "lifetime" | "day";
  timezone?: string;
};

async function withApp(
  dir: string,
  name: string,
  mockUrl: string,
  budgets: SmokeBudgets,
  fn: (base: string, app: App) => Promise<void>,
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
      budgets: {
        period: budgets.period,
        timezone: budgets.timezone,
        global: { softUsd: budgets.softUsd, hardUsd: budgets.hardUsd },
      },
    }),
  );
  const config = loadConfig(configPath);
  config.port = 0;
  const app = createApp(config);
  const base = await listen(app);
  try {
    await fn(base, app);
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
  budget: {
    status: string;
    period: string;
    timezone: string;
    globalSpend: number;
    windowStart: string | null;
  };
  events: { type: string; project: string; message: string; createdAt: string }[];
  recent: { streamed?: number; error?: string | null; totalTokens?: number; costUsd?: number }[];
}> {
  return (await fetch(`${base}/api/summary`).then((r) => r.json())) as {
    spendUsd: number;
    requests: number;
    budget: {
      status: string;
      period: string;
      timezone: string;
      globalSpend: number;
      windowStart: string | null;
    };
    events: { type: string; project: string; message: string; createdAt: string }[];
    recent: { streamed?: number; error?: string | null; totalTokens?: number; costUsd?: number }[];
  };
}

function seedSpend(db: Db, createdAt: string, costUsd: number, project: string): void {
  insertRequest(db, {
    createdAt,
    project,
    model: "gpt-4o-mini",
    usage: { promptTokens: 1, completionTokens: 0, cachedTokens: 0, totalTokens: 1 },
    costUsd,
    status: 200,
    path: "/v1/chat/completions",
  });
}

function testCalendarDayBounds(): void {
  const mid = calendarDayBounds("America/New_York", new Date("2026-09-30T15:00:00.000Z"));
  assert(mid.start.toISOString() === "2026-09-30T04:00:00.000Z", `ny midday start ${mid.start.toISOString()}`);
  assert(mid.end.toISOString() === "2026-10-01T04:00:00.000Z", `ny midday end ${mid.end.toISOString()}`);

  const beforeMidnight = calendarDayBounds("America/New_York", new Date("2026-09-30T03:30:00.000Z"));
  assert(
    beforeMidnight.start.toISOString() === "2026-09-29T04:00:00.000Z",
    `ny late start ${beforeMidnight.start.toISOString()}`,
  );

  const spring = calendarDayBounds("America/New_York", new Date("2026-03-08T18:00:00.000Z"));
  assert(spring.start.toISOString() === "2026-03-08T05:00:00.000Z", `spring start ${spring.start.toISOString()}`);
  assert(spring.end.toISOString() === "2026-03-09T04:00:00.000Z", `spring end ${spring.end.toISOString()}`);

  const fall = calendarDayBounds("America/New_York", new Date("2026-11-01T18:00:00.000Z"));
  assert(fall.start.toISOString() === "2026-11-01T04:00:00.000Z", `fall start ${fall.start.toISOString()}`);
  assert(fall.end.toISOString() === "2026-11-02T05:00:00.000Z", `fall end ${fall.end.toISOString()}`);

  const utc = calendarDayBounds("UTC", new Date("2026-09-30T15:00:00.000Z"));
  assert(utc.start.toISOString() === "2026-09-30T00:00:00.000Z", `utc start ${utc.start.toISOString()}`);
  assert(utc.end.toISOString() === "2026-10-01T00:00:00.000Z", `utc end ${utc.end.toISOString()}`);
}

function testBudgetConfig(dir: string): void {
  const path = join(dir, "period.json");
  writeFileSync(
    path,
    JSON.stringify({
      budgets: { period: "lifetime", timezone: "Europe/Berlin", global: { softUsd: 1, hardUsd: 2 } },
    }),
  );
  const savedPeriod = process.env.SPENDLIGHT_BUDGET_PERIOD;
  const savedZone = process.env.SPENDLIGHT_BUDGET_TIMEZONE;
  const origWarn = console.warn;
  try {
    delete process.env.SPENDLIGHT_BUDGET_PERIOD;
    delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    const base = loadConfig(path);
    assert(base.budgets.period === "lifetime", "file period lifetime");
    assert(base.budgets.timezone === "Europe/Berlin", "file timezone");

    const barePath = join(dir, "bare.json");
    writeFileSync(barePath, JSON.stringify({ budgets: { global: { hardUsd: 1 } } }));
    const bare = loadConfig(barePath);
    assert(bare.budgets.period === "lifetime", "omitted period must stay lifetime");
    assert(bare.budgets.timezone === "UTC", "omitted timezone defaults to UTC");

    const dayPath = join(dir, "day-no-zone.json");
    writeFileSync(dayPath, JSON.stringify({ budgets: { period: "day", global: { hardUsd: 1 } } }));
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    const dayDefault = loadConfig(dayPath);
    assert(dayDefault.budgets.period === "day", "day period from file");
    assert(dayDefault.budgets.timezone === "UTC", "missing day timezone uses UTC");
    assert(
      warnings.some((w) => w.includes("UTC") && w.toLowerCase().includes("timezone")),
      `missing timezone should warn, got ${warnings.join(" | ")}`,
    );

    process.env.SPENDLIGHT_BUDGET_PERIOD = "day";
    process.env.SPENDLIGHT_BUDGET_TIMEZONE = "America/Chicago";
    const overridden = loadConfig(path);
    assert(overridden.budgets.period === "day", "env period overrides file");
    assert(overridden.budgets.timezone === "America/Chicago", "env timezone overrides file");

    process.env.SPENDLIGHT_BUDGET_TIMEZONE = "Not/AZone";
    let threw = false;
    try {
      loadConfig(path);
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      assert(message.includes("Not/AZone"), message);
      assert(message.toLowerCase().includes("iana"), message);
    }
    assert(threw, "invalid timezone must fail startup");

    delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    writeFileSync(
      join(dir, "bad-zone.json"),
      JSON.stringify({ budgets: { period: "day", timezone: "Mars/Olympus" } }),
    );
    threw = false;
    try {
      loadConfig(join(dir, "bad-zone.json"));
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      assert(message.includes("Mars/Olympus"), message);
    }
    assert(threw, "invalid timezone in the config file must fail startup");

    process.env.SPENDLIGHT_BUDGET_PERIOD = "week";
    threw = false;
    try {
      loadConfig(barePath);
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      assert(message.includes("week"), message);
    }
    assert(threw, "invalid period must fail startup");
  } finally {
    console.warn = origWarn;
    if (savedPeriod == null) delete process.env.SPENDLIGHT_BUDGET_PERIOD;
    else process.env.SPENDLIGHT_BUDGET_PERIOD = savedPeriod;
    if (savedZone == null) delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    else process.env.SPENDLIGHT_BUDGET_TIMEZONE = savedZone;
  }
}

function testDayLedgerWindow(dir: string): void {
  const configPath = join(dir, "ledger-day.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "day",
        timezone: "America/New_York",
        global: { softUsd: 1, hardUsd: 5 },
        projects: { demo: { softUsd: null, hardUsd: 10 } },
      },
    }),
  );
  const config = loadConfig(configPath);
  const db = openDb(":memory:");
  const now = new Date("2026-09-30T15:00:00.000Z");
  const window = spendWindow(config, now);
  assert(window, "day spend window");
  assert(window.startIso === "2026-09-30T04:00:00.000Z", window.startIso);
  seedSpend(db, window.startIso, 1, "demo");
  seedSpend(db, new Date(Date.parse(window.startIso) + 60_000).toISOString(), 3, "demo");
  seedSpend(db, new Date(Date.parse(window.startIso) - 1).toISOString(), 100, "demo");
  seedSpend(db, window.endIso, 100, "demo");

  const day = evaluateBudget(db, config, "demo", now);
  assert(Math.abs(day.globalSpend - 4) < 1e-9, `day global spend ${day.globalSpend}`);
  assert(Math.abs(day.projectSpend - 4) < 1e-9, `day project spend ${day.projectSpend}`);
  assert(day.status === "soft", `expected soft inside the day window, got ${day.status}`);
  assert(day.message?.includes("today America/New_York"), day.message ?? "missing soft message");

  const lifetime = evaluateBudget(db, { ...config, budgets: { ...config.budgets, period: "lifetime" } }, "demo", now);
  assert(lifetime.globalSpend > 100, `lifetime spend should include other days, got ${lifetime.globalSpend}`);
  assert(lifetime.status === "hard", `lifetime should be hard, got ${lifetime.status}`);
  assert(!lifetime.message?.includes("today"), lifetime.message ?? "");
  assert(lifetime.windowStart == null, "lifetime decision has no window");
  closeDb(db);
}

function testReservationOutsideDay(dir: string): void {
  const configPath = join(dir, "res-day.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "day",
        timezone: "America/New_York",
        global: { softUsd: null, hardUsd: 1 },
      },
    }),
  );
  const config = loadConfig(configPath);
  const db = openDb(":memory:");
  const now = new Date("2026-06-15T04:10:00.000Z");
  const window = spendWindow(config, now);
  assert(window?.startIso === "2026-06-15T04:00:00.000Z", window?.startIso ?? "no window");
  const heldAt = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
  assert(heldAt < window.startIso, "hold should be before local midnight");
  db.prepare(`INSERT INTO reservations (id, created_at, project, cost_usd) VALUES (?, ?, ?, ?)`).run(
    "old-hold",
    heldAt,
    "default",
    50,
  );
  const dayAdmit = admitMutating(db, config, "default", null, now);
  assert(dayAdmit.allowed, "day window should ignore a hold from before local midnight");
  const lifeAdmit = admitMutating(
    db,
    { ...config, budgets: { ...config.budgets, period: "lifetime" } },
    "default",
    null,
    now,
  );
  assert(!lifeAdmit.allowed, "lifetime should still count that in-flight hold");
  closeDb(db);
}

async function testDayWindow(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "day-window",
    mockUrl,
    { softUsd: null, hardUsd: 0.04, period: "day", timezone: "America/New_York" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "day config should expose a window");
      seedSpend(app.db, new Date(Date.parse(window.startIso) - 1000).toISOString(), 9, "yesterday");

      const first = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      );
      assert(first.status === 200, `day window should admit despite yesterday's spend, got ${first.status}`);
      await first.text();

      const second = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "again" }] }),
      );
      assert(second.status === 402, `day window should block once today's spend hits hard, got ${second.status}`);
      const blocked = (await second.json()) as { error?: { message?: string } };
      assert(
        blocked.error?.message?.includes("today America/New_York") === true,
        blocked.error?.message ?? "missing day kill-switch message",
      );

      const summary = await summaryOf(base);
      assert(summary.spendUsd > 9, `lifetime hero should include yesterday, got ${summary.spendUsd}`);
      assert(summary.budget.globalSpend < 1, `budget meter should be today only, got ${summary.budget.globalSpend}`);
      assert(summary.budget.globalSpend >= 0.04, `today spend should reach the hard cap, got ${summary.budget.globalSpend}`);
      assert(summary.budget.status === "hard", summary.budget.status);
      assert(summary.budget.period === "day", summary.budget.period);
      assert(summary.budget.timezone === "America/New_York", summary.budget.timezone);
      assert(summary.requests === 2, `seed plus admitted call, got ${summary.requests}`);

      const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(md.includes("| Budget window | today (America/New_York) |"), "markdown receipt missing day window");
      assert(md.includes("Spend in window"), "markdown receipt missing window spend");
      const svg = await fetch(`${base}/receipt.svg`).then((r) => r.text());
      assert(svg.includes("counted today"), "svg receipt missing day window");
      assert(svg.includes("America/New_York"), "svg receipt missing timezone");
      const badge = await fetch(`${base}/badge.svg`).then((r) => r.text());
      assert(badge.includes("today"), "badge should show today's spend");
      assert(!badge.includes("$9"), "badge should not use the lifetime total");
    },
  );
}

async function testLifetimeStillAccumulates(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "lifetime-old", mockUrl, { softUsd: null, hardUsd: 0.04 }, async (base, app) => {
    assert(app.config.budgets.period === "lifetime", "omitted period must stay lifetime");
    seedSpend(app.db, new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(), 9, "yesterday");
    const first = await postChat(
      base,
      "demo",
      JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    );
    assert(first.status === 402, `lifetime should still block on older spend, got ${first.status}`);
    const blocked = (await first.json()) as { error?: { message?: string } };
    assert(!blocked.error?.message?.includes("today"), blocked.error?.message ?? "lifetime message");
    const summary = await summaryOf(base);
    assert(summary.requests === 1, `blocked call should not add a row, got ${summary.requests}`);
    assert(summary.budget.period === "lifetime", summary.budget.period);
    assert(summary.budget.windowStart == null, "lifetime summary should not set a window");
    assert(summary.budget.globalSpend >= 9, `lifetime budget spend ${summary.budget.globalSpend}`);
    const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
    assert(!md.includes("Budget window"), "lifetime receipt should not mention a day window");
  });
}

async function testSoftWarnRefires(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "soft-day",
    mockUrl,
    { softUsd: 0.00001, hardUsd: 100, period: "day", timezone: "UTC" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "soft day window");
      const yesterday = new Date(Date.parse(window.startIso) - 1000).toISOString();
      app.db
        .prepare(`INSERT INTO events (created_at, type, project, message) VALUES (?, 'soft_warn', ?, ?)`)
        .run(yesterday, "daywarn", "yesterday warning");
      seedSpend(app.db, window.startIso, 0.001, "daywarn");
      const body = JSON.stringify({
        model: "gpt-4o-mini",
        small: true,
        messages: [{ role: "user", content: "hi" }],
      });
      const first = await postChat(base, "daywarn", body);
      assert(first.status === 200, `soft day request ${first.status}`);
      assert(first.headers.get("x-spendlight-budget-status") === "soft", "expected a soft warning");
      const warning = first.headers.get("x-spendlight-budget-warning") ?? "";
      assert(warning.includes("today UTC"), warning);
      await first.text();
      const mid = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(mid.length === 2, `expected yesterday's warning plus a new one, got ${mid.length}`);

      const second = await postChat(base, "daywarn", body);
      assert(second.status === 200, `second soft request ${second.status}`);
      await second.text();
      const after = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(after.length === 2, `soft_warn should dedupe inside the same day, got ${after.length}`);
    },
  );
}

async function testSoftWarnLifetimeDedupe(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "soft-life", mockUrl, { softUsd: 0.00001, hardUsd: 100 }, async (base, app) => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    app.db
      .prepare(`INSERT INTO events (created_at, type, project, message) VALUES (?, 'soft_warn', ?, ?)`)
      .run(yesterday, "life", "old warning");
    seedSpend(app.db, yesterday, 0.001, "life");
    const res = await postChat(
      base,
      "life",
      JSON.stringify({ model: "gpt-4o-mini", small: true, messages: [{ role: "user", content: "hi" }] }),
    );
    assert(res.status === 200, `lifetime soft request ${res.status}`);
    await res.text();
    const warns = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
    assert(warns.length === 1, `lifetime soft_warn should stay deduped across days, got ${warns.length}`);
  });
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

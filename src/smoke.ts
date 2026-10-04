import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitMutating, evaluateBudget, spendWindow } from "./budget.js";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig, normalizeUpstreamUrl } from "./config.js";
import { calendarDayBounds, calendarMonthBounds, calendarWeekBounds } from "./day.js";
import { closeDb, insertRequest, openDb, type Db } from "./db.js";
import { createApp, listen, type App } from "./server.js";
import { estimateCostUsd } from "./pricing.js";
import { joinUpstream, normalizeModelId, normalizeProjectTag, sanitizeProject } from "./proxy.js";

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
  assert(normalizeProjectTag("  demo  ") === "demo", "query tag trims like a request tag");
  assert(normalizeProjectTag("@@@") === "", "empty garbage stays empty for scoped queries");
  assert(sanitizeProject("@@@") === "default", "request tags still fall back to default");
  assert(normalizeModelId("  gpt-4o-mini  ") === "gpt-4o-mini", "model query trims like a project tag");
  assert(normalizeModelId("@@@") === "", "empty model garbage stays empty");
  assert(normalizeModelId("gpt-4o-mini\r\nX") === "gpt-4o-miniX", "model query strips CR/LF without collapsing");
  assert(normalizeModelId("") === "", "blank model query stays blank");
  assert(normalizeModelId("no-such-model") === "no-such-model", "unknown model ids are not rewritten to default");
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
    assert(dash.includes('href="/receipt.md?project='), "dashboard missing scoped markdown link");
    assert(dash.includes('href="/receipt.svg?project='), "dashboard missing scoped svg link");
    assert(dash.includes('href="/api/export.csv?project='), "dashboard missing scoped csv link");
    assert(dash.includes('href="/receipt.md?model='), "dashboard missing model markdown link");
    assert(dash.includes('href="/receipt.svg?model='), "dashboard missing model svg link");
    assert(dash.includes('href="/api/export.csv?model='), "dashboard missing model csv link");
    assert(dash.includes("const esc"), "dashboard should HTML-escape untrusted fields");
    assert(dash.includes("Today ("), "dashboard should name the day window");
    assert(dash.includes("This week ("), "dashboard should name the week window");
    assert(dash.includes("This month ("), "dashboard should name the month window");
    assert(dash.includes("Estimated spend · lifetime"), "dashboard should label lifetime hero spend");

    const models = await fetch(`${base}/v1/models`);
    assert(models.status === 200, `pass-through /v1/models failed (${models.status})`);

    await testUnboundedRace(dir, mockUrl);
    await testBoundedRace(dir, mockUrl);
    await testStreamCutoff(dir, mockUrl);
    testCalendarDayBounds();
    testCalendarWeekBounds();
    testCalendarMonthBounds();
    testBudgetConfig(dir);
    testDayLedgerWindow(dir);
    testWeekLedgerWindow(dir);
    testMonthLedgerWindow(dir);
    testReservationOutsideDay(dir);
    testReservationOutsideWeek(dir);
    testReservationOutsideMonth(dir);
    await testDayWindow(dir, mockUrl);
    await testWeekWindow(dir, mockUrl);
    await testMonthWindow(dir, mockUrl);
    await testLifetimeStillAccumulates(dir, mockUrl);
    await testSoftWarnRefires(dir, mockUrl);
    await testSoftWarnWeekRefires(dir, mockUrl);
    await testSoftWarnMonthRefires(dir, mockUrl);
    await testSoftWarnLifetimeDedupe(dir, mockUrl);
    await testProjectScope(dir, mockUrl);
    await testModelScope(dir, mockUrl);

    console.log("SMOKE OK: logged completion, csv export, hard kill-switch, receipts, pass-through, cors, budget race, stream cutoff, day window, week window, month window, project scope, model scope");
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
  period?: "lifetime" | "day" | "week" | "month";
  timezone?: string;
  projects?: Record<string, { softUsd: number | null; hardUsd: number | null }>;
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
        projects: budgets.projects,
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

function seedSpend(db: Db, createdAt: string, costUsd: number, project: string, model = "gpt-4o-mini"): void {
  insertRequest(db, {
    createdAt,
    project,
    model,
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

function testCalendarWeekBounds(): void {
  const mid = calendarWeekBounds("America/New_York", new Date("2026-09-30T15:00:00.000Z"));
  assert(mid.start.toISOString() === "2026-09-28T04:00:00.000Z", `ny week start ${mid.start.toISOString()}`);
  assert(mid.end.toISOString() === "2026-10-05T04:00:00.000Z", `ny week end ${mid.end.toISOString()}`);

  const sundayNight = calendarWeekBounds("America/New_York", new Date("2026-09-28T03:30:00.000Z"));
  assert(
    sundayNight.start.toISOString() === "2026-09-21T04:00:00.000Z",
    `ny sunday night start ${sundayNight.start.toISOString()}`,
  );
  assert(
    sundayNight.end.toISOString() === "2026-09-28T04:00:00.000Z",
    `ny sunday night end ${sundayNight.end.toISOString()}`,
  );
  const mondayMidnight = calendarWeekBounds("America/New_York", new Date("2026-09-28T04:00:00.000Z"));
  assert(
    mondayMidnight.start.toISOString() === "2026-09-28T04:00:00.000Z",
    `ny monday start ${mondayMidnight.start.toISOString()}`,
  );

  const spring = calendarWeekBounds("America/New_York", new Date("2026-03-04T15:00:00.000Z"));
  assert(spring.start.toISOString() === "2026-03-02T05:00:00.000Z", `spring week start ${spring.start.toISOString()}`);
  assert(spring.end.toISOString() === "2026-03-09T04:00:00.000Z", `spring week end ${spring.end.toISOString()}`);

  const fall = calendarWeekBounds("America/New_York", new Date("2026-10-28T15:00:00.000Z"));
  assert(fall.start.toISOString() === "2026-10-26T04:00:00.000Z", `fall week start ${fall.start.toISOString()}`);
  assert(fall.end.toISOString() === "2026-11-02T05:00:00.000Z", `fall week end ${fall.end.toISOString()}`);

  const year = calendarWeekBounds("America/New_York", new Date("2026-01-01T15:00:00.000Z"));
  assert(year.start.toISOString() === "2025-12-29T05:00:00.000Z", `year week start ${year.start.toISOString()}`);
  assert(year.end.toISOString() === "2026-01-05T05:00:00.000Z", `year week end ${year.end.toISOString()}`);

  const utc = calendarWeekBounds("UTC", new Date("2026-09-30T15:00:00.000Z"));
  assert(utc.start.toISOString() === "2026-09-28T00:00:00.000Z", `utc week start ${utc.start.toISOString()}`);
  assert(utc.end.toISOString() === "2026-10-05T00:00:00.000Z", `utc week end ${utc.end.toISOString()}`);
}

function testCalendarMonthBounds(): void {
  const mid = calendarMonthBounds("America/New_York", new Date("2026-09-30T15:00:00.000Z"));
  assert(mid.start.toISOString() === "2026-09-01T04:00:00.000Z", `ny month start ${mid.start.toISOString()}`);
  assert(mid.end.toISOString() === "2026-10-01T04:00:00.000Z", `ny month end ${mid.end.toISOString()}`);

  const beforeFirst = calendarMonthBounds("America/New_York", new Date("2026-09-01T03:30:00.000Z"));
  assert(
    beforeFirst.start.toISOString() === "2026-08-01T04:00:00.000Z",
    `ny late August start ${beforeFirst.start.toISOString()}`,
  );
  assert(
    beforeFirst.end.toISOString() === "2026-09-01T04:00:00.000Z",
    `ny late August end ${beforeFirst.end.toISOString()}`,
  );
  const onFirst = calendarMonthBounds("America/New_York", new Date("2026-09-01T04:00:00.000Z"));
  assert(onFirst.start.toISOString() === "2026-09-01T04:00:00.000Z", `ny Sept 1 start ${onFirst.start.toISOString()}`);

  const spring = calendarMonthBounds("America/New_York", new Date("2026-03-15T15:00:00.000Z"));
  assert(spring.start.toISOString() === "2026-03-01T05:00:00.000Z", `spring month start ${spring.start.toISOString()}`);
  assert(spring.end.toISOString() === "2026-04-01T04:00:00.000Z", `spring month end ${spring.end.toISOString()}`);

  const fall = calendarMonthBounds("America/New_York", new Date("2026-11-15T15:00:00.000Z"));
  assert(fall.start.toISOString() === "2026-11-01T04:00:00.000Z", `fall month start ${fall.start.toISOString()}`);
  assert(fall.end.toISOString() === "2026-12-01T05:00:00.000Z", `fall month end ${fall.end.toISOString()}`);

  const year = calendarMonthBounds("America/New_York", new Date("2026-12-15T15:00:00.000Z"));
  assert(year.start.toISOString() === "2026-12-01T05:00:00.000Z", `december start ${year.start.toISOString()}`);
  assert(year.end.toISOString() === "2027-01-01T05:00:00.000Z", `december end ${year.end.toISOString()}`);

  const utc = calendarMonthBounds("UTC", new Date("2026-01-15T12:00:00.000Z"));
  assert(utc.start.toISOString() === "2026-01-01T00:00:00.000Z", `utc month start ${utc.start.toISOString()}`);
  assert(utc.end.toISOString() === "2026-02-01T00:00:00.000Z", `utc month end ${utc.end.toISOString()}`);
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

    warnings.length = 0;
    delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    process.env.SPENDLIGHT_BUDGET_PERIOD = "month";
    const monthDefault = loadConfig(barePath);
    assert(monthDefault.budgets.period === "month", "month period from env");
    assert(monthDefault.budgets.timezone === "UTC", "missing month timezone uses UTC");
    assert(
      warnings.some((w) => w.includes('"month"') && w.includes("UTC")),
      `missing month timezone should warn, got ${warnings.join(" | ")}`,
    );

    const monthPath = join(dir, "month.json");
    writeFileSync(
      monthPath,
      JSON.stringify({ budgets: { period: "month", timezone: "Europe/Berlin", global: { hardUsd: 1 } } }),
    );
    delete process.env.SPENDLIGHT_BUDGET_PERIOD;
    const monthFile = loadConfig(monthPath);
    assert(monthFile.budgets.period === "month", "month period from file");
    assert(monthFile.budgets.timezone === "Europe/Berlin", "month timezone from file");

    process.env.SPENDLIGHT_BUDGET_PERIOD = "month";
    process.env.SPENDLIGHT_BUDGET_TIMEZONE = "Asia/Tokyo";
    const monthOverride = loadConfig(path);
    assert(monthOverride.budgets.period === "month", "env month overrides file lifetime");
    assert(monthOverride.budgets.timezone === "Asia/Tokyo", "env timezone overrides file for month");

    warnings.length = 0;
    delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    process.env.SPENDLIGHT_BUDGET_PERIOD = "week";
    const weekDefault = loadConfig(barePath);
    assert(weekDefault.budgets.period === "week", "week period from env");
    assert(weekDefault.budgets.timezone === "UTC", "missing week timezone uses UTC");
    assert(
      warnings.some((w) => w.includes('"week"') && w.includes("UTC")),
      `missing week timezone should warn, got ${warnings.join(" | ")}`,
    );

    const weekPath = join(dir, "week.json");
    writeFileSync(
      weekPath,
      JSON.stringify({ budgets: { period: "week", timezone: "Europe/Berlin", global: { hardUsd: 1 } } }),
    );
    delete process.env.SPENDLIGHT_BUDGET_PERIOD;
    const weekFile = loadConfig(weekPath);
    assert(weekFile.budgets.period === "week", "week period from file");
    assert(weekFile.budgets.timezone === "Europe/Berlin", "week timezone from file");

    process.env.SPENDLIGHT_BUDGET_PERIOD = "week";
    process.env.SPENDLIGHT_BUDGET_TIMEZONE = "Pacific/Auckland";
    const weekOverride = loadConfig(path);
    assert(weekOverride.budgets.period === "week", "env week overrides file lifetime");
    assert(weekOverride.budgets.timezone === "Pacific/Auckland", "env timezone overrides file for week");

    delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
    process.env.SPENDLIGHT_BUDGET_PERIOD = "year";
    threw = false;
    try {
      loadConfig(barePath);
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      assert(message.includes("year"), message);
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

function testWeekLedgerWindow(dir: string): void {
  const configPath = join(dir, "ledger-week.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "week",
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
  assert(window, "week spend window");
  assert(window.startIso === "2026-09-28T04:00:00.000Z", window.startIso);
  assert(window.endIso === "2026-10-05T04:00:00.000Z", window.endIso);
  seedSpend(db, window.startIso, 1, "demo");
  seedSpend(db, new Date(Date.parse(window.startIso) + 60_000).toISOString(), 3, "demo");
  seedSpend(db, new Date(Date.parse(window.startIso) - 1).toISOString(), 100, "demo");
  seedSpend(db, window.endIso, 100, "demo");

  const week = evaluateBudget(db, config, "demo", now);
  assert(Math.abs(week.globalSpend - 4) < 1e-9, `week global spend ${week.globalSpend}`);
  assert(Math.abs(week.projectSpend - 4) < 1e-9, `week project spend ${week.projectSpend}`);
  assert(week.status === "soft", `expected soft inside the week window, got ${week.status}`);
  assert(week.message?.includes("this week America/New_York"), week.message ?? "missing week soft message");
  assert(week.windowStart === window.startIso, "week decision should expose the window");

  const lifetime = evaluateBudget(db, { ...config, budgets: { ...config.budgets, period: "lifetime" } }, "demo", now);
  assert(lifetime.globalSpend > 100, `lifetime spend should include other weeks, got ${lifetime.globalSpend}`);
  assert(lifetime.status === "hard", `lifetime should be hard, got ${lifetime.status}`);
  assert(!lifetime.message?.includes("this week"), lifetime.message ?? "");
  assert(lifetime.windowStart == null, "lifetime decision has no window");
  closeDb(db);
}

function testMonthLedgerWindow(dir: string): void {
  const configPath = join(dir, "ledger-month.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "month",
        timezone: "America/New_York",
        global: { softUsd: 10, hardUsd: 20 },
        projects: { demo: { softUsd: 1, hardUsd: 3 } },
      },
    }),
  );
  const config = loadConfig(configPath);
  const db = openDb(":memory:");
  const now = new Date("2026-09-30T15:00:00.000Z");
  const window = spendWindow(config, now);
  assert(window, "month spend window");
  assert(window.startIso === "2026-09-01T04:00:00.000Z", window.startIso);
  assert(window.endIso === "2026-10-01T04:00:00.000Z", window.endIso);
  seedSpend(db, window.startIso, 1.5, "demo");
  seedSpend(db, new Date(Date.parse(window.startIso) + 86_400_000).toISOString(), 0.25, "other");
  seedSpend(db, new Date(Date.parse(window.startIso) - 1).toISOString(), 100, "demo");
  seedSpend(db, window.endIso, 50, "demo");

  const month = evaluateBudget(db, config, "demo", now);
  assert(Math.abs(month.projectSpend - 1.5) < 1e-9, `month project spend ${month.projectSpend}`);
  assert(Math.abs(month.globalSpend - 1.75) < 1e-9, `month global spend ${month.globalSpend}`);
  assert(month.status === "soft", `expected project soft inside the month, got ${month.status}`);
  assert(month.triggeredBy === "project", `soft should be the project cap, got ${month.triggeredBy}`);
  assert(month.message?.includes("this month America/New_York"), month.message ?? "missing month soft message");
  assert(month.windowStart === window.startIso, "month decision should expose the window");

  const other = evaluateBudget(db, config, "other", now);
  assert(Math.abs(other.projectSpend - 0.25) < 1e-9, `other project spend ${other.projectSpend}`);
  assert(other.status === "ok", `other project should ignore demo's soft cap, got ${other.status}`);

  seedSpend(db, new Date(Date.parse(window.startIso) + 1000).toISOString(), 2, "demo");
  const blocked = evaluateBudget(db, config, "demo", now);
  assert(Math.abs(blocked.projectSpend - 3.5) < 1e-9, `month project spend after cap ${blocked.projectSpend}`);
  assert(blocked.globalSpend < 20, `prior-month rows must stay out of the global total, got ${blocked.globalSpend}`);
  assert(blocked.status === "hard", `expected project hard inside the month, got ${blocked.status}`);
  assert(blocked.triggeredBy === "project", `hard should be the project cap, got ${blocked.triggeredBy}`);
  assert(blocked.message?.includes("project 'demo'"), blocked.message ?? "missing project hard message");
  assert(blocked.message?.includes("this month America/New_York"), blocked.message ?? "missing month hard message");

  const lifetime = evaluateBudget(db, { ...config, budgets: { ...config.budgets, period: "lifetime" } }, "demo", now);
  assert(lifetime.globalSpend > 100, `lifetime spend should include prior months, got ${lifetime.globalSpend}`);
  assert(lifetime.status === "hard", `lifetime should be hard, got ${lifetime.status}`);
  assert(!lifetime.message?.includes("this month"), lifetime.message ?? "");
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

function testReservationOutsideWeek(dir: string): void {
  const configPath = join(dir, "res-week.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "week",
        timezone: "America/New_York",
        global: { softUsd: null, hardUsd: 1 },
      },
    }),
  );
  const config = loadConfig(configPath);
  const db = openDb(":memory:");
  const now = new Date("2026-09-28T04:10:00.000Z");
  const window = spendWindow(config, now);
  assert(window?.startIso === "2026-09-28T04:00:00.000Z", window?.startIso ?? "no window");
  const heldAt = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
  assert(heldAt < window.startIso, "hold should be before local midnight on Monday");
  db.prepare(`INSERT INTO reservations (id, created_at, project, cost_usd) VALUES (?, ?, ?, ?)`).run(
    "old-week-hold",
    heldAt,
    "default",
    50,
  );
  const weekAdmit = admitMutating(db, config, "default", null, now);
  assert(weekAdmit.allowed, "week window should ignore a hold from the previous week");
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

function testReservationOutsideMonth(dir: string): void {
  const configPath = join(dir, "res-month.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dbPath: ":memory:",
      budgets: {
        period: "month",
        timezone: "America/New_York",
        global: { softUsd: null, hardUsd: 1 },
      },
    }),
  );
  const config = loadConfig(configPath);
  const db = openDb(":memory:");
  const now = new Date("2026-09-01T04:10:00.000Z");
  const window = spendWindow(config, now);
  assert(window?.startIso === "2026-09-01T04:00:00.000Z", window?.startIso ?? "no window");
  const heldAt = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
  assert(heldAt < window.startIso, "hold should be before local midnight on the 1st");
  db.prepare(`INSERT INTO reservations (id, created_at, project, cost_usd) VALUES (?, ?, ?, ?)`).run(
    "old-month-hold",
    heldAt,
    "default",
    50,
  );
  const monthAdmit = admitMutating(db, config, "default", null, now);
  assert(monthAdmit.allowed, "month window should ignore a hold from the previous month");
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

async function testWeekWindow(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "week-window",
    mockUrl,
    { softUsd: null, hardUsd: 0.04, period: "week", timezone: "America/New_York" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "week config should expose a window");
      seedSpend(app.db, new Date(Date.parse(window.startIso) - 1000).toISOString(), 9, "last-week");

      const first = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      );
      assert(first.status === 200, `week window should admit despite last week's spend, got ${first.status}`);
      await first.text();

      const second = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "again" }] }),
      );
      assert(second.status === 402, `week window should block once this week's spend hits hard, got ${second.status}`);
      const blocked = (await second.json()) as { error?: { message?: string } };
      assert(
        blocked.error?.message?.includes("this week America/New_York") === true,
        blocked.error?.message ?? "missing week kill-switch message",
      );

      const summary = await summaryOf(base);
      assert(summary.spendUsd > 9, `lifetime hero should include last week, got ${summary.spendUsd}`);
      assert(summary.budget.globalSpend < 1, `budget meter should be this week only, got ${summary.budget.globalSpend}`);
      assert(
        summary.budget.globalSpend >= 0.04,
        `this week's spend should reach the hard cap, got ${summary.budget.globalSpend}`,
      );
      assert(summary.budget.status === "hard", summary.budget.status);
      assert(summary.budget.period === "week", summary.budget.period);
      assert(summary.budget.timezone === "America/New_York", summary.budget.timezone);
      assert(summary.budget.windowStart === window.startIso, "summary window should be this week");
      assert(summary.requests === 2, `seed plus admitted call, got ${summary.requests}`);

      const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(md.includes("| Budget window | this week (America/New_York) |"), "markdown receipt missing week window");
      assert(md.includes("Spend in window"), "markdown receipt missing window spend");
      assert(!md.includes("today"), "week receipt should not say today");
      const svg = await fetch(`${base}/receipt.svg`).then((r) => r.text());
      assert(svg.includes("counted this week"), "svg receipt missing week window");
      assert(svg.includes("America/New_York"), "svg receipt missing timezone");
      const badge = await fetch(`${base}/badge.svg`).then((r) => r.text());
      assert(badge.includes("this week"), "badge should show this week's spend");
      assert(!badge.includes("$9"), "badge should not use the lifetime total");
    },
  );
}

async function testMonthWindow(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "month-window",
    mockUrl,
    { softUsd: null, hardUsd: 0.04, period: "month", timezone: "America/New_York" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "month config should expose a window");
      seedSpend(app.db, new Date(Date.parse(window.startIso) - 1000).toISOString(), 9, "last-month");

      const first = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      );
      assert(first.status === 200, `month window should admit despite last month's spend, got ${first.status}`);
      await first.text();

      const second = await postChat(
        base,
        "demo",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "again" }] }),
      );
      assert(second.status === 402, `month window should block once this month's spend hits hard, got ${second.status}`);
      const blocked = (await second.json()) as { error?: { message?: string } };
      assert(
        blocked.error?.message?.includes("this month America/New_York") === true,
        blocked.error?.message ?? "missing month kill-switch message",
      );

      const summary = await summaryOf(base);
      assert(summary.spendUsd > 9, `lifetime hero should include last month, got ${summary.spendUsd}`);
      assert(summary.budget.globalSpend < 1, `budget meter should be this month only, got ${summary.budget.globalSpend}`);
      assert(
        summary.budget.globalSpend >= 0.04,
        `this month's spend should reach the hard cap, got ${summary.budget.globalSpend}`,
      );
      assert(summary.budget.status === "hard", summary.budget.status);
      assert(summary.budget.period === "month", summary.budget.period);
      assert(summary.budget.timezone === "America/New_York", summary.budget.timezone);
      assert(summary.budget.windowStart === window.startIso, "summary window should be this month");
      assert(summary.requests === 2, `seed plus admitted call, got ${summary.requests}`);

      const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(md.includes("| Budget window | this month (America/New_York) |"), "markdown receipt missing month window");
      assert(md.includes("Spend in window"), "markdown receipt missing window spend");
      assert(!md.includes("today"), "month receipt should not say today");
      const svg = await fetch(`${base}/receipt.svg`).then((r) => r.text());
      assert(svg.includes("counted this month"), "svg receipt missing month window");
      assert(svg.includes("America/New_York"), "svg receipt missing timezone");
      const badge = await fetch(`${base}/badge.svg`).then((r) => r.text());
      assert(badge.includes("this month"), "badge should show this month's spend");
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

async function testSoftWarnWeekRefires(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "soft-week",
    mockUrl,
    { softUsd: 0.00001, hardUsd: 100, period: "week", timezone: "UTC" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "soft week window");
      const lastWeek = new Date(Date.parse(window.startIso) - 1000).toISOString();
      app.db
        .prepare(`INSERT INTO events (created_at, type, project, message) VALUES (?, 'soft_warn', ?, ?)`)
        .run(lastWeek, "weekwarn", "last week warning");
      seedSpend(app.db, window.startIso, 0.001, "weekwarn");
      const body = JSON.stringify({
        model: "gpt-4o-mini",
        small: true,
        messages: [{ role: "user", content: "hi" }],
      });
      const first = await postChat(base, "weekwarn", body);
      assert(first.status === 200, `soft week request ${first.status}`);
      assert(first.headers.get("x-spendlight-budget-status") === "soft", "expected a soft warning");
      const warning = first.headers.get("x-spendlight-budget-warning") ?? "";
      assert(warning.includes("this week UTC"), warning);
      await first.text();
      const mid = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(mid.length === 2, `expected last week's warning plus a new one, got ${mid.length}`);

      const second = await postChat(base, "weekwarn", body);
      assert(second.status === 200, `second soft week request ${second.status}`);
      await second.text();
      const after = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(after.length === 2, `soft_warn should dedupe inside the same week, got ${after.length}`);
    },
  );
}

async function testSoftWarnMonthRefires(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "soft-month",
    mockUrl,
    { softUsd: 0.00001, hardUsd: 100, period: "month", timezone: "UTC" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "soft month window");
      const lastMonth = new Date(Date.parse(window.startIso) - 1000).toISOString();
      app.db
        .prepare(`INSERT INTO events (created_at, type, project, message) VALUES (?, 'soft_warn', ?, ?)`)
        .run(lastMonth, "monthwarn", "last month warning");
      seedSpend(app.db, window.startIso, 0.001, "monthwarn");
      const body = JSON.stringify({
        model: "gpt-4o-mini",
        small: true,
        messages: [{ role: "user", content: "hi" }],
      });
      const first = await postChat(base, "monthwarn", body);
      assert(first.status === 200, `soft month request ${first.status}`);
      assert(first.headers.get("x-spendlight-budget-status") === "soft", "expected a soft warning");
      const warning = first.headers.get("x-spendlight-budget-warning") ?? "";
      assert(warning.includes("this month UTC"), warning);
      await first.text();
      const mid = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(mid.length === 2, `expected last month's warning plus a new one, got ${mid.length}`);

      const second = await postChat(base, "monthwarn", body);
      assert(second.status === 200, `second soft month request ${second.status}`);
      await second.text();
      const after = (await summaryOf(base)).events.filter((e) => e.type === "soft_warn");
      assert(after.length === 2, `soft_warn should dedupe inside the same month, got ${after.length}`);
    },
  );
}

async function testProjectScope(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "project-scope",
    mockUrl,
    {
      softUsd: 1,
      hardUsd: 10,
      projects: { demo: { softUsd: 0.5, hardUsd: 2 } },
    },
    async (base, app) => {
      const t0 = Date.parse("2026-01-15T12:00:00.000Z");
      seedSpend(app.db, new Date(t0).toISOString(), 1.25, "demo");
      seedSpend(app.db, new Date(t0 + 1000).toISOString(), 3, "other");
      seedSpend(app.db, new Date(t0 + 2000).toISOString(), 0.5, "demo");

      const allCsv = await fetch(`${base}/api/export.csv`);
      assert(allCsv.status === 200, `unscoped csv ${allCsv.status}`);
      assert((allCsv.headers.get("content-disposition") ?? "").includes("spendlight-ledger.csv"), "unscoped filename");
      const allText = await allCsv.text();
      const allLines = csvLines(allText);
      assert(allLines.length === 4, `unscoped csv rows ${allLines.length}`);
      assert(allLines.filter((line) => line.includes(",demo,")).length === 2, "unscoped csv demo rows");
      assert(allLines.some((line) => line.includes(",other,")), "unscoped csv missing other");

      const demoCsv = await fetch(`${base}/api/export.csv?project=demo`);
      assert(demoCsv.status === 200, `demo csv ${demoCsv.status}`);
      assert((demoCsv.headers.get("content-type") ?? "").includes("text/csv"), "demo csv type");
      assert(
        (demoCsv.headers.get("content-disposition") ?? "").includes("spendlight-demo.csv"),
        demoCsv.headers.get("content-disposition") ?? "missing disposition",
      );
      const demoLines = csvLines(await demoCsv.text());
      assert(demoLines.length === 3, `demo csv should be header + 2 rows, got ${demoLines.length}`);
      assert(demoLines[0] === allLines[0], "scoped csv header changed");
      assert(demoLines.every((line, i) => i === 0 || line.includes(",demo,")), "demo csv leaked another project");
      assert(!demoLines.some((line) => line.includes(",other,")), "demo csv includes other");

      const demoMd = await fetch(`${base}/receipt.md?project=demo`).then((r) => r.text());
      assert(demoMd.includes("Project **demo**"), demoMd);
      assert(demoMd.includes("| Total spend | $1.75 |"), demoMd);
      assert(demoMd.includes("| `gpt-4o-mini` | $1.75 |"), demoMd);
      assert(demoMd.includes("| Project hard | $2.00 |"), demoMd);
      assert(demoMd.includes("| Project soft | $0.5000 |"), demoMd);
      assert(demoMd.includes("| Global spend | $4.75 |"), demoMd);
      assert(!demoMd.includes("| other |"), "scoped receipt listed another project");

      const allMd = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(allMd.includes("| Total spend | $4.75 |"), allMd);
      assert(allMd.includes("| other |"), "unscoped receipt missing other");
      assert(!allMd.includes("Project **"), "unscoped receipt should not name a scope");
      assert(!allMd.includes("Project hard"), "unscoped receipt should not add project cap lines");

      const demoSvg = await fetch(`${base}/receipt.svg?project=demo`).then((r) => r.text());
      assert(demoSvg.includes("spend receipt · demo"), demoSvg);
      assert(demoSvg.includes("project hard"), demoSvg);
      assert(demoSvg.includes("$1.75"), demoSvg);
      assert(!demoSvg.includes("$3.00"), "scoped svg showed the other project's spend");

      const demoBadge = await fetch(`${base}/badge.svg?project=demo`).then((r) => r.text());
      assert(demoBadge.includes("$1.75 / $2.00"), demoBadge);
      const otherBadge = await fetch(`${base}/badge.svg?project=other`).then((r) => r.text());
      assert(otherBadge.includes("$3.00 / $10.00"), otherBadge);
      const allBadge = await fetch(`${base}/badge.svg`).then((r) => r.text());
      assert(allBadge.includes("$4.75 / $10.00"), allBadge);
      assert(!allBadge.includes("today"), "lifetime badge should not say today");

      const missingCsv = await fetch(`${base}/api/export.csv?project=missing-tag`);
      assert(missingCsv.status === 200, `missing project csv ${missingCsv.status}`);
      assert(csvLines(await missingCsv.text()).length === 1, "unknown project should be a header-only csv");
      const missingMd = await fetch(`${base}/receipt.md?project=missing-tag`);
      assert(missingMd.status === 200, `missing project receipt ${missingMd.status}`);
      const missingText = await missingMd.text();
      assert(missingText.includes("| Total spend | $0.000000 |"), missingText);
      assert(!missingText.includes("gpt-4o-mini"), "unknown project receipt leaked models");

      const garbage = await fetch(`${base}/receipt.md?project=${encodeURIComponent("@@@")}`);
      assert(garbage.status === 200, `garbage project status ${garbage.status}`);
      const garbageText = await garbage.text();
      assert(garbageText.includes("Project **—**"), garbageText);
      assert(garbageText.includes("| Total spend | $0.000000 |"), garbageText);
      assert(!garbageText.includes("$1.75"), "garbage project query returned real spend");
      const garbageCsv = await fetch(`${base}/api/export.csv?project=`);
      assert(garbageCsv.status === 200, `empty project csv ${garbageCsv.status}`);
      assert(csvLines(await garbageCsv.text()).length === 1, "empty project query should not dump the ledger");

      const cleaned = await fetch(`${base}/api/export.csv?project=${encodeURIComponent("demo\r\n")}`);
      assert(cleaned.status === 200, `sanitized project csv ${cleaned.status}`);
      assert(csvLines(await cleaned.text()).length === 3, "trailing CR/LF should sanitize to the demo tag");
      const injected = await fetch(`${base}/api/export.csv?project=${encodeURIComponent("demo\r\nX")}`);
      assert(injected.status === 200, `injected project csv ${injected.status}`);
      assert(csvLines(await injected.text()).length === 1, "a sanitized tag that matches nothing should be empty, not a 500");
    },
  );

  await withApp(
    dir,
    "project-scope-day",
    mockUrl,
    {
      softUsd: null,
      hardUsd: 50,
      period: "day",
      timezone: "UTC",
      projects: { demo: { softUsd: null, hardUsd: 2 } },
    },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "day scope window");
      seedSpend(app.db, new Date(Date.parse(window.startIso) - 1000).toISOString(), 9, "demo");
      seedSpend(app.db, window.startIso, 1, "demo");
      seedSpend(app.db, window.startIso, 4, "other");

      const badge = await fetch(`${base}/badge.svg?project=demo`).then((r) => r.text());
      assert(badge.includes("today $1.00 / $2.00"), badge);
      assert(!badge.includes("$9"), "project badge used lifetime or yesterday's spend");

      const md = await fetch(`${base}/receipt.md?project=demo`).then((r) => r.text());
      assert(md.includes("| Total spend | $10.00 |"), md);
      assert(md.includes("| Spend in window | $1.00 |"), md);
      assert(md.includes("| Global spend in window | $5.00 |"), md);
      assert(md.includes("| Project hard | $2.00 |"), md);
      assert(!md.includes("| other |"), "day scoped receipt listed other");

      const all = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(all.includes("| Total spend | $14.00 |"), all);
      assert(all.includes("| Spend in window | $5.00 |"), all);
      assert(!all.includes("Global spend in window"), "unscoped day receipt grew a global-window line");
      assert(!all.includes("Project hard"), "unscoped day receipt showed a project cap");

      const svg = await fetch(`${base}/receipt.svg?project=demo`).then((r) => r.text());
      assert(svg.includes("$1.00 counted today") || svg.includes("$1.000000 counted today"), svg);
      assert(svg.includes("project hard"), svg);
    },
  );
}

async function testModelScope(dir: string, mockUrl: string): Promise<void> {
  await withApp(
    dir,
    "model-scope",
    mockUrl,
    {
      softUsd: 1,
      hardUsd: 10,
      projects: { demo: { softUsd: 0.5, hardUsd: 2 } },
    },
    async (base, app) => {
      const t0 = Date.parse("2026-02-01T12:00:00.000Z");
      seedSpend(app.db, new Date(t0).toISOString(), 1.25, "demo", "gpt-4o-mini");
      seedSpend(app.db, new Date(t0 + 1000).toISOString(), 2, "demo", "gpt-4o");
      seedSpend(app.db, new Date(t0 + 2000).toISOString(), 3, "other", "gpt-4o-mini");
      seedSpend(app.db, new Date(t0 + 3000).toISOString(), 0.5, "other", "gpt-4o");

      const allCsv = await fetch(`${base}/api/export.csv`);
      assert(allCsv.status === 200, `unscoped model csv ${allCsv.status}`);
      assert((allCsv.headers.get("content-disposition") ?? "").includes("spendlight-ledger.csv"), "unscoped filename");
      const allLines = csvLines(await allCsv.text());
      assert(allLines.length === 5, `unscoped csv rows ${allLines.length}`);
      assert(allLines.filter((line) => line.includes(",gpt-4o-mini,")).length === 2, "unscoped csv mini rows");
      assert(allLines.filter((line) => line.includes(",gpt-4o,")).length === 2, "unscoped csv gpt-4o rows");

      const miniCsv = await fetch(`${base}/api/export.csv?model=gpt-4o-mini`);
      assert(miniCsv.status === 200, `mini csv ${miniCsv.status}`);
      assert((miniCsv.headers.get("content-type") ?? "").includes("text/csv"), "mini csv type");
      assert(
        (miniCsv.headers.get("content-disposition") ?? "").includes("spendlight-gpt-4o-mini.csv"),
        miniCsv.headers.get("content-disposition") ?? "missing model disposition",
      );
      const miniLines = csvLines(await miniCsv.text());
      assert(miniLines.length === 3, `mini csv should be header + 2 rows, got ${miniLines.length}`);
      assert(miniLines[0] === allLines[0], "model csv header changed");
      assert(miniLines.every((line, i) => i === 0 || line.includes(",gpt-4o-mini,")), "mini csv leaked another model");
      assert(!miniLines.some((line) => line.includes(",gpt-4o,")), "mini csv includes gpt-4o");
      assert(miniLines.some((line) => line.includes(",demo,")), "mini csv missing demo");
      assert(miniLines.some((line) => line.includes(",other,")), "mini csv missing other");

      const miniMd = await fetch(`${base}/receipt.md?model=gpt-4o-mini`).then((r) => r.text());
      assert(miniMd.includes("Model **gpt-4o-mini**"), miniMd);
      assert(!miniMd.includes("Project **"), "model receipt should not name a project scope");
      assert(miniMd.includes("| Total spend | $4.25 |"), miniMd);
      assert(miniMd.includes("| `gpt-4o-mini` | $4.25 |"), miniMd);
      assert(!miniMd.includes("| `gpt-4o` |"), "model receipt listed another model");
      assert(miniMd.includes("| Global spend | $6.75 |"), miniMd);
      assert(!miniMd.includes("| Project hard |"), "model receipt should not invent a project cap");

      const allMd = await fetch(`${base}/receipt.md`).then((r) => r.text());
      assert(allMd.includes("| Total spend | $6.75 |"), allMd);
      assert(allMd.includes("| `gpt-4o` |"), "unscoped receipt missing gpt-4o");
      assert(!allMd.includes("Model **"), "unscoped receipt should not name a model scope");

      const miniSvg = await fetch(`${base}/receipt.svg?model=gpt-4o-mini`).then((r) => r.text());
      assert(miniSvg.includes("spend receipt · gpt-4o-mini"), miniSvg);
      assert(miniSvg.includes("$4.25"), miniSvg);
      assert(miniSvg.includes("global spend"), miniSvg);
      assert(!miniSvg.includes("$2.00"), "model svg showed the other model's spend");

      const miniBadge = await fetch(`${base}/badge.svg?model=gpt-4o-mini`).then((r) => r.text());
      assert(miniBadge.includes("$4.25 / $10.00"), miniBadge);
      const fourBadge = await fetch(`${base}/badge.svg?model=gpt-4o`).then((r) => r.text());
      assert(fourBadge.includes("$2.50 / $10.00"), fourBadge);

      const bothCsv = await fetch(`${base}/api/export.csv?project=demo&model=gpt-4o-mini`);
      assert(bothCsv.status === 200, `project+model csv ${bothCsv.status}`);
      assert(
        (bothCsv.headers.get("content-disposition") ?? "").includes("spendlight-demo-gpt-4o-mini.csv"),
        bothCsv.headers.get("content-disposition") ?? "missing combined disposition",
      );
      const bothLines = csvLines(await bothCsv.text());
      assert(bothLines.length === 2, `project+model csv should be header + 1 row, got ${bothLines.length}`);
      assert(bothLines[1]?.includes(",demo,gpt-4o-mini,"), bothLines[1] ?? "missing AND row");
      assert(!bothLines.some((line) => line.includes(",other,")), "AND csv leaked other project");
      assert(!bothLines.some((line) => line.includes(",gpt-4o,")), "AND csv leaked gpt-4o");

      const bothMd = await fetch(`${base}/receipt.md?project=demo&model=gpt-4o-mini`).then((r) => r.text());
      assert(bothMd.includes("Project **demo**"), bothMd);
      assert(bothMd.includes("Model **gpt-4o-mini**"), bothMd);
      assert(bothMd.includes("| Total spend | $1.25 |"), bothMd);
      assert(bothMd.includes("| Project hard | $2.00 |"), bothMd);
      assert(!bothMd.includes("| other |"), "AND receipt listed another project");
      assert(!bothMd.includes("| `gpt-4o` |"), "AND receipt listed another model");
      const bothBadge = await fetch(`${base}/badge.svg?project=demo&model=gpt-4o-mini`).then((r) => r.text());
      assert(bothBadge.includes("$1.25 / $2.00"), bothBadge);

      const swapped = await fetch(`${base}/api/export.csv?model=gpt-4o&project=other`);
      const swappedLines = csvLines(await swapped.text());
      assert(swappedLines.length === 2, `swapped AND rows ${swappedLines.length}`);
      assert(swappedLines[1]?.includes(",other,gpt-4o,"), swappedLines[1] ?? "missing swapped AND row");
      assert(
        (swapped.headers.get("content-disposition") ?? "").includes("spendlight-other-gpt-4o.csv"),
        swapped.headers.get("content-disposition") ?? "missing swapped disposition",
      );

      const missingCsv = await fetch(`${base}/api/export.csv?model=missing-model`);
      assert(missingCsv.status === 200, `missing model csv ${missingCsv.status}`);
      assert(
        (missingCsv.headers.get("content-disposition") ?? "").includes("spendlight-missing-model.csv"),
        "unknown model filename",
      );
      assert(csvLines(await missingCsv.text()).length === 1, "unknown model should be a header-only csv");
      const missingMd = await fetch(`${base}/receipt.md?model=missing-model`);
      assert(missingMd.status === 200, `missing model receipt ${missingMd.status}`);
      const missingText = await missingMd.text();
      assert(missingText.includes("Model **missing-model**"), missingText);
      assert(missingText.includes("| Total spend | $0.000000 |"), missingText);
      assert(!missingText.includes("gpt-4o-mini"), "unknown model receipt leaked rows");
      assert(!missingText.includes("$1.25"), "unknown model receipt returned real spend");

      const garbage = await fetch(`${base}/receipt.md?model=${encodeURIComponent("@@@")}`);
      assert(garbage.status === 200, `garbage model status ${garbage.status}`);
      const garbageText = await garbage.text();
      assert(garbageText.includes("Model **—**"), garbageText);
      assert(garbageText.includes("| Total spend | $0.000000 |"), garbageText);
      assert(!garbageText.includes("$4.25"), "garbage model query returned real spend");
      const garbageCsv = await fetch(`${base}/api/export.csv?model=`);
      assert(garbageCsv.status === 200, `empty model csv ${garbageCsv.status}`);
      assert(csvLines(await garbageCsv.text()).length === 1, "empty model query should not dump the ledger");
      assert(
        (garbageCsv.headers.get("content-disposition") ?? "").includes("spendlight-ledger.csv"),
        "empty model filename should not invent a slug",
      );

      const cleaned = await fetch(`${base}/api/export.csv?model=${encodeURIComponent("gpt-4o-mini\r\n")}`);
      assert(cleaned.status === 200, `sanitized model csv ${cleaned.status}`);
      assert(csvLines(await cleaned.text()).length === 3, "trailing CR/LF should sanitize to gpt-4o-mini");
      const injected = await fetch(`${base}/api/export.csv?model=${encodeURIComponent("gpt-4o-mini\r\nX")}`);
      assert(injected.status === 200, `injected model csv ${injected.status}`);
      assert(csvLines(await injected.text()).length === 1, "a sanitized model that matches nothing should be empty, not a 500");
      const disposition = injected.headers.get("content-disposition") ?? "";
      assert(!disposition.includes("\n") && !disposition.includes("\r"), "model filename kept a line break");
    },
  );

  await withApp(
    dir,
    "model-scope-day",
    mockUrl,
    {
      softUsd: null,
      hardUsd: 50,
      period: "day",
      timezone: "UTC",
      projects: { demo: { softUsd: null, hardUsd: 2 } },
    },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "model day window");
      const yesterday = new Date(Date.parse(window.startIso) - 1000).toISOString();
      seedSpend(app.db, yesterday, 9, "demo", "gpt-4o-mini");
      seedSpend(app.db, window.startIso, 1, "demo", "gpt-4o-mini");
      seedSpend(app.db, window.startIso, 4, "demo", "gpt-4o");
      seedSpend(app.db, window.startIso, 2, "other", "gpt-4o-mini");

      const badge = await fetch(`${base}/badge.svg?model=gpt-4o-mini`).then((r) => r.text());
      assert(badge.includes("today $3.00 / $50.00"), badge);
      assert(!badge.includes("$9"), "model badge used lifetime or yesterday's spend");

      const md = await fetch(`${base}/receipt.md?model=gpt-4o-mini`).then((r) => r.text());
      assert(md.includes("| Total spend | $12.00 |"), md);
      assert(md.includes("| Spend in window | $3.00 |"), md);
      assert(md.includes("| Global spend in window | $7.00 |"), md);
      assert(!md.includes("| `gpt-4o` |"), "day model receipt listed gpt-4o");

      const both = await fetch(`${base}/receipt.md?project=demo&model=gpt-4o-mini`).then((r) => r.text());
      assert(both.includes("| Total spend | $10.00 |"), both);
      assert(both.includes("| Spend in window | $1.00 |"), both);
      assert(both.includes("| Global spend in window | $7.00 |"), both);
      assert(both.includes("| Project hard | $2.00 |"), both);

      const bothBadge = await fetch(`${base}/badge.svg?project=demo&model=gpt-4o-mini`).then((r) => r.text());
      assert(bothBadge.includes("today $1.00 / $2.00"), bothBadge);

      const svg = await fetch(`${base}/receipt.svg?model=gpt-4o-mini`).then((r) => r.text());
      assert(svg.includes("$3.00 counted today"), svg);
    },
  );
}

function csvLines(csv: string): string[] {
  return csv.split(/\r?\n/).filter((line) => line.length > 0);
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

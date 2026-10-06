import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitMutating, evaluateBudget, spendWindow } from "./budget.js";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig, normalizeUpstreamUrl } from "./config.js";
import { calendarDayBounds, calendarDayKey, calendarMonthBounds, calendarWeekBounds, shiftCalendarDay, SkippedLocalTimeError, utcFromCivilTime } from "./day.js";
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
    assert(dash.includes("Spend by day"), "dashboard missing spend-by-day");
    assert(dash.includes("last 14 days"), "dashboard should label the daily window");
    assert(dash.includes("function dayLinks"), "dashboard missing per-day receipt links");
    assert(dash.includes('href="/receipt.md?'), "dashboard day links should include the markdown receipt");
    assert(dash.includes('href="/api/export.csv?'), "dashboard day links should include csv");
    assert(dash.includes("since="), "dashboard day links should set since");
    assert(dash.includes("until="), "dashboard day links should set until");

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
    await testTimeScope(dir, mockUrl);
    await testDailyDst(dir, mockUrl);

    console.log("SMOKE OK: logged completion, csv export, hard kill-switch, receipts, pass-through, cors, budget race, stream cutoff, day window, week window, month window, project scope, model scope, time scope, daily breakdown");
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

async function testTimeScope(dir: string, mockUrl: string): Promise<void> {
  const midnight = utcFromCivilTime("America/New_York", { year: 2026, month: 10, day: 4, hour: 0, minute: 0, second: 0 });
  assert(midnight.toISOString() === "2026-10-04T04:00:00.000Z", `ny midnight ${midnight.toISOString()}`);
  const fold = utcFromCivilTime("America/New_York", { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 });
  assert(fold.toISOString() === "2026-11-01T05:30:00.000Z", `dst overlap ${fold.toISOString()}`);
  let skipped = false;
  try {
    utcFromCivilTime("America/New_York", { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 });
  } catch (err) {
    skipped = err instanceof SkippedLocalTimeError;
  }
  assert(skipped, "spring-forward gap should be rejected");

  await withApp(dir, "time-scope", mockUrl, { softUsd: null, hardUsd: 100 }, async (base, app) => {
    seedSpend(app.db, "2026-10-01T00:00:00.000Z", 1, "demo", "gpt-4o-mini");
    seedSpend(app.db, "2026-10-03T12:00:00.000Z", 2, "demo", "gpt-4o");
    seedSpend(app.db, "2026-10-03T18:00:00.000Z", 4, "other", "gpt-4o-mini");
    seedSpend(app.db, "2026-10-05T00:00:00.000Z", 8, "demo", "gpt-4o-mini");

    const allCsv = await fetch(`${base}/api/export.csv`);
    assert(allCsv.status === 200, `unscoped csv ${allCsv.status}`);
    assert((allCsv.headers.get("content-disposition") ?? "").includes("spendlight-ledger.csv"), "time tests changed the unscoped filename");
    assert(csvLines(await allCsv.text()).length === 5, "unscoped csv should still be the whole ledger");
    const allMd = await fetch(`${base}/receipt.md`).then((r) => r.text());
    assert(!allMd.includes("Covered **"), "unscoped receipt should not name a time slice");
    const allSummary = (await fetch(`${base}/api/summary`).then((r) => r.json())) as {
      spendUsd: number;
      scopeSince: string | null;
      scopeUntil: string | null;
      budget: { globalSpend: number };
    };
    assert(Math.abs(allSummary.spendUsd - 15) < 1e-6, `unscoped summary spend ${allSummary.spendUsd}`);
    assert(allSummary.scopeSince == null && allSummary.scopeUntil == null, "unscoped summary should not set a time slice");
    assert(Math.abs(allSummary.budget.globalSpend - 15) < 1e-6, `lifetime budget spend ${allSummary.budget.globalSpend}`);
    const allDaily = (await fetch(`${base}/api/summary`).then((r) => r.json())) as DailySummary;
    assertSummaryFields(allDaily, "unscoped");
    assertContiguous(allDaily.daily, "unscoped utc");
    assert(allDaily.daily[0]?.day === "2026-10-01", `unscoped daily should start at the first spend day, got ${allDaily.daily[0]?.day}`);
    const utcToday = calendarDayKey("UTC", new Date(allDaily.generatedAt));
    const utcEnd = utcToday > "2026-10-05" ? utcToday : "2026-10-05";
    assert(allDaily.daily.at(-1)?.day === utcEnd, `unscoped daily end ${allDaily.daily.at(-1)?.day} !== ${utcEnd}`);
    assertDaily(sliceDaily(allDaily.daily, "2026-10-01", "2026-10-06"), [
      { day: "2026-10-01", spendUsd: 1, requests: 1 },
      { day: "2026-10-02", spendUsd: 0, requests: 0 },
      { day: "2026-10-03", spendUsd: 6, requests: 2 },
      { day: "2026-10-04", spendUsd: 0, requests: 0 },
      { day: "2026-10-05", spendUsd: 8, requests: 1 },
    ], "utc unscoped");
    assert(Math.abs(sumDaily(allDaily.daily) - allDaily.spendUsd) < 1e-6, "unscoped daily spend drifted from the ledger");

    const sinceCsv = await fetch(`${base}/api/export.csv?since=2026-10-03`);
    assert(sinceCsv.status === 200, `since csv ${sinceCsv.status}`);
    assert(
      (sinceCsv.headers.get("content-disposition") ?? "").includes("spendlight-since-2026-10-03.csv"),
      sinceCsv.headers.get("content-disposition") ?? "missing since filename",
    );
    const sinceLines = csvLines(await sinceCsv.text());
    assert(sinceLines.length === 4, `since csv rows ${sinceLines.length}`);
    assert(!sinceLines.some((line) => line.startsWith("2026-10-01T")), "since csv included the earlier row");
    assert(sinceLines.some((line) => line.startsWith("2026-10-05T00:00:00.000Z")), "since csv dropped the open end");
    const sinceMd = await fetch(`${base}/receipt.md?since=2026-10-03`).then((r) => r.text());
    assert(sinceMd.includes("Covered **from 2026-10-03 inclusive (UTC)**"), sinceMd);
    assert(sinceMd.includes("| Total spend | $14.00 |"), sinceMd);
    assert(!sinceMd.includes("2026-10-01T00:00:00.000Z"), "since receipt listed the earlier request");
    const sinceSummary = (await fetch(`${base}/api/summary?since=2026-10-03`).then((r) => r.json())) as {
      spendUsd: number;
      requests: number;
      scopeSince: string | null;
      scopeUntil: string | null;
      budget: { globalSpend: number; status: string };
    };
    assert(Math.abs(sinceSummary.spendUsd - 14) < 1e-6, `since summary spend ${sinceSummary.spendUsd}`);
    assert(sinceSummary.requests === 3, `since summary requests ${sinceSummary.requests}`);
    assert(sinceSummary.scopeSince === "2026-10-03T00:00:00.000Z", sinceSummary.scopeSince ?? "missing since");
    assert(sinceSummary.scopeUntil == null, "since-only summary should leave until open");
    assert(Math.abs(sinceSummary.budget.globalSpend - 15) < 1e-6, "since filter changed the kill-switch spend");

    const untilCsv = await fetch(`${base}/api/export.csv?until=2026-10-03`);
    assert(untilCsv.status === 200, `until csv ${untilCsv.status}`);
    assert(
      (untilCsv.headers.get("content-disposition") ?? "").includes("spendlight-until-2026-10-03.csv"),
      untilCsv.headers.get("content-disposition") ?? "missing until filename",
    );
    const untilLines = csvLines(await untilCsv.text());
    assert(untilLines.length === 2, `until csv should be header + the Oct 1 row, got ${untilLines.length}`);
    assert(untilLines[1]?.startsWith("2026-10-01T00:00:00.000Z,demo,gpt-4o-mini,"), untilLines[1] ?? "missing until row");
    const untilMd = await fetch(`${base}/receipt.md?until=2026-10-03`).then((r) => r.text());
    assert(untilMd.includes("Covered **before 2026-10-03 (UTC)**"), untilMd);
    assert(untilMd.includes("| Total spend | $1.00 |"), untilMd);
    assert(!untilMd.includes("2026-10-03T12:00:00.000Z"), "until receipt included the exclusive bound");

    const bothCsv = await fetch(`${base}/api/export.csv?since=2026-10-03&until=2026-10-05`);
    assert(bothCsv.status === 200, `both csv ${bothCsv.status}`);
    assert(
      (bothCsv.headers.get("content-disposition") ?? "").includes("spendlight-2026-10-03_2026-10-05.csv"),
      bothCsv.headers.get("content-disposition") ?? "missing range filename",
    );
    const bothLines = csvLines(await bothCsv.text());
    assert(bothLines.length === 3, `both csv rows ${bothLines.length}`);
    assert(bothLines.some((line) => line.startsWith("2026-10-03T12:00:00.000Z")), "both csv missing the inclusive start");
    assert(bothLines.some((line) => line.startsWith("2026-10-03T18:00:00.000Z")), "both csv missing the later in-range row");
    assert(!bothLines.some((line) => line.startsWith("2026-10-05T")), "both csv included the exclusive until");
    assert(!bothLines.some((line) => line.startsWith("2026-10-01T")), "both csv included the row before since");
    const bothMd = await fetch(`${base}/receipt.md?since=2026-10-03&until=2026-10-05`).then((r) => r.text());
    assert(bothMd.includes("Covered **2026-10-03 inclusive to 2026-10-05 exclusive (UTC)**"), bothMd);
    assert(bothMd.includes("| Total spend | $6.00 |"), bothMd);
    const bothSvg = await fetch(`${base}/receipt.svg?since=2026-10-03&until=2026-10-05`).then((r) => r.text());
    assert(bothSvg.includes("2026-10-03 → 2026-10-05 · UTC"), bothSvg);
    assert(bothSvg.includes("$6.00"), bothSvg);
    assert(!bothSvg.includes("$8.00"), "ranged svg showed the excluded row");
    const rangedDaily = (await fetch(`${base}/api/summary?since=2026-10-03&until=2026-10-05`).then((r) => r.json())) as DailySummary;
    assertDaily(rangedDaily.daily, [
      { day: "2026-10-03", spendUsd: 6, requests: 2 },
      { day: "2026-10-04", spendUsd: 0, requests: 0 },
    ], "utc ranged");
    assert(Math.abs(sumDaily(rangedDaily.daily) - rangedDaily.spendUsd) < 1e-6, "ranged daily spend drifted");
    assert(Math.abs(rangedDaily.budget.globalSpend - 15) < 1e-6, "daily range changed kill-switch spend");

    const clockCsv = await fetch(`${base}/api/export.csv?since=2026-10-03T15:00:00Z&until=2026-10-05T00:00:00Z`);
    assert(clockCsv.status === 200, `datetime csv ${clockCsv.status}`);
    assert(
      (clockCsv.headers.get("content-disposition") ?? "").includes("spendlight-2026-10-03T150000_2026-10-05.csv"),
      clockCsv.headers.get("content-disposition") ?? "missing datetime filename",
    );
    const clockLines = csvLines(await clockCsv.text());
    assert(clockLines.length === 2, `datetime csv rows ${clockLines.length}`);
    assert(clockLines[1]?.startsWith("2026-10-03T18:00:00.000Z,other,gpt-4o-mini,"), clockLines[1] ?? "missing datetime row");
    const clockMd = await fetch(`${base}/receipt.md?since=2026-10-03T15:00:00Z&until=2026-10-05T00:00:00Z`).then((r) => r.text());
    assert(clockMd.includes("Covered **2026-10-03 15:00:00 inclusive to 2026-10-05 exclusive (UTC)**"), clockMd);
    assert(clockMd.includes("| Total spend | $4.00 |"), clockMd);

    const andCsv = await fetch(`${base}/api/export.csv?project=demo&model=gpt-4o-mini&since=2026-10-01&until=2026-10-05`);
    assert(andCsv.status === 200, `project+model+range csv ${andCsv.status}`);
    assert(
      (andCsv.headers.get("content-disposition") ?? "").includes("spendlight-demo-gpt-4o-mini-2026-10-01_2026-10-05.csv"),
      andCsv.headers.get("content-disposition") ?? "missing combined filename",
    );
    const andLines = csvLines(await andCsv.text());
    assert(andLines.length === 2, `combined csv rows ${andLines.length}`);
    assert(andLines[1]?.includes(",demo,gpt-4o-mini,"), andLines[1] ?? "missing combined row");
    assert(andLines[1]?.startsWith("2026-10-01T00:00:00.000Z"), "combined csv picked the wrong row");
    const andMd = await fetch(`${base}/receipt.md?project=demo&model=gpt-4o-mini&since=2026-10-01&until=2026-10-05`).then((r) => r.text());
    assert(andMd.includes("Project **demo**"), andMd);
    assert(andMd.includes("Model **gpt-4o-mini**"), andMd);
    assert(andMd.includes("Covered **2026-10-01 inclusive to 2026-10-05 exclusive (UTC)**"), andMd);
    assert(andMd.includes("| Total spend | $1.00 |"), andMd);
    assert(andMd.includes("| Global spend | $15.00 |"), andMd);
    assert(!andMd.includes("| other |"), "combined receipt listed another project");
    assert(!andMd.includes("| `gpt-4o` |"), "combined receipt listed another model");
    const andSummary = (await fetch(`${base}/api/summary?project=demo&model=gpt-4o-mini&since=2026-10-01&until=2026-10-05`).then((r) => r.json())) as {
      spendUsd: number;
      requests: number;
      scopeProject: string | null;
      scopeModel: string | null;
      scopeSince: string | null;
      scopeUntil: string | null;
      budget: { globalSpend: number };
      byProject: { project: string }[];
      byModel: { model: string }[];
    };
    assert(Math.abs(andSummary.spendUsd - 1) < 1e-6, `combined summary spend ${andSummary.spendUsd}`);
    assert(andSummary.requests === 1, `combined summary requests ${andSummary.requests}`);
    assert(andSummary.scopeProject === "demo", andSummary.scopeProject ?? "missing project");
    assert(andSummary.scopeModel === "gpt-4o-mini", andSummary.scopeModel ?? "missing model");
    assert(andSummary.scopeSince === "2026-10-01T00:00:00.000Z", andSummary.scopeSince ?? "missing since");
    assert(andSummary.scopeUntil === "2026-10-05T00:00:00.000Z", andSummary.scopeUntil ?? "missing until");
    assert(Math.abs(andSummary.budget.globalSpend - 15) < 1e-6, "combined filters changed kill-switch spend");
    assert(andSummary.byProject.length === 1 && andSummary.byProject[0]?.project === "demo", "combined summary leaked projects");
    assert(andSummary.byModel.length === 1 && andSummary.byModel[0]?.model === "gpt-4o-mini", "combined summary leaked models");

    const badge = await fetch(`${base}/badge.svg?since=2026-10-05&until=2026-10-06`);
    assert(badge.status === 200, `badge should ignore a time slice, got ${badge.status}`);
    const badgeText = await badge.text();
    assert(badgeText.includes("$15.00 / $100.00"), badgeText);
    assert(!badgeText.includes("2026-10-05"), "badge rendered the time slice");
    const badBadge = await fetch(`${base}/badge.svg?since=yesterday`);
    assert(badBadge.status === 200, `badge should ignore an invalid time slice, got ${badBadge.status}`);

    await expectRange400(`${base}/api/export.csv?since=yesterday`, "since", "Invalid since");
    await expectRange400(`${base}/api/export.csv?since=`, "since", "Invalid since");
    await expectRange400(`${base}/api/export.csv?until=2026-02-31`, "until", "does not exist");
    await expectRange400(`${base}/api/export.csv?since=2026-13-01`, "since", "does not exist");
    await expectRange400(`${base}/api/export.csv?since=2026-10-04T25:00:00Z`, "since", "does not exist");
    await expectRange400(`${base}/api/export.csv?since=2026-10-05&until=2026-10-03`, null, "earlier than until");
    await expectRange400(`${base}/api/export.csv?since=2026-10-03&until=2026-10-03`, null, "earlier than until");
    await expectRange400(`${base}/receipt.md?since=nope`, "since", "Invalid since");
    await expectRange400(`${base}/receipt.svg?until=2026-02-31`, "until", "does not exist");
    await expectRange400(`${base}/api/summary?since=2026-10-05&until=2026-10-01`, null, "earlier than until");
    await expectRange400(`${base}/api/export.csv?window=current`, "window", "lifetime");
    await expectRange400(`${base}/receipt.md?window=later`, "window", "current");
    await expectRange400(`${base}/api/summary?window=current&since=2026-10-01`, "window", "cannot be combined");
  });

  await withApp(
    dir,
    "time-scope-ny",
    mockUrl,
    { softUsd: null, hardUsd: 100, timezone: "America/New_York" },
    async (base, app) => {
      seedSpend(app.db, "2026-10-04T03:59:59.000Z", 9, "demo", "gpt-4o-mini");
      seedSpend(app.db, "2026-10-04T04:00:00.000Z", 1, "demo", "gpt-4o-mini");
      seedSpend(app.db, "2026-10-04T16:00:00.000Z", 2, "other", "gpt-4o");
      seedSpend(app.db, "2026-10-05T04:00:00.000Z", 4, "demo", "gpt-4o-mini");

      const sinceCsv = await fetch(`${base}/api/export.csv?since=2026-10-04`);
      assert(sinceCsv.status === 200, `ny since csv ${sinceCsv.status}`);
      assert(
        (sinceCsv.headers.get("content-disposition") ?? "").includes("spendlight-since-2026-10-04.csv"),
        sinceCsv.headers.get("content-disposition") ?? "ny since filename used the UTC instant",
      );
      const sinceLines = csvLines(await sinceCsv.text());
      assert(sinceLines.length === 4, `ny since rows ${sinceLines.length}`);
      assert(!sinceLines.some((line) => line.startsWith("2026-10-04T03:59:59.000Z")), "ny since included the previous local day");
      const sinceMd = await fetch(`${base}/receipt.md?since=2026-10-04`).then((r) => r.text());
      assert(sinceMd.includes("Covered **from 2026-10-04 inclusive (America/New_York)**"), sinceMd);
      assert(sinceMd.includes("| Total spend | $7.00 |"), sinceMd);

      const untilCsv = await fetch(`${base}/api/export.csv?until=2026-10-05`);
      assert(
        (untilCsv.headers.get("content-disposition") ?? "").includes("spendlight-until-2026-10-05.csv"),
        untilCsv.headers.get("content-disposition") ?? "ny until filename",
      );
      const untilLines = csvLines(await untilCsv.text());
      assert(untilLines.length === 4, `ny until rows ${untilLines.length}`);
      assert(!untilLines.some((line) => line.startsWith("2026-10-05T04:00:00.000Z")), "ny until included local midnight");
      const untilMd = await fetch(`${base}/receipt.md?until=2026-10-05`).then((r) => r.text());
      assert(untilMd.includes("Covered **before 2026-10-05 (America/New_York)**"), untilMd);
      assert(untilMd.includes("| Total spend | $12.00 |"), untilMd);

      const bothCsv = await fetch(`${base}/api/export.csv?since=2026-10-04&until=2026-10-05`);
      assert(bothCsv.status === 200, `ny both csv ${bothCsv.status}`);
      assert(
        (bothCsv.headers.get("content-disposition") ?? "").includes("spendlight-2026-10-04_2026-10-05.csv"),
        bothCsv.headers.get("content-disposition") ?? "ny range filename",
      );
      const bothLines = csvLines(await bothCsv.text());
      assert(bothLines.length === 3, `ny both rows ${bothLines.length}`);
      assert(bothLines.some((line) => line.startsWith("2026-10-04T04:00:00.000Z")), "ny both excluded local midnight");
      assert(bothLines.some((line) => line.startsWith("2026-10-04T16:00:00.000Z")), "ny both excluded the afternoon row");
      assert(!bothLines.some((line) => line.startsWith("2026-10-04T03:59:59.000Z")), "ny both included the previous evening");
      assert(!bothLines.some((line) => line.startsWith("2026-10-05T04:00:00.000Z")), "ny both included the next local midnight");
      const bothMd = await fetch(`${base}/receipt.md?since=2026-10-04&until=2026-10-05`).then((r) => r.text());
      assert(bothMd.includes("Covered **2026-10-04 inclusive to 2026-10-05 exclusive (America/New_York)**"), bothMd);
      assert(bothMd.includes("| Total spend | $3.00 |"), bothMd);
      const bothSvg = await fetch(`${base}/receipt.svg?since=2026-10-04&until=2026-10-05`).then((r) => r.text());
      assert(bothSvg.includes("2026-10-04 → 2026-10-05 · America/New_York"), bothSvg);
      const bothSummary = (await fetch(`${base}/api/summary?since=2026-10-04&until=2026-10-05`).then((r) => r.json())) as {
        scopeSince: string | null;
        scopeUntil: string | null;
        budget: { globalSpend: number; timezone: string };
      };
      assert(bothSummary.scopeSince === "2026-10-04T04:00:00.000Z", bothSummary.scopeSince ?? "missing ny since");
      assert(bothSummary.scopeUntil === "2026-10-05T04:00:00.000Z", bothSummary.scopeUntil ?? "missing ny until");
      assert(bothSummary.budget.timezone === "America/New_York", bothSummary.budget.timezone);
      assert(Math.abs(bothSummary.budget.globalSpend - 16) < 1e-6, "ny slice changed kill-switch spend");
      const nyDay = (await fetch(`${base}/api/summary?since=2026-10-04&until=2026-10-05`).then((r) => r.json())) as DailySummary;
      assertDaily(nyDay.daily, [{ day: "2026-10-04", spendUsd: 3, requests: 2 }], "ny local day");
      const nySpan = (await fetch(`${base}/api/summary?since=2026-10-03&until=2026-10-06`).then((r) => r.json())) as DailySummary;
      assertDaily(nySpan.daily, [
        { day: "2026-10-03", spendUsd: 9, requests: 1 },
        { day: "2026-10-04", spendUsd: 3, requests: 2 },
        { day: "2026-10-05", spendUsd: 4, requests: 1 },
      ], "ny midnight span");
      assert(nySpan.daily.find((d) => d.day === "2026-10-03")?.requests === 1, "row just before local midnight was not counted on the previous day");
      assert(nySpan.daily.find((d) => d.day === "2026-10-04")?.spendUsd === 3, "local-midnight row was not counted on the new day");

      const offset = (await fetch(`${base}/api/summary?since=2026-10-04T00:00:00-04:00&until=2026-10-05T00:00:00-04:00`).then((r) => r.json())) as {
        spendUsd: number;
        scopeSince: string | null;
        scopeUntil: string | null;
      };
      assert(offset.scopeSince === "2026-10-04T04:00:00.000Z", offset.scopeSince ?? "offset since");
      assert(offset.scopeUntil === "2026-10-05T04:00:00.000Z", offset.scopeUntil ?? "offset until");
      assert(Math.abs(offset.spendUsd - 3) < 1e-6, `offset range spend ${offset.spendUsd}`);

      const civil = (await fetch(`${base}/api/summary?since=2026-10-04T12:00:00&until=2026-10-05`).then((r) => r.json())) as {
        spendUsd: number;
        requests: number;
        scopeSince: string | null;
      };
      assert(civil.scopeSince === "2026-10-04T16:00:00.000Z", civil.scopeSince ?? "civil since");
      assert(civil.requests === 1, `civil datetime requests ${civil.requests}`);
      assert(Math.abs(civil.spendUsd - 2) < 1e-6, `civil datetime spend ${civil.spendUsd}`);
      const partial = (await fetch(`${base}/api/summary?since=2026-10-04T12:00:00&until=2026-10-05`).then((r) => r.json())) as DailySummary;
      assertDaily(partial.daily, [{ day: "2026-10-04", spendUsd: 2, requests: 1 }], "ny partial day");

      const andCsv = await fetch(`${base}/api/export.csv?project=demo&model=gpt-4o-mini&since=2026-10-04&until=2026-10-05`);
      assert(
        (andCsv.headers.get("content-disposition") ?? "").includes("spendlight-demo-gpt-4o-mini-2026-10-04_2026-10-05.csv"),
        andCsv.headers.get("content-disposition") ?? "ny combined filename",
      );
      const andLines = csvLines(await andCsv.text());
      assert(andLines.length === 2, `ny combined rows ${andLines.length}`);
      assert(andLines[1]?.startsWith("2026-10-04T04:00:00.000Z,demo,gpt-4o-mini,"), andLines[1] ?? "ny combined row");
      const andMd = await fetch(`${base}/receipt.md?project=demo&model=gpt-4o-mini&since=2026-10-04&until=2026-10-05`).then((r) => r.text());
      assert(andMd.includes("| Total spend | $1.00 |"), andMd);
      assert(andMd.includes("| Global spend | $16.00 |"), andMd);
      assert(andMd.includes("America/New_York"), andMd);
      const andDaily = (await fetch(`${base}/api/summary?project=demo&model=gpt-4o-mini&since=2026-10-03&until=2026-10-06`).then((r) => r.json())) as DailySummary;
      assert(andDaily.scopeProject === "demo", "combined daily dropped the project scope");
      assert(andDaily.scopeModel === "gpt-4o-mini", "combined daily dropped the model scope");
      assertDaily(andDaily.daily, [
        { day: "2026-10-03", spendUsd: 9, requests: 1 },
        { day: "2026-10-04", spendUsd: 1, requests: 1 },
        { day: "2026-10-05", spendUsd: 4, requests: 1 },
      ], "ny project+model+range");
      assert(Math.abs(andDaily.spendUsd - 14) < 1e-6, `combined daily total ${andDaily.spendUsd}`);
      assert(Math.abs(sumDaily(andDaily.daily) - andDaily.spendUsd) < 1e-6, "combined daily spend drifted");
      assert(andDaily.byProject.length === 1 && andDaily.byProject[0]?.project === "demo", "combined daily leaked projects");
      assert(andDaily.byModel.length === 1 && andDaily.byModel[0]?.model === "gpt-4o-mini", "combined daily leaked models");
      assert(Math.abs(andDaily.budget.globalSpend - 16) < 1e-6, "combined daily changed kill-switch spend");

      await expectRange400(`${base}/receipt.md?since=2026-03-08T02:30:00`, "since", "America/New_York");
    },
  );

  await withApp(
    dir,
    "time-scope-day",
    mockUrl,
    { softUsd: null, hardUsd: 50, period: "day", timezone: "America/New_York" },
    async (base, app) => {
      const window = spendWindow(app.config);
      assert(window, "day window for export scope");
      const today = civilYmd("America/New_York", new Date(window.startIso));
      const tomorrow = civilYmd("America/New_York", new Date(window.endIso));
      const yesterday = civilYmd("America/New_York", new Date(Date.parse(window.startIso) - 1000));
      seedSpend(app.db, new Date(Date.parse(window.startIso) - 1000).toISOString(), 9, "demo");
      seedSpend(app.db, window.startIso, 1, "demo");

      const currentCsv = await fetch(`${base}/api/export.csv?window=current`);
      assert(currentCsv.status === 200, `window=current csv ${currentCsv.status}`);
      assert(
        (currentCsv.headers.get("content-disposition") ?? "").includes(`spendlight-${today}_${tomorrow}.csv`),
        currentCsv.headers.get("content-disposition") ?? "window filename",
      );
      const currentLines = csvLines(await currentCsv.text());
      assert(currentLines.length === 2, `window=current rows ${currentLines.length}`);
      assert(currentLines[1]?.startsWith(window.startIso), currentLines[1] ?? "window csv row");
      const currentSummary = (await fetch(`${base}/api/summary?window=current`).then((r) => r.json())) as {
        spendUsd: number;
        scopeSince: string | null;
        scopeUntil: string | null;
        budget: { globalSpend: number; status: string; period: string };
      };
      assert(Math.abs(currentSummary.spendUsd - 1) < 1e-6, `window summary spend ${currentSummary.spendUsd}`);
      assert(currentSummary.scopeSince === window.startIso, currentSummary.scopeSince ?? "missing window since");
      assert(currentSummary.scopeUntil === window.endIso, currentSummary.scopeUntil ?? "missing window until");
      assert(Math.abs(currentSummary.budget.globalSpend - 1) < 1e-6, `window budget spend ${currentSummary.budget.globalSpend}`);
      assert(currentSummary.budget.status === "ok", currentSummary.budget.status);
      assert(currentSummary.budget.period === "day", currentSummary.budget.period);
      const currentDaily = (await fetch(`${base}/api/summary?window=current`).then((r) => r.json())) as DailySummary;
      assertDaily(currentDaily.daily, [{ day: today, spendUsd: 1, requests: 1 }], "window=current");
      const windowScoped = (await fetch(`${base}/api/summary?project=demo&model=gpt-4o-mini&window=current`).then((r) => r.json())) as DailySummary;
      assertDaily(windowScoped.daily, [{ day: today, spendUsd: 1, requests: 1 }], "window=current project+model");
      const windowMiss = (await fetch(`${base}/api/summary?project=demo&model=gpt-4o&window=current`).then((r) => r.json())) as DailySummary;
      assert(windowMiss.requests === 0, `window model miss requests ${windowMiss.requests}`);
      assertDaily(windowMiss.daily, [{ day: today, spendUsd: 0, requests: 0 }], "window=current quiet day");
      assert(Math.abs(windowMiss.budget.globalSpend - 1) < 1e-6, "window daily filter changed the day budget");
      const yesterdayDaily = (await fetch(`${base}/api/summary?since=${yesterday}&until=${today}`).then((r) => r.json())) as DailySummary;
      assertDaily(yesterdayDaily.daily, [{ day: yesterday, spendUsd: 9, requests: 1 }], "yesterday local day");

      const slice = (await fetch(`${base}/api/summary?since=${yesterday}&until=${today}`).then((r) => r.json())) as {
        spendUsd: number;
        budget: { globalSpend: number; status: string };
      };
      assert(Math.abs(slice.spendUsd - 9) < 1e-6, `yesterday slice spend ${slice.spendUsd}`);
      assert(Math.abs(slice.budget.globalSpend - 1) < 1e-6, "export slice replaced the day budget");
      assert(slice.budget.status === "ok", slice.budget.status);
      const sliceMd = await fetch(`${base}/receipt.md?since=${yesterday}&until=${today}`).then((r) => r.text());
      assert(sliceMd.includes(`Covered **${yesterday} inclusive to ${today} exclusive (America/New_York)**`), sliceMd);
      assert(sliceMd.includes("| Total spend | $9.00 |"), sliceMd);
      assert(sliceMd.includes("| Budget window | today (America/New_York) |"), sliceMd);
      assert(sliceMd.includes("| Spend in window | $1.00 |"), sliceMd);
      const plain = (await fetch(`${base}/api/summary`).then((r) => r.json())) as { spendUsd: number; scopeSince: string | null };
      assert(plain.spendUsd > 9, `unscoped day summary should stay lifetime, got ${plain.spendUsd}`);
      assert(plain.scopeSince == null, "unscoped summary picked up window=current");
    },
  );
}

type DailyRow = { day: string; spendUsd: number; requests: number };

type DailySummary = {
  generatedAt: string;
  spendUsd: number;
  requests: number;
  scopeProject: string | null;
  scopeModel: string | null;
  daily: DailyRow[];
  byProject: { project: string }[];
  byModel: { model: string }[];
  budget: { globalSpend: number };
} & Record<string, unknown>;

const SUMMARY_FIELDS = [
  "generatedAt",
  "scopeProject",
  "scopeModel",
  "scopeSince",
  "scopeUntil",
  "scopeWindowSpend",
  "spendUsd",
  "requests",
  "tokens",
  "budget",
  "byProject",
  "byModel",
  "daily",
  "recent",
  "events",
] as const;

const BUDGET_FIELDS = [
  "allowed",
  "status",
  "project",
  "projectSpend",
  "globalSpend",
  "projectLimit",
  "globalLimit",
  "message",
  "triggeredBy",
  "period",
  "timezone",
  "windowStart",
  "windowEnd",
] as const;

function assertSummaryFields(summary: Record<string, unknown>, label: string): void {
  for (const key of SUMMARY_FIELDS) assert(key in summary, `${label} summary missing ${key}`);
  const budget = summary.budget as Record<string, unknown>;
  assert(budget && typeof budget === "object", `${label} summary missing budget`);
  for (const key of BUDGET_FIELDS) assert(key in budget, `${label} budget missing ${key}`);
  for (const side of ["projectLimit", "globalLimit"] as const) {
    const limit = budget[side] as Record<string, unknown>;
    assert(limit && "softUsd" in limit && "hardUsd" in limit, `${label} ${side} missing soft/hard`);
  }
  for (const key of ["byProject", "byModel", "daily", "recent", "events"] as const) {
    assert(Array.isArray(summary[key]), `${label} ${key} is not an array`);
  }
  const projects = summary.byProject as Record<string, unknown>[];
  if (projects[0]) {
    for (const key of ["project", "spendUsd", "requests", "tokens"]) {
      assert(key in projects[0], `${label} byProject missing ${key}`);
    }
  }
  const models = summary.byModel as Record<string, unknown>[];
  if (models[0]) {
    for (const key of ["model", "spendUsd", "requests", "tokens"]) {
      assert(key in models[0], `${label} byModel missing ${key}`);
    }
  }
  const daily = summary.daily as Record<string, unknown>[];
  if (daily[0]) {
    for (const key of ["day", "spendUsd", "requests"]) assert(key in daily[0], `${label} daily missing ${key}`);
  }
  const recent = summary.recent as Record<string, unknown>[];
  if (recent[0]) {
    for (const key of [
      "id",
      "createdAt",
      "project",
      "model",
      "promptTokens",
      "completionTokens",
      "cachedTokens",
      "totalTokens",
      "costUsd",
      "status",
      "error",
      "upstreamId",
      "path",
      "streamed",
    ]) {
      assert(key in recent[0], `${label} recent missing ${key}`);
    }
  }
}

function assertDaily(daily: DailyRow[], expected: DailyRow[], label: string): void {
  assert(
    daily.length === expected.length,
    `${label} days [${daily.map((d) => d.day).join(",")}] expected [${expected.map((d) => d.day).join(",")}]`,
  );
  for (let i = 0; i < expected.length; i++) {
    const got = daily[i];
    const want = expected[i]!;
    assert(got?.day === want.day, `${label} day ${i} ${got?.day} !== ${want.day}`);
    assert(Math.abs((got?.spendUsd ?? NaN) - want.spendUsd) < 1e-6, `${label} ${want.day} spend ${got?.spendUsd}`);
    assert(got?.requests === want.requests, `${label} ${want.day} requests ${got?.requests}`);
  }
}

function assertContiguous(daily: DailyRow[], label: string): void {
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1]!.day;
    assert(daily[i]!.day === shiftCalendarDay(prev, 1), `${label} gap after ${prev} (${daily[i]!.day})`);
  }
}

function sliceDaily(daily: DailyRow[], from: string, untilDay: string): DailyRow[] {
  return daily.filter((d) => d.day >= from && d.day < untilDay);
}

function sumDaily(daily: DailyRow[]): number {
  return daily.reduce((sum, row) => sum + row.spendUsd, 0);
}

async function testDailyDst(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "daily-dst", mockUrl, { softUsd: null, hardUsd: 1000, timezone: "America/New_York" }, async (base, app) => {
    seedSpend(app.db, "2026-03-08T04:59:59.000Z", 1, "demo");
    seedSpend(app.db, "2026-03-08T05:00:00.000Z", 2, "demo");
    seedSpend(app.db, "2026-03-08T06:30:00.000Z", 4, "demo");
    seedSpend(app.db, "2026-03-08T07:30:00.000Z", 8, "demo");
    seedSpend(app.db, "2026-03-09T03:30:00.000Z", 16, "demo");
    seedSpend(app.db, "2026-03-09T04:00:00.000Z", 32, "demo");
    seedSpend(app.db, "2026-11-01T03:59:59.000Z", 1, "demo");
    seedSpend(app.db, "2026-11-01T04:00:00.000Z", 2, "demo");
    seedSpend(app.db, "2026-11-01T05:30:00.000Z", 4, "demo");
    seedSpend(app.db, "2026-11-01T06:30:00.000Z", 8, "demo");
    seedSpend(app.db, "2026-11-02T04:30:00.000Z", 16, "demo");
    seedSpend(app.db, "2026-11-02T05:00:00.000Z", 32, "demo");

    const spring = (await fetch(`${base}/api/summary?since=2026-03-08&until=2026-03-09`).then((r) => r.json())) as DailySummary;
    assertDaily(spring.daily, [{ day: "2026-03-08", spendUsd: 30, requests: 4 }], "spring-forward day");
    assert(Math.abs(spring.spendUsd - 30) < 1e-6, `spring spend ${spring.spendUsd}`);
    assert(Math.abs(spring.budget.globalSpend - 126) < 1e-6, "dst slice changed kill-switch spend");
    const springCsv = csvLines(await fetch(`${base}/api/export.csv?since=2026-03-08&until=2026-03-09`).then((r) => r.text()));
    assert(springCsv.length === 5, `spring csv rows ${springCsv.length}`);
    assert(springCsv.some((line) => line.startsWith("2026-03-09T03:30:00.000Z")), "spring day dropped the late local evening");
    assert(!springCsv.some((line) => line.startsWith("2026-03-09T04:00:00.000Z")), "spring day included the next local midnight");
    assert(!springCsv.some((line) => line.startsWith("2026-03-08T04:59:59.000Z")), "spring day included the previous local day");

    const fall = (await fetch(`${base}/api/summary?since=2026-11-01&until=2026-11-02`).then((r) => r.json())) as DailySummary;
    assertDaily(fall.daily, [{ day: "2026-11-01", spendUsd: 30, requests: 4 }], "fall-back day");
    const fallSpan = (await fetch(`${base}/api/summary?since=2026-10-31&until=2026-11-03`).then((r) => r.json())) as DailySummary;
    assertDaily(fallSpan.daily, [
      { day: "2026-10-31", spendUsd: 1, requests: 1 },
      { day: "2026-11-01", spendUsd: 30, requests: 4 },
      { day: "2026-11-02", spendUsd: 32, requests: 1 },
    ], "fall-back midnight span");
    assert(Math.abs(fall.budget.globalSpend - 126) < 1e-6, "fall slice changed kill-switch spend");
  });
}

async function expectRange400(url: string, param: string | null, snippet: string): Promise<void> {
  const res = await fetch(url);
  const text = await res.text();
  assert(res.status === 400, `${url} status ${res.status}: ${text.slice(0, 240)}`);
  assert((res.headers.get("content-type") ?? "").includes("application/json"), `${url} content-type ${res.headers.get("content-type")}`);
  assert(!text.includes("promptTokens"), `${url} returned a ledger: ${text.slice(0, 180)}`);
  const body = JSON.parse(text) as {
    error?: { message?: string; type?: string; param?: string | null; code?: string };
  };
  assert(body.error?.type === "invalid_request_error", text);
  assert(body.error?.code === "invalid_time_range", text);
  assert(body.error?.param === param, `${url} param ${String(body.error?.param)}: ${body.error?.message}`);
  assert((body.error?.message ?? "").includes(snippet), body.error?.message ?? text);
}

function civilYmd(timeZone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
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

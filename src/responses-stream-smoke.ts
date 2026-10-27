import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig } from "./config.js";
import { createApp, listen } from "./server.js";
import { completionCharsFromSseData, estimateCostUsd, extractUsageFromSse, preflightFromBody } from "./pricing.js";

const OFFICIAL = { promptTokens: 1000, completionTokens: 20, cachedTokens: 0, totalTokens: 1020 };
const JSON_USAGE = { promptTokens: 8, completionTokens: 4, cachedTokens: 0, totalTokens: 12 };
const FAT = "X".repeat(100_000);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`RESPONSES STREAM FAIL: ${message}`);
}

type LedgerRow = {
  path: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  status: number;
  error: string | null;
  upstreamId: string | null;
  streamed: number;
};

type SummaryBody = {
  spendUsd: number;
  requests: number;
  recent: LedgerRow[];
  budget: { status: string; globalSpend: number };
  events: { type: string }[];
};

/**
 * Responses streams bill from `response.usage`, count output deltas toward the
 * hard-budget cutoff, and reserve `max_output_tokens` instead of the whole cap.
 */
export async function runResponsesStreamSmoke(dir: string): Promise<void> {
  testParsing();

  const seen = { upstream: 0, streamOptions: false };
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
    if (payload.stream_options != null) seen.streamOptions = true;
    if (url.pathname !== "/responses" && url.pathname !== "/v1/responses") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
      return;
    }
    seen.upstream += 1;
    if (payload.stream === true && payload.cut === true) {
      writeCut(res);
      return;
    }
    if (payload.stream === true && payload.partial === true) {
      writePartial(res);
      return;
    }
    if (payload.stream === true) {
      writeOk(res);
      return;
    }
    if (payload.delay === true) await new Promise((resolve) => setTimeout(resolve, 200));
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_json",
        object: "response",
        model: "gpt-4o-mini",
        output: [],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      }),
    );
  });

  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address();
  assert(addr && typeof addr === "object", "responses mock failed to bind");
  const mockUrl = `http://127.0.0.1:${addr.port}/v1`;

  try {
    await testLoggedStream(dir, mockUrl, seen);
    await testPartialDeltas(dir, mockUrl);
    await testStreamCutoff(dir, mockUrl);
    await testBoundedOverlap(dir, mockUrl, seen);
    await testUnboundedOverlap(dir, mockUrl, seen, "responses-open", {});
    await testUnboundedOverlap(dir, mockUrl, seen, "responses-max-tokens", { max_tokens: 10 });
    await testPreflightReject(dir, mockUrl, seen);
    console.log("responses stream smoke ok");
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
}

function testParsing(): void {
  assert(
    completionCharsFromSseData(JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })) === 2,
    "chat content delta",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ choices: [{ text: "abcd" }] })) === 4,
    "legacy completion text",
  );
  assert(
    completionCharsFromSseData(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: "xy" } }] } }] }),
    ) === 2,
    "chat tool-call arguments",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })) === 5,
    "responses output text delta",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ type: "response.refusal.delta", delta: "No" })) === 2,
    "responses refusal delta",
  );
  assert(
    completionCharsFromSseData(
      JSON.stringify({ type: "response.function_call_arguments.delta", delta: "{\"a\":1}" }),
    ) === 7,
    "responses function-call delta",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ type: "response.reasoning_text.delta", delta: "think" })) === 5,
    "responses reasoning delta",
  );
  assert(
    completionCharsFromSseData(
      JSON.stringify({ type: "response.output_audio.delta", delta: "A".repeat(5000) }),
    ) === 0,
    "audio deltas must not inflate the cutoff",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ type: "response.output_text.done", text: "Hello world" })) === 0,
    "done events repeat text and must not be counted",
  );
  assert(
    completionCharsFromSseData(
      JSON.stringify({
        type: "response.completed",
        response: { output: [{ content: [{ text: "Y".repeat(1000) }] }] },
      }),
    ) === 0,
    "completed output text must not be counted",
  );
  assert(
    completionCharsFromSseData(JSON.stringify({ type: "response.output_text.delta", delta: { text: "Hi" } })) === 0,
    "non-string deltas are ignored",
  );

  const chat = extractUsageFromSse(
    `data: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`,
  );
  assert(chat?.promptTokens === 4 && chat.completionTokens === 2 && chat.totalTokens === 6, "chat usage chunk");

  const nested = extractUsageFromSse(
    [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_x" } })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_x",
          usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 },
        },
      })}`,
      "",
    ].join("\n"),
  );
  assert(
    nested?.promptTokens === 1000 && nested.completionTokens === 20 && nested.totalTokens === 1020,
    `nested responses usage ${JSON.stringify(nested)}`,
  );

  const crlf = extractUsageFromSse(
    `data: ${JSON.stringify({
      type: "response.incomplete",
      response: { usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } },
    })}\r\n\r\n`,
  );
  assert(crlf?.promptTokens === 3 && crlf.completionTokens === 1, `crlf usage ${JSON.stringify(crlf)}`);

  const responsesCap = preflightFromBody(
    "gpt-4o-mini",
    { input: "hi", max_output_tokens: 10.9 },
    "/v1/responses",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(responsesCap.outputBounded === true, "max_output_tokens should bound a responses call");
  assert(responsesCap.usage.completionTokens === 10, `floored cap ${responsesCap.usage.completionTokens}`);

  const ignored = preflightFromBody(
    "gpt-4o-mini",
    { input: "hi", max_tokens: 10, max_completion_tokens: 10 },
    "/v1/responses",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(ignored.outputBounded === false, "max_tokens must not bound a responses call");

  const chatCap = preflightFromBody(
    "gpt-4o-mini",
    { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 7, max_tokens: 99 },
    "/v1/chat/completions",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(chatCap.outputBounded === true && chatCap.usage.completionTokens === 7, "chat cap precedence changed");

  const chatIgnoresResponsesCap = preflightFromBody(
    "gpt-4o-mini",
    { messages: [{ role: "user", content: "hi" }], max_output_tokens: 1000 },
    "/v1/chat/completions",
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  );
  assert(chatIgnoresResponsesCap.outputBounded === false, "chat must ignore max_output_tokens");
}

async function testLoggedStream(
  dir: string,
  mockUrl: string,
  seen: { upstream: number; streamOptions: boolean },
): Promise<void> {
  seen.upstream = 0;
  seen.streamOptions = false;
  await withApp(dir, "responses-ok", mockUrl, 0.01, async (base) => {
    const res = await post(base, {
      model: "gpt-4o-mini",
      stream: true,
      input: "hello",
      max_output_tokens: 100,
    });
    const text = await res.text();
    assert(res.status === 200, `responses stream status ${res.status}: ${text.slice(0, 180)}`);
    assert((res.headers.get("content-type") ?? "").includes("text/event-stream"), "responses stream content type");
    assert(text.includes("Hello") && text.includes(" world"), "responses stream dropped the deltas");
    assert(text.includes(FAT.slice(0, 32)), "responses stream dropped the completed event");
    assert(text.includes('"output_tokens":20'), "responses stream dropped provider usage");
    assert(!text.includes("budget_hard_limit"), "completed output tripped the hard-budget cutoff");
    assert(seen.streamOptions === false, "responses stream should not gain chat stream_options");

    const json = await post(base, { model: "gpt-4o-mini", input: "hello" });
    assert(json.status === 200, `responses json status ${json.status}`);
    const jsonCost = cost(JSON_USAGE);
    const header = Number(json.headers.get("x-spendlight-cost-usd"));
    assert(Math.abs(header - jsonCost) < 1e-9, `responses json cost header ${header}`);
    await json.text();

    const summary = await summaryOf(base);
    assert(summary.requests === 2, `responses logged ${summary.requests} rows`);
    const official = cost(OFFICIAL);
    assert(Math.abs(summary.spendUsd - (official + jsonCost)) < 1e-9, `responses spend ${summary.spendUsd}`);
    assert(Math.abs(summary.budget.globalSpend - summary.spendUsd) < 1e-9, "responses changed kill-switch spend");
    assert(summary.budget.status === "ok", summary.budget.status);
    assert(!JSON.stringify(summary).includes("sk-smoke"), "responses summary stored the API key");

    const row = summary.recent.find((item) => item.upstreamId === "resp_ok");
    assert(row != null, "responses stream row missing");
    assert(row.path === "/v1/responses", row.path);
    assert(row.model === "gpt-4o-mini", row.model);
    assert(row.streamed === 1, "responses stream not marked streamed");
    assert(row.status === 200 && row.error == null, `responses stream error ${row.error}`);
    assert(
      row.promptTokens === 1000 && row.completionTokens === 20 && row.cachedTokens === 0 && row.totalTokens === 1020,
      `responses stream usage ${JSON.stringify(row)}`,
    );
    assert(Math.abs(row.costUsd - official) < 1e-9, `responses stream cost ${row.costUsd}`);

    const buffered = summary.recent.find((item) => item.upstreamId === "resp_json");
    assert(buffered?.streamed === 0 && buffered.completionTokens === 4, `responses json row ${JSON.stringify(buffered)}`);
  });
}

async function testPartialDeltas(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "responses-partial", mockUrl, 1, async (base) => {
    const res = await post(base, { model: "gpt-4o-mini", stream: true, partial: true, input: "hello" });
    const text = await res.text();
    assert(res.status === 200 && text.includes("Hello") && text.includes(" world"), `partial stream ${res.status}`);
    const summary = await summaryOf(base);
    const row = summary.recent[0];
    assert(row != null && row.streamed === 1 && row.error == null, `partial row ${JSON.stringify(row)}`);
    assert(row.promptTokens === 2 && row.completionTokens === 3 && row.totalTokens === 5, `partial usage ${JSON.stringify(row)}`);
    const expected = cost({ promptTokens: 2, completionTokens: 3, cachedTokens: 0, totalTokens: 5 });
    assert(Math.abs(row.costUsd - expected) < 1e-9, `partial cost ${row.costUsd}`);
  });
}

async function testStreamCutoff(dir: string, mockUrl: string): Promise<void> {
  await withApp(dir, "responses-cut", mockUrl, 0.001, async (base) => {
    const res = await post(base, { model: "gpt-4o-mini", stream: true, cut: true, input: "hi" });
    const text = await res.text();
    assert(res.status === 200, `cutoff status ${res.status}: ${text.slice(0, 180)}`);
    assert(text.includes("AAAAAAAA"), "responses cutoff forwarded no text");
    assert(!text.includes("END_OF_STREAM_MARKER"), "responses cutoff forwarded past the hard budget");
    assert(text.includes("budget_hard_limit"), "responses cutoff missing budget frame");
    const summary = await summaryOf(base);
    const row = summary.recent[0];
    assert(summary.requests === 1 && row?.streamed === 1, `cutoff row ${JSON.stringify(row)}`);
    assert(row?.error?.includes("hard budget") === true, `cutoff ledger error ${row?.error}`);
    assert(summary.spendUsd > 0.0004 && summary.spendUsd < 0.001, `cutoff spend ${summary.spendUsd}`);
    assert((row?.totalTokens ?? 0) < 20_000, `cutoff logged provider usage (${row?.totalTokens} tokens)`);
    assert(row?.upstreamId == null, `cutoff kept an upstream id (${row?.upstreamId})`);
  });
}

async function testBoundedOverlap(
  dir: string,
  mockUrl: string,
  seen: { upstream: number },
): Promise<void> {
  seen.upstream = 0;
  await withApp(dir, "responses-bound", mockUrl, 0.05, async (base) => {
    const body = { model: "gpt-4o-mini", input: "hi", max_output_tokens: 1000, delay: true };
    const [a, b] = await Promise.all([post(base, body), post(base, body)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert(statuses[0] === 200 && statuses[1] === 200, `bounded responses statuses ${statuses.join(",")}`);
    assert(seen.upstream === 2, `bounded responses reached upstream ${seen.upstream} times`);
    await Promise.all([a.text(), b.text()]);
    const summary = await summaryOf(base);
    assert(summary.requests === 2, `bounded responses logged ${summary.requests}`);
    assert(summary.spendUsd > 0 && summary.spendUsd < 0.001, `bounded responses spend ${summary.spendUsd}`);
    assert(summary.budget.status === "ok", summary.budget.status);
  });
}

async function testUnboundedOverlap(
  dir: string,
  mockUrl: string,
  seen: { upstream: number },
  name: string,
  extra: Record<string, unknown>,
): Promise<void> {
  seen.upstream = 0;
  await withApp(dir, name, mockUrl, 0.04, async (base) => {
    const body = { model: "gpt-4o-mini", input: "hi", delay: true, ...extra };
    const [a, b] = await Promise.all([post(base, body), post(base, body)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert(statuses[0] === 200 && statuses[1] === 402, `${name} statuses ${statuses.join(",")}`);
    assert(seen.upstream === 1, `${name} reached upstream ${seen.upstream} times`);
    const blocked = a.status === 402 ? a : b;
    const blockedJson = (await blocked.json()) as { error?: { code?: string } };
    assert(blockedJson.error?.code === "budget_hard_limit", `${name} 402 code ${blockedJson.error?.code}`);
    await (a.status === 200 ? a.text() : b.text());
    const summary = await summaryOf(base);
    assert(summary.requests === 1, `${name} logged ${summary.requests}`);
    assert(summary.spendUsd < 0.001, `${name} spend ${summary.spendUsd}`);
  });
}

async function testPreflightReject(
  dir: string,
  mockUrl: string,
  seen: { upstream: number },
): Promise<void> {
  seen.upstream = 0;
  await withApp(dir, "responses-too-big", mockUrl, 0.001, async (base) => {
    const res = await post(base, { model: "gpt-4o-mini", input: "hi", max_output_tokens: 100_000 });
    const body = (await res.json()) as { error?: { code?: string } };
    assert(res.status === 402, `oversize responses status ${res.status}`);
    assert(body.error?.code === "budget_hard_limit", `oversize code ${body.error?.code}`);
    assert(seen.upstream === 0, `oversize responses reached upstream ${seen.upstream} times`);
    const summary = await summaryOf(base);
    assert(summary.requests === 0 && summary.spendUsd === 0, `oversize logged spend ${summary.spendUsd}`);
    assert(summary.events.some((event) => event.type === "hard_block"), "oversize missing hard_block event");
  });
}

function cost(usage: { promptTokens: number; completionTokens: number; cachedTokens: number; totalTokens: number }): number {
  return estimateCostUsd("gpt-4o-mini", usage, DEFAULT_PRICING, DEFAULT_FALLBACK).costUsd;
}

async function withApp(
  dir: string,
  name: string,
  mockUrl: string,
  hardUsd: number,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const configPath = join(dir, `${name}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(dir, `${name}.db`),
      upstream: { baseUrl: mockUrl },
      budgets: { global: { softUsd: null, hardUsd } },
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

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spendlight-project": "demo" },
    body: JSON.stringify(body),
  });
}

async function summaryOf(base: string): Promise<SummaryBody> {
  const res = await fetch(`${base}/api/summary`);
  assert(res.status === 200, `summary status ${res.status}`);
  return (await res.json()) as SummaryBody;
}

function readReq(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeEvents(res: ServerResponse, events: string[]): void {
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

function writeOk(res: ServerResponse): void {
  writeEvents(res, [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ok", model: "gpt-4o-mini" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " world" })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_ok",
        model: "gpt-4o-mini",
        output: [{ type: "message", content: [{ type: "output_text", text: FAT }] }],
        usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 },
      },
    })}\n\n`,
  ]);
}

function writePartial(res: ServerResponse): void {
  writeEvents(res, [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " world" })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

function writeCut(res: ServerResponse): void {
  const piece = "A".repeat(800);
  const events: string[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "END_OF_STREAM_MARKER" })}\n\n`);
  events.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_cut",
        usage: { input_tokens: 1, output_tokens: 5_000_000, total_tokens: 5_000_001 },
      },
    })}\n\n`,
  );
  writeEvents(res, events);
}

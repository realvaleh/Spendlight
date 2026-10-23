import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FALLBACK, DEFAULT_PRICING, loadConfig } from "./config.js";
import { createApp, listen } from "./server.js";
import { estimateCostUsd } from "./pricing.js";
import { responseIsStream, upstreamErrorText } from "./proxy.js";

const API_KEY = "sk-json-error-not-in-ledger";

const RATE_LIMIT_MESSAGE = "Rate limit reached for gpt-4o-mini";
const RATE_LIMIT_BODY = JSON.stringify({
  error: {
    message: RATE_LIMIT_MESSAGE,
    type: "tokens",
    param: null,
    code: "rate_limit_exceeded",
  },
});
const UNKNOWN_MESSAGE = "Unknown model gpt|4";
const UNKNOWN_BODY = JSON.stringify({
  error: { message: UNKNOWN_MESSAGE, type: "invalid_request_error" },
});
const PLAIN_BODY = "upstream said left | right\n";
const PLAIN_MESSAGE = "upstream said left | right";
const OK_BODY = JSON.stringify({
  id: "chatcmpl-json",
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
});

function fail(message: string): never {
  console.error(`JSON ERROR SMOKE FAIL: ${message}`);
  process.exit(1);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

function testPure(): void {
  assert(responseIsStream(true, 429, "application/json; charset=utf-8") === false, "json error is not a stream");
  assert(responseIsStream(true, 200, "application/json") === false, "json success is not a stream");
  assert(responseIsStream(true, 200, "application/problem+json") === false, "problem+json is not a stream");
  assert(responseIsStream(true, 200, "Text/Event-Stream") === true, "event stream is a stream");
  assert(responseIsStream(true, 500, "text/event-stream") === true, "error event stream stays a stream");
  assert(responseIsStream(false, 200, "text/event-stream") === true, "event stream without the client flag");
  assert(responseIsStream(true, 200, "") === true, "2xx with no content type stays a stream");
  assert(responseIsStream(true, 502, "") === false, "non-OK with no content type is buffered");
  assert(responseIsStream(true, 502, "text/plain; charset=utf-8") === false, "plain error is buffered");
  assert(responseIsStream(false, 200, "") === false, "non-stream empty type is buffered");
  assert(responseIsStream(true, 200, "application/jsonl") === true, "jsonl is not treated as a json body");
  assert(responseIsStream(false, 200, "application/jsonl") === false, "jsonl without stream is not forced onto SSE");

  assert(upstreamErrorText("") === "", "empty error");
  assert(upstreamErrorText(" \n\t") === "", "blank error");
  assert(upstreamErrorText(RATE_LIMIT_BODY) === RATE_LIMIT_MESSAGE, "openai error.message");
  assert(upstreamErrorText('{"message":"nope"}') === "nope", "top-level message");
  assert(upstreamErrorText('{"error":"plain error"}') === "plain error", "string error");
  assert(upstreamErrorText("bad gateway\r\ntry later") === "bad gateway try later", "newlines collapse");
  const raw = '{"error":{"code":"nope"}}';
  assert(upstreamErrorText(raw) === raw, "json without a message stays the body");
  const long = "m".repeat(501);
  const clipped = upstreamErrorText(JSON.stringify({ error: { message: long } }));
  assert(clipped.length === 500, `clip length ${clipped.length}`);
  assert(clipped.endsWith("…") && clipped.startsWith("m"), "clip keeps the start of the message");
  const huge = JSON.stringify({ padding: "p".repeat(9000), error: { message: "hidden-message" } });
  assert(huge.length > 8192, `huge fixture ${huge.length}`);
  const hugeText = upstreamErrorText(huge);
  assert(!hugeText.includes("hidden-message"), "a body past the parse cap is clipped as text");
  assert(hugeText.startsWith("{") && hugeText.length === 500, `huge clip ${hugeText.length}`);
}

type LedgerRow = {
  status: number;
  error: string | null;
  streamed: number;
  costUsd: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  upstreamId: string | null;
};

type SummaryBody = {
  spendUsd: number;
  requests: number;
  recent: LedgerRow[];
  budget: { status: string; allowed: boolean; globalSpend: number };
};

async function main(): Promise<void> {
  testPure();

  const dir = mkdtempSync(join(tmpdir(), "spendlight-json-error-"));
  let seenStream = false;
  let seenIncludeUsage = false;
  let seenAuthorization = false;

  const mock = createServer(async (req, res) => {
    res.on("error", () => {});
    const raw = await readReq(req);
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    const mode = String(req.headers["x-test-mode"] ?? "");
    if (mode === "json-error") {
      seenStream = payload.stream === true;
      const options = payload.stream_options as { include_usage?: boolean } | undefined;
      seenIncludeUsage = options?.include_usage === true;
      const auth = req.headers.authorization;
      seenAuthorization = typeof auth === "string" && auth === `Bearer ${API_KEY}`;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(RATE_LIMIT_BODY);
      return;
    }
    if (mode === "json-400") {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(UNKNOWN_BODY);
      return;
    }
    if (mode === "plain-502") {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(PLAIN_BODY);
      return;
    }
    if (mode === "json-ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OK_BODY);
      return;
    }
    if (mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-sse", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-sse", usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "bare-sse") {
      res.writeHead(200);
      res.end(
        `data: ${JSON.stringify({ id: "chatcmpl-bare", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });

  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockAddr = mock.address();
  assert(mockAddr && typeof mockAddr === "object", "mock failed to bind");
  const mockUrl = `http://127.0.0.1:${mockAddr.port}/v1`;

  const dbPath = join(dir, "ledger.db");
  const configPath = join(dir, "spendlight.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      upstream: { baseUrl: mockUrl },
      budgets: { global: { hardUsd: 10 } },
    }),
  );

  process.env.OPENAI_API_KEY = API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.SPENDLIGHT_UPSTREAM_URL;
  delete process.env.SPENDLIGHT_CONFIG;
  delete process.env.SPENDLIGHT_SOFT_BUDGET_USD;
  delete process.env.SPENDLIGHT_HARD_BUDGET_USD;
  delete process.env.SPENDLIGHT_BUDGET_PERIOD;
  delete process.env.SPENDLIGHT_BUDGET_TIMEZONE;
  delete process.env.SPENDLIGHT_PORT;
  delete process.env.SPENDLIGHT_HOST;
  delete process.env.SPENDLIGHT_DB;

  const config = loadConfig(configPath);
  config.port = 0;
  const app = createApp(config);
  let base = "";
  try {
    base = await listen(app);
    await exercise(base);
    assert(seenStream, "stream:true should still be forwarded");
    assert(seenIncludeUsage, "stream_options.include_usage should still be set");
    assert(seenAuthorization, "upstream should receive the configured key");
    console.log("JSON ERROR SMOKE OK: json upstream errors logged, not billed as streams");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function exercise(base: string): Promise<void> {
  const longPrompt = "y".repeat(4000);
  const limited = await post(base, "json-error", {
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: longPrompt }],
  });
  const limitedBody = await limited.text();
  assert(limited.status === 429, `json error status ${limited.status}: ${limitedBody.slice(0, 180)}`);
  assert((limited.headers.get("content-type") ?? "").includes("application/json"), "json error content type");
  assert(limitedBody === RATE_LIMIT_BODY, "json error body should be forwarded unchanged");
  assert(!limitedBody.includes("data:"), "json error should not be wrapped as SSE");
  assert(!limitedBody.includes("budget_hard_limit"), "json error should not be a budget frame");

  const afterLimit = await summary(base);
  assert(afterLimit.requests === 1, `rate limit should be one ledger row, got ${afterLimit.requests}`);
  assert(afterLimit.spendUsd === 0, `rate limit charged spend ${afterLimit.spendUsd}`);
  assert(afterLimit.budget.globalSpend === 0, `rate limit changed kill-switch spend ${afterLimit.budget.globalSpend}`);
  assert(afterLimit.budget.status === "ok" && afterLimit.budget.allowed === true, "rate limit tripped the kill-switch");
  const limitedRow = afterLimit.recent[0];
  assert(limitedRow?.status === 429, `rate limit status ${limitedRow?.status}`);
  assert(limitedRow?.streamed === 0, "json error should not be marked streamed");
  assert(limitedRow?.error === RATE_LIMIT_MESSAGE, `rate limit error ${limitedRow?.error}`);
  assert(limitedRow?.promptTokens === 0 && limitedRow?.totalTokens === 0, "json error charged a prompt estimate");
  assert(!JSON.stringify(afterLimit).includes(API_KEY), "summary stored the API key");

  const unknown = await post(base, "json-400", {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
  });
  assert(unknown.status === 400, `non-stream error status ${unknown.status}`);
  await unknown.text();

  const plain = await post(base, "plain-502", {
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const plainBody = await plain.text();
  assert(plain.status === 502, `plain error status ${plain.status}`);
  assert(plainBody === PLAIN_BODY, "plain error body should be forwarded unchanged");

  const jsonOk = await post(base, "json-ok", {
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const jsonOkBody = await jsonOk.text();
  assert(jsonOk.status === 200, `json completion status ${jsonOk.status}: ${jsonOkBody.slice(0, 180)}`);
  assert(jsonOkBody === OK_BODY, "a JSON completion should not be rewritten as SSE");

  const sse = await post(base, "sse", {
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const sseBody = await sse.text();
  assert(sse.status === 200, `sse status ${sse.status}`);
  assert(sseBody.includes("data:") && sseBody.includes("chatcmpl-sse"), "event stream should be forwarded");

  const bare = await post(base, "bare-sse", {
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const bareBody = await bare.text();
  assert(bare.status === 200 && bareBody.includes("chatcmpl-bare"), "typeless 2xx stream should be forwarded");

  const jsonCost = estimateCostUsd(
    "gpt-4o-mini",
    { promptTokens: 20, completionTokens: 10, cachedTokens: 0, totalTokens: 30 },
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  ).costUsd;
  const sseCost = estimateCostUsd(
    "gpt-4o-mini",
    { promptTokens: 4, completionTokens: 2, cachedTokens: 0, totalTokens: 6 },
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  ).costUsd;
  const bareCost = estimateCostUsd(
    "gpt-4o-mini",
    { promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2 },
    DEFAULT_PRICING,
    DEFAULT_FALLBACK,
  ).costUsd;
  const expectedSpend = jsonCost + sseCost + bareCost;

  const done = await summary(base);
  assert(done.requests === 6, `logged ${done.requests} rows`);
  assert(Math.abs(done.spendUsd - expectedSpend) < 1e-9, `spend ${done.spendUsd} !== ${expectedSpend}`);
  assert(Math.abs(done.budget.globalSpend - expectedSpend) < 1e-9, `kill-switch spend ${done.budget.globalSpend}`);
  assert(done.budget.status === "ok", `budget status ${done.budget.status}`);
  assert(!JSON.stringify(done).includes(API_KEY), "summary stored the API key");

  const byStatus = new Map(done.recent.map((row) => [row.status, row]));
  const rate = byStatus.get(429);
  assert(rate?.error === RATE_LIMIT_MESSAGE && rate.streamed === 0 && rate.costUsd === 0, "429 row drifted");
  const badModel = byStatus.get(400);
  assert(badModel?.error === UNKNOWN_MESSAGE && badModel.streamed === 0 && badModel.costUsd === 0, `400 row ${badModel?.error}`);
  const gateway = byStatus.get(502);
  assert(gateway?.error === PLAIN_MESSAGE && gateway.streamed === 0 && gateway.costUsd === 0, `502 row ${gateway?.error}`);
  const completion = done.recent.find((row) => row.upstreamId === "chatcmpl-json");
  assert(
    completion?.streamed === 0 &&
      completion.error === null &&
      completion.totalTokens === 30 &&
      Math.abs(completion.costUsd - jsonCost) < 1e-9,
    `json completion row ${JSON.stringify(completion)}`,
  );
  const stream = done.recent.find((row) => row.upstreamId === "chatcmpl-sse");
  assert(
    stream?.streamed === 1 && stream.error === null && stream.totalTokens === 6 && Math.abs(stream.costUsd - sseCost) < 1e-9,
    `sse row ${JSON.stringify(stream)}`,
  );
  const typeless = done.recent.find((row) => row.upstreamId === "chatcmpl-bare");
  assert(
    typeless?.streamed === 1 && typeless.error === null && typeless.totalTokens === 2,
    `typeless stream row ${JSON.stringify(typeless)}`,
  );

  const exported = await fetch(`${base}/api/export.json`).then((r) => r.json());
  assert(Array.isArray(exported), "json export should be an array");
  const exportedLimit = (exported as { error: string | null; streamed: boolean; status?: number }[]).find(
    (row) => row.error === RATE_LIMIT_MESSAGE,
  );
  assert(exportedLimit?.streamed === false, "export should say the json error was not streamed");
  assert(!JSON.stringify(exported).includes(API_KEY), "export stored the API key");

  const md = await fetch(`${base}/receipt.md`).then((r) => r.text());
  assert(md.includes("| Error |"), "receipt missing the error column");
  assert(md.includes(RATE_LIMIT_MESSAGE), "receipt missing the rate-limit message");
  assert(md.includes("| 429 |"), "receipt missing the 429 status");
  assert(md.includes("left \\| right"), "receipt should escape a pipe in the error");
  assert(!md.includes("left | right"), "receipt left a raw pipe in the error cell");
  assert(md.includes("| 200 |") && md.includes("| 502 |"), "receipt missing success or gateway status");
  assert(!md.includes(API_KEY), "receipt stored the API key");
}

function post(base: string, mode: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spendlight-project": "demo",
      "x-test-mode": mode,
    },
    body: JSON.stringify(body),
  });
}

async function summary(base: string): Promise<SummaryBody> {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

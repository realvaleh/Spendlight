import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Config, Usage } from "./types.js";
import type { Db } from "./db.js";
import { insertEvent, releaseReservation, settleReservation } from "./db.js";
import { admitMutating, budgetErrorBody, evaluateBudget } from "./budget.js";
import {
  completionCharsFromSseData,
  estimateCostUsd,
  extractUsageFromSse,
  parseUsage,
  preflightFromBody,
  roughTokens,
  type Preflight,
} from "./pricing.js";

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const STRIP_REQUEST = new Set(["cookie", "cookie2", "set-cookie"]);

export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  db: Db,
  url: URL,
): Promise<void> {
  const rawBody = await readBody(req);
  const project = resolveProject(req, url, rawBody);
  const priced = isPricedPath(url.pathname);
  const mutating = isMutating(req.method ?? "GET");
  const isChat = url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions";

  let outboundBody = rawBody;
  let model = "unknown";
  let stream = false;
  let parsed: Record<string, unknown> | null = null;

  if (rawBody.length && isJsonReq(req)) {
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      if (typeof parsed.model === "string") model = parsed.model;
      stream = Boolean(parsed.stream);
      if ("spendlight_project" in parsed) {
        delete parsed.spendlight_project;
      }
      if (stream && isChat) {
        const so = (parsed.stream_options as Record<string, unknown> | undefined) ?? {};
        so.include_usage = true;
        parsed.stream_options = so;
      }
      outboundBody = Buffer.from(JSON.stringify(parsed));
    } catch {
      parsed = null;
    }
  }

  const preflight = priced
    ? preflightFromBody(model, parsed, url.pathname, config.pricing, config.fallbackPrice)
    : null;

  let decision = evaluateBudget(db, config, project);
  let reservationId: string | null = null;
  let reserveUsd = 0;
  if (mutating) {
    const admission = admitMutating(db, config, project, preflight);
    decision = admission.decision;
    reservationId = admission.reservationId;
    reserveUsd = admission.reserveUsd;
    if (!admission.allowed) {
      insertEvent(db, "hard_block", project, decision.message ?? "hard budget");
      json(
        res,
        402,
        budgetErrorBody(decision.message ?? "Hard budget exceeded"),
        {
          "x-spendlight-budget-status": "hard",
          "x-spendlight-project": project,
        },
        req,
      );
      return;
    }
  }

  const upstreamUrl = joinUpstream(config.upstreamBaseUrl, url.pathname, url.search);
  const headers = forwardHeaders(req, config, outboundBody.length);
  const ac = new AbortController();
  let settled = false;
  const release = () => {
    if (!settled) {
      releaseReservation(db, reservationId);
      settled = true;
    }
  };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : outboundBody,
      signal: ac.signal,
    });
  } catch (err) {
    release();
    const message = err instanceof Error ? err.message : String(err);
    json(
      res,
      502,
      {
        error: { message: `Spendlight could not reach upstream: ${message}`, type: "spendlight_upstream_error" },
      },
      {},
      req,
    );
    return;
  }

  try {
    const outHeaders = filterResponseHeaders(upstream.headers, req);
    outHeaders["x-spendlight-project"] = project;
    outHeaders["x-spendlight-budget-status"] = decision.status;
    if (decision.message) outHeaders["x-spendlight-budget-warning"] = decision.message;
    if (priced && decision.status === "soft") {
      insertEvent(db, "soft_warn", project, decision.message ?? "soft budget");
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const streamed = stream || contentType.includes("text/event-stream");

    if (streamed && upstream.body) {
      for (const key of Object.keys(outHeaders)) {
        if (key.toLowerCase() === "content-length") delete outHeaders[key];
      }
      res.writeHead(upstream.status, outHeaders);
      const piped = await pipeSse(upstream.body, res, {
        ac,
        capUsd: reserveUsd > 0 ? reserveUsd : null,
        preflight,
        model,
        pricing: config.pricing,
        fallback: config.fallbackPrice,
      });
      if (priced || piped.usage.totalTokens > 0) {
        logCompleted({
          db,
          config,
          project,
          model,
          usage: piped.usage,
          status: upstream.status,
          path: url.pathname,
          streamed: true,
          upstreamId: piped.upstreamId,
          error: piped.stopped ? "stream stopped at hard budget" : null,
          reservationId,
        });
        settled = true;
      }
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    let usage = zeroUsage();
    let upstreamId: string | null = null;
    let loggedModel = model;
    if (contentType.includes("json")) {
      try {
        const parsedJson = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        usage = parseUsage(parsedJson) ?? zeroUsage();
        if (typeof parsedJson.id === "string") upstreamId = parsedJson.id;
        if (typeof parsedJson.model === "string") loggedModel = parsedJson.model;
      } catch {
        // ignore
      }
    }
    outHeaders["content-length"] = String(buf.length);
    const cost = estimateCostUsd(loggedModel, usage, config.pricing, config.fallbackPrice).costUsd;
    outHeaders["x-spendlight-cost-usd"] = String(cost);
    res.writeHead(upstream.status, outHeaders);
    res.end(buf);

    if (priced || usage.totalTokens > 0) {
      logCompleted({
        db,
        config,
        project,
        model: loggedModel,
        usage,
        status: upstream.status,
        path: url.pathname,
        streamed: false,
        upstreamId,
        error: upstream.ok ? null : buf.toString("utf8").slice(0, 500),
        reservationId,
      });
      settled = true;
    }
  } finally {
    release();
  }
}

type PipeArgs = {
  ac: AbortController;
  capUsd: number | null;
  preflight: Preflight | null;
  model: string;
  pricing: Config["pricing"];
  fallback: Config["fallbackPrice"];
};

async function pipeSse(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  args: PipeArgs,
): Promise<{ usage: Usage; upstreamId: string | null; stopped: boolean }> {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  let completionChars = 0;
  let forwarded = "";
  let stopped = false;
  const promptTokens = args.preflight?.usage.promptTokens ?? 0;

  const runningCost = (chars: number) =>
    estimateCostUsd(
      args.model,
      {
        promptTokens,
        completionTokens: roughTokens(chars),
        cachedTokens: 0,
        totalTokens: promptTokens + roughTokens(chars),
      },
      args.pricing,
      args.fallback,
    ).costUsd;

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, Buffer.from(value)]);
      while (!stopped) {
        const sep = findBlankLine(pending);
        if (!sep) break;
        const eventBuf = pending.subarray(0, sep.index + sep.len);
        const eventText = eventBuf.toString("utf8");
        const added = completionCharsFromEvent(eventText);
        const nextChars = completionChars + added;
        if (args.capUsd != null && added > 0 && runningCost(nextChars) >= args.capUsd) {
          stopped = true;
          break;
        }
        completionChars = nextChars;
        pending = pending.subarray(sep.index + sep.len);
        forwarded += eventText;
        res.write(eventBuf);
      }
    }
  } finally {
    if (stopped) {
      args.ac.abort();
      try {
        await reader.cancel();
      } catch {
        // Upstream is already going away.
      }
      const frame = `data: ${JSON.stringify(budgetErrorBody("Spendlight hard budget reached while streaming; forwarding stopped."))}\n\n`;
      if (!res.writableEnded) res.write(frame);
    } else if (pending.length && !res.writableEnded) {
      forwarded += pending.toString("utf8");
      res.write(pending);
    }
    if (!res.writableEnded) res.end();
  }

  const counted: Usage = {
    promptTokens,
    completionTokens: roughTokens(completionChars),
    cachedTokens: 0,
    totalTokens: promptTokens + roughTokens(completionChars),
  };
  const official = !stopped ? extractUsageFromSse(forwarded) : null;
  return {
    usage: official ?? counted,
    upstreamId: extractSseId(forwarded),
    stopped,
  };
}

function findBlankLine(buf: Buffer): { index: number; len: number } | null {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { index: lf, len: 2 };
  return { index: crlf, len: 4 };
}

function completionCharsFromEvent(event: string): number {
  let chars = 0;
  for (const line of event.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    chars += completionCharsFromSseData(trimmed.slice(5).trim());
  }
  return chars;
}

function isMutating(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/** Routes whose usage we know how to price. Kill-switch still covers all mutating /v1 calls. */
function isPricedPath(pathname: string): boolean {
  return (
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/completions") ||
    pathname.endsWith("/embeddings") ||
    pathname.endsWith("/responses")
  );
}

function logCompleted(args: {
  db: Db;
  config: Config;
  project: string;
  model: string;
  usage: Usage;
  status: number;
  path: string;
  streamed: boolean;
  upstreamId: string | null;
  error?: string | null;
  reservationId: string | null;
}): void {
  const { costUsd } = estimateCostUsd(args.model, args.usage, args.config.pricing, args.config.fallbackPrice);
  settleReservation(args.db, args.reservationId, {
    id: randomUUID(),
    project: args.project,
    model: args.model,
    usage: args.usage,
    costUsd,
    status: args.status,
    error: args.error ?? null,
    upstreamId: args.upstreamId,
    path: args.path,
    streamed: args.streamed,
  });
}

export function joinUpstream(base: string, pathname: string, search = ""): string {
  const baseHasV1 = /\/v1$/i.test(base);
  let path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (baseHasV1 && path.startsWith("/v1/")) path = path.slice(3);
  else if (baseHasV1 && path === "/v1") path = "";
  if (path.startsWith("//")) path = `/${path.replace(/^\/+/, "")}`;
  return `${base}${path}${search}`;
}

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = headerVal(req, "origin");
  if (!origin || !isLocalOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers":
      "authorization, content-type, x-spendlight-project, x-spendlight-tag",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-expose-headers":
      "x-spendlight-cost-usd, x-spendlight-budget-status, x-spendlight-budget-warning, x-spendlight-project",
    vary: "Origin",
  };
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function resolveProject(req: IncomingMessage, url: URL, body: Buffer): string {
  const header = headerVal(req, "x-spendlight-project") ?? headerVal(req, "x-spendlight-tag");
  if (header) return sanitizeProject(header);
  const q = url.searchParams.get("project") ?? url.searchParams.get("tag");
  if (q) return sanitizeProject(q);
  if (body.length) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { spendlight_project?: unknown };
      if (typeof parsed.spendlight_project === "string" && parsed.spendlight_project.trim()) {
        return sanitizeProject(parsed.spendlight_project);
      }
    } catch {
      // ignore
    }
  }
  return "default";
}

/** Safe for headers, SQLite grouping, and dashboard HTML. Client-chosen tags are not auth. */
export function sanitizeProject(value: string): string {
  const cleaned = value
    .replace(/[\r\n\0]/g, "")
    .replace(/[^A-Za-z0-9._/\- ]+/g, "")
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned || "default";
}

function forwardHeaders(req: IncomingMessage, config: Config, contentLength: number): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (!value || HOP.has(lower) || STRIP_REQUEST.has(lower)) continue;
    if (lower.startsWith("x-spendlight-")) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (!headers.authorization && config.upstreamApiKey) {
    headers.authorization = `Bearer ${config.upstreamApiKey}`;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["content-length"] = String(contentLength);
  }
  headers.accept ??= "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

function filterResponseHeaders(headers: Headers, req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP.has(lower)) return;
    if (lower === "content-encoding") return;
    if (lower.startsWith("access-control-")) return;
    out[key] = value;
  });
  Object.assign(out, corsHeaders(req));
  return out;
}

function isJsonReq(req: IncomingMessage): boolean {
  const ct = headerVal(req, "content-type") ?? "";
  return ct.includes("json") || ct === "";
}

function headerVal(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  if (req.method === "GET" || req.method === "HEAD") return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
  req?: IncomingMessage,
): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.length),
    ...(req ? corsHeaders(req) : {}),
    ...extra,
  });
  res.end(buf);
}

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function extractSseId(buffer: string): string | null {
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { id?: unknown };
      if (typeof parsed.id === "string") return parsed.id;
    } catch {
      // ignore
    }
  }
  return null;
}

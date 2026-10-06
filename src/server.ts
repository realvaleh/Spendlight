import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config, LedgerRow, Summary } from "./types.js";
import { closeDb, listRequests, loadSummaryParts, openDb, spendMatching, type CreatedRange, type Db } from "./db.js";
import { evaluateBudget, spendWindow } from "./budget.js";
import { dashboardHtml, FAVICON_SVG } from "./ui.js";
import { badgeSvg, receiptMarkdown, receiptSvg } from "./receipts.js";
import { proxyRequest, corsHeaders, normalizeModelId, normalizeProjectTag } from "./proxy.js";
import { parseExportRange, type ParsedExportRange } from "./range.js";

export type App = {
  server: Server;
  db: Db;
  config: Config;
  close: () => Promise<void>;
};

export function createApp(config: Config): App {
  const db = openDb(config.dbPath);

  const server = createServer((req, res) => {
    void handle(req, res, config, db).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        const body = JSON.stringify({ error: { message, type: "spendlight_error" } });
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    db,
    config,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
      closeDb(db);
    },
  };
}

export function listen(app: App): Promise<string> {
  return new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.config.port, app.config.host, () => {
      const addr = app.server.address();
      if (addr && typeof addr === "object") {
        const host = addr.address === "::" ? "127.0.0.1" : addr.address;
        resolve(`http://${host}:${addr.port}`);
      } else {
        resolve(`http://${app.config.host}:${app.config.port}`);
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: Config, db: Db): Promise<void> {
  const host = req.headers.host ?? `${config.host}:${config.port}`;
  const url = new URL(req.url ?? "/", `http://${host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    return send(res, 200, "text/html; charset=utf-8", dashboardHtml(), req);
  }
  if (req.method === "GET" && url.pathname === "/favicon.svg") {
    return send(res, 200, "image/svg+xml", FAVICON_SVG, req);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "spendlight" }, req);
  }
  if (req.method === "GET" && url.pathname === "/api/summary") {
    const parsed = exportRangeOr400(url, config, res, req);
    if (!parsed) return;
    return sendJson(res, 200, summaryFor(db, config, url, parsed.range), req);
  }
  if (req.method === "GET" && url.pathname === "/api/export.csv") {
    const parsed = exportRangeOr400(url, config, res, req);
    if (!parsed) return;
    const project = queryProject(url);
    const model = queryModel(url);
    res.setHeader("cache-control", "no-cache");
    res.setHeader("content-disposition", `attachment; filename="${csvFilename(project, model, parsed.range?.slug)}"`);
    return send(res, 200, "text/csv; charset=utf-8", ledgerCsv(listRequests(db, project, model, parsed.range)), req);
  }
  if (req.method === "GET" && url.pathname === "/receipt.md") {
    const parsed = exportRangeOr400(url, config, res, req);
    if (!parsed) return;
    return send(res, 200, "text/markdown; charset=utf-8", receiptMarkdown(summaryFor(db, config, url, parsed.range)), req);
  }
  if (req.method === "GET" && url.pathname === "/receipt.svg") {
    const parsed = exportRangeOr400(url, config, res, req);
    if (!parsed) return;
    return send(res, 200, "image/svg+xml; charset=utf-8", receiptSvg(summaryFor(db, config, url, parsed.range)), req);
  }
  if (req.method === "GET" && url.pathname === "/badge.svg") {
    res.setHeader("cache-control", "no-cache");
    return send(res, 200, "image/svg+xml; charset=utf-8", badgeSvg(summaryFor(db, config, url)), req);
  }

  if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
    await proxyRequest(req, res, config, db, url);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } }, req);
}

export function buildSummary(
  db: Db,
  config: Config,
  project?: string,
  model?: string,
  range?: CreatedRange | null,
): Summary {
  const now = new Date();
  const parts = loadSummaryParts(db, project, model, range, config.budgets.timezone, now);
  const budget = evaluateBudget(db, config, project ?? "default");
  const window = model !== undefined ? spendWindow(config) : null;
  const scopeWindowSpend = window ? spendMatching(db, project, model, window) : null;
  return {
    generatedAt: now.toISOString(),
    ...parts,
    scopeProject: project === undefined ? null : project,
    scopeModel: model === undefined ? null : model,
    scopeSince: range?.sinceIso ?? null,
    scopeUntil: range?.untilIso ?? null,
    scopeWindowSpend,
    budget,
  };
}

function summaryFor(db: Db, config: Config, url: URL, range?: CreatedRange | null): Summary {
  return buildSummary(db, config, queryProject(url), queryModel(url), range);
}

/** Writes a 400 and returns undefined when `since`, `until`, or `window` is invalid. */
function exportRangeOr400(
  url: URL,
  config: Config,
  res: ServerResponse,
  req: IncomingMessage,
): Extract<ParsedExportRange, { ok: true }> | undefined {
  const parsed = parseExportRange(url, config);
  if (!parsed.ok) {
    sendJson(res, 400, parsed.error, req);
    return undefined;
  }
  return parsed;
}

/** Absent `project` stays unscoped. Present values use request-tag rules and do not become `default`. */
function queryProject(url: URL): string | undefined {
  if (!url.searchParams.has("project")) return undefined;
  return normalizeProjectTag(url.searchParams.get("project") ?? "");
}

/** Absent `model` stays unscoped. Present values use the same rules and do not become `default`. */
function queryModel(url: URL): string | undefined {
  if (!url.searchParams.has("model")) return undefined;
  return normalizeModelId(url.searchParams.get("model") ?? "");
}

function csvFilename(project: string | undefined, model: string | undefined, rangeSlug?: string | null): string {
  const slug = [project, model, rangeSlug]
    .filter((value): value is string => Boolean(value))
    .map(fileSlug)
    .filter(Boolean)
    .join("-");
  return slug ? `spendlight-${slug}.csv` : "spendlight-ledger.csv";
}

function fileSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function send(res: ServerResponse, status: number, type: string, body: string, req: IncomingMessage): void {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": String(buf.length),
    ...corsHeaders(req),
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: unknown, req: IncomingMessage): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body), req);
}

const LEDGER_CSV_HEADER = [
  "timestamp",
  "project",
  "model",
  "promptTokens",
  "completionTokens",
  "cachedTokens",
  "totalTokens",
  "costUsd",
  "streamed",
  "id",
  "error",
] as const;

export function ledgerCsv(rows: LedgerRow[]): string {
  const lines = [LEDGER_CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.createdAt,
        row.project,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.cachedTokens,
        row.totalTokens,
        row.costUsd,
        row.streamed ? 1 : 0,
        row.id,
        row.error ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

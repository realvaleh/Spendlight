import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config, Summary } from "./types.js";
import { closeDb, loadSummaryParts, openDb, type Db } from "./db.js";
import { evaluateBudget } from "./budget.js";
import { dashboardHtml, FAVICON_SVG } from "./ui.js";
import { badgeSvg, receiptMarkdown, receiptSvg } from "./receipts.js";
import { proxyRequest, corsHeaders } from "./proxy.js";

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
    return sendJson(res, 200, buildSummary(db, config), req);
  }
  if (req.method === "GET" && url.pathname === "/receipt.md") {
    return send(res, 200, "text/markdown; charset=utf-8", receiptMarkdown(buildSummary(db, config)), req);
  }
  if (req.method === "GET" && url.pathname === "/receipt.svg") {
    return send(res, 200, "image/svg+xml; charset=utf-8", receiptSvg(buildSummary(db, config)), req);
  }
  if (req.method === "GET" && url.pathname === "/badge.svg") {
    res.setHeader("cache-control", "no-cache");
    return send(res, 200, "image/svg+xml; charset=utf-8", badgeSvg(buildSummary(db, config)), req);
  }

  if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
    await proxyRequest(req, res, config, db, url);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } }, req);
}

export function buildSummary(db: Db, config: Config): Summary {
  const parts = loadSummaryParts(db);
  const budget = evaluateBudget(db, config, "default");
  return {
    generatedAt: new Date().toISOString(),
    ...parts,
    budget,
  };
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

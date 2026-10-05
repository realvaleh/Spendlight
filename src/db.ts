import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { LedgerRow, Usage } from "./types.js";

export type Db = DatabaseSync;

export function openDb(dbPath: string): Db {
  const absolute = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (absolute !== ":memory:") {
    mkdirSync(dirname(absolute), { recursive: true });
  }
  const db = new DatabaseSync(absolute);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'default',
      model TEXT NOT NULL DEFAULT 'unknown',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      upstream_id TEXT,
      path TEXT NOT NULL DEFAULT '/v1/chat/completions',
      streamed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      project TEXT NOT NULL,
      cost_usd REAL NOT NULL
    );
  `);
  return db;
}

/** Drop in-flight holds left behind by a crashed process so they cannot wedge the kill-switch. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export function withImmediate<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already be closed.
    }
    throw err;
  }
}

export function purgeStaleReservations(db: Db, now = Date.now()): void {
  const cutoff = new Date(now - RESERVATION_TTL_MS).toISOString();
  db.prepare(`DELETE FROM reservations WHERE created_at < ?`).run(cutoff);
}

/** Half-open UTC range. When set, only rows inside it count toward a budget. */
export type SpendWindow = { startIso: string; endIso: string };

/**
 * Half-open `created_at` filter for exports and summaries.
 * A null side is unbounded. This does not change budget windows.
 */
export type CreatedRange = {
  sinceIso: string | null;
  untilIso: string | null;
};

export function reservedSpend(db: Db, project?: string, window?: SpendWindow | null): number {
  if (!window) {
    if (project) {
      const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM reservations WHERE project = ?`).get(project) as {
        s: number;
      };
      return Number(row.s) || 0;
    }
    const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM reservations`).get() as { s: number };
    return Number(row.s) || 0;
  }
  if (project) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM reservations WHERE project = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(project, window.startIso, window.endIso) as { s: number };
    return Number(row.s) || 0;
  }
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM reservations WHERE created_at >= ? AND created_at < ?`)
    .get(window.startIso, window.endIso) as { s: number };
  return Number(row.s) || 0;
}

export function insertReservation(db: Db, id: string, project: string, costUsd: number): void {
  db.prepare(`INSERT INTO reservations (id, created_at, project, cost_usd) VALUES (?, ?, ?, ?)`).run(
    id,
    new Date().toISOString(),
    project,
    roundUsd(costUsd),
  );
}

export function deleteReservation(db: Db, id: string): void {
  db.prepare(`DELETE FROM reservations WHERE id = ?`).run(id);
}

export function spendFor(db: Db, project?: string, window?: SpendWindow | null): number {
  if (!window) {
    if (project) {
      const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM requests WHERE project = ?`).get(project) as {
        s: number;
      };
      return Number(row.s) || 0;
    }
    const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM requests`).get() as { s: number };
    return Number(row.s) || 0;
  }
  if (project) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM requests WHERE project = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(project, window.startIso, window.endIso) as { s: number };
    return Number(row.s) || 0;
  }
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM requests WHERE created_at >= ? AND created_at < ?`)
    .get(window.startIso, window.endIso) as { s: number };
  return Number(row.s) || 0;
}

export function insertRequest(
  db: Db,
  row: {
    id?: string;
    createdAt?: string;
    project: string;
    model: string;
    usage: Usage;
    costUsd: number;
    status: number;
    error?: string | null;
    upstreamId?: string | null;
    path: string;
    streamed?: boolean;
  },
): LedgerRow {
  const id = row.id ?? randomUUID();
  const createdAt = row.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (
      id, created_at, project, model, prompt_tokens, completion_tokens, cached_tokens,
      total_tokens, cost_usd, status, error, upstream_id, path, streamed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    createdAt,
    row.project,
    row.model,
    row.usage.promptTokens,
    row.usage.completionTokens,
    row.usage.cachedTokens,
    row.usage.totalTokens,
    roundUsd(row.costUsd),
    row.status,
    row.error ?? null,
    row.upstreamId ?? null,
    row.path,
    row.streamed ? 1 : 0,
  );
  return {
    id,
    createdAt,
    project: row.project,
    model: row.model,
    promptTokens: row.usage.promptTokens,
    completionTokens: row.usage.completionTokens,
    cachedTokens: row.usage.cachedTokens,
    totalTokens: row.usage.totalTokens,
    costUsd: roundUsd(row.costUsd),
    status: row.status,
    error: row.error ?? null,
    upstreamId: row.upstreamId ?? null,
    path: row.path,
    streamed: row.streamed ? 1 : 0,
  };
}

export function insertEvent(
  db: Db,
  type: string,
  project: string,
  message: string,
  opts?: { dedupeSinceIso?: string | null },
): void {
  if (type === "soft_warn") {
    const since = opts?.dedupeSinceIso;
    const existing = since
      ? db
          .prepare(
            `SELECT 1 AS ok FROM events WHERE type = 'soft_warn' AND project = ? AND created_at >= ? LIMIT 1`,
          )
          .get(project, since)
      : db.prepare(`SELECT 1 AS ok FROM events WHERE type = 'soft_warn' AND project = ? LIMIT 1`).get(project);
    if (existing) return;
  }
  db.prepare(`INSERT INTO events (created_at, type, project, message) VALUES (?, ?, ?, ?)`).run(
    new Date().toISOString(),
    type,
    project,
    message,
  );
}

const REQUEST_COLUMNS = `id, created_at AS createdAt, project, model,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              cached_tokens AS cachedTokens, total_tokens AS totalTokens,
              cost_usd AS costUsd, status, error, upstream_id AS upstreamId, path, streamed`;

export function listRecent(db: Db, limit = 50, project?: string, model?: string, range?: CreatedRange | null): LedgerRow[] {
  const { clause, args } = requestWhere({ project, model }, range);
  const rows = db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM requests${clause} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit) as LedgerRow[];
  return rows.map(normalizeRow);
}

/** Ledger rows, oldest first, for CSV export. Pass a project, model, and/or time range to export one slice. */
export function listRequests(db: Db, project?: string, model?: string, range?: CreatedRange | null): LedgerRow[] {
  const { clause, args } = requestWhere({ project, model }, range);
  const rows = db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM requests${clause} ORDER BY created_at ASC, id ASC`)
    .all(...args) as LedgerRow[];
  return rows.map(normalizeRow);
}

/** Sum cost for an export scope. Undefined project or model leaves that dimension unscoped. */
export function spendMatching(db: Db, project?: string, model?: string, window?: SpendWindow | null): number {
  const range = window ? { sinceIso: window.startIso, untilIso: window.endIso } : null;
  const { clause, args } = requestWhere({ project, model }, range);
  const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM requests${clause}`).get(...args) as { s: number };
  return Number(row.s) || 0;
}

function requestWhere(
  scope: { project?: string; model?: string },
  range?: CreatedRange | null,
): { clause: string; args: string[] } {
  const clauses: string[] = [];
  const args: string[] = [];
  if (scope.project != null) {
    clauses.push("project = ?");
    args.push(scope.project);
  }
  if (scope.model != null) {
    clauses.push("model = ?");
    args.push(scope.model);
  }
  if (range?.sinceIso) {
    clauses.push("created_at >= ?");
    args.push(range.sinceIso);
  }
  if (range?.untilIso) {
    clauses.push("created_at < ?");
    args.push(range.untilIso);
  }
  return { clause: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", args };
}

export function loadSummaryParts(db: Db, project?: string, model?: string, range?: CreatedRange | null): {
  spendUsd: number;
  requests: number;
  tokens: number;
  byProject: { project: string; spendUsd: number; requests: number; tokens: number }[];
  byModel: { model: string; spendUsd: number; requests: number; tokens: number }[];
  daily: { day: string; spendUsd: number; requests: number }[];
  recent: LedgerRow[];
  events: { createdAt: string; type: string; project: string; message: string }[];
} {
  const { clause, args } = requestWhere({ project, model }, range);
  const totals = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS spendUsd, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens FROM requests${clause}`).get(...args) as {
    spendUsd: number;
    requests: number;
    tokens: number;
  };
  const byProject = db
    .prepare(
      `SELECT project, COALESCE(SUM(cost_usd),0) AS spendUsd, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
       FROM requests${clause} GROUP BY project ORDER BY spendUsd DESC`,
    )
    .all(...args) as { project: string; spendUsd: number; requests: number; tokens: number }[];
  const byModel = db
    .prepare(
      `SELECT model, COALESCE(SUM(cost_usd),0) AS spendUsd, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
       FROM requests${clause} GROUP BY model ORDER BY spendUsd DESC`,
    )
    .all(...args) as { model: string; spendUsd: number; requests: number; tokens: number }[];
  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(cost_usd),0) AS spendUsd, COUNT(*) AS requests
       FROM requests${clause} GROUP BY day ORDER BY day ASC`,
    )
    .all(...args) as { day: string; spendUsd: number; requests: number }[];
  const events = db
    .prepare(
      `SELECT created_at AS createdAt, type, project, message FROM events ORDER BY id DESC LIMIT 20`,
    )
    .all() as { createdAt: string; type: string; project: string; message: string }[];
  return {
    spendUsd: Number(totals.spendUsd) || 0,
    requests: Number(totals.requests) || 0,
    tokens: Number(totals.tokens) || 0,
    byProject: byProject.map((r) => ({ ...r, spendUsd: Number(r.spendUsd), requests: Number(r.requests), tokens: Number(r.tokens) })),
    byModel: byModel.map((r) => ({ ...r, spendUsd: Number(r.spendUsd), requests: Number(r.requests), tokens: Number(r.tokens) })),
    daily: daily.map((r) => ({ ...r, spendUsd: Number(r.spendUsd), requests: Number(r.requests) })),
    recent: listRecent(db, 40, project, model, range),
    events,
  };
}

function normalizeRow(row: LedgerRow): LedgerRow {
  return {
    ...row,
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    cachedTokens: Number(row.cachedTokens),
    totalTokens: Number(row.totalTokens),
    costUsd: Number(row.costUsd),
    status: Number(row.status),
    streamed: Number(row.streamed),
  };
}

export function roundUsd(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function releaseReservation(db: Db, reservationId: string | null): void {
  if (!reservationId) return;
  withImmediate(db, () => {
    deleteReservation(db, reservationId);
  });
}

export function settleReservation(
  db: Db,
  reservationId: string | null,
  row: {
    id?: string;
    createdAt?: string;
    project: string;
    model: string;
    usage: Usage;
    costUsd: number;
    status: number;
    error?: string | null;
    upstreamId?: string | null;
    path: string;
    streamed?: boolean;
  },
): LedgerRow {
  if (!reservationId) return insertRequest(db, row);
  return withImmediate(db, () => {
    deleteReservation(db, reservationId);
    return insertRequest(db, row);
  });
}

export function closeDb(db: Db): void {
  db.close();
}

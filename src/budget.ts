import { randomUUID } from "node:crypto";
import type { BudgetDecision, BudgetLimit, BudgetPeriod, Config } from "./types.js";
import type { Preflight } from "./pricing.js";
import { calendarDayBounds, calendarMonthBounds, calendarWeekBounds } from "./day.js";
import {
  insertReservation,
  purgeStaleReservations,
  reservedSpend,
  roundUsd,
  spendFor,
  withImmediate,
  type Db,
  type SpendWindow,
} from "./db.js";

export type Admission = {
  allowed: boolean;
  decision: BudgetDecision;
  reservationId: string | null;
  /** USD held for this call. Streaming stops forwarding once a running estimate reaches it. */
  reserveUsd: number;
};

/** Null for a lifetime budget. Otherwise the current calendar day, ISO week, or month in the configured timezone. */
export function spendWindow(config: Config, now = new Date()): SpendWindow | null {
  const period = config.budgets.period;
  const zone = config.budgets.timezone;
  const bounds =
    period === "day"
      ? calendarDayBounds(zone, now)
      : period === "week"
        ? calendarWeekBounds(zone, now)
        : period === "month"
          ? calendarMonthBounds(zone, now)
          : null;
  if (!bounds) return null;
  return { startIso: bounds.start.toISOString(), endIso: bounds.end.toISOString() };
}

export function evaluateBudget(db: Db, config: Config, project: string, now = new Date()): BudgetDecision {
  const window = spendWindow(config, now);
  const projectSpend = spendFor(db, project, window);
  const globalSpend = spendFor(db, undefined, window);
  const projectLimit = config.budgets.projects[project] ?? { softUsd: null, hardUsd: null };
  const globalLimit = config.budgets.global;
  const meta = windowMeta(config, window);

  const projectHard = hitHard(projectSpend, projectLimit);
  const globalHard = hitHard(globalSpend, globalLimit);
  if (projectHard || globalHard) {
    const triggeredBy = projectHard ? "project" : "global";
    const limit = triggeredBy === "project" ? projectLimit.hardUsd : globalLimit.hardUsd;
    const spend = triggeredBy === "project" ? projectSpend : globalSpend;
    return {
      allowed: false,
      status: "hard",
      project,
      projectSpend,
      globalSpend,
      projectLimit,
      globalLimit,
      triggeredBy,
      message: hardMessage(triggeredBy, project, spend, limit, meta),
      ...meta,
    };
  }

  const projectSoft = hitSoft(projectSpend, projectLimit);
  const globalSoft = hitSoft(globalSpend, globalLimit);
  if (projectSoft || globalSoft) {
    const triggeredBy = projectSoft ? "project" : "global";
    const limit = triggeredBy === "project" ? projectLimit.softUsd : globalLimit.softUsd;
    const spend = triggeredBy === "project" ? projectSpend : globalSpend;
    return {
      allowed: true,
      status: "soft",
      project,
      projectSpend,
      globalSpend,
      projectLimit,
      globalLimit,
      triggeredBy,
      message: softMessage(triggeredBy, spend, limit, meta),
      ...meta,
    };
  }

  return {
    allowed: true,
    status: "ok",
    project,
    projectSpend,
    globalSpend,
    projectLimit,
    globalLimit,
    triggeredBy: null,
    message: null,
    ...meta,
  };
}

/**
 * Atomic hard-budget admission. Committed spend plus in-flight reservations is checked
 * inside BEGIN IMMEDIATE, then this call's hold is inserted before we talk to upstream.
 * Unbounded completions (no max_tokens) hold the entire remaining headroom so a second
 * concurrent call cannot pass the same check. Bounded calls hold their preflight estimate.
 */
export function admitMutating(
  db: Db,
  config: Config,
  project: string,
  preflight: Preflight | null,
  now = new Date(),
): Admission {
  return withImmediate(db, () => {
    purgeStaleReservations(db, now.getTime());
    const committed = evaluateBudget(db, config, project, now);
    if (!committed.allowed) {
      return { allowed: false, decision: committed, reservationId: null, reserveUsd: 0 };
    }

    const snap = snapshot(db, config, project, now);
    if (snap.room != null && snap.room <= 0) {
      const spend = snap.triggeredBy === "project" ? snap.projectAdmission : snap.globalAdmission;
      const limit = snap.triggeredBy === "project" ? snap.projectLimit.hardUsd : snap.globalLimit.hardUsd;
      return {
        allowed: false,
        decision: hardDecision(
          project,
          snap,
          hardMessage(snap.triggeredBy ?? "global", project, spend, limit, snap),
        ),
        reservationId: null,
        reserveUsd: 0,
      };
    }

    if (!preflight || snap.room == null) {
      return { allowed: true, decision: committed, reservationId: null, reserveUsd: 0 };
    }

    const room = snap.room;
    const triggeredBy = snap.triggeredBy ?? "global";
    const spend = triggeredBy === "project" ? snap.projectAdmission : snap.globalAdmission;
    const limit = triggeredBy === "project" ? snap.projectLimit.hardUsd : snap.globalLimit.hardUsd;
    if (preflight.promptCostUsd > room || (preflight.outputBounded && preflight.costUsd > room)) {
      const estimate = preflight.outputBounded ? preflight.costUsd : preflight.promptCostUsd;
      const where = windowClause(snap);
      const label = triggeredBy === "project" ? project : "global";
      const message = `Spendlight hard budget exceeded (${triggeredBy} '${label}'${where}): preflight ${fmt(estimate)} exceeds remaining ${fmt(room)} (${fmt(spend)} / ${fmt(limit)}). Kill-switch is on; further completions are rejected.`;
      return {
        allowed: false,
        decision: hardDecision(project, snap, message),
        reservationId: null,
        reserveUsd: 0,
      };
    }

    const reserveUsd = roundUsd(preflight.outputBounded ? preflight.costUsd : room);
    if (!(reserveUsd > 0)) {
      return { allowed: true, decision: committed, reservationId: null, reserveUsd: 0 };
    }

    const reservationId = randomUUID();
    insertReservation(db, reservationId, project, reserveUsd);
    return { allowed: true, decision: committed, reservationId, reserveUsd };
  });
}

function snapshot(db: Db, config: Config, project: string, now: Date): {
  projectAdmission: number;
  globalAdmission: number;
  projectLimit: BudgetLimit;
  globalLimit: BudgetLimit;
  room: number | null;
  triggeredBy: "project" | "global" | null;
  period: BudgetPeriod;
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
} {
  const projectLimit = config.budgets.projects[project] ?? { softUsd: null, hardUsd: null };
  const globalLimit = config.budgets.global;
  const window = spendWindow(config, now);
  const meta = windowMeta(config, window);
  const projectAdmission = spendFor(db, project, window) + reservedSpend(db, project, window);
  const globalAdmission = spendFor(db, undefined, window) + reservedSpend(db, undefined, window);
  let room: number | null = null;
  let triggeredBy: "project" | "global" | null = null;
  if (projectLimit.hardUsd != null) {
    room = projectLimit.hardUsd - projectAdmission;
    triggeredBy = "project";
  }
  if (globalLimit.hardUsd != null) {
    const globalRoom = globalLimit.hardUsd - globalAdmission;
    if (room == null || globalRoom < room) {
      room = globalRoom;
      triggeredBy = "global";
    }
  }
  return { projectAdmission, globalAdmission, projectLimit, globalLimit, room, triggeredBy, ...meta };
}

function hardDecision(
  project: string,
  snap: {
    projectAdmission: number;
    globalAdmission: number;
    projectLimit: BudgetLimit;
    globalLimit: BudgetLimit;
    triggeredBy: "project" | "global" | null;
    period: BudgetPeriod;
    timezone: string;
    windowStart: string | null;
    windowEnd: string | null;
  },
  message: string,
): BudgetDecision {
  return {
    allowed: false,
    status: "hard",
    project,
    projectSpend: snap.projectAdmission,
    globalSpend: snap.globalAdmission,
    projectLimit: snap.projectLimit,
    globalLimit: snap.globalLimit,
    triggeredBy: snap.triggeredBy,
    message,
    period: snap.period,
    timezone: snap.timezone,
    windowStart: snap.windowStart,
    windowEnd: snap.windowEnd,
  };
}

function windowMeta(config: Config, window: SpendWindow | null): {
  period: BudgetPeriod;
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
} {
  return {
    period: config.budgets.period,
    timezone: config.budgets.timezone,
    windowStart: window?.startIso ?? null,
    windowEnd: window?.endIso ?? null,
  };
}

function windowClause(meta: { period: BudgetPeriod; timezone: string }): string {
  if (meta.period === "day") return `, today ${meta.timezone}`;
  if (meta.period === "week") return `, this week ${meta.timezone}`;
  if (meta.period === "month") return `, this month ${meta.timezone}`;
  return "";
}

function hardMessage(
  triggeredBy: "project" | "global",
  project: string,
  spend: number,
  limit: number | null,
  meta: { period: BudgetPeriod; timezone: string },
): string {
  const label = triggeredBy === "project" ? project : "global";
  return `Spendlight hard budget exceeded (${triggeredBy} '${label}'${windowClause(meta)}): ${fmt(spend)} / ${fmt(limit)}. Kill-switch is on; further completions are rejected.`;
}

function softMessage(
  triggeredBy: "project" | "global",
  spend: number,
  limit: number | null,
  meta: { period: BudgetPeriod; timezone: string },
): string {
  return `Spendlight soft budget warning (${triggeredBy}${windowClause(meta)}): ${fmt(spend)} / ${fmt(limit)}.`;
}

function hitHard(spend: number, limit: BudgetLimit): boolean {
  return limit.hardUsd != null && spend >= limit.hardUsd;
}

function hitSoft(spend: number, limit: BudgetLimit): boolean {
  return limit.softUsd != null && spend >= limit.softUsd;
}

export function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export function budgetErrorBody(message: string) {
  return {
    error: {
      message,
      type: "spendlight_budget_exceeded",
      param: null,
      code: "budget_hard_limit",
    },
  };
}

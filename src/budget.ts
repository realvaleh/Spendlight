import { randomUUID } from "node:crypto";
import type { BudgetDecision, BudgetLimit, Config } from "./types.js";
import type { Preflight } from "./pricing.js";
import {
  insertReservation,
  purgeStaleReservations,
  reservedSpend,
  roundUsd,
  spendFor,
  withImmediate,
  type Db,
} from "./db.js";

export type Admission = {
  allowed: boolean;
  decision: BudgetDecision;
  reservationId: string | null;
  /** USD held for this call. Streaming stops forwarding once a running estimate reaches it. */
  reserveUsd: number;
};

export function evaluateBudget(db: Db, config: Config, project: string): BudgetDecision {
  const projectSpend = spendFor(db, project);
  const globalSpend = spendFor(db);
  const projectLimit = config.budgets.projects[project] ?? { softUsd: null, hardUsd: null };
  const globalLimit = config.budgets.global;

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
      message: hardMessage(triggeredBy, project, spend, limit),
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
      message: `Spendlight soft budget warning (${triggeredBy}): ${fmt(spend)} / ${fmt(limit)}.`,
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
  };
}

/**
 * Atomic hard-budget admission. Committed spend plus in-flight reservations is checked
 * inside BEGIN IMMEDIATE, then this call's hold is inserted before we talk to upstream.
 * Unbounded completions (no max_tokens) hold the entire remaining headroom so a second
 * concurrent call cannot pass the same check. Bounded calls hold their preflight estimate.
 */
export function admitMutating(db: Db, config: Config, project: string, preflight: Preflight | null): Admission {
  return withImmediate(db, () => {
    purgeStaleReservations(db);
    const committed = evaluateBudget(db, config, project);
    if (!committed.allowed) {
      return { allowed: false, decision: committed, reservationId: null, reserveUsd: 0 };
    }

    const snap = snapshot(db, config, project);
    if (snap.room != null && snap.room <= 0) {
      const spend = snap.triggeredBy === "project" ? snap.projectAdmission : snap.globalAdmission;
      const limit = snap.triggeredBy === "project" ? snap.projectLimit.hardUsd : snap.globalLimit.hardUsd;
      return {
        allowed: false,
        decision: hardDecision(project, snap, hardMessage(snap.triggeredBy ?? "global", project, spend, limit)),
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
      const message = `Spendlight hard budget exceeded (${triggeredBy} '${triggeredBy === "project" ? project : "global"}'): preflight ${fmt(estimate)} exceeds remaining ${fmt(room)} (${fmt(spend)} / ${fmt(limit)}). Kill-switch is on; further completions are rejected.`;
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

function snapshot(db: Db, config: Config, project: string): {
  projectAdmission: number;
  globalAdmission: number;
  projectLimit: BudgetLimit;
  globalLimit: BudgetLimit;
  room: number | null;
  triggeredBy: "project" | "global" | null;
} {
  const projectLimit = config.budgets.projects[project] ?? { softUsd: null, hardUsd: null };
  const globalLimit = config.budgets.global;
  const projectAdmission = spendFor(db, project) + reservedSpend(db, project);
  const globalAdmission = spendFor(db) + reservedSpend(db);
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
  return { projectAdmission, globalAdmission, projectLimit, globalLimit, room, triggeredBy };
}

function hardDecision(
  project: string,
  snap: {
    projectAdmission: number;
    globalAdmission: number;
    projectLimit: BudgetLimit;
    globalLimit: BudgetLimit;
    triggeredBy: "project" | "global" | null;
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
  };
}

function hardMessage(triggeredBy: "project" | "global", project: string, spend: number, limit: number | null): string {
  const label = triggeredBy === "project" ? project : "global";
  return `Spendlight hard budget exceeded (${triggeredBy} '${label}'): ${fmt(spend)} / ${fmt(limit)}. Kill-switch is on; further completions are rejected.`;
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

import type { BudgetDecision, BudgetLimit, Config } from "./types.js";
import { spendFor, type Db } from "./db.js";

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
      message: `Spendlight hard budget exceeded (${triggeredBy} '${triggeredBy === "project" ? project : "global"}'): ${fmt(spend)} / ${fmt(limit)}. Kill-switch is on; further completions are rejected.`,
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

import { spendWindow } from "./budget.js";
import { formatCivil, SkippedLocalTimeError, utcFromCivilTime, type CivilTime } from "./day.js";
import type { Config } from "./types.js";

/** Resolved export slice. Bounds are UTC instants; a null side is open. */
export type ExportRange = {
  sinceIso: string | null;
  untilIso: string | null;
  /** Filesystem-safe fragment for the CSV download name. */
  slug: string;
};

export type TimeRangeErrorBody = {
  error: {
    message: string;
    type: "invalid_request_error";
    param: "since" | "until" | "window" | null;
    code: "invalid_time_range";
  };
};

export type ParsedExportRange =
  | { ok: true; range: ExportRange | null }
  | { ok: false; error: TimeRangeErrorBody };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/i;

/**
 * `since` / `until` / `window` for an export or receipt.
 * Absent params leave the ledger unscoped in time. A bare date is midnight in the
 * budget timezone. The range is half-open: since inclusive, until exclusive.
 */
export function parseExportRange(url: URL, config: Config, now = new Date()): ParsedExportRange {
  const params = url.searchParams;
  const hasSince = params.has("since");
  const hasUntil = params.has("until");
  const hasWindow = params.has("window");
  if (!hasSince && !hasUntil && !hasWindow) return { ok: true, range: null };

  const zone = config.budgets.timezone;
  const since = hasSince ? parseBound(params.get("since") ?? "", "since", zone) : null;
  if (since && !since.ok) return since;
  const until = hasUntil ? parseBound(params.get("until") ?? "", "until", zone) : null;
  if (until && !until.ok) return until;

  let sinceIso = since?.ok ? since.iso : null;
  let untilIso = until?.ok ? until.iso : null;

  if (hasWindow) {
    const raw = (params.get("window") ?? "").trim();
    if (raw !== "current") {
      return fail("window", `Invalid window "${clip(raw)}". Expected "current".`);
    }
    if (hasSince || hasUntil) {
      return fail(
        "window",
        "window=current cannot be combined with since or until. Omit window to set the bounds yourself.",
      );
    }
    const budgetWindow = spendWindow(config, now);
    if (!budgetWindow) {
      return fail(
        "window",
        "window=current needs a day, week, or month budget period. This budget period is lifetime.",
      );
    }
    sinceIso = budgetWindow.startIso;
    untilIso = budgetWindow.endIso;
  }

  if (sinceIso && untilIso && sinceIso >= untilIso) {
    return fail(
      null,
      `Invalid time range. since (${sinceIso}) must be earlier than until (${untilIso}); the range is half-open (since inclusive, until exclusive).`,
    );
  }

  return { ok: true, range: { sinceIso, untilIso, slug: rangeSlug(sinceIso, untilIso, zone) } };
}

type BoundResult = { ok: true; iso: string } | { ok: false; error: TimeRangeErrorBody };

function parseBound(raw: string, param: "since" | "until", timeZone: string): BoundResult {
  const text = raw.trim();
  if (!text) {
    return fail(param, `Invalid ${param}. Use an ISO date (YYYY-MM-DD) or datetime.`);
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!validYmd(year, month, day)) {
      return fail(param, `Invalid ${param} "${clip(text)}". That calendar date does not exist.`);
    }
    return civil(param, timeZone, { year, month, day, hour: 0, minute: 0, second: 0 }, text);
  }

  const match = DATE_TIME.exec(text);
  if (!match) {
    return fail(
      param,
      `Invalid ${param} "${clip(text)}". Use an ISO date (YYYY-MM-DD) or datetime (YYYY-MM-DDTHH:mm:ss with Z, an offset, or no zone for ${timeZone}).`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] != null ? Number(match[6]) : 0;
  const millisecond = fractionMs(match[7]);
  if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return fail(param, `Invalid ${param} "${clip(text)}". That date or time does not exist.`);
  }
  const zone = match[8];
  if (zone) {
    const parsed = new Date(absoluteIso(year, month, day, hour, minute, second, millisecond, zone));
    if (Number.isNaN(parsed.getTime())) {
      return fail(param, `Invalid ${param} "${clip(text)}". That datetime could not be parsed.`);
    }
    return { ok: true, iso: parsed.toISOString() };
  }
  return civil(param, timeZone, { year, month, day, hour, minute, second, millisecond }, text);
}

function civil(param: "since" | "until", timeZone: string, parts: CivilTime, raw: string): BoundResult {
  try {
    return { ok: true, iso: utcFromCivilTime(timeZone, parts).toISOString() };
  } catch (err) {
    if (err instanceof SkippedLocalTimeError) {
      return fail(param, `Invalid ${param} "${clip(raw)}". That local time does not exist in ${timeZone}.`);
    }
    throw err;
  }
}

function absoluteIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  zone: string,
): string {
  const ymd = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
  const hms = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${String(millisecond).padStart(3, "0")}`;
  const suffix = zone.toUpperCase() === "Z" ? "Z" : normalizeOffset(zone);
  return `${ymd}T${hms}${suffix}`;
}

function normalizeOffset(zone: string): string {
  if (/^[+-]\d{4}$/.test(zone)) return `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return zone;
}

function fractionMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number((frac + "000").slice(0, 3));
}

function validYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function rangeSlug(sinceIso: string | null, untilIso: string | null, timeZone: string): string {
  const since = sinceIso ? slugBound(sinceIso, timeZone) : "";
  const until = untilIso ? slugBound(untilIso, timeZone) : "";
  if (since && until) return `${since}_${until}`;
  if (since) return `since-${since}`;
  if (until) return `until-${until}`;
  return "";
}

function slugBound(iso: string, timeZone: string): string {
  return formatCivil(timeZone, new Date(iso)).replace(" ", "T").replaceAll(":", "");
}

function fail(
  param: "since" | "until" | "window" | null,
  message: string,
): { ok: false; error: TimeRangeErrorBody } {
  return {
    ok: false,
    error: {
      error: {
        message,
        type: "invalid_request_error",
        param,
        code: "invalid_time_range",
      },
    },
  };
}

function clip(raw: string): string {
  const text = raw.replace(/[\r\n]+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

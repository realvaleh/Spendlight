/** Inclusive start and exclusive end of the calendar day containing `now`, as UTC instants. */
export function calendarDayBounds(timeZone: string, now: Date): { start: Date; end: Date } {
  const today = calendarDate(timeZone, now);
  const tomorrow = addCalendarDays(today, 1);
  return {
    start: zonedMidnightUtc(timeZone, today),
    end: zonedMidnightUtc(timeZone, tomorrow),
  };
}

/**
 * Inclusive start and exclusive end of the ISO week containing `now`, as UTC instants.
 * Weeks run Monday 00:00 through the next Monday 00:00 in `timeZone`.
 */
export function calendarWeekBounds(timeZone: string, now: Date): { start: Date; end: Date } {
  const today = calendarDate(timeZone, now);
  const monday = addCalendarDays(today, 1 - isoWeekday(today));
  return {
    start: zonedMidnightUtc(timeZone, monday),
    end: zonedMidnightUtc(timeZone, addCalendarDays(monday, 7)),
  };
}

/** Inclusive start and exclusive end of the calendar month containing `now`, as UTC instants. */
export function calendarMonthBounds(timeZone: string, now: Date): { start: Date; end: Date } {
  const today = calendarDate(timeZone, now);
  const first = { year: today.year, month: today.month, day: 1 };
  return {
    start: zonedMidnightUtc(timeZone, first),
    end: zonedMidnightUtc(timeZone, addCalendarMonths(first, 1)),
  };
}

export function assertIanaTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(
      `Invalid budget timezone "${timeZone}". Use an IANA name such as America/New_York.`,
    );
  }
}

type Ymd = { year: number; month: number; day: number };

function calendarDate(timeZone: string, now: Date): Ymd {
  const parts = zonedParts(timeZone, now);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** ISO weekday of a civil date: Monday = 1 … Sunday = 7. */
function isoWeekday(date: Ymd): number {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const sunday0 = utc.getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

function addCalendarDays(date: Ymd, days: number): Ymd {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** `YYYY-MM-DD` civil date of `date` in `timeZone`. A 23h or 25h local day is still one key. */
export function calendarDayKey(timeZone: string, date: Date): string {
  return formatYmd(zonedParts(timeZone, date));
}

/** Shift a `YYYY-MM-DD` key by whole calendar days. The step does not depend on DST length. */
export function shiftCalendarDay(day: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`Invalid calendar day "${day}".`);
  return formatYmd(
    addCalendarDays({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, delta),
  );
}

function formatYmd(date: Ymd): string {
  return `${String(date.year).padStart(4, "0")}-${pad2(date.month)}-${pad2(date.day)}`;
}

function addCalendarMonths(date: Ymd, months: number): Ymd {
  const utc = new Date(Date.UTC(date.year, date.month - 1 + months, date.day));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export type CivilTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
};

/** A civil time that falls in a DST spring-forward gap. */
export class SkippedLocalTimeError extends Error {
  constructor(readonly timeZone: string) {
    super(`That local time does not exist in ${timeZone}`);
    this.name = "SkippedLocalTimeError";
  }
}

/**
 * Civil time in `timeZone` as a UTC instant.
 * When the local clock repeats (DST overlap), the earlier offset is used.
 */
export function utcFromCivilTime(timeZone: string, civil: CivilTime): Date {
  const millisecond = civil.millisecond ?? 0;
  const utcGuess = new Date(
    Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second, millisecond),
  );
  const offset = zoneOffsetMs(timeZone, utcGuess);
  let instant = new Date(utcGuess.getTime() - offset);
  const corrected = zoneOffsetMs(timeZone, instant);
  if (corrected !== offset) instant = new Date(utcGuess.getTime() - corrected);
  const parts = zonedParts(timeZone, instant);
  if (
    parts.year !== civil.year ||
    parts.month !== civil.month ||
    parts.day !== civil.day ||
    parts.hour !== civil.hour ||
    parts.minute !== civil.minute ||
    parts.second !== civil.second
  ) {
    throw new SkippedLocalTimeError(timeZone);
  }
  return instant;
}

/**
 * `YYYY-MM-DD` when `date` is local midnight in `timeZone`.
 * Otherwise `YYYY-MM-DD HH:mm:ss`, with milliseconds when the instant has them.
 */
export function formatCivil(timeZone: string, date: Date): string {
  const parts = zonedParts(timeZone, date);
  const ymd = `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const ms = date.getUTCMilliseconds();
  if (parts.hour === 0 && parts.minute === 0 && parts.second === 0 && ms === 0) return ymd;
  const clock = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  return ms === 0 ? `${ymd} ${clock}` : `${ymd} ${clock}.${String(ms).padStart(3, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Local midnight as a UTC instant. The offset is taken at the candidate instant and
 * corrected once so a DST transition later that day does not shift midnight.
 */
function zonedMidnightUtc(timeZone: string, date: Ymd): Date {
  const utcGuess = new Date(Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0));
  const offset = zoneOffsetMs(timeZone, utcGuess);
  let instant = new Date(utcGuess.getTime() - offset);
  const corrected = zoneOffsetMs(timeZone, instant);
  if (corrected !== offset) instant = new Date(utcGuess.getTime() - corrected);
  return instant;
}

function zoneOffsetMs(timeZone: string, date: Date): number {
  const parts = zonedParts(timeZone, date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedParts(timeZone: string, date: Date): Ymd & { hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

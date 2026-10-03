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

function addCalendarMonths(date: Ymd, months: number): Ymd {
  const utc = new Date(Date.UTC(date.year, date.month - 1 + months, date.day));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
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

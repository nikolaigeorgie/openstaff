/** Pay periods are fixed-length blocks counted from an anchor date (YYYY-MM-DD). */
export interface Period {
  index: number;
  /** First day, inclusive (YYYY-MM-DD). */
  start: string;
  /** Last day, inclusive (YYYY-MM-DD). */
  end: string;
}

const DAY = 86_400_000;

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY);
}

export function periodFor(day: string, anchor: string, lengthDays = 14): Period {
  const index = Math.floor((toUtc(day) - toUtc(anchor)) / (lengthDays * DAY));
  return periodAt(index, anchor, lengthDays);
}

export function periodAt(index: number, anchor: string, lengthDays = 14): Period {
  const start = toUtc(anchor) + index * lengthDays * DAY;
  return { index, start: fromUtc(start), end: fromUtc(start + (lengthDays - 1) * DAY) };
}

/** The calendar day (YYYY-MM-DD) of a unix minute in a given IANA timezone. */
export function dayOfMinute(m: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(m * 60_000));
}

/** Unix-minute range [from, to) covering a calendar day in a timezone. */
export function minuteRangeOfDay(day: string, timeZone: string): [number, number] {
  return [startOfDayMinute(day, timeZone), startOfDayMinute(addDays(day, 1), timeZone)];
}

function startOfDayMinute(day: string, timeZone: string): number {
  // Start from UTC midnight and correct by the zone's offset at that moment (twice, for DST edges).
  let guess = toUtc(day);
  for (let i = 0; i < 2; i++) {
    guess = toUtc(day) - offsetMs(guess, timeZone);
  }
  return Math.round(guess / 60_000);
}

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

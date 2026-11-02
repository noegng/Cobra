/** Timezone helpers without a date library (Intl only). */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const get = (type: string) => Number(fmt.formatToParts(instant).find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DD" of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD HH:mm:ss" of `instant` in `timeZone`. */
export function localDateTime(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Offset (local - UTC) in ms of `timeZone` at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC instants [start, end) of local calendar day `date` ("YYYY-MM-DD") in `timeZone`. */
export function localDayRange(date: string, timeZone: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  const midnight = (y: number, mo: number, d: number) => {
    const guess = Date.UTC(y, mo - 1, d);
    let t = guess - offsetMs(new Date(guess), timeZone);
    t = guess - offsetMs(new Date(t), timeZone); // second pass for DST edges
    return new Date(t);
  };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return { start: midnight(y, mo, d), end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) };
}

export const TIMEZONE_BY_COUNTRY: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  BR: "America/Sao_Paulo",
  MX: "America/Mexico_City",
  CO: "America/Bogota",
  CL: "America/Santiago",
  PE: "America/Lima",
};

/**
 * Classifies eth_getLogs failures. Providers word "your range is too big" in many ways
 * (Alchemy, Infura, QuickNode, forno, drpc, …) and some just time out; both mean "ask for less".
 */
const RANGE_PATTERNS = [
  /block range/i,
  /range (is )?too (large|wide|big)/i,
  /exceed(s|ed)?\b.*\brange/i,
  /max(imum)? (block )?range/i,
  /too many (results|logs|blocks)/i,
  /(returned|return) more than \d+/i,
  /more than \d+ (results|logs)/i,
  /response (size|is too large)/i,
  /log response/i,
  /query timeout|timed? ?out|timeout/i,
];
const RATE_LIMIT = /rate.?limit|too many requests|429/i;

interface ErrLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  cause?: unknown;
}

function* chain(e: unknown): Generator<ErrLike> {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 10; depth++) {
    yield cur as ErrLike;
    cur = (cur as ErrLike).cause;
  }
}

function text(e: ErrLike): string {
  return [e.message, e.shortMessage, e.details].filter((s) => typeof s === "string").join(" | ");
}

/** True when shrinking the getLogs block range is the right reaction. */
export function isRangeError(e: unknown): boolean {
  for (const c of chain(e)) {
    const t = text(c);
    if (RATE_LIMIT.test(t) || c.status === 429) return false;
    if (c.name === "TimeoutError") return true;
    if (c.code === -32005) return true; // LimitExceeded (most providers: too many logs / range)
    if (c.status === 413 || c.status === 504) return true;
    if (RANGE_PATTERNS.some((re) => re.test(t))) return true;
  }
  return false;
}

export function errorMessage(e: unknown): string {
  for (const c of chain(e)) {
    if (typeof c.shortMessage === "string") return c.shortMessage;
    if (typeof c.message === "string") return c.message.split("\n")[0]!;
  }
  return String(e);
}

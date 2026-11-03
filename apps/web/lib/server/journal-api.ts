/** GET /api/agent/journal: public, rate-limited, cached a few seconds. Same privacy filter as the /proof page. */
import type { Db } from "@cobra/db";
import { clientIp, json } from "./http";
import { createMemoryRateLimiter, type RateLimiter } from "./rate-limit";
import { queryJournal, type Journal } from "./journal";

export const JOURNAL_CACHE_MS = 10_000;
const limiter = createMemoryRateLimiter({ journal: { limit: 30, windowMs: 60_000 } });
let cached: { at: number; key: string; body: Journal } | null = null;

export async function handleJournalGet(
  req: Request,
  deps: { db: Db; now?: () => number; rateLimiter?: RateLimiter; agentAddress?: string | null },
): Promise<Response> {
  const now = deps.now?.() ?? Date.now();
  const wait = (deps.rateLimiter ?? limiter).hit("journal", clientIp(req), now);
  if (wait > 0) return json({ error: "rate_limited" }, 429, { "retry-after": String(wait) });
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(raw) ? raw : 50;
  const key = String(limit);
  if (!cached || cached.key !== key || now - cached.at > JOURNAL_CACHE_MS) {
    cached = { at: now, key, body: await queryJournal(deps.db, { now: new Date(now), limit, agentAddress: deps.agentAddress }) };
  }
  return json(cached.body, 200, {
    "cache-control": "public, s-maxage=10, stale-while-revalidate=30",
    "access-control-allow-origin": "*",
  });
}

export function resetJournalCache(): void {
  cached = null;
}

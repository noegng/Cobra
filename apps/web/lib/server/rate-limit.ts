/**
 * Fixed-window, in-memory rate limiter keyed by `<bucket>:<ip>`.
 * On Vercel each warm instance has its own memory, so this is a per-instance limit — good enough to stop
 * a single phone/script hammering the solver/RPC; a shared store (Upstash/Postgres) can replace `RateLimiter`.
 */
export interface RateLimiter {
  /** Returns 0 if allowed, else the number of seconds to wait. */
  hit(bucket: string, key: string, now?: number): number;
}

export const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  quote: { limit: 20, windowMs: 60_000 },
  submit: { limit: 10, windowMs: 60_000 },
  // WS7-2: keyed by payer address / invoice id, on top of the per-IP buckets (a script rotating IPs is still bounded)
  quotePayer: { limit: 10, windowMs: 60_000 },
  quoteInvoice: { limit: 30, windowMs: 60_000 },
  submitPayer: { limit: 6, windowMs: 60_000 },
  submitInvoice: { limit: 10, windowMs: 60_000 },
  staticInvoice: { limit: 10, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
};

export function createMemoryRateLimiter(limits = RATE_LIMITS, maxKeys = 10_000): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(bucket, key, now = Date.now()) {
      const cfg = limits[bucket];
      if (!cfg) return 0;
      const k = `${bucket}:${key}`;
      const w = windows.get(k);
      if (!w || now - w.start >= cfg.windowMs) {
        if (windows.size >= maxKeys) windows.clear(); // crude memory bound
        windows.set(k, { start: now, count: 1 });
        return 0;
      }
      w.count += 1;
      if (w.count > cfg.limit) return Math.ceil((w.start + cfg.windowMs - now) / 1000);
      return 0;
    },
  };
}

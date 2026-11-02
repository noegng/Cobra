/**
 * USD reference rates used ONLY for risk caps (per-payment / per-day). Never used to compute amounts.
 * ReferenceRates = USD value of one whole unit of a currency (ARS -> 0.0006).
 */
import type { Currency, ReferenceRates } from "@cobra/shared";

export type RatesSource = ReferenceRates | (() => Promise<ReferenceRates>);

export async function resolveRates(src: RatesSource): Promise<ReferenceRates> {
  return typeof src === "function" ? src() : src;
}

/** Fixed-point scale for USD values (1e12) so caps are compared in integers. */
export const USD_SCALE = 10n ** 12n;

/** USD value of `amount` base units (decimals) at `rate` USD/unit, scaled by USD_SCALE. Throws if rate unknown. */
export function usdValueScaled(amount: bigint, decimals: number, currency: Currency, rates: ReferenceRates): bigint {
  const rate = currency === "USD" ? 1 : rates[currency];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) throw new Error(`missing_rate:${currency}`);
  // rate as an integer with 12 decimals (rates are floats by nature; caps are risk limits, not money movement)
  const rateScaled = BigInt(Math.round(rate * 1e12));
  return (amount * rateScaled) / 10n ** BigInt(decimals);
}

export function usdToScaled(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6)) * 10n ** 6n;
}

export function scaledToUsd(v: bigint): number {
  return Number(v / 10n ** 6n) / 1e6;
}

/**
 * HTTP rates (open.er-api.com, no key, daily) with a TTL cache and a last-good fallback.
 * `overrides` (e.g. from env REF_RATES='{"ARS":0.0006}') win over fetched values.
 */
export function createHttpRates(opts: {
  url?: string;
  ttlMs?: number;
  maxStaleMs?: number;
  overrides?: ReferenceRates;
  fetchFn?: typeof fetch;
} = {}): () => Promise<ReferenceRates> {
  const url = opts.url ?? "https://open.er-api.com/v6/latest/USD";
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const maxStale = opts.maxStaleMs ?? 24 * 3600_000;
  const f = opts.fetchFn ?? fetch;
  let cache: { at: number; rates: ReferenceRates } | null = null;
  return async () => {
    const now = Date.now();
    if (cache && now - cache.at < ttl) return { ...cache.rates, ...opts.overrides };
    try {
      const res = await f(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`rates http ${res.status}`);
      const body = (await res.json()) as { rates?: Record<string, number> };
      const rates: ReferenceRates = { USD: 1 };
      for (const [k, perUsd] of Object.entries(body.rates ?? {})) {
        if (typeof perUsd === "number" && perUsd > 0) (rates as Record<string, number>)[k] = 1 / perUsd;
      }
      cache = { at: now, rates };
    } catch (e) {
      if (!cache || now - cache.at > maxStale) {
        if (opts.overrides) return { USD: 1, ...opts.overrides };
        throw e;
      }
    }
    return { ...cache.rates, ...opts.overrides };
  };
}

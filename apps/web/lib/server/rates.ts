/**
 * Reference rates adapter (USD value of one unit of each currency) used by the solver's price guard
 * and the cost / savings display.
 *
 * Preference order:
 *  1. `fetchReferenceRates` exported by @cobra/solver (WS2), if it exists and returns a sane object;
 *  2. local fetcher over free no-key sources (docs/research/onchain-verification.md §10):
 *     ARS = DolarAPI "cripto" (the rate the wARS pool tracks), BRL = AwesomeAPI USD-BRL.
 * Fails CLOSED: a currency with no fresh rate is simply absent (the solver then refuses to route it).
 */
import * as solverModule from "@cobra/solver";
import type { ReferenceRates } from "@cobra/shared";

type Fetch = typeof fetch;

const CACHE_MS = 60_000;
let cache: { at: number; rates: ReferenceRates } | null = null;

function sane(r: unknown): r is ReferenceRates {
  if (!r || typeof r !== "object") return false;
  return Object.values(r as Record<string, unknown>).every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}

async function getJson(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Local fallback fetcher. Exported for tests. */
export async function fetchLocalReferenceRates(fetchImpl: Fetch = fetch, timeoutMs = 2500): Promise<ReferenceRates> {
  const rates: ReferenceRates = { USD: 1 };
  const [ars, brl] = await Promise.allSettled([
    getJson(fetchImpl, "https://dolarapi.com/v1/dolares/cripto", timeoutMs),
    getJson(fetchImpl, "https://economia.awesomeapi.com.br/json/last/USD-BRL", timeoutMs),
  ]);
  if (ars.status === "fulfilled") {
    const v = Number((ars.value as { venta?: unknown }).venta);
    if (Number.isFinite(v) && v > 0) rates.ARS = 1 / v;
  }
  if (brl.status === "fulfilled") {
    const v = Number((brl.value as { USDBRL?: { bid?: unknown } }).USDBRL?.bid);
    if (Number.isFinite(v) && v > 0) rates.BRL = 1 / v;
  }
  return rates;
}

export async function getReferenceRates(now = Date.now()): Promise<ReferenceRates> {
  if (cache && now - cache.at < CACHE_MS) return cache.rates;
  let rates: ReferenceRates | null = null;
  const fromSolver = (solverModule as Record<string, unknown>)["fetchReferenceRates"];
  if (typeof fromSolver === "function") {
    try {
      const r: unknown = await (fromSolver as () => Promise<unknown>)();
      if (sane(r)) rates = r;
    } catch {
      rates = null;
    }
  }
  rates ??= await fetchLocalReferenceRates();
  cache = { at: now, rates };
  return rates;
}

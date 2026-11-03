/**
 * Reference FX rates (USD value of one unit of each currency) from free, key-less APIs.
 *
 * ARS uses the "dólar cripto" rate (dolarapi.com /v1/dolares/cripto, fallback CriptoYa USDT/ARS):
 * the on-chain wARS/USDT pool tracks it (~1650 ARS/USD on 2026-11-02), NOT the official rate (~1535-1565).
 * Using the official rate would make the solver's price guard reject every wARS payment (~7.5% gap).
 * BRL uses the market rate (AwesomeAPI, fallback br.dolarapi.com, then open.er-api.com).
 * MXN, COP, CLP, PEN use market rates (open.er-api.com, fallback fawazahmed0 currency-api on jsDelivr). They have no
 * Celo pool, so they only feed the USD caps for same-token (direct wFIAT) payments, never a swap price guard.
 *
 * Each currency is resolved independently: a failing source falls through to the next; if every source fails
 * the currency is omitted (the solver then answers `price_guard` for invoices in that currency) unless a
 * previous value younger than `staleTtlMs` is cached. Values outside sanity bounds are rejected.
 */
import type { Currency, ReferenceRates } from "@cobra/shared";

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface FxOptions {
  fetch?: Fetch;
  now?: () => number;
  /** Per-request timeout, ms. Default 3000. */
  timeoutMs?: number;
  /** Fresh cache TTL, ms. Default 60_000. */
  cacheTtlMs?: number;
  /** Serve a cached value up to this age when every source fails, ms. Default 600_000. */
  staleTtlMs?: number;
  /** Currencies to resolve. Default: all six LatAm currencies. */
  currencies?: readonly FxCurrency[];
}

export type FxCurrency = "ARS" | "BRL" | "MXN" | "COP" | "CLP" | "PEN";

export const FX_CURRENCIES: readonly FxCurrency[] = ["ARS", "BRL", "MXN", "COP", "CLP", "PEN"];

/** Local currency units per USD accepted as sane. */
export const FX_BOUNDS: Record<FxCurrency, [number, number]> = {
  ARS: [300, 20_000],
  BRL: [2, 15],
  MXN: [8, 40],
  COP: [1_500, 8_000],
  CLP: [400, 2_000],
  PEN: [2, 8],
};

interface Source {
  name: string;
  url: string;
  /** Returns local currency units per 1 USD. */
  parse(body: unknown): number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return n;
};
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null) throw new Error("not an object");
  return v as Record<string, unknown>;
};
const mid = (a: unknown, b: unknown) => (num(a) + num(b)) / 2;

/** Key-less market-rate sources for currencies without a dedicated local API. */
function marketSources(cur: "MXN" | "COP" | "CLP" | "PEN"): Source[] {
  return [
    { name: "open-er-api", url: "https://open.er-api.com/v6/latest/USD", parse: (b) => num(obj(obj(b).rates)[cur]) },
    {
      name: "currency-api",
      url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      parse: (b) => num(obj(obj(b).usd)[cur.toLowerCase()]),
    },
  ];
}

export const FX_SOURCES: Record<FxCurrency, Source[]> = {
  ARS: [
    {
      name: "dolarapi-cripto",
      url: "https://dolarapi.com/v1/dolares/cripto",
      parse: (b) => mid(obj(b).compra, obj(b).venta),
    },
    {
      name: "criptoya-usdt-ars",
      url: "https://criptoya.com/api/usdt/ars/1",
      parse: (b) => {
        // Median of per-exchange mids (robust to one outlier venue).
        const mids = Object.values(obj(b))
          .map((x) => {
            try {
              const o = obj(x);
              return mid(o.totalAsk, o.totalBid);
            } catch {
              return NaN;
            }
          })
          .filter((x) => Number.isFinite(x) && x > 0)
          .sort((x, y) => x - y);
        if (mids.length === 0) throw new Error("no quotes");
        const h = Math.floor(mids.length / 2);
        return mids.length % 2 ? mids[h]! : (mids[h - 1]! + mids[h]!) / 2;
      },
    },
  ],
  BRL: [
    {
      name: "awesomeapi",
      url: "https://economia.awesomeapi.com.br/json/last/USD-BRL",
      parse: (b) => {
        const o = obj(obj(b).USDBRL);
        return mid(o.bid, o.ask);
      },
    },
    {
      name: "br-dolarapi",
      url: "https://br.dolarapi.com/v1/cotacoes/usd",
      parse: (b) => mid(obj(b).compra, obj(b).venda),
    },
    {
      name: "open-er-api",
      url: "https://open.er-api.com/v6/latest/USD",
      parse: (b) => num(obj(obj(b).rates).BRL),
    },
  ],
  MXN: marketSources("MXN"),
  COP: marketSources("COP"),
  CLP: marketSources("CLP"),
  PEN: marketSources("PEN"),
};

export interface ReferenceRateSource {
  (): Promise<ReferenceRates>;
  /** Drop cached values (tests). */
  clear(): void;
}

export function createReferenceRateSource(opts: FxOptions = {}): ReferenceRateSource {
  const doFetch: Fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const ttl = opts.cacheTtlMs ?? 60_000;
  const staleTtl = opts.staleTtlMs ?? 600_000;
  const currencies = opts.currencies ?? FX_CURRENCIES;
  const cache = new Map<FxCurrency, { usdPerUnit: number; at: number }>();
  let inflight: Promise<ReferenceRates> | null = null;

  const resolveOne = async (cur: FxCurrency): Promise<number | null> => {
    const [lo, hi] = FX_BOUNDS[cur];
    for (const src of FX_SOURCES[cur]) {
      try {
        const res = await doFetch(src.url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
        if (!res.ok) continue;
        const perUsd = src.parse(await res.json());
        if (!(perUsd >= lo && perUsd <= hi)) continue;
        return 1 / perUsd;
      } catch {
        // next source
      }
    }
    return null;
  };

  const run = async (): Promise<ReferenceRates> => {
    const t = now();
    const out: ReferenceRates = { USD: 1 };
    await Promise.all(
      currencies.map(async (cur) => {
        const c = cache.get(cur);
        if (c && t - c.at < ttl) {
          out[cur as Currency] = c.usdPerUnit;
          return;
        }
        const v = await resolveOne(cur);
        if (v !== null) {
          cache.set(cur, { usdPerUnit: v, at: t });
          out[cur as Currency] = v;
        } else if (c && t - c.at < staleTtl) {
          out[cur as Currency] = c.usdPerUnit;
        }
      }),
    );
    return out;
  };

  const fn = (() => {
    if (!inflight) inflight = run().finally(() => (inflight = null));
    return inflight;
  }) as ReferenceRateSource;
  fn.clear = () => cache.clear();
  return fn;
}

const defaultSource = createReferenceRateSource();

/** USD value of one unit of each LatAm currency (and USD = 1), cached 60 s. Never throws; missing currencies are omitted. */
export function fetchReferenceRates(): Promise<ReferenceRates> {
  return defaultSource();
}

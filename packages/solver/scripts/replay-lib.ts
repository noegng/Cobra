/**
 * Shared by scripts/replay-quotes.ts (records real QuoterV2 answers) and test/replay.test.ts (replays them).
 * Recording works because the solver is deterministic: the same input asks the same quotes.
 */
import type { Hex } from "viem";
import { tokenBySymbol, type QuoteSource, type ReferenceRates, type SolveResult, type SolverInput } from "@cobra/shared";

export const REPLAY_USD_AMOUNTS = [50, 500, 5000] as const;
/** Replay uses a high cap so 500/5000 USD invoices are routed (production default is 200). */
export const REPLAY_CAP_USD = 10_000;
export const REPLAY_NOW = 1_793_620_800_000; // 2026-11-02T12:00:00Z, fixed so results are reproducible

export type QuoteRecord = { ok: true; v: string } | { ok: false; err: string };

export interface ReplayScenario {
  name: string;
  tokenOut: "wARS" | "wBRL";
  usd: number;
  input: SolverInput;
}

export interface ReplayFixture {
  meta: { recordedAt: string; rpc: string; quoterV2: string; blockNumber: string };
  refRates: ReferenceRates;
  scenarios: ReplayScenario[];
  quotes: Record<string, QuoteRecord>;
  results: Record<string, SolveResult>;
}

/** JSON with bigint as "123n". */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x), 2);
export const fromJson = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (typeof x === "string" && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as T;

const qkey = (dir: "in" | "out", path: Hex, amount: bigint) => `${dir}:${path.toLowerCase()}:${amount}`;

export function recordingQuoter(inner: QuoteSource, store: Record<string, QuoteRecord>): QuoteSource {
  const rec = async (dir: "in" | "out", path: Hex, amount: bigint, f: () => Promise<bigint>) => {
    try {
      const v = await f();
      store[qkey(dir, path, amount)] = { ok: true, v: v.toString() };
      return v;
    } catch (e) {
      store[qkey(dir, path, amount)] = { ok: false, err: e instanceof Error ? e.message.slice(0, 120) : String(e) };
      throw e;
    }
  };
  return {
    quoteExactInput: async (path, amountIn) => ({
      amountOut: await rec("in", path, amountIn, async () => (await inner.quoteExactInput(path, amountIn)).amountOut),
    }),
    quoteExactOutput: async (path, amountOut) => ({
      amountIn: await rec("out", path, amountOut, async () => (await inner.quoteExactOutput(path, amountOut)).amountIn),
    }),
  };
}

export function fixtureQuoter(store: Record<string, QuoteRecord>): QuoteSource & { misses: string[] } {
  const misses: string[] = [];
  const get = (dir: "in" | "out", path: Hex, amount: bigint): bigint => {
    const k = qkey(dir, path, amount);
    const r = store[k];
    if (!r) {
      misses.push(k);
      throw new Error(`quote not recorded: ${k}`);
    }
    if (!r.ok) throw new Error(r.err);
    return BigInt(r.v);
  };
  return {
    misses,
    quoteExactInput: async (path, amountIn) => ({ amountOut: get("in", path, amountIn) }),
    quoteExactOutput: async (path, amountOut) => ({ amountIn: get("out", path, amountOut) }),
  };
}

const t = (s: string) => {
  const x = tokenBySymbol(s);
  if (!x) throw new Error(`token ${s} missing from registry`);
  return x;
};
/** `units` whole tokens worth `usd` USD at `usdPerUnit`, scaled by `mult`, as base units. */
const worth = (sym: string, usd: number, mult: number, refRates: ReferenceRates): bigint => {
  const info = t(sym);
  const rate = info.currency === "USD" ? 1 : refRates[info.currency]!;
  const whole = (usd * mult) / rate;
  return BigInt(Math.round(whole * 1e6)) * 10n ** BigInt(info.decimals) / 1_000_000n;
};

/** Payer portfolios per invoice size. Multipliers are relative to the invoice USD value. */
export function buildScenarios(refRates: ReferenceRates): ReplayScenario[] {
  const out: ReplayScenario[] = [];
  const portfolios: { name: string; holdings: [string, number][] }[] = [
    { name: "usdc_only", holdings: [["USDC", 2]] },
    { name: "usdt_only", holdings: [["USDT", 2]] },
    { name: "usdc_big_usdt_small", holdings: [["USDC", 3], ["USDT", 0.6]] },
    { name: "usat_big_usdt_enough", holdings: [["USAT", 3], ["USDT", 1.5]] },
    { name: "wfiat_usdt_usdc_split", holdings: [["@out", 0.2], ["USDT", 0.4], ["USDC", 0.6]] },
  ];
  for (const tokenOut of ["wARS", "wBRL"] as const) {
    const outInfo = t(tokenOut);
    for (const usd of REPLAY_USD_AMOUNTS) {
      const amountOut = worth(tokenOut, usd, 1, refRates);
      // Round the invoice to whole local units, like a merchant would.
      const whole = (amountOut / 10n ** BigInt(outInfo.decimals)) * 10n ** BigInt(outInfo.decimals);
      for (const p of portfolios) {
        out.push({
          name: `${tokenOut}-${usd}usd-${p.name}`,
          tokenOut,
          usd,
          input: {
            invoice: { tokenOut: outInfo.address, amountOut: whole, deadline: BigInt(Math.floor(REPLAY_NOW / 1000) + 900) },
            balances: p.holdings.map(([sym, mult]) => {
              const s = sym === "@out" ? tokenOut : sym;
              return { token: t(s).address, amount: worth(s, usd, mult, refRates) };
            }),
            refRates,
          },
        });
      }
    }
  }
  return out;
}

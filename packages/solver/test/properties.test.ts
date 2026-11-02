import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Address, Hex } from "viem";
import { decodePath, encodePath, type FeeTier, type SolverInput } from "@cobra/shared";
import { solve } from "../src/index";
import { PoolSimulator, poolFromPrice, type SimPool } from "../src/simulator";
import { costE2, e2ToBps, rateToE18, usdE18 } from "../src/math";
import { RATES, REGISTRY, T } from "./helpers";

const FEES: FeeTier[] = [100, 500, 3000, 10000];
const RATE = (t: Address) => rateToE18(t === T.ARS ? RATES.ARS! : 1);
const DEC = (t: Address) => (t === T.ARS ? 18 : 6);

const scenario = fc.record({
  invoiceCents: fc.integer({ min: 100, max: 19_900 }),
  bal: fc.record({
    USDC: fc.integer({ min: 0, max: 30_000 }), // cents
    USDT: fc.integer({ min: 0, max: 30_000 }),
    USDX: fc.integer({ min: 0, max: 30_000 }),
    ARS: fc.integer({ min: 0, max: 30_000 }),
  }),
  arsDepth: fc.integer({ min: 300, max: 2_000_000 }),
  arsPrice: fc.integer({ min: 1600, max: 1700 }),
  usdcDepth: fc.integer({ min: 300, max: 5_000_000 }),
  usdcPriceBps: fc.integer({ min: 9_700, max: 10_300 }),
  directUsdc: fc.option(fc.record({ depth: fc.integer({ min: 300, max: 500_000 }), fee: fc.constantFrom<FeeTier>(...FEES) }), { nil: undefined }),
  usdxDepth: fc.option(fc.integer({ min: 300, max: 500_000 }), { nil: undefined }),
  slippage: fc.integer({ min: 0, max: 200 }),
});

type Sc = typeof scenario extends fc.Arbitrary<infer X> ? X : never;

function build(s: Sc): { input: SolverInput; q: PoolSimulator } {
  const pools: SimPool[] = [
    poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: s.arsPrice, depthA: s.arsDepth }),
    poolFromPrice({ tokenA: T.USDC, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: s.usdcPriceBps / 10_000, depthA: s.usdcDepth }),
  ];
  if (s.directUsdc) pools.push(poolFromPrice({ tokenA: T.USDC, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: 1650, depthA: s.directUsdc.depth, fee: s.directUsdc.fee }));
  if (s.usdxDepth) pools.push(poolFromPrice({ tokenA: T.USDX, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: 1, depthA: s.usdxDepth, fee: 500 }));
  const cents = (c: number, dec: number) => (BigInt(c) * 10n ** BigInt(dec)) / 100n;
  const amountOut = cents(s.invoiceCents * 1650, 18);
  return {
    q: new PoolSimulator(pools),
    input: {
      invoice: { tokenOut: T.ARS, amountOut, deadline: 2_000_000_000n },
      balances: [
        { token: T.USDC, amount: cents(s.bal.USDC, 6) },
        { token: T.USDT, amount: cents(s.bal.USDT, 6) },
        { token: T.USDX, amount: cents(s.bal.USDX, 6) },
        { token: T.ARS, amount: cents(s.bal.ARS * 1650, 18) },
      ],
      refRates: RATES,
      prefs: { maxSlippageBps: s.slippage },
    },
  };
}

/** Brute force: cheapest feasible single leg over every path the solver is allowed to consider. */
async function bestSingleE2(input: SolverInput, q: PoolSimulator, guardBps: number | null): Promise<bigint | null> {
  const A = input.invoice.amountOut;
  const usdOut = usdE18(A, 18, RATE(T.ARS));
  const m = BigInt(input.prefs?.maxSlippageBps ?? 50);
  let best: bigint | null = null;
  for (const b of input.balances) {
    if (b.amount <= 0n) continue;
    if (b.token === T.ARS) {
      if (b.amount >= A) best = best === null || 0n < best ? 0n : best;
      continue;
    }
    const paths: Hex[] = FEES.map((f) => encodePath([b.token, T.ARS], [f]));
    if (b.token !== T.USDT) for (const f1 of FEES) for (const f2 of FEES) paths.push(encodePath([b.token, T.USDT, T.ARS], [f1, f2]));
    for (const p of paths) {
      let qin: bigint;
      try {
        qin = (await q.quoteExactOutput(p, A)).amountIn;
      } catch {
        continue;
      }
      if (qin + (qin * m + 9_999n) / 10_000n > b.amount) continue;
      const c = costE2(usdE18(qin, DEC(b.token), RATE(b.token)), usdOut);
      if (guardBps !== null && (c < 0n ? -c : c) > BigInt(guardBps) * 100n) continue;
      if (best === null || c < best) best = c;
    }
  }
  return best;
}

const opts = (q: PoolSimulator, guard: number) => ({ quoter: q, registry: REGISTRY, now: () => 0, maxPriceDeviationBps: guard });

describe("solver properties (fast-check)", () => {
  it("chosen plan never costs more than the best feasible single leg; legs within balances; output covered", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { input, q } = build(s);
        const r = await solve(input, opts(q, 10_000));
        const single = await bestSingleE2(input, q, 10_000);
        if (single !== null) expect(r.ok).toBe(true);
        if (!r.ok) return;
        const p = r.plan;
        expect(p.legs.length).toBeGreaterThanOrEqual(1);
        expect(p.legs.length).toBeLessThanOrEqual(3);
        expect(new Set(p.legs.map((l) => l.token)).size).toBe(p.legs.length);
        expect(p.legs.reduce((acc, l) => acc + l.quotedOut, 0n)).toBeGreaterThanOrEqual(input.invoice.amountOut);
        expect(p.minOut).toBe(input.invoice.amountOut);
        for (const l of p.legs) {
          const bal = input.balances.find((b) => b.token === l.token)!.amount;
          expect(l.amountIn).toBeLessThanOrEqual(bal);
          expect(l.amountIn).toBeGreaterThan(0n);
          if (l.token === T.ARS) expect(l.path).toBe("0x");
          else {
            const { tokens } = decodePath(l.path);
            expect(tokens[0]).toBe(l.token);
            expect(tokens[tokens.length - 1]).toBe(T.ARS);
          }
        }
        if (single !== null) expect(p.costBps).toBeLessThanOrEqual(e2ToBps(single));
        if (p.naiveCostBps !== null) expect(p.savingsBps).toBeCloseTo(p.naiveCostBps - p.costBps, 6);
      }),
      { numRuns: 150, seed: 20261102 },
    );
  });

  it("every executed leg respects the price guard, and a feasible guarded single implies ok", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.integer({ min: 5, max: 300 }), async (s, guard) => {
        const { input, q } = build(s);
        const r = await solve(input, opts(q, guard));
        const single = await bestSingleE2(input, q, guard);
        if (single !== null) expect(r.ok).toBe(true);
        if (!r.ok) {
          expect(["insufficient_balance", "no_route", "price_guard"]).toContain(r.reason);
          return;
        }
        expect(Math.abs(r.plan.costBps)).toBeLessThanOrEqual(guard);
        if (single !== null) expect(r.plan.costBps).toBeLessThanOrEqual(e2ToBps(single));
      }),
      { numRuns: 100, seed: 7 },
    );
  });

  it("is deterministic: same input twice -> deep-equal result", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { input, q } = build(s);
        const a = await solve(input, opts(q, 200));
        const b = await solve(input, opts(build(s).q, 200)); // fresh simulator, same pools
        expect(b).toEqual(a);
      }),
      { numRuns: 50, seed: 3 },
    );
  });
});

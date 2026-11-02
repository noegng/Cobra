import { describe, expect, it } from "vitest";
import { PullKind, decodePath, encodePath, type PaymentPlan, type SolveResult } from "@cobra/shared";
import { solve, QUOTE_TTL_MS } from "../src/index";
import { PoolSimulator, poolFromPrice } from "../src/simulator";
import { RATES, REGISTRY, T, ars, baseOpts, brl, invoiceArs, mainnetLikePools, sim, usd } from "./helpers";

function plan(r: SolveResult): PaymentPlan {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`);
  return r.plan;
}

describe("solve: single leg", () => {
  it("same token: zero cost, empty path, amountIn == amountOut", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.ARS, amount: ars("100000") }], refRates: RATES },
      baseOpts(),
    );
    const p = plan(r);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]).toMatchObject({ token: T.ARS, path: "0x", amountIn: ars("82500"), quotedOut: ars("82500") });
    expect(p.costBps).toBe(0);
    expect(p.minOut).toBe(ars("82500"));
    // wARS is PERMIT2-first but the payer has no Permit2 allowance -> ALLOWANCE.
    expect(p.legs[0]!.kind).toBe(PullKind.ALLOWANCE);
  });

  it("uses PERMIT2 when the payer is permit2Ready for that token", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.ARS, amount: ars("100000") }], refRates: RATES },
      { ...baseOpts(), permit2Ready: [T.ARS] },
    );
    expect(plan(r).legs[0]!.kind).toBe(PullKind.PERMIT2);
  });

  it("single swap USDT -> wARS: direct 0.01% path, amountIn = exact-output quote + 50 bps margin", async () => {
    const q = sim();
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.USDT, amount: usd("1000") }], refRates: RATES },
      baseOpts(q),
    );
    const p = plan(r);
    expect(p.legs).toHaveLength(1);
    const leg = p.legs[0]!;
    expect(leg.path).toBe(encodePath([T.USDT, T.ARS], [100]));
    expect(leg.kind).toBe(PullKind.EIP3009);
    expect(leg.quotedOut).toBe(ars("82500"));
    const { amountIn } = await q.quoteExactOutput(leg.path, ars("82500"));
    expect(leg.amountIn).toBe(amountIn + (amountIn * 50n + 9_999n) / 10_000n);
    // 1 bp fee + ~0.3 bp impact.
    expect(p.costBps).toBeGreaterThan(0);
    expect(p.costBps).toBeLessThan(3);
  });

  it("decimals normalisation: 6-dec USDC two-hop into 18-dec wARS costs a few bps, not orders of magnitude", async () => {
    const r = await solve(
      { invoice: invoiceArs("165000"), balances: [{ token: T.USDC, amount: usd("1000") }], refRates: RATES },
      baseOpts(),
    );
    const p = plan(r);
    const { tokens, fees } = decodePath(p.legs[0]!.path);
    expect(tokens).toEqual([T.USDC, T.USDT, T.ARS]);
    expect(fees).toEqual([100, 100]);
    // $100 out; amountIn ≈ 100.0x USDC (6 decimals).
    expect(p.legs[0]!.amountIn).toBeGreaterThan(usd("100"));
    expect(p.legs[0]!.amountIn).toBeLessThan(usd("100.8"));
    expect(p.costBps).toBeGreaterThan(1);
    expect(p.costBps).toBeLessThan(5);
  });

  it("slippage pref is honoured", async () => {
    const r0 = plan(
      await solve(
        { invoice: invoiceArs("82500"), balances: [{ token: T.USDT, amount: usd("1000") }], refRates: RATES, prefs: { maxSlippageBps: 0 } },
        baseOpts(),
      ),
    );
    const r100 = plan(
      await solve(
        { invoice: invoiceArs("82500"), balances: [{ token: T.USDT, amount: usd("1000") }], refRates: RATES, prefs: { maxSlippageBps: 100 } },
        baseOpts(),
      ),
    );
    const base = r0.legs[0]!.amountIn;
    expect(r100.legs[0]!.amountIn).toBe(base + (base * 100n + 9_999n) / 10_000n);
    expect(r0.costBps).toBe(r100.costBps); // margin is not a cost (surplus is refunded)
  });

  it("prefers the cheaper asset and reports savings vs the naive (largest balance) route", async () => {
    // USDC is the largest balance but priced 1% rich vs USDT in its pool -> naive pays ~1% more.
    const q = sim(mainnetLikePools({ usdcPrice: 0.99 }));
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.USDC, amount: usd("500") },
          { token: T.USDT, amount: usd("60") },
        ],
        refRates: RATES,
      },
      baseOpts(q),
    );
    const p = plan(r);
    expect(p.legs.map((l) => l.token)).toEqual([T.USDT]);
    expect(p.naiveCostBps).not.toBeNull();
    expect(p.naiveCostBps!).toBeGreaterThan(p.costBps + 90);
    expect(p.savingsBps).toBeCloseTo(p.naiveCostBps! - p.costBps, 2);
  });
});

describe("solve: balances and preferences", () => {
  it("insufficient balance -> ripio fallback when payer holds no tokenOut", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.USDT, amount: usd("10") }], refRates: RATES },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", fallback: "ripio" });
  });

  it("insufficient balance -> direct_wfiat fallback when payer holds some tokenOut", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.ARS, amount: ars("1000") },
          { token: T.USDT, amount: usd("10") },
        ],
        refRates: RATES,
      },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", fallback: "direct_wfiat" });
  });

  it("empty balances -> insufficient_balance", async () => {
    const r = await solve({ invoice: invoiceArs("82500"), balances: [], refRates: RATES }, baseOpts());
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", fallback: "ripio" });
  });

  it("excluded tokens are never used", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.USDT, amount: usd("1000") },
          { token: T.USDC, amount: usd("1000") },
        ],
        refRates: RATES,
        prefs: { excludeTokens: [T.USDT.toLowerCase() as `0x${string}`] },
      },
      baseOpts(),
    );
    const p = plan(r);
    expect(p.legs.map((l) => l.token)).toEqual([T.USDC]);
    expect(decodePath(p.legs[0]!.path).tokens).toEqual([T.USDC, T.USDT, T.ARS]);
  });

  it("excluding every usable token -> insufficient_balance", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [{ token: T.USDT, amount: usd("1000") }],
        refRates: RATES,
        prefs: { excludeTokens: [T.USDT] },
      },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance" });
  });

  it("combines legs when no single asset suffices, bounded by balances", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("165000"), // $100
        balances: [
          { token: T.ARS, amount: ars("50000") }, // ~$30
          { token: T.USDT, amount: usd("40") },
          { token: T.USDC, amount: usd("40") },
        ],
        refRates: RATES,
      },
      baseOpts(),
    );
    const p = plan(r);
    expect(p.legs).toHaveLength(3);
    const byToken = new Map(p.legs.map((l) => [l.token, l]));
    expect(byToken.get(T.ARS)!.amountIn).toBeLessThanOrEqual(ars("50000"));
    expect(byToken.get(T.USDT)!.amountIn).toBeLessThanOrEqual(usd("40"));
    expect(byToken.get(T.USDC)!.amountIn).toBeLessThanOrEqual(usd("40"));
    expect(p.legs.reduce((s, l) => s + l.quotedOut, 0n)).toBeGreaterThanOrEqual(ars("165000"));
    // The free wARS balance is used in full before paying swap fees.
    expect(byToken.get(T.ARS)!.amountIn).toBe(ars("50000"));
  });

  it("never more than 3 legs: 4 assets of 30% each cannot pay", async () => {
    const q = new PoolSimulator([
      ...mainnetLikePools(),
      poolFromPrice({ tokenA: T.USDX, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: 1, depthA: 100_000 }),
    ]);
    const r = await solve(
      {
        invoice: invoiceArs("165000"),
        balances: [
          { token: T.ARS, amount: ars("49500") },
          { token: T.USDT, amount: usd("30") },
          { token: T.USDC, amount: usd("30") },
          { token: T.USDX, amount: usd("30") },
        ],
        refRates: RATES,
      },
      baseOpts(q),
    );
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", fallback: "direct_wfiat" });
  });

  it("split is chosen when it is cheaper than any single leg (shallow pools)", async () => {
    // Two shallow direct pools into wARS: one leg of $150 moves the price a lot, two legs of $75 much less.
    const shallow = (t: `0x${string}`) =>
      poolFromPrice({ tokenA: t, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: 1650, depthA: 2_000, fee: 100 });
    const q = new PoolSimulator([shallow(T.USDT), shallow(T.USDC)]);
    const input = {
      invoice: invoiceArs("247500"), // $150
      balances: [
        { token: T.USDT, amount: usd("1000") },
        { token: T.USDC, amount: usd("1000") },
      ],
      refRates: RATES,
    };
    const p = plan(await solve(input, { ...baseOpts(q), maxPriceDeviationBps: 2_000 }));
    const singles = await Promise.all(
      [T.USDT, T.USDC].map((t) =>
        solve({ ...input, prefs: { excludeTokens: [t === T.USDT ? T.USDC : T.USDT] } }, { ...baseOpts(q), maxPriceDeviationBps: 2_000 }),
      ),
    );
    const bestSingle = Math.min(...singles.map((s) => plan(s).costBps));
    expect(p.legs).toHaveLength(2);
    expect(p.costBps).toBeLessThan(bestSingle - 5);
  });

  it("leg penalty keeps a single leg when splitting saves less than the penalty", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.USDT, amount: usd("1000") },
          { token: T.USDC, amount: usd("1000") },
        ],
        refRates: RATES,
      },
      baseOpts(),
    );
    expect(plan(r).legs).toHaveLength(1);
  });

  it("maxLegs option is respected", async () => {
    const r = await solve(
      {
        invoice: invoiceArs("165000"),
        balances: [
          { token: T.ARS, amount: ars("50000") },
          { token: T.USDT, amount: usd("40") },
          { token: T.USDC, amount: usd("40") },
        ],
        refRates: RATES,
      },
      { ...baseOpts(), maxLegs: 2 },
    );
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance" });
  });

  it("depth-bounded: a pool that cannot deliver the whole invoice is topped up by another asset", async () => {
    const q = new PoolSimulator([
      // USDT pool can deliver at most 90% of 200k wARS.
      poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: 1650, depthA: 100, fee: 100 }),
    ]);
    const r = await solve(
      {
        invoice: invoiceArs("247500"), // $150, > pool depth (~165k wARS)
        balances: [
          { token: T.USDT, amount: usd("10000") },
          { token: T.ARS, amount: ars("200000") },
        ],
        refRates: RATES,
      },
      { ...baseOpts(q), maxPriceDeviationBps: 10_000 },
    );
    const p = plan(r);
    expect(p.legs.reduce((s, l) => s + l.quotedOut, 0n)).toBeGreaterThanOrEqual(ars("247500"));
  });
});

describe("solve: guards and fallbacks", () => {
  it("price_guard when the pool is >2% away from the reference rate", async () => {
    const q = sim(mainnetLikePools().map((p) => (p.tokenB === T.ARS ? poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: 1550, depthA: 100_000 }) : p)));
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.USDT, amount: usd("1000") }], refRates: RATES },
      baseOpts(q),
    );
    expect(r).toMatchObject({ ok: false, reason: "price_guard", fallback: "ripio" });
  });

  it("price guard also rejects a pool that is suspiciously CHEAP (manipulation / wrong reference)", async () => {
    // Official ARS rate (1535) as reference vs. pool at the crypto dollar (1650): payer would "gain" 7% -> refuse.
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [{ token: T.USDT, amount: usd("1000") }],
        refRates: { ...RATES, ARS: 1 / 1535 },
      },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "price_guard" });
  });

  it("price guard skips only the bad asset when another one is fine", async () => {
    const q = new PoolSimulator([
      ...mainnetLikePools().filter((p) => p.tokenA !== T.USDC),
      poolFromPrice({ tokenA: T.USDC, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: 0.9, depthA: 100_000 }),
    ]);
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.USDC, amount: usd("1000") },
          { token: T.USDT, amount: usd("60") },
        ],
        refRates: RATES,
      },
      baseOpts(q),
    );
    const p = plan(r);
    expect(p.legs.map((l) => l.token)).toEqual([T.USDT]);
    // Naive (largest balance = USDC) is reported even though it breaches the guard.
    expect(p.naiveCostBps!).toBeGreaterThan(1000);
  });

  it("wBRL: default per-currency guard (350 bps) accepts the ~2.2% premium; stricter override refuses it", async () => {
    // Pool sells wBRL at 5.28/USD while the market reference is 5.40 (-2.2%).
    const q = sim(mainnetLikePools({ brlPrice: 5.28 }));
    const input = {
      invoice: { tokenOut: T.BRL, amountOut: brl("270"), deadline: 2_000_000_000n },
      balances: [{ token: T.USDT, amount: usd("100") }],
      refRates: RATES,
    };
    const ok = plan(await solve(input, baseOpts(q)));
    expect(ok.costBps).toBeGreaterThan(200);
    expect(ok.costBps).toBeLessThan(350);
    const strict = await solve(input, { ...baseOpts(q), maxPriceDeviationBpsByCurrency: { BRL: 200 } });
    expect(strict).toMatchObject({ ok: false, reason: "price_guard" });
    // An explicit global guard also overrides the BRL default.
    const strictGlobal = await solve(input, { ...baseOpts(q), maxPriceDeviationBps: 200 });
    expect(strictGlobal).toMatchObject({ ok: false, reason: "price_guard" });
  });

  it("over_cap above capUsd (default 200)", async () => {
    const r = await solve(
      { invoice: invoiceArs("335000"), balances: [{ token: T.ARS, amount: ars("1000000") }], refRates: RATES },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "over_cap", fallback: "direct_wfiat" });
    const r2 = await solve(
      { invoice: invoiceArs("335000"), balances: [{ token: T.ARS, amount: ars("1000000") }], refRates: RATES },
      { ...baseOpts(), capUsd: 500 },
    );
    expect(r2.ok).toBe(true);
  });

  it("no_route when no pool path exists", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.USDX, amount: usd("1000") }], refRates: RATES },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "no_route", fallback: "ripio" });
  });

  it("no_route when the quoter is down (failing quotes = no route), never throws", async () => {
    const down = {
      quoteExactInput: async () => Promise.reject(new Error("rpc down")),
      quoteExactOutput: async () => Promise.reject(new Error("rpc down")),
    };
    const r = await solve(
      {
        invoice: invoiceArs("82500"),
        balances: [
          { token: T.USDT, amount: usd("1000") },
          { token: T.ARS, amount: ars("10") },
        ],
        refRates: RATES,
      },
      baseOpts(down),
    );
    // The tiny wARS balance is "routable" (no swap) but insufficient; USDT has no route.
    expect(r).toMatchObject({ ok: false, reason: "insufficient_balance", fallback: "direct_wfiat" });
  });

  it("missing reference rate for tokenOut -> price_guard", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.ARS, amount: ars("100000") }], refRates: { USD: 1 } },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "price_guard" });
  });

  it("unknown or unverified tokenOut -> no_route; unverified held tokens are ignored", async () => {
    const r = await solve(
      { invoice: { tokenOut: T.MXN, amountOut: ars("100"), deadline: 0n }, balances: [{ token: T.MXN, amount: ars("1000") }], refRates: RATES },
      baseOpts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "no_route" });
    const r2 = await solve(
      { invoice: invoiceArs("1000"), balances: [{ token: T.MXN, amount: ars("1000000") }], refRates: RATES },
      baseOpts(),
    );
    expect(r2).toMatchObject({ ok: false, reason: "insufficient_balance" });
  });

  it("invalid input throws (programming error, not a business outcome)", async () => {
    await expect(
      solve({ invoice: invoiceArs("0"), balances: [], refRates: RATES }, baseOpts()),
    ).rejects.toThrow(RangeError);
    await expect(
      solve({ invoice: invoiceArs("1"), balances: [], refRates: RATES, prefs: { maxSlippageBps: -1 } }, baseOpts()),
    ).rejects.toThrow(RangeError);
  });
});

describe("solve: time and determinism", () => {
  it("quotedAt / expiresAt come from the injected clock (TTL 60 s)", async () => {
    const r = await solve(
      { invoice: invoiceArs("82500"), balances: [{ token: T.ARS, amount: ars("100000") }], refRates: RATES },
      { ...baseOpts(), now: () => 42_000 },
    );
    const p = plan(r);
    expect(p.quotedAt).toBe(42_000);
    expect(p.expiresAt).toBe(42_000 + QUOTE_TTL_MS);
    expect(QUOTE_TTL_MS).toBe(60_000);
  });

  it("same input -> identical output (also with shuffled balances and different case)", async () => {
    const balances = [
      { token: T.ARS, amount: ars("50000") },
      { token: T.USDT, amount: usd("40") },
      { token: T.USDC, amount: usd("40") },
    ];
    const input = { invoice: invoiceArs("165000"), balances, refRates: RATES };
    const a = await solve(input, baseOpts());
    const b = await solve(input, baseOpts());
    const c = await solve(
      { ...input, balances: [...balances].reverse().map((x) => ({ ...x, token: x.token.toLowerCase() as `0x${string}` })) },
      baseOpts(),
    );
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("uses the injected registry (fake tokens) and the default registry otherwise", async () => {
    expect(REGISTRY.some((t) => t.symbol === "USDX")).toBe(true);
    // Fake token is unknown to the default registry -> no_route.
    const r = await solve(
      { invoice: invoiceArs("1"), balances: [], refRates: RATES },
      { quoter: sim(), now: () => 0 },
    );
    expect(r).toMatchObject({ ok: false, reason: "no_route" });
  });
});

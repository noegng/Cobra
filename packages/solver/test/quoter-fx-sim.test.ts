import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { encodePath, reversePath } from "@cobra/shared";
import { createUniswapQuoter, QuoteFailedError, quoterV2Abi } from "../src/index";
import { createReferenceRateSource } from "../src/fx";
import { PoolSimulator, poolFromPrice, QuoteError } from "../src/simulator";
import { T } from "./helpers";

const QUOTER = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8" as const;

describe("createUniswapQuoter", () => {
  function fakeClient(impl: (args: { functionName: string; args: readonly unknown[] }) => unknown) {
    const calls: { address: string; functionName: string; args: readonly unknown[]; abi: unknown }[] = [];
    const client = {
      readContract: async (a: { address: string; functionName: string; args: readonly unknown[]; abi: unknown }) => {
        calls.push(a);
        return impl(a);
      },
    } as unknown as PublicClient;
    return { client, calls };
  }

  it("exact input: passes the swap-direction path unchanged", async () => {
    const { client, calls } = fakeClient(() => [123n, [], [], 0n]);
    const path = encodePath([T.USDC, T.USDT, T.ARS], [100, 100]);
    const r = await createUniswapQuoter(client, QUOTER).quoteExactInput(path, 10n);
    expect(r).toEqual({ amountOut: 123n });
    expect(calls[0]).toMatchObject({ address: QUOTER, functionName: "quoteExactInput", args: [path, 10n] });
    expect(calls[0]!.abi).toBe(quoterV2Abi);
  });

  it("exact output: REVERSES the path (QuoterV2 expects tokenOut first)", async () => {
    const { client, calls } = fakeClient(() => [456n, [], [], 0n]);
    const path = encodePath([T.USDC, T.USDT, T.ARS], [100, 500]);
    const r = await createUniswapQuoter(client, QUOTER).quoteExactOutput(path, 99n);
    expect(r).toEqual({ amountIn: 456n });
    expect(calls[0]!.args).toEqual([reversePath(path), 99n]);
    expect(calls[0]!.args[0]).toBe(encodePath([T.ARS, T.USDT, T.USDC], [500, 100]));
  });

  it("wraps reverts / RPC errors in QuoteFailedError and rejects zero amounts without calling", async () => {
    const { client, calls } = fakeClient(() => {
      throw new Error("execution reverted");
    });
    const q = createUniswapQuoter(client, QUOTER);
    const path = encodePath([T.USDT, T.ARS], [100]);
    await expect(q.quoteExactOutput(path, 1n)).rejects.toBeInstanceOf(QuoteFailedError);
    await expect(q.quoteExactInput(path, 0n)).rejects.toBeInstanceOf(QuoteFailedError);
    expect(calls).toHaveLength(1);
  });
});

describe("PoolSimulator", () => {
  const sim = new PoolSimulator([
    poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: 1650, depthA: 10_000, fee: 100 }),
    poolFromPrice({ tokenA: T.USDC, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: 1, depthA: 10_000, fee: 500 }),
  ]);
  const direct = encodePath([T.USDT, T.ARS], [100]);
  const twoHop = encodePath([T.USDC, T.USDT, T.ARS], [500, 100]);

  it("prices around the configured rate with fee + impact", async () => {
    const { amountOut } = await sim.quoteExactInput(direct, 1_000_000n); // 1 USDT
    expect(Number(amountOut / 10n ** 15n) / 1000).toBeCloseTo(1650 * 0.9999, 0);
  });

  it("exact output is consistent with exact input (rounding in the pool's favour)", async () => {
    for (const path of [direct, twoHop]) {
      for (const out of [10n ** 18n, 1650n * 10n ** 18n, 500_000n * 10n ** 18n]) {
        const { amountIn } = await sim.quoteExactOutput(path, out);
        const { amountOut } = await sim.quoteExactInput(path, amountIn);
        expect(amountOut).toBeGreaterThanOrEqual(out);
        const { amountOut: less } = await sim.quoteExactInput(path, amountIn - 2n);
        expect(less).toBeLessThanOrEqual(out);
      }
    }
  });

  it("fails on missing pools, zero amounts and depth exhaustion", async () => {
    await expect(sim.quoteExactOutput(encodePath([T.USDC, T.ARS], [100]), 1n)).rejects.toBeInstanceOf(QuoteError);
    await expect(sim.quoteExactOutput(direct, 0n)).rejects.toBeInstanceOf(QuoteError);
    // Pool holds 16.5M wARS; maxOutBps 90% -> 15M wARS cannot be bought.
    await expect(sim.quoteExactOutput(direct, 15_000_000n * 10n ** 18n)).rejects.toThrow("insufficient liquidity");
  });
});

describe("fetchReferenceRates (createReferenceRateSource)", () => {
  type Handler = (url: string) => unknown;
  function fakeFetch(handler: Handler) {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const body = handler(url);
      if (body instanceof Error) throw body;
      if (body === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    };
    return { f, urls };
  }
  const good: Handler = (url) => {
    if (url.includes("dolarapi.com/v1/dolares/cripto")) return { compra: 1650, venta: 1660 };
    if (url.includes("awesomeapi")) return { USDBRL: { bid: "5.43", ask: "5.44" } };
    return undefined;
  };

  it("ARS from the dólar cripto mid, BRL from AwesomeAPI mid, USD = 1", async () => {
    const { f } = fakeFetch(good);
    const r = await createReferenceRateSource({ fetch: f, now: () => 0 })();
    expect(r.USD).toBe(1);
    expect(r.ARS).toBeCloseTo(1 / 1655, 12);
    expect(r.BRL).toBeCloseTo(1 / 5.435, 12);
  });

  it("caches 60 s, then refetches", async () => {
    let t = 0;
    const { f, urls } = fakeFetch(good);
    const src = createReferenceRateSource({ fetch: f, now: () => t, currencies: ["ARS", "BRL"] });
    await src();
    t = 59_000;
    await src();
    expect(urls).toHaveLength(2);
    t = 61_000;
    await src();
    expect(urls).toHaveLength(4);
  });

  it("resolves MXN, COP, CLP, PEN from market sources (same-token payments need them for the USD cap)", async () => {
    const { f } = fakeFetch((url) => {
      if (url.includes("open.er-api.com")) return { rates: { MXN: 18.6, COP: 3200, CLP: 99_999, PEN: 3.46 } }; // CLP insane
      if (url.includes("currency-api")) return { usd: { clp: 980 } };
      throw new Error("unexpected " + url);
    });
    const r = await createReferenceRateSource({ fetch: f, currencies: ["MXN", "COP", "CLP", "PEN"] })();
    expect(r.MXN).toBeCloseTo(1 / 18.6, 9);
    expect(r.COP).toBeCloseTo(1 / 3200, 12);
    expect(r.CLP).toBeCloseTo(1 / 980, 12); // out-of-bounds value rejected, fallback used
    expect(r.PEN).toBeCloseTo(1 / 3.46, 9);
  });

  it("falls back to the next source on error / out-of-bounds values", async () => {
    const { f, urls } = fakeFetch((url) => {
      if (url.includes("dolarapi.com/v1/dolares/cripto")) return { compra: 1.65, venta: 1.66 }; // insane -> rejected
      if (url.includes("criptoya")) return { ripio: { totalAsk: 1670, totalBid: 1620 }, binancep2p: { totalAsk: 1651, totalBid: 1645 }, bad: {} };
      if (url.includes("awesomeapi")) return new Error("timeout");
      if (url.includes("br.dolarapi")) return { compra: 5.43, venda: 5.45 };
      return undefined;
    });
    const r = await createReferenceRateSource({ fetch: f, now: () => 0 })();
    expect(r.ARS).toBeCloseTo(1 / ((1645 + 1648 + 1645 + 1648) / 4), 4); // median of mids 1645, 1648
    expect(r.BRL).toBeCloseTo(1 / 5.44, 12);
    expect(urls.some((u) => u.includes("criptoya"))).toBe(true);
  });

  it("omits a currency when every source fails, serves a stale value up to staleTtlMs", async () => {
    let t = 0;
    let up = true;
    const { f } = fakeFetch((url) => (up ? good(url) : new Error("down")));
    const src = createReferenceRateSource({ fetch: f, now: () => t, staleTtlMs: 300_000 });
    await src();
    up = false;
    t = 120_000;
    const stale = await src();
    expect(stale.ARS).toBeCloseTo(1 / 1655, 12);
    t = 400_000;
    const gone = await src();
    expect(gone).toEqual({ USD: 1 });
  });
});

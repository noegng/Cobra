// Usage: pnpm exec tsx scripts/research/plan3/pools-t1-t2.ts --pass 1|2|3   (read-only; appends a pass to docs/research/plan3/pools.json)
import { createRequire } from "node:module";
import type { Address } from "viem";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const req = createRequire(new URL("../../../packages/solver/package.json", import.meta.url));
const { createPublicClient, http, parseAbi, getAddress } = await import(req.resolve("viem"));
const ROOT = new URL("../../../", import.meta.url).pathname; const OUT = decodeURIComponent(ROOT) + "docs/research/plan3/pools.json";
const pass = Number(process.argv[process.argv.indexOf("--pass") + 1] || 1);
const client = createPublicClient({ transport: http("https://forno.celo.org"), batch: { multicall: true } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FACTORY = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc" as Address;
const QUOTER = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8" as Address;
const STABLES = { USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771" } as Record<string, Address>;
const WFIAT = { wARS: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d", wBRL: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0", wMXN: "0x337e7456b420bd3481e7fa61fa9850343d610d34", wCOP: "0x8a1d45e102e886510e891d2ec656a708991e2d76", wCLP: "0x61D450a098b6a7f69fC4b98CE68198fe59768651", wPEN: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE" } as Record<string, Address>;
const FEES = [100, 500, 3000, 10000];
const SIZES = [5, 50, 500, 5000];
const erc = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const fabi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const pabi = parseAbi(["function liquidity() view returns (uint128)", "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const qabi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) view returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

async function retry<T>(f: () => Promise<T>): Promise<T> {
  let e: unknown;
  for (let i = 0; i < 3; i++) { try { return await f(); } catch (x) { e = x; await sleep(800); } }
  throw e;
}

// Reference FX (local units per USD). ARS = dolarapi crypto (matches solver fx.ts), BRL = AwesomeAPI, others = open.er-api.com
async function getJson(url: string) { const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json() as Promise<any>; }
async function fx() {
  const out: Record<string, { perUsd: number | null; source: string; note?: string }> = {};
  let er: any = null;
  try { er = await getJson("https://open.er-api.com/v6/latest/USD"); } catch (e) { /* noted below */ }
  for (const c of ["MXN", "COP", "CLP", "PEN"]) out["w" + c] = { perUsd: er?.rates?.[c] ?? null, source: "open.er-api.com (mid-market)" };
  try { const b = await getJson("https://dolarapi.com/v1/dolares/cripto"); out.wARS = { perUsd: (b.compra + b.venta) / 2, source: "dolarapi.com /v1/dolares/cripto (crypto/USDT rate)", note: "ARS crypto rate, not official" }; } catch { out.wARS = { perUsd: null, source: "dolarapi cripto unreachable" }; }
  try { const b = await getJson("https://economia.awesomeapi.com.br/json/last/USD-BRL"); out.wBRL = { perUsd: (Number(b.USDBRL.bid) + Number(b.USDBRL.ask)) / 2, source: "economia.awesomeapi.com.br USD-BRL mid" }; } catch { out.wBRL = { perUsd: er?.rates?.BRL ?? null, source: "open.er-api.com (awesomeapi unreachable)" }; }
  return out;
}

const revertMsg = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 200);

async function main() {
  const startedAt = new Date().toISOString();
  const block = await retry(() => client.getBlockNumber());
  const bn = { blockNumber: block };
  // re-verify tokens
  const dec: Record<string, number> = {};
  const tokenCheck: any[] = [];
  for (const [n, a] of [...Object.entries(STABLES), ...Object.entries(WFIAT)]) {
    const [symbol, decimals] = await retry(() => Promise.all([client.readContract({ address: a, abi: erc, functionName: "symbol", ...bn }), client.readContract({ address: a, abi: erc, functionName: "decimals", ...bn })]));
    dec[n] = decimals; tokenCheck.push({ name: n, address: a, symbol, decimals });
    console.log("token", n, symbol, decimals);
  }
  const rates = await fx();

  const t1: any[] = [];
  for (const [wn, wa] of Object.entries(WFIAT)) for (const [sn, sa] of Object.entries(STABLES)) for (const fee of FEES) {
    let pool: Address;
    try { pool = await retry(() => client.readContract({ address: FACTORY, abi: fabi, functionName: "getPool", args: [wa, sa, fee], ...bn })); } catch (e) { t1.push({ wfiat: wn, stable: sn, fee, error: revertMsg(e) }); continue; }
    if (/^0x0+$/.test(pool)) continue;
    const g = (fn: any) => retry(() => client.readContract({ address: pool, abi: pabi, functionName: fn, ...bn } as any));
    const [liq, s0, t0, t1a] = await Promise.all([g("liquidity"), g("slot0"), g("token0"), g("token1")]) as any;
    const [bw, bs] = await Promise.all([wa, sa].map((t) => retry(() => client.readContract({ address: t, abi: erc, functionName: "balanceOf", args: [pool], ...bn }))));
    const sqrt = Number(s0[0]) / 2 ** 96; const p = sqrt * sqrt; // token1 raw per token0 raw
    const stableIs0 = getAddress(t0) === getAddress(sa);
    const wPerUsd = (stableIs0 ? p : 1 / p) * 10 ** (dec[sn]! - dec[wn]!) * 1; // wFIAT per stable (human)
    // p = token1_raw/token0_raw. stable0: wfiat_raw/stable_raw -> human wfiat per stable = p*1e6/1e18
    const spot = stableIs0 ? p * 10 ** (dec[sn]! - dec[wn]!) : (1 / p) * 10 ** (dec[sn]! - dec[wn]!);
    const rate = rates[wn]?.perUsd ?? null;
    t1.push({ wfiat: wn, stable: sn, fee, pool, token0: t0, token1: t1a, liquidity: String(liq), sqrtPriceX96: String(s0[0]), tick: s0[1], balanceWfiat: String(bw), balanceStable: String(bs), stableBalanceUsd: Number(bs) / 10 ** dec[sn]!, spotWfiatPerUsd: spot, refWfiatPerUsd: rate, spotVsRefPct: rate ? (spot / rate - 1) * 100 : null });
    console.log("pool", wn, sn, fee, pool, "liq", String(liq), "spot", spot);
    void wPerUsd;
  }

  // GeckoTerminal cross-check
  const t1CrossCheck: any[] = [];
  for (const [wn, wa] of Object.entries(WFIAT)) {
    let done = false;
    for (let i = 0; i < 3 && !done; i++) {
      try {
        const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/celo/tokens/${wa.toLowerCase()}/pools?page=1`);
        for (const d of j.data ?? []) { const a = d.attributes; t1CrossCheck.push({ wfiat: wn, dex: d.relationships?.dex?.data?.id, pool: a.address, name: a.name, reserveInUsd: a.reserve_in_usd, volume24hUsd: a.volume_usd?.h24, fee: a.pool_fee_percentage ?? null, inFactoryScan: t1.some((x) => x.pool && x.pool.toLowerCase() === a.address.toLowerCase()) }); }
        if (!(j.data ?? []).length) t1CrossCheck.push({ wfiat: wn, note: "no pools returned" });
        done = true;
      } catch (e) { if (i === 2) t1CrossCheck.push({ wfiat: wn, error: revertMsg(e) }); await sleep(7000); }
    }
    await sleep(4000);
  }

  // T2
  const t2: any[] = [];
  const live = t1.filter((p) => p.pool && BigInt(p.liquidity) > 0n);
  for (const p of live) {
    const wa = WFIAT[p.wfiat]!, sa = STABLES[p.stable]!, wd = dec[p.wfiat]!, sd = dec[p.stable]!;
    const feePct = p.fee / 10000;
    const refRate = rates[p.wfiat];
    for (const size of SIZES) {
      const wAmt = BigInt(Math.round(size * p.spotWfiatPerUsd * 1e6)) * 10n ** BigInt(wd - 6); // wFIAT worth size USD at spot (6 sig. decimals)
      const sAmt = BigInt(size) * 10n ** BigInt(sd);
      const cases = [
        { direction: "buy_exact_in", fn: "quoteExactInputSingle", tokenIn: sa, tokenOut: wa, amt: sAmt },
        { direction: "sell_exact_in", fn: "quoteExactInputSingle", tokenIn: wa, tokenOut: sa, amt: wAmt },
        { direction: "buy_exact_out", fn: "quoteExactOutputSingle", tokenIn: sa, tokenOut: wa, amt: wAmt },
      ];
      for (const c of cases) {
        const args = [{ tokenIn: c.tokenIn, tokenOut: c.tokenOut, [c.fn === "quoteExactInputSingle" ? "amountIn" : "amount"]: c.amt, fee: p.fee, sqrtPriceLimitX96: 0n }];
        const rec: any = { pass, source: "uniswap-v3", pool: p.pool, wfiat: p.wfiat, stable: p.stable, fee: p.fee, feePct, direction: c.direction, sizeUsd: size, spotWfiatPerUsd: p.spotWfiatPerUsd, referenceRate: { wfiatPerUsd: refRate?.perUsd ?? null, source: refRate?.source, note: refRate?.note }, call: { to: QUOTER, function: c.fn, args: [{ tokenIn: c.tokenIn, tokenOut: c.tokenOut, amount: String(c.amt), fee: p.fee, sqrtPriceLimitX96: "0" }] } };
        try {
          const blk = await retry(() => client.getBlockNumber());
          const r = (await retry(() => client.readContract({ address: QUOTER, abi: qabi, functionName: c.fn as any, args: args as any, blockNumber: blk }))) as any;
          const q = r[0] as bigint;
          const aIn = c.direction.startsWith("buy_exact_in") ? c.amt : c.direction === "sell_exact_in" ? c.amt : q;
          const aOut = c.direction === "buy_exact_out" ? c.amt : q;
          const wfiatAmt = c.direction === "sell_exact_in" ? aIn : aOut; // raw
          const stableAmt = c.direction === "sell_exact_in" ? aOut : aIn;
          const eff = Number(wfiatAmt) / 10 ** wd / (Number(stableAmt) / 10 ** sd); // wFIAT per USD
          // buy: higher is better; sell: lower is better
          const buy = c.direction !== "sell_exact_in";
          const total = (buy ? 1 - eff / p.spotWfiatPerUsd : eff / p.spotWfiatPerUsd - 1) * 100;
          rec.blockNumber = String(blk); rec.timestamp = new Date().toISOString(); rec.reverted = false;
          rec.amountIn = String(aIn); rec.amountOut = String(aOut); rec.gasEstimate = String(r[3]); rec.ticksCrossed = r[2];
          rec.effectiveWfiatPerUsd = eff; rec.feePctOfQuote = feePct; rec.totalCostPct = total; rec.priceImpactPct = total - feePct;
          // QuoterV2 does not revert on thin pools: it fills what it can. Flag outputs that exceed what the pool holds or absurd cost.
          const outTok = c.direction === "sell_exact_in" ? "stable" : "wfiat";
          const poolBal = BigInt(outTok === "stable" ? p.balanceStable : p.balanceWfiat);
          rec.exceedsPoolBalance = c.direction === "buy_exact_out" ? c.amt > poolBal : aOut > poolBal;
          rec.unusable = rec.exceedsPoolBalance || total > 50 || total < -5; // linear split fee + impact
        } catch (e) { rec.reverted = true; rec.revertReason = revertMsg(e); rec.timestamp = new Date().toISOString(); }
        t2.push(rec);
        await sleep(120);
      }
    }
    console.log("quoted", p.wfiat, p.stable, p.fee);
  }

  const file = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { chainId: 42220, passes: [] };
  file.generatedAt = new Date().toISOString();
  file.passes = file.passes.filter((x: any) => x.pass !== pass);
  file.passes.push({ pass, startedAt, block: String(block), tokenCheck, fx: rates, t1, t1CrossCheck, t2 });
  mkdirSync(decodeURIComponent(ROOT) + "docs/research/plan3", { recursive: true });
  writeFileSync(OUT, JSON.stringify(file, null, 2));
  console.log("written", OUT, "pools", t1.length, "quotes", t2.length);
}
main().catch((e) => { console.error(e); process.exit(1); });

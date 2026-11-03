/**
 * Plan 3 sub-agent C: T4 (Mento), T7 (pool deviation vs reference), T6 (Cruce, static note). READ-ONLY.
 * Usage (repo root): export PATH="/opt/homebrew/opt/node@24/bin:$PATH"; pnpm exec tsx scripts/research/plan3/c-mento-fx.ts
 * Writes docs/research/plan3/mento-fx.json
 */
import { createPublicClient, http, parseAbi, getAddress, formatUnits, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { writeFileSync } from "node:fs";

const client = createPublicClient({ chain: celo, transport: http("https://forno.celo.org", { retryCount: 2, retryDelay: 800 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BROKER: Address = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD";
const BIPOOL: Address = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901";
const USDM: Address = "0x765DE816845861e75A25fCA122bb6898B8B1282a";
const FACTORY: Address = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc";

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const brokerAbi = parseAbi([
  "function getExchangeProviders() view returns (address[])",
  "function getAmountOut(address,bytes32,address,address,uint256) view returns (uint256)",
  "function getAmountIn(address,bytes32,address,address,uint256) view returns (uint256)",
  "function tradingLimitsConfig(bytes32) view returns (uint32,int48,int48,int48,int48,uint8)",
  "function tradingLimitsState(bytes32) view returns (uint32,uint32,int48,int48,int48,int48,int48)",
]);
const poolAbi = [{
  type: "function", name: "getPoolExchange", stateMutability: "view", inputs: [{ name: "exchangeId", type: "bytes32" }],
  outputs: [{ type: "tuple", components: [
    { name: "asset0", type: "address" }, { name: "asset1", type: "address" }, { name: "pricingModule", type: "address" },
    { name: "bucket0", type: "uint256" }, { name: "bucket1", type: "uint256" }, { name: "lastBucketUpdate", type: "uint256" },
    { name: "config", type: "tuple", components: [
      { name: "spread", type: "tuple", components: [{ name: "value", type: "uint256" }] },
      { name: "referenceRateFeedID", type: "address" }, { name: "referenceRateResetFrequency", type: "uint256" },
      { name: "minimumReports", type: "uint256" }, { name: "stablePoolResetSize", type: "uint256" }] }] }],
}, { type: "function", name: "broker", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
{ type: "function", name: "sortedOracles", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
{ type: "function", name: "getExchanges", stateMutability: "view", inputs: [], outputs: [{ type: "tuple[]", components: [{ name: "exchangeId", type: "bytes32" }, { name: "assets", type: "address[]" }] }] }] as const;
const oracleAbi = parseAbi(["function medianRate(address) view returns (uint256,uint256)", "function numRates(address) view returns (uint256)"]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const uniPool = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const slot0Celo = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"]);

const sym = async (a: Address) => ({ symbol: await client.readContract({ address: a, abi: erc20, functionName: "symbol" }), decimals: Number(await client.readContract({ address: a, abi: erc20, functionName: "decimals" })) });
const get = async (url: string) => {
  const at = new Date().toISOString();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return { url, at, ok: r.ok, body: await r.json() as any }; }
  catch (e) { return { url, at, ok: false, body: null as any, error: String(e) }; }
};

const block = await client.getBlock();
const blockInfo = { number: Number(block.number), timestamp: new Date(Number(block.timestamp) * 1000).toISOString() };

// ---------- T4 ----------
const providers = await client.readContract({ address: BROKER, abi: brokerAbi, functionName: "getExchangeProviders" });
const bpBroker = await client.readContract({ address: BIPOOL, abi: poolAbi, functionName: "broker" });
const oracleAddr = await client.readContract({ address: BIPOOL, abi: poolAbi, functionName: "sortedOracles" });
const exchanges = await client.readContract({ address: BIPOOL, abi: poolAbi, functionName: "getExchanges" });
const usdSizes = [5, 50, 500, 5000];
const t4ex: any[] = [];
for (const ex of exchanges) {
  const pe = await client.readContract({ address: BIPOOL, abi: poolAbi, functionName: "getPoolExchange", args: [ex.exchangeId] });
  const [s0, s1] = [await sym(pe.asset0), await sym(pe.asset1)];
  const local = pe.asset0.toLowerCase() === USDM.toLowerCase() ? pe.asset1 : pe.asset0;
  const lsym = pe.asset0.toLowerCase() === USDM.toLowerCase() ? s1.symbol : s0.symbol;
  let oracle: any = null;
  try {
    const [rate, den] = await client.readContract({ address: oracleAddr, abi: oracleAbi, functionName: "medianRate", args: [pe.config.referenceRateFeedID] });
    oracle = { feed: pe.config.referenceRateFeedID, medianRate: rate.toString(), denominator: den.toString(), asNumber: Number(rate) / Number(den) };
  } catch (e) { oracle = { feed: pe.config.referenceRateFeedID, error: String(e).slice(0, 80) }; }
  const quotes: any[] = [];
  for (const usd of usdSizes) {
    const inUsdm = BigInt(usd) * 10n ** 18n;
    try {
      const out = await client.readContract({ address: BROKER, abi: brokerAbi, functionName: "getAmountOut", args: [BIPOOL, ex.exchangeId, USDM, local, inUsdm] });
      let back: bigint | null = null;
      try { back = await client.readContract({ address: BROKER, abi: brokerAbi, functionName: "getAmountOut", args: [BIPOOL, ex.exchangeId, local, USDM, out] }); } catch {}
      quotes.push({ usd, usdmIn: inUsdm.toString(), localOut: out.toString(), localPerUsd: Number(formatUnits(out, 18)) / usd,
        roundTripUsdmBack: back?.toString() ?? null, roundTripLossPct: back === null ? null : (1 - Number(back) / Number(inUsdm)) * 100 });
    } catch (e) { quotes.push({ usd, error: String(e).slice(0, 120) }); }
    await sleep(120);
  }
  // trading limits: limitId = exchangeId XOR (uint256(uint160(asset)))
  const limits: any = {};
  for (const a of [USDM, local]) {
    const id = ("0x" + (BigInt(ex.exchangeId) ^ BigInt(a)).toString(16).padStart(64, "0")) as Hex;
    try {
      const c = await client.readContract({ address: BROKER, abi: brokerAbi, functionName: "tradingLimitsConfig", args: [id] });
      limits[a === USDM ? "USDm" : lsym] = { limitId: id, timestep0: c[0], limit0: c[1].toString(), timestep1: c[2].toString(), limit1: c[3].toString(), limitGlobal: c[4].toString(), flags: c[5] };
    } catch (e) { limits[a === USDM ? "USDm" : lsym] = { error: String(e).slice(0, 80) }; }
  }
  t4ex.push({ exchangeId: ex.exchangeId, pair: `USDm/${lsym}`, localToken: local, localSymbol: lsym,
    spreadPct: Number(pe.config.spread.value) / 1e24 * 100, pricingModule: pe.pricingModule,
    bucket0: pe.bucket0.toString(), bucket1: pe.bucket1.toString(), asset0: pe.asset0, asset1: pe.asset1,
    lastBucketUpdate: Number(pe.lastBucketUpdate), referenceRateResetFrequency: Number(pe.config.referenceRateResetFrequency), oracle, quotes, tradingLimits: limits });
}
const t4 = { source: { broker: BROKER, biPoolManager: BIPOOL, docs: "https://docs.mento.org", github: "https://github.com/mento-protocol/mento-core" },
  verified: { providers, bipoolBrokerMatches: getAddress(bpBroker) === BROKER, sortedOracles: oracleAddr, exchangeCount: exchanges.length },
  exchanges: t4ex, readAt: { block: blockInfo } };

// ---------- T7 ----------
const wfiat: Record<string, { cur: string; addr: Address }> = {
  wARS: { cur: "ARS", addr: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d" }, wBRL: { cur: "BRL", addr: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0" },
  wMXN: { cur: "MXN", addr: "0x337e7456b420bd3481e7fa61fa9850343d610d34" }, wCOP: { cur: "COP", addr: "0x8a1d45e102e886510e891d2ec656a708991e2d76" },
  wCLP: { cur: "CLP", addr: "0x61D450a098b6a7f69fC4b98CE68198fe59768651" }, wPEN: { cur: "PEN", addr: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE" } };
const stables: Record<string, Address> = { USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", USDm: USDM };
const meta: Record<string, { symbol: string; decimals: number }> = {};
for (const a of [...Object.values(wfiat).map((x) => x.addr), ...Object.values(stables)]) { meta[a.toLowerCase()] = await sym(getAddress(a)); }

const refs = {
  erApi: await get("https://open.er-api.com/v6/latest/USD"),
  dolarOficial: await get("https://dolarapi.com/v1/dolares/oficial"), dolarBolsa: await get("https://dolarapi.com/v1/dolares/bolsa"),
  dolarCripto: await get("https://dolarapi.com/v1/dolares/cripto"), dolarBlue: await get("https://dolarapi.com/v1/dolares/blue"),
  criptoyaUsdtArs: await get("https://criptoya.com/api/usdt/ars/1"),
  awesome: await get("https://economia.awesomeapi.com.br/json/last/USD-BRL,USD-MXN,USD-COP,USD-CLP,USD-PEN"),
};
const mid = (o: any) => (Number(o.compra) + Number(o.venta)) / 2;
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2) : NaN; };
const R: Record<string, Record<string, { value: number; source: string; at: string }>> = {};
const put = (cur: string, name: string, value: number, r: { url: string; at: string }) => { if (Number.isFinite(value)) (R[cur] ??= {})[name] = { value, source: r.url, at: r.at }; };
if (refs.dolarOficial.ok) put("ARS", "official", mid(refs.dolarOficial.body), refs.dolarOficial);
if (refs.dolarBolsa.ok) put("ARS", "MEP", mid(refs.dolarBolsa.body), refs.dolarBolsa);
if (refs.dolarCripto.ok) put("ARS", "cripto", mid(refs.dolarCripto.body), refs.dolarCripto);
if (refs.dolarBlue.ok) put("ARS", "blue", mid(refs.dolarBlue.body), refs.dolarBlue);
if (refs.criptoyaUsdtArs.ok) put("ARS", "criptoya_usdt_median", median(Object.values(refs.criptoyaUsdtArs.body).map((o: any) => (Number(o.totalAsk) + Number(o.totalBid)) / 2)), refs.criptoyaUsdtArs);
for (const c of ["ARS", "BRL", "MXN", "COP", "CLP", "PEN"]) if (refs.erApi.ok) put(c, "open.er-api", refs.erApi.body.rates[c], refs.erApi);
if (refs.awesome.ok) for (const c of ["BRL", "MXN", "COP", "CLP", "PEN"]) { const o = refs.awesome.body[`USD${c}`]; if (o) put(c, "awesomeapi", (Number(o.bid) + Number(o.ask)) / 2, refs.awesome); }
// Mento oracle (BRL, COP) as extra reference
for (const e of t4ex) { const c = e.localSymbol === "BRLm" ? "BRL" : e.localSymbol === "COPm" ? "COP" : null; if (c && e.oracle.asNumber) R[c]["mento_oracle"] = { value: 1 / e.oracle.asNumber, source: `SortedOracles ${oracleAddr} medianRate(${e.oracle.feed})`, at: blockInfo.timestamp }; }

const t7: any[] = [];
for (const [wn, w] of Object.entries(wfiat)) for (const [sn, s] of Object.entries(stables)) for (const fee of [100, 500, 3000, 10000]) {
  const pool = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [getAddress(w.addr), s, fee] });
  await sleep(60);
  if (/^0x0+$/.test(pool)) continue;
  const t0 = (await client.readContract({ address: pool, abi: uniPool, functionName: "token0" })) as Address;
  let sqrt: bigint;
  try { sqrt = (await client.readContract({ address: pool, abi: uniPool, functionName: "slot0" }))[0]; } catch { sqrt = (await client.readContract({ address: pool, abi: slot0Celo, functionName: "slot0" }))[0]; }
  const liq = await client.readContract({ address: pool, abi: uniPool, functionName: "liquidity" });
  const wIs0 = t0.toLowerCase() === w.addr.toLowerCase();
  const p10 = (Number(sqrt) / 2 ** 96) ** 2; // raw token1 per raw token0
  const dW = meta[w.addr.toLowerCase()].decimals, dS = meta[s.toLowerCase()].decimals;
  // wFIAT per 1 stable (human)
  const wPerS = wIs0 ? 1 / (p10 * 10 ** (dW - dS)) : p10 * 10 ** (dS - dW);
  const dev = (ref: number) => (wPerS / ref - 1) * 100;
  const devs: Record<string, number> = {};
  for (const [rn, r] of Object.entries(R[w.cur] ?? {})) devs[rn] = dev(r.value);
  t7.push({ pair: `${wn}/${sn}`, fee, pool, liquidity: liq.toString(), sqrtPriceX96: sqrt.toString(), wfiatPerUsd: wPerS, devVsRefPct: devs,
    flag2: Object.values(devs).some((d) => Math.abs(d) > 2), flag5: Object.values(devs).some((d) => Math.abs(d) > 5), block: blockInfo });
}
// wARS 1:1 peso parity: implied USD value of 1 wARS vs ARS refs is equivalent to the ARS deviation above; recorded in notes.

const out = { generatedAt: new Date().toISOString(), chainId: 42220, block: blockInfo, t4, t7Refs: R, t7,
  t6: { status: "not done: no public source found", note: "See C-T4-T7-T6.md. Two web searches and cruce.xyz probe found no quote API or contracts." } };
writeFileSync(new URL("../../../docs/research/plan3/mento-fx.json", import.meta.url), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : Number.isNaN(v) ? null : v), 2));
console.log("done", blockInfo, "exchanges", t4ex.length, "pools", t7.length);

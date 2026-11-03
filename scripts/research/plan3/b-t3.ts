/**
 * Plan 3 / sub-agent B — T3: multi-hop and wFIAT<->wFIAT quotes (read-only, eth_call at a pinned block).
 * Usage (repo root): pnpm exec tsx scripts/research/plan3/b-pools.ts && pnpm exec tsx scripts/research/plan3/b-t3.ts
 * Reads docs/research/plan3/b-pools.json, enumerates every 1- and 2-hop path over existing pools, quotes
 * QuoterV2.quoteExactOutput (reversed path, like the solver) and quoteExactInput at 5/50/500/5000 USD,
 * writes docs/research/plan3/b-t3.json.
 * Spot method: slot0 sqrtPriceX96 of each pool (raw-unit rate), product along the path; USD value of a wFIAT = USDT
 * pool spot (USDT assumed = 1 USD, USDC/USAT too). cost = 1 - effective/spot; fees = 1 - prod(1-fee_i); impact = cost - fees.
 */
import { createPublicClient, http, parseAbi, encodePacked, type Hex, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { TOKENS, QUOTER } from "./b-common.ts";

const c = createPublicClient({ transport: http("https://forno.celo.org"), batch: { multicall: true } });
const qAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) view returns (uint256,uint160[],uint32[],uint256)",
  "function quoteExactOutput(bytes path,uint256 amountOut) view returns (uint256,uint160[],uint32[],uint256)",
]);
const P = JSON.parse(readFileSync("docs/research/plan3/b-pools.json", "utf8"));
const block = BigInt(P.block);
const pools: any[] = P.pools;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// raw out-per-in spot rate of one pool hop
function hopRate(p: any, from: string): number {
  const q = Number(BigInt(p.sqrtPriceX96) * 10n ** 18n / (1n << 96n)) / 1e18; // sqrt price
  const price01 = q * q; // token1 raw per token0 raw
  const isT0 = TOKENS[from].address.toLowerCase() === p.token0.toLowerCase();
  return isT0 ? price01 : 1 / price01;
}
type Hop = { from: string; to: string; fee: number; pool: any };
const edges: Hop[] = [];
for (const p of pools) {
  edges.push({ from: p.a, to: p.b, fee: p.fee, pool: p });
  edges.push({ from: p.b, to: p.a, fee: p.fee, pool: p });
}
function paths(a: string, b: string): Hop[][] {
  const res: Hop[][] = [];
  for (const e1 of edges.filter((e) => e.from === a)) {
    if (e1.to === b) res.push([e1]);
    else for (const e2 of edges.filter((e) => e.from === e1.to && e.to === b && e.to !== a)) res.push([e1, e2]);
  }
  return res;
}
const encode = (h: Hop[]): Hex => {
  const types: string[] = [], vals: any[] = [];
  h.forEach((x, i) => { if (i === 0) { types.push("address"); vals.push(TOKENS[x.from].address); } types.push("uint24", "address"); vals.push(x.fee, TOKENS[x.to].address); });
  return encodePacked(types, vals);
};
const encodeRev = (h: Hop[]): Hex => encode([...h].reverse().map((x) => ({ ...x, from: x.to, to: x.from })));
const pretty = (h: Hop[]) => h[0].from + h.map((x) => `-(${x.fee})->${x.to}`).join("");
const sp = (h: Hop[]) => h.reduce((a, x) => a * hopRate(x.pool, x.from), 1);
const feeFrac = (h: Hop[]) => 1 - h.reduce((a, x) => a * (1 - x.fee / 1e6), 1);

// USD value (token units per 1 USD)
const unitsPerUsd: Record<string, number> = {};
for (const s of Object.keys(TOKENS)) {
  if (TOKENS[s].stable) unitsPerUsd[s] = 1;
  else {
    const hs = paths("USDT", s).filter((p) => p.length === 1);
    if (hs.length) unitsPerUsd[s] = sp(hs[0]) / 10 ** (TOKENS[s].decimals - 6); // human units per USDT
  }
}
const toRaw = (sym: string, usd: number) => BigInt(Math.round(usd * (unitsPerUsd[sym] ?? NaN) * 10 ** 6)) * 10n ** BigInt(TOKENS[sym].decimals - 6);

async function call(fn: "quoteExactInput" | "quoteExactOutput", path: Hex, amt: bigint) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = (await c.readContract({ address: QUOTER, abi: qAbi, functionName: fn, args: [path, amt], blockNumber: block })) as any;
      return { ok: true, amount: r[0].toString(), gasEstimate: r[3].toString() };
    } catch (e: any) {
      const m = String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 120);
      if (/rate|429|timeout|fetch/i.test(m) && t < 2) { await sleep(1500); continue; }
      return { ok: false, error: m };
    }
  }
}
const SIZES = [5, 50, 500, 5000];
const syms = Object.keys(TOKENS);
const results: any[] = [];
const unreachable: string[] = [];
for (const out of syms.filter((s) => !TOKENS[s].stable)) for (const inn of syms) {
  if (inn === out) continue;
  const ps = paths(inn, out);
  if (!ps.length) { unreachable.push(`${inn}->${out}`); continue; }
  for (const h of ps) {
    const spot = sp(h), fee = feeFrac(h);
    for (const usd of SIZES) {
      const amountOut = toRaw(out, usd), amountIn = toRaw(inn, usd);
      const xo = await call("quoteExactOutput", encodeRev(h), amountOut);
      const xi = await call("quoteExactInput", encode(h), amountIn);
      const row: any = { pair: `${inn}->${out}`, path: pretty(h), hops: h.length, encodedPath: encode(h), encodedPathReversed: encodeRev(h), sizeUsd: usd, spotRate: spot, feeFrac: fee,
        exactOutput: { call: `quoteExactOutput(reversedPath, ${amountOut})`, amountOut: amountOut.toString(), ...xo }, exactInput: { call: `quoteExactInput(path, ${amountIn})`, amountIn: amountIn.toString(), ...xi } };
      if (xo!.ok) { const eff = Number(amountOut) / Number(BigInt(xo!.amount!)); row.exactOutput.costPct = (1 - eff / spot) * 100; row.exactOutput.feePct = fee * 100; row.exactOutput.impactPct = row.exactOutput.costPct - fee * 100; }
      if (xi!.ok) { const eff = Number(BigInt(xi!.amount!)) / Number(amountIn); row.exactInput.costPct = (1 - eff / spot) * 100; row.exactInput.feePct = fee * 100; row.exactInput.impactPct = row.exactInput.costPct - fee * 100; }
      results.push(row); await sleep(120);
    }
  }
}
const blk = await c.getBlock({ blockNumber: block });
writeFileSync("docs/research/plan3/b-t3.json", JSON.stringify({ block: P.block, timestamp: Number(blk.timestamp), unitsPerUsd, unreachable, results }, null, 1));
for (const r of results) console.log(r.path.padEnd(40), r.sizeUsd, "XO", r.exactOutput.ok ? r.exactOutput.costPct.toFixed(3) + "%" : r.exactOutput.error, "XI", r.exactInput.ok ? r.exactInput.costPct.toFixed(3) + "%" : r.exactInput.error);
console.log("unreachable:", unreachable.length, unreachable.join(" "));
